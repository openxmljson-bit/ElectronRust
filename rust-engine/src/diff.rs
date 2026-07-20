// Structural diff between two ingested databases (Compare With Open Tab).
// Walks both trees in lockstep and reports added / removed / changed paths.
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;

struct Row {
    id: i64,
    kind: i64,
    name: Option<String>,
    value: Option<String>,
    n: i64,
}

fn es(e: rusqlite::Error) -> String {
    e.to_string()
}

fn open_ro(p: &str) -> Result<Connection, String> {
    Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(es)
}

fn root_of(conn: &Connection) -> i64 {
    conn.query_row("SELECT value FROM meta WHERE key='root_id'", [], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(1)
}

fn get(conn: &Connection, id: i64) -> Result<Row, String> {
    conn.query_row(
        "SELECT id, kind, name, value, n_children FROM nodes WHERE id=?1",
        params![id],
        |r| {
            Ok(Row {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                value: r.get(3)?,
                n: r.get(4)?,
            })
        },
    )
    .map_err(|_| String::from("node not found"))
}

fn children(conn: &Connection, id: i64, cap: i64) -> Result<Vec<Row>, String> {
    let mut st = conn
        .prepare_cached(
            "SELECT id, kind, name, value, n_children FROM nodes WHERE parent_id=?1 \
             ORDER BY ord LIMIT ?2",
        )
        .map_err(es)?;
    let mut rows = st.query(params![id, cap]).map_err(es)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(es)? {
        out.push(Row {
            id: r.get(0).map_err(es)?,
            kind: r.get(1).map_err(es)?,
            name: r.get(2).map_err(es)?,
            value: r.get(3).map_err(es)?,
            n: r.get(4).map_err(es)?,
        });
    }
    Ok(out)
}

struct DState {
    entries: Vec<Value>,
    added: u64,
    removed: u64,
    changed: u64,
    limit: usize,
    budget: i64,
    truncated: bool,
}

fn summary(r: &Row) -> String {
    match r.kind {
        0 | 6 => format!("{{{} keys}}", r.n),
        1 => format!("[{} items]", r.n),
        5 => String::from("null"),
        _ => {
            let v = r.value.clone().unwrap_or_default();
            if v.chars().count() > 120 {
                let mut s: String = v.chars().take(120).collect();
                s.push('…');
                s
            } else {
                v
            }
        }
    }
}

fn record(st: &mut DState, op: &str, path: &str, a: Option<&Row>, b: Option<&Row>) {
    match op {
        "added" => st.added += 1,
        "removed" => st.removed += 1,
        _ => st.changed += 1,
    }
    if st.entries.len() < st.limit {
        st.entries.push(json!({
            "op": op,
            "path": path,
            "a": a.map(summary),
            "b": b.map(summary),
        }));
    } else {
        st.truncated = true;
    }
}

const CHILD_CAP: i64 = 10_000;

fn compare(
    ca: &Connection,
    cb: &Connection,
    a: &Row,
    b: &Row,
    path: &str,
    st: &mut DState,
) -> Result<(), String> {
    st.budget -= 1;
    if st.budget < 0 {
        st.truncated = true;
        return Ok(());
    }
    if a.kind != b.kind {
        record(st, "changed", path, Some(a), Some(b));
        return Ok(());
    }
    match a.kind {
        0 | 6 => {
            let ka = children(ca, a.id, CHILD_CAP)?;
            let kb = children(cb, b.id, CHILD_CAP)?;
            let build = |v: &[Row]| -> BTreeMap<String, usize> {
                let mut m = BTreeMap::new();
                for (i, r) in v.iter().enumerate() {
                    let key = r.name.clone().unwrap_or_else(|| format!("#{}", i));
                    m.entry(key).or_insert(i);
                }
                m
            };
            let ma = build(&ka);
            let mb = build(&kb);
            for (name, &ia) in &ma {
                let child_path = format!("{}.{}", path, name);
                match mb.get(name) {
                    Some(&ib) => compare(ca, cb, &ka[ia], &kb[ib], &child_path, st)?,
                    None => record(st, "removed", &child_path, Some(&ka[ia]), None),
                }
                if st.truncated {
                    return Ok(());
                }
            }
            for (name, &ib) in &mb {
                if !ma.contains_key(name) {
                    record(st, "added", &format!("{}.{}", path, name), None, Some(&kb[ib]));
                }
            }
            if a.n > CHILD_CAP || b.n > CHILD_CAP {
                st.truncated = true;
            }
        }
        1 => {
            let ka = children(ca, a.id, CHILD_CAP)?;
            let kb = children(cb, b.id, CHILD_CAP)?;
            let common = ka.len().min(kb.len());
            for i in 0..common {
                compare(ca, cb, &ka[i], &kb[i], &format!("{}[{}]", path, i), st)?;
                if st.truncated {
                    return Ok(());
                }
            }
            for (i, r) in ka.iter().enumerate().skip(common) {
                record(st, "removed", &format!("{}[{}]", path, i), Some(r), None);
            }
            for (i, r) in kb.iter().enumerate().skip(common) {
                record(st, "added", &format!("{}[{}]", path, i), None, Some(r));
            }
            if a.n > CHILD_CAP || b.n > CHILD_CAP {
                st.truncated = true;
            }
        }
        _ => {
            let va = a.value.as_deref().unwrap_or("");
            let vb = b.value.as_deref().unwrap_or("");
            if va != vb {
                record(st, "changed", path, Some(a), Some(b));
            }
        }
    }
    Ok(())
}

pub fn run(db_a: &str, db_b: &str, limit: usize) -> Result<(), String> {
    let ca = open_ro(db_a)?;
    let cb = open_ro(db_b)?;
    let ra = get(&ca, root_of(&ca))?;
    let rb = get(&cb, root_of(&cb))?;
    let mut st = DState {
        entries: Vec::new(),
        added: 0,
        removed: 0,
        changed: 0,
        limit,
        budget: 2_000_000,
        truncated: false,
    };
    compare(&ca, &cb, &ra, &rb, "$", &mut st)?;
    println!(
        "{}",
        json!({
            "event": "diff",
            "added": st.added,
            "removed": st.removed,
            "changed": st.changed,
            "entries": st.entries,
            "truncated": st.truncated,
        })
    );
    let _ = std::io::stdout().flush();
    Ok(())
}
