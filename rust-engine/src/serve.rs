// Long-lived query server. Reads one JSON request per line on stdin and
// writes one JSON response per line on stdout.
//
// Ops:
//   {"id":1,"op":"meta"}
//   {"id":2,"op":"children","node":1,"offset":0,"limit":200}
//   {"id":3,"op":"node","node":42}
//   {"id":4,"op":"path","node":42}
//   {"id":5,"op":"search","q":"foo","scope":"all|keys|values","offset":0,"limit":100}
//   {"id":6,"op":"table","node":1,"offset":0,"limit":100}
//   {"id":7,"op":"subtree","node":42,"budget":50000}   -> pretty JSON/XML source
use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

// Escape a user value for use inside a LIKE pattern (with ESCAPE '\').
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

// Build the SQL condition (on alias `f.value`) and push any bound values for one
// column filter. Returns the condition fragment.
fn filter_cond(op: &str, val: &str, binds: &mut Vec<String>) -> String {
    match op {
        "equals" => { binds.push(val.to_string()); "f.value = ?".into() }
        "not-equals" => { binds.push(val.to_string()); "IFNULL(f.value,'') <> ?".into() }
        "starts-with" => { binds.push(format!("{}%", like_escape(val))); "f.value LIKE ? ESCAPE '\\'".into() }
        "gt" => { binds.push(val.to_string()); "CAST(f.value AS REAL) > CAST(? AS REAL)".into() }
        "lt" => { binds.push(val.to_string()); "CAST(f.value AS REAL) < CAST(? AS REAL)".into() }
        "between" => {
            let mut it = val.splitn(2, ',');
            binds.push(it.next().unwrap_or("").trim().to_string());
            binds.push(it.next().unwrap_or("").trim().to_string());
            "CAST(f.value AS REAL) BETWEEN CAST(? AS REAL) AND CAST(? AS REAL)".into()
        }
        _ => { binds.push(format!("%{}%", like_escape(val))); "f.value LIKE ? ESCAPE '\\'".into() } // contains
    }
}

// WHERE clause (rows are children of `node`) + ordered bound values, from the
// request's optional `filters` array. Column indices are inlined (safe i64).
fn build_filter_where(node: i64, req: &Value) -> (String, Vec<String>) {
    let mut clauses = vec![format!("r.parent_id = {}", node)];
    let mut binds: Vec<String> = Vec::new();
    if let Some(fs) = req.get("filters").and_then(|v| v.as_array()) {
        for f in fs {
            let col = f.get("col").and_then(|v| v.as_i64()).unwrap_or(-1);
            if col < 0 { continue; }
            let op = f.get("op").and_then(|v| v.as_str()).unwrap_or("contains");
            let val = f.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let cond = filter_cond(op, val, &mut binds);
            clauses.push(format!(
                "EXISTS (SELECT 1 FROM nodes f WHERE f.parent_id=r.id AND f.ord={} AND {})",
                col, cond
            ));
        }
    }
    (clauses.join(" AND "), binds)
}

fn es(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn serve(db_path: &str) -> Result<(), String> {
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(es)?;
    let _ = conn.execute_batch("PRAGMA cache_size=-131072; PRAGMA busy_timeout=30000;");
    emit(&json!({"event":"ready"}));
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                emit(&json!({"id": null, "ok": false, "error": format!("bad request: {}", e)}));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match handle(&conn, db_path, &req) {
            Ok(data) => emit(&json!({"id": id, "ok": true, "data": data})),
            Err(e) => emit(&json!({"id": id, "ok": false, "error": e})),
        }
    }
    Ok(())
}

fn emit(v: &Value) {
    println!("{}", v);
    let _ = std::io::stdout().flush();
}

fn geti(req: &Value, k: &str, d: i64) -> i64 {
    req.get(k).and_then(|v| v.as_i64()).unwrap_or(d)
}

fn gets<'a>(req: &'a Value, k: &str, d: &'a str) -> &'a str {
    req.get(k).and_then(|v| v.as_str()).unwrap_or(d)
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn handle(conn: &Connection, db_path: &str, req: &Value) -> Result<Value, String> {
    match gets(req, "op", "") {
        "meta" => op_meta(conn),
        "children" => op_children(conn, req),
        "node" => op_node(conn, req),
        "path" => op_path(conn, req),
        "search" => op_search(conn, db_path, req),
        "table" => op_table(conn, req),
        "distinct" => op_distinct(conn, req),
        "profile" => op_profile(conn, req),
        "export" => op_export(conn, req),
        "subtree" => op_subtree(conn, req),
        "stats" => op_stats(conn, req),
        "schema" => op_schema(conn, req),
        "validate" => op_validate(conn, req),
        other => Err(format!("unknown op: {}", other)),
    }
}

fn op_meta(conn: &Connection) -> Result<Value, String> {
    let mut st = conn.prepare("SELECT key, value FROM meta").map_err(es)?;
    let mut rows = st.query([]).map_err(es)?;
    let mut m = serde_json::Map::new();
    while let Some(row) = rows.next().map_err(es)? {
        let k: String = row.get(0).map_err(es)?;
        let v: String = row.get(1).map_err(es)?;
        m.insert(k, Value::String(v));
    }
    Ok(Value::Object(m))
}

fn row_item(row: &rusqlite::Row) -> Result<Value, String> {
    Ok(json!({
        "id": row.get::<_, i64>(0).map_err(es)?,
        "ord": row.get::<_, i64>(1).map_err(es)?,
        "kind": row.get::<_, i64>(2).map_err(es)?,
        "name": row.get::<_, Option<String>>(3).map_err(es)?,
        "value": row.get::<_, Option<String>>(4).map_err(es)?,
        "vlen": row.get::<_, i64>(5).map_err(es)?,
        "n": row.get::<_, i64>(6).map_err(es)?,
    }))
}

fn op_children(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let offset = geti(req, "offset", 0).max(0);
    let limit = geti(req, "limit", 200).clamp(1, 1000);
    let mut st = conn
        .prepare_cached(
            "SELECT id, ord, kind, name, substr(value,1,4096), \
             CASE WHEN value IS NULL THEN 0 ELSE length(value) END, n_children \
             FROM nodes WHERE parent_id=?1 ORDER BY ord LIMIT ?2 OFFSET ?3",
        )
        .map_err(es)?;
    let mut rows = st.query(params![node, limit, offset]).map_err(es)?;
    let mut items: Vec<Value> = Vec::new();
    while let Some(row) = rows.next().map_err(es)? {
        items.push(row_item(row)?);
    }
    Ok(json!({"items": items}))
}

fn op_node(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    conn.query_row(
        "SELECT id, ord, kind, name, substr(value,1,10000000), \
         CASE WHEN value IS NULL THEN 0 ELSE length(value) END, n_children, parent_id, depth \
         FROM nodes WHERE id=?1",
        params![node],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "ord": r.get::<_, i64>(1)?,
                "kind": r.get::<_, i64>(2)?,
                "name": r.get::<_, Option<String>>(3)?,
                "value": r.get::<_, Option<String>>(4)?,
                "vlen": r.get::<_, i64>(5)?,
                "n": r.get::<_, i64>(6)?,
                "parent_id": r.get::<_, Option<i64>>(7)?,
                "depth": r.get::<_, i64>(8)?,
            }))
        },
    )
    .map_err(|_| String::from("node not found"))
}

struct PathSeg {
    id: i64,
    ord: i64,
    name: Option<String>,
    kind: i64,
}

fn is_ident(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut chars = s.chars();
    let c0 = chars.next().unwrap();
    if !(c0.is_ascii_alphabetic() || c0 == '_' || c0 == '$') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn op_path(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let root_id: i64 = meta_get(conn, "root_id")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let format = meta_get(conn, "format").unwrap_or_else(|| "json".into());
    let is_xml = format == "xml";

    let mut chain: Vec<PathSeg> = Vec::new();
    let mut cur = node;
    loop {
        let (ord, name, kind, parent): (i64, Option<String>, i64, Option<i64>) = conn
            .query_row(
                "SELECT ord, name, kind, parent_id FROM nodes WHERE id=?1",
                params![cur],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| String::from("node not found"))?;
        chain.push(PathSeg { id: cur, ord, name, kind });
        match parent {
            Some(p) => cur = p,
            None => break,
        }
        if chain.len() > 4000 {
            return Err(String::from("path too deep"));
        }
    }
    chain.reverse(); // synthetic root .. node

    let start = chain.iter().position(|c| c.id == root_id).unwrap_or(0);
    let mut path = String::new();
    if !is_xml {
        path.push('$');
    }
    for k in (start + 1)..chain.len() {
        let seg = &chain[k];
        let parent_kind = chain[k - 1].kind;
        if is_xml {
            match seg.kind {
                7 => {
                    path.push_str("/@");
                    path.push_str(seg.name.as_deref().unwrap_or(""));
                }
                8 => path.push_str("/text()"),
                _ => {
                    path.push('/');
                    path.push_str(seg.name.as_deref().unwrap_or("*"));
                }
            }
        } else if parent_kind == 1 {
            // array parent -> positional
            path.push_str(&format!("[{}]", seg.ord));
        } else {
            let n = seg.name.clone().unwrap_or_default();
            if is_ident(&n) {
                path.push('.');
                path.push_str(&n);
            } else {
                path.push_str(&format!(
                    "[{}]",
                    serde_json::to_string(&n).unwrap_or_default()
                ));
            }
        }
    }

    let ancestors: Vec<Value> = chain[start..]
        .iter()
        .map(|c| json!({"id": c.id, "ord": c.ord, "kind": c.kind}))
        .collect();
    Ok(json!({"path": path, "ancestors": ancestors, "root_id": root_id}))
}

fn like_pattern(q: &str) -> String {
    let mut s = String::from("%");
    for c in q.chars() {
        if c == '%' || c == '_' || c == '\\' {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

fn fts_built(conn: &Connection) -> bool {
    // The table's existence alone isn't proof: an interrupted index build
    // leaves a partial nodes_fts behind, which silently drops matches.
    // Only trust the index once the indexer has stamped completion in meta.
    meta_get(conn, "fts_built").as_deref() == Some("1")
        && conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
                [],
                |_r| Ok(1i64),
            )
            .is_ok()
}

fn search_row(row: &rusqlite::Row) -> Result<Value, String> {
    Ok(json!({
        "id": row.get::<_, i64>(0).map_err(es)?,
        "kind": row.get::<_, i64>(1).map_err(es)?,
        "name": row.get::<_, Option<String>>(2).map_err(es)?,
        "value": row.get::<_, Option<String>>(3).map_err(es)?,
        "parent_id": row.get::<_, Option<i64>>(4).map_err(es)?,
    }))
}

// Parallel chunked scan (same idea as a raw mmap scan with rayon: split the
// key space into per-core chunks, each scanned by its own read-only
// connection). Ranges are disjoint and processed in ascending order, so the
// concatenated result is already sorted by id.
fn count_parallel(db_path: &str, sql: &str, pat: &str, max_id: i64) -> Result<i64, String> {
    if max_id <= 0 {
        return Ok(0);
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i64)
        .unwrap_or(4)
        .min(8)
        .max(1);
    let chunk = (max_id + threads - 1) / threads;
    let mut total: i64 = 0;
    let mut first_err: Option<String> = None;
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for t in 0..threads {
            let lo = t * chunk;
            let hi = (lo + chunk).min(max_id);
            if lo >= max_id {
                break;
            }
            let db = db_path.to_string();
            let pat = pat.to_string();
            let sql = sql.to_string();
            handles.push(s.spawn(move || -> Result<i64, String> {
                let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(es)?;
                let _ = c.execute_batch("PRAGMA busy_timeout=30000;");
                c.query_row(&sql, params![pat, lo, hi], |r| r.get::<_, i64>(0))
                    .map_err(es)
            }));
        }
        for h in handles {
            match h.join() {
                Ok(Ok(n)) => total += n,
                Ok(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Err(_) => {
                    if first_err.is_none() {
                        first_err = Some(String::from("count thread panicked"));
                    }
                }
            }
        }
    });
    match first_err {
        Some(e) => Err(e),
        None => Ok(total),
    }
}

fn scan_parallel(
    db_path: &str,
    sql: &str,
    pat: &str,
    after: i64,
    max_id: i64,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let span = max_id - after;
    if span <= 0 {
        return Ok(Vec::new());
    }
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i64)
        .unwrap_or(4)
        .min(8)
        .max(1);
    let chunk = (span + threads - 1) / threads;
    let mut all: Vec<Value> = Vec::new();
    let mut first_err: Option<String> = None;
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for t in 0..threads {
            let lo = after + t * chunk; // exclusive lower bound
            let hi = (lo + chunk).min(max_id); // inclusive upper bound
            if lo >= max_id {
                break;
            }
            let db = db_path.to_string();
            let pat = pat.to_string();
            let sql = sql.to_string();
            handles.push(s.spawn(move || -> Result<Vec<Value>, String> {
                let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(es)?;
                let _ = c.execute_batch("PRAGMA busy_timeout=30000;");
                let mut st = c.prepare(&sql).map_err(es)?;
                let mut rows = st.query(params![pat, lo, hi, limit + 1]).map_err(es)?;
                let mut out = Vec::new();
                while let Some(r) = rows.next().map_err(es)? {
                    out.push(search_row(r)?);
                }
                Ok(out)
            }));
        }
        for h in handles {
            match h.join() {
                Ok(Ok(mut v)) => all.append(&mut v),
                Ok(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Err(_) => {
                    if first_err.is_none() {
                        first_err = Some(String::from("search thread panicked"));
                    }
                }
            }
        }
    });
    match first_err {
        Some(e) => Err(e),
        None => Ok(all),
    }
}

fn op_search(conn: &Connection, db_path: &str, req: &Value) -> Result<Value, String> {
    let q = gets(req, "q", "");
    if q.is_empty() {
        return Err(String::from("empty query"));
    }
    let scope = gets(req, "scope", "all");
    let exact = req.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);
    let limit = geti(req, "limit", 100).clamp(1, 500);
    // Trigram FTS needs at least 3 characters; shorter queries fall back to scan.
    let use_fts = fts_built(conn) && q.chars().count() >= 3;
    let want_total = req.get("total").and_then(|v| v.as_bool()).unwrap_or(false);
    let mut total: Option<i64> = None;
    let mut items: Vec<Value> = Vec::new();

    if use_fts {
        let offset = geti(req, "offset", 0).max(0);
        let esc = q.replace('"', "\"\"");
        let match_expr = match scope {
            "keys" => format!("name : \"{}\"", esc),
            "values" => format!("value : \"{}\"", esc),
            _ => format!("\"{}\"", esc),
        };
        if exact {
            let sql = match scope {
                "keys" => {
                    "SELECT n.id, n.kind, n.name, substr(n.value,1,200), n.parent_id \
                     FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                     WHERE nodes_fts MATCH ?1 AND n.name = ?2 \
                     ORDER BY f.rowid LIMIT ?3 OFFSET ?4"
                }
                "values" => {
                    "SELECT n.id, n.kind, n.name, substr(n.value,1,200), n.parent_id \
                     FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                     WHERE nodes_fts MATCH ?1 AND n.value = ?2 \
                     ORDER BY f.rowid LIMIT ?3 OFFSET ?4"
                }
                _ => {
                    "SELECT n.id, n.kind, n.name, substr(n.value,1,200), n.parent_id \
                     FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                     WHERE nodes_fts MATCH ?1 AND (n.name = ?2 OR n.value = ?2) \
                     ORDER BY f.rowid LIMIT ?3 OFFSET ?4"
                }
            };
            let mut st = conn.prepare_cached(sql).map_err(es)?;
            let mut rows = st
                .query(params![match_expr, q, limit + 1, offset])
                .map_err(|e| format!("index search failed: {}", e))?;
            while let Some(row) = rows.next().map_err(es)? {
                items.push(search_row(row)?);
            }
        } else {
            let sql = "SELECT n.id, n.kind, n.name, substr(n.value,1,200), n.parent_id \
                       FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                       WHERE nodes_fts MATCH ?1 \
                       ORDER BY f.rowid LIMIT ?2 OFFSET ?3";
            let mut st = conn.prepare_cached(sql).map_err(es)?;
            let mut rows = st
                .query(params![match_expr, limit + 1, offset])
                .map_err(|e| format!("index search failed: {}", e))?;
            while let Some(row) = rows.next().map_err(es)? {
                items.push(search_row(row)?);
            }
        }
        if want_total {
            let cnt: i64 = if exact {
                let csql = match scope {
                    "keys" => {
                        "SELECT COUNT(*) FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                         WHERE nodes_fts MATCH ?1 AND n.name = ?2"
                    }
                    "values" => {
                        "SELECT COUNT(*) FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                         WHERE nodes_fts MATCH ?1 AND n.value = ?2"
                    }
                    _ => {
                        "SELECT COUNT(*) FROM nodes_fts f JOIN nodes n ON n.id = f.rowid \
                         WHERE nodes_fts MATCH ?1 AND (n.name = ?2 OR n.value = ?2)"
                    }
                };
                conn.query_row(csql, params![match_expr, q], |r| r.get(0))
                    .map_err(es)?
            } else {
                conn.query_row(
                    "SELECT COUNT(*) FROM nodes_fts WHERE nodes_fts MATCH ?1",
                    params![match_expr],
                    |r| r.get(0),
                )
                .map_err(es)?
            };
            total = Some(cnt);
        }
    } else {
        // Parallel chunked scan with keyset pagination: the id range after the
        // cursor is split across CPU cores, each core scanning its own slice
        // with a dedicated read-only connection.
        let after = geti(req, "after", 0).max(0);
        let pat = if exact { q.to_string() } else { like_pattern(q) };
        let where_clause: &'static str = if exact {
            match scope {
                "keys" => "name = ?1",
                "values" => "value = ?1",
                _ => "(name = ?1 OR value = ?1)",
            }
        } else {
            match scope {
                "keys" => "name LIKE ?1 ESCAPE '\\'",
                "values" => "value LIKE ?1 ESCAPE '\\'",
                _ => "(name LIKE ?1 ESCAPE '\\' OR value LIKE ?1 ESCAPE '\\')",
            }
        };
        let sql = format!(
            "SELECT id, kind, name, substr(value,1,200), parent_id FROM nodes \
             WHERE {} AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4",
            where_clause
        );
        let max_id: i64 = conn
            .query_row("SELECT COALESCE(MAX(id),0) FROM nodes", [], |r| r.get(0))
            .map_err(es)?;
        if max_id - after <= 500_000 {
            // Small remainder: one connection is faster than spinning up threads.
            let mut st = conn.prepare(&sql).map_err(es)?;
            let mut rows = st.query(params![pat, after, max_id, limit + 1]).map_err(es)?;
            while let Some(row) = rows.next().map_err(es)? {
                items.push(search_row(row)?);
            }
        } else {
            items = scan_parallel(db_path, &sql, &pat, after, max_id, limit)?;
        }
        if want_total {
            let csql = format!(
                "SELECT COUNT(*) FROM nodes WHERE {} AND id > ?2 AND id <= ?3",
                where_clause
            );
            total = Some(count_parallel(db_path, &csql, &pat, max_id)?);
        }
    }

    let has_more = items.len() as i64 > limit;
    if has_more {
        items.truncate(limit as usize);
    }
    Ok(json!({"items": items, "hasMore": has_more, "indexed": use_fts, "total": total}))
}

// ---------- node statistics ----------
fn op_stats(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let mut kinds = serde_json::Map::new();
    let mut total: i64 = 0;
    {
        let mut st = conn
            .prepare_cached("SELECT kind, COUNT(*) FROM nodes WHERE parent_id=?1 GROUP BY kind")
            .map_err(es)?;
        let mut rows = st.query(params![node]).map_err(es)?;
        while let Some(r) = rows.next().map_err(es)? {
            let k: i64 = r.get(0).map_err(es)?;
            let c: i64 = r.get(1).map_err(es)?;
            total += c;
            let name = match k {
                0 => "objects",
                1 => "arrays",
                2 => "strings",
                3 => "numbers",
                4 => "booleans",
                5 => "nulls",
                6 => "elements",
                7 => "attributes",
                8 => "text",
                _ => "other",
            };
            kinds.insert(name.to_string(), Value::from(c));
        }
    }
    let distinct: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT value) FROM nodes WHERE parent_id=?1 AND value IS NOT NULL",
            params![node],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let numeric = conn
        .query_row(
            "SELECT COUNT(*), MIN(CAST(value AS REAL)), MAX(CAST(value AS REAL)), AVG(CAST(value AS REAL)) \
             FROM nodes WHERE parent_id=?1 AND kind=3",
            params![node],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<f64>>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                    r.get::<_, Option<f64>>(3)?,
                ))
            },
        )
        .unwrap_or((0, None, None, None));
    Ok(json!({
        "children": total,
        "kinds": kinds,
        "distinct_values": distinct,
        "numeric": {"count": numeric.0, "min": numeric.1, "max": numeric.2, "avg": numeric.3}
    }))
}

// ---------- subtree reconstruction (pretty JSON / XML source) ----------

struct NodeRow {
    id: i64,
    kind: i64,
    name: Option<String>,
    value: Option<String>,
    n: i64,
}

fn row_to_node(r: &rusqlite::Row) -> rusqlite::Result<NodeRow> {
    Ok(NodeRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        value: r.get(3)?,
        n: r.get(4)?,
    })
}

fn fetch_node(conn: &Connection, id: i64) -> Result<NodeRow, String> {
    conn.query_row(
        "SELECT id, kind, name, value, n_children FROM nodes WHERE id=?1",
        params![id],
        row_to_node,
    )
    .map_err(|_| String::from("node not found"))
}

fn fetch_children(conn: &Connection, id: i64, budget: &mut i64) -> Result<Vec<NodeRow>, String> {
    let mut st = conn
        .prepare_cached(
            "SELECT id, kind, name, value, n_children FROM nodes WHERE parent_id=?1 ORDER BY ord",
        )
        .map_err(es)?;
    let mut rows = st.query(params![id]).map_err(es)?;
    let mut out: Vec<NodeRow> = Vec::new();
    while let Some(r) = rows.next().map_err(es)? {
        *budget -= 1;
        if *budget < 0 {
            return Err(String::from("subtree too large to render as source"));
        }
        out.push(row_to_node(r).map_err(es)?);
    }
    Ok(out)
}

fn fetch_children_page(
    conn: &Connection,
    id: i64,
    offset: i64,
    limit: i64,
) -> Result<Vec<NodeRow>, String> {
    let mut st = conn
        .prepare_cached(
            "SELECT id, kind, name, value, n_children FROM nodes WHERE parent_id=?1 \
             ORDER BY ord LIMIT ?2 OFFSET ?3",
        )
        .map_err(es)?;
    let mut rows = st.query(params![id, limit, offset]).map_err(es)?;
    let mut out: Vec<NodeRow> = Vec::new();
    while let Some(r) = rows.next().map_err(es)? {
        out.push(row_to_node(r).map_err(es)?);
    }
    Ok(out)
}

fn json_scalar(kind: i64, value: &Option<String>) -> String {
    match kind {
        3 | 4 => value.clone().unwrap_or_else(|| "null".into()),
        5 => String::from("null"),
        _ => serde_json::to_string(value.as_deref().unwrap_or("")).unwrap_or_default(),
    }
}

fn build_json(
    conn: &Connection,
    node: &NodeRow,
    out: &mut String,
    indent: usize,
    budget: &mut i64,
) -> Result<(), String> {
    if indent > 512 {
        return Err(String::from("subtree too deep"));
    }
    let pad = "  ".repeat(indent + 1);
    let pad_end = "  ".repeat(indent);
    match node.kind {
        0 => {
            let kids = fetch_children(conn, node.id, budget)?;
            if kids.is_empty() {
                out.push_str("{}");
                return Ok(());
            }
            out.push_str("{\n");
            for (i, k) in kids.iter().enumerate() {
                out.push_str(&pad);
                out.push_str(
                    &serde_json::to_string(k.name.as_deref().unwrap_or("")).unwrap_or_default(),
                );
                out.push_str(": ");
                build_json(conn, k, out, indent + 1, budget)?;
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push('}');
        }
        1 => {
            let kids = fetch_children(conn, node.id, budget)?;
            if kids.is_empty() {
                out.push_str("[]");
                return Ok(());
            }
            out.push_str("[\n");
            for (i, k) in kids.iter().enumerate() {
                out.push_str(&pad);
                build_json(conn, k, out, indent + 1, budget)?;
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push(']');
        }
        _ => out.push_str(&json_scalar(node.kind, &node.value)),
    }
    Ok(())
}

fn xml_escape(s: &str, attr: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attr => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn build_xml(
    conn: &Connection,
    node: &NodeRow,
    out: &mut String,
    indent: usize,
    budget: &mut i64,
) -> Result<(), String> {
    if indent > 512 {
        return Err(String::from("subtree too deep"));
    }
    let pad = "  ".repeat(indent);
    match node.kind {
        6 => {
            let kids = fetch_children(conn, node.id, budget)?;
            let name = node.name.clone().unwrap_or_else(|| "node".into());
            out.push_str(&pad);
            out.push('<');
            out.push_str(&name);
            let mut content: Vec<&NodeRow> = Vec::new();
            for k in &kids {
                if k.kind == 7 {
                    out.push(' ');
                    out.push_str(k.name.as_deref().unwrap_or("attr"));
                    out.push_str("=\"");
                    out.push_str(&xml_escape(k.value.as_deref().unwrap_or(""), true));
                    out.push('"');
                } else {
                    content.push(k);
                }
            }
            if content.is_empty() {
                out.push_str("/>\n");
            } else if content.len() == 1 && content[0].kind == 8 {
                out.push('>');
                out.push_str(&xml_escape(content[0].value.as_deref().unwrap_or(""), false));
                out.push_str("</");
                out.push_str(&name);
                out.push_str(">\n");
            } else {
                out.push_str(">\n");
                for k in content {
                    build_xml(conn, k, out, indent + 1, budget)?;
                }
                out.push_str(&pad);
                out.push_str("</");
                out.push_str(&name);
                out.push_str(">\n");
            }
        }
        8 => {
            out.push_str(&pad);
            out.push_str(&xml_escape(node.value.as_deref().unwrap_or(""), false));
            out.push('\n');
        }
        7 => {
            out.push_str(&pad);
            out.push_str(&format!(
                "{}=\"{}\"\n",
                node.name.as_deref().unwrap_or("attr"),
                xml_escape(node.value.as_deref().unwrap_or(""), true)
            ));
        }
        _ => {
            // Synthetic document root: emit children.
            let kids = fetch_children(conn, node.id, budget)?;
            for k in &kids {
                build_xml(conn, k, out, indent, budget)?;
            }
        }
    }
    Ok(())
}

fn op_subtree(conn: &Connection, req: &Value) -> Result<Value, String> {
    let id = geti(req, "node", 1);
    let mut budget = geti(req, "budget", 50_000).clamp(100, 300_000);
    let format = meta_get(conn, "format").unwrap_or_else(|| "json".into());
    let node = fetch_node(conn, id)?;
    let mut out = String::new();
    let language;
    if format == "xml" && (node.kind == 6 || node.kind == 8 || node.kind == 1) {
        language = "xml";
        build_xml(conn, &node, &mut out, 0, &mut budget)?;
    } else {
        language = "json";
        build_json(conn, &node, &mut out, 0, &mut budget)?;
    }
    Ok(json!({"text": out, "language": language, "truncated": false}))
}

fn op_table(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let offset = geti(req, "offset", 0).max(0);
    let limit = geti(req, "limit", 100).clamp(1, 500);

    let (where_sql, binds) = build_filter_where(node, req);

    // Filtered row count (drives the virtual scroll height).
    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM nodes r WHERE {}", where_sql);
        let mut st = conn.prepare(&sql).map_err(es)?;
        st.query_row(params_from_iter(binds.iter()), |row| row.get(0)).map_err(es)?
    };

    // Optional numeric-aware sort by a column (its cell's ord). Numeric compare
    // first (non-numeric collapse to 0.0), then case-insensitive text tiebreak.
    let (join_sql, order_by) = match req.get("sort").filter(|s| s.is_object()) {
        Some(sort) => {
            let col = sort.get("col").and_then(|v| v.as_i64()).unwrap_or(-1);
            let dir = if sort.get("dir").and_then(|v| v.as_str()) == Some("desc") { "DESC" } else { "ASC" };
            if col >= 0 {
                (
                    format!("LEFT JOIN nodes sc ON sc.parent_id=r.id AND sc.ord={}", col),
                    format!("CAST(sc.value AS REAL) {}, sc.value COLLATE NOCASE {}", dir, dir),
                )
            } else {
                (String::new(), "r.ord".to_string())
            }
        }
        None => (String::new(), "r.ord".to_string()),
    };

    let mut row_ids: Vec<(i64, i64)> = Vec::new();
    {
        let sql = format!(
            "SELECT r.id, r.ord FROM nodes r {} WHERE {} ORDER BY {} LIMIT {} OFFSET {}",
            join_sql, where_sql, order_by, limit, offset
        );
        let mut st = conn.prepare(&sql).map_err(es)?;
        let mut rows = st.query(params_from_iter(binds.iter())).map_err(es)?;
        while let Some(row) = rows.next().map_err(es)? {
            row_ids.push((row.get(0).map_err(es)?, row.get(1).map_err(es)?));
        }
    }
    let mut st2 = conn
        .prepare_cached(
            "SELECT name, substr(value,1,4096) FROM nodes WHERE parent_id=?1 ORDER BY ord",
        )
        .map_err(es)?;
    let mut out: Vec<Value> = Vec::new();
    for (rid, ord) in row_ids {
        let mut cells: Vec<Value> = Vec::new();
        let mut cq = st2.query(params![rid]).map_err(es)?;
        while let Some(c) = cq.next().map_err(es)? {
            cells.push(json!({
                "name": c.get::<_, Option<String>>(0).map_err(es)?,
                "value": c.get::<_, Option<String>>(1).map_err(es)?,
            }));
        }
        out.push(json!({"id": rid, "ord": ord, "cells": cells}));
    }
    Ok(json!({"rows": out, "total": total}))
}

// Column coverage: distinct values of one column over the filtered rows, with
// counts (desc), plus distinct/total and optional numeric stats.
fn op_distinct(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let col = geti(req, "col", 0);
    let top = geti(req, "top", 1000).clamp(1, 100_000);
    let ci = req.get("ci").and_then(|v| v.as_bool()).unwrap_or(false);
    let trim = req.get("trim").and_then(|v| v.as_bool()).unwrap_or(false);
    let (where_sql, binds) = build_filter_where(node, req);

    let mut expr = String::from("c.value");
    if trim { expr = format!("TRIM({})", expr); }
    if ci { expr = format!("LOWER({})", expr); }
    let base = format!(
        "SELECT {} AS k FROM nodes r JOIN nodes c ON c.parent_id=r.id AND c.ord={} WHERE {}",
        expr, col, where_sql
    );

    let total_rows: i64 = {
        let sql = format!("SELECT COUNT(*) FROM nodes r WHERE {}", where_sql);
        conn.prepare(&sql).map_err(es)?.query_row(params_from_iter(binds.iter()), |r| r.get(0)).map_err(es)?
    };
    let distinct: i64 = {
        let sql = format!("SELECT COUNT(DISTINCT k) FROM ({})", base);
        conn.prepare(&sql).map_err(es)?.query_row(params_from_iter(binds.iter()), |r| r.get(0)).map_err(es)?
    };

    let mut items: Vec<Value> = Vec::new();
    {
        let sql = format!("SELECT k, COUNT(*) FROM ({}) GROUP BY k ORDER BY COUNT(*) DESC, k LIMIT {}", base, top);
        let mut st = conn.prepare(&sql).map_err(es)?;
        let mut rows = st.query(params_from_iter(binds.iter())).map_err(es)?;
        while let Some(row) = rows.next().map_err(es)? {
            items.push(json!({
                "value": row.get::<_, Option<String>>(0).map_err(es)?,
                "count": row.get::<_, i64>(1).map_err(es)?
            }));
        }
    }

    let numeric = {
        let sql = format!(
            "SELECT SUM(CASE WHEN k IS NOT NULL AND k<>'' THEN 1 ELSE 0 END), \
             SUM(CASE WHEN k GLOB '-[0-9]*' OR k GLOB '[0-9]*' OR k GLOB '.[0-9]*' THEN 1 ELSE 0 END), \
             MIN(CAST(k AS REAL)), MAX(CAST(k AS REAL)), AVG(CAST(k AS REAL)) FROM ({})",
            base
        );
        let row: (Option<i64>, Option<i64>, Option<f64>, Option<f64>, Option<f64>) =
            conn.prepare(&sql).map_err(es)?
                .query_row(params_from_iter(binds.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map_err(es)?;
        let nonempty = row.0.unwrap_or(0);
        let num = row.1.unwrap_or(0);
        if nonempty > 0 && (num as f64) / (nonempty as f64) >= 0.8 {
            json!({"min": row.2, "max": row.3, "mean": row.4})
        } else {
            Value::Null
        }
    };

    Ok(json!({"items": items, "total_rows": total_rows, "distinct": distinct, "numeric": numeric}))
}

// Whole-file profile: one entry per column with distinct / non_empty / empty /
// fill_% and the most common value.
fn op_profile(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let headers: Vec<String> = meta_get(conn, "csv_headers")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let total_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM nodes WHERE parent_id=?1", params![node], |r| r.get(0))
        .map_err(es)?;
    let mut cols: Vec<Value> = Vec::new();
    for (c, name) in headers.iter().enumerate() {
        let base = format!(
            "SELECT c.value AS v FROM nodes r JOIN nodes c ON c.parent_id=r.id AND c.ord={} WHERE r.parent_id={}",
            c, node
        );
        let (non_empty, distinct): (i64, i64) = conn
            .query_row(
                &format!("SELECT SUM(CASE WHEN v IS NULL OR v='' THEN 0 ELSE 1 END), COUNT(DISTINCT v) FROM ({})", base),
                [],
                |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get(1)?)),
            )
            .map_err(es)?;
        let top: (Option<String>, i64) = conn
            .query_row(
                &format!("SELECT v, COUNT(*) FROM ({}) WHERE v IS NOT NULL AND v<>'' GROUP BY v ORDER BY COUNT(*) DESC, v LIMIT 1", base),
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap_or((None, 0));
        cols.push(json!({
            "column": name, "distinct": distinct,
            "non_empty": non_empty, "empty": total_rows - non_empty,
            "top_value": top.0, "top_count": top.1
        }));
    }
    Ok(json!({"columns": cols, "total_rows": total_rows}))
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// Export the visible columns + filtered/sorted rows as CSV or JSON text (capped).
fn op_export(conn: &Connection, req: &Value) -> Result<Value, String> {
    let node = geti(req, "node", 1);
    let fmt = gets(req, "format", "csv");
    let cap: i64 = 2_000_000;
    let cols: Vec<(i64, String)> = req
        .get("cols")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let ord = c.get("ord").and_then(|v| v.as_i64())?;
                    Some((ord, c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let (where_sql, binds) = build_filter_where(node, req);
    let (join_sql, order_by) = match req.get("sort").filter(|s| s.is_object()) {
        Some(sort) => {
            let col = sort.get("col").and_then(|v| v.as_i64()).unwrap_or(-1);
            let dir = if sort.get("dir").and_then(|v| v.as_str()) == Some("desc") { "DESC" } else { "ASC" };
            if col >= 0 {
                (format!("LEFT JOIN nodes sc ON sc.parent_id=r.id AND sc.ord={}", col),
                 format!("CAST(sc.value AS REAL) {}, sc.value COLLATE NOCASE {}", dir, dir))
            } else { (String::new(), "r.ord".to_string()) }
        }
        None => (String::new(), "r.ord".to_string()),
    };

    let mut row_ids: Vec<i64> = Vec::new();
    {
        let sql = format!("SELECT r.id FROM nodes r {} WHERE {} ORDER BY {} LIMIT {}", join_sql, where_sql, order_by, cap);
        let mut st = conn.prepare(&sql).map_err(es)?;
        let mut rows = st.query(params_from_iter(binds.iter())).map_err(es)?;
        while let Some(row) = rows.next().map_err(es)? {
            row_ids.push(row.get(0).map_err(es)?);
        }
    }

    let mut cellq = conn.prepare_cached("SELECT ord, value FROM nodes WHERE parent_id=?1").map_err(es)?;
    let mut out = String::new();
    if fmt == "json" {
        out.push('[');
        for (ri, rid) in row_ids.iter().enumerate() {
            let mut map = std::collections::HashMap::new();
            let mut cq = cellq.query(params![rid]).map_err(es)?;
            while let Some(c) = cq.next().map_err(es)? {
                let ord: i64 = c.get(0).map_err(es)?;
                let v: Option<String> = c.get(1).map_err(es)?;
                map.insert(ord, v.unwrap_or_default());
            }
            if ri > 0 { out.push(','); }
            let mut obj = serde_json::Map::new();
            for (ord, name) in &cols {
                obj.insert(name.clone(), Value::String(map.get(ord).cloned().unwrap_or_default()));
            }
            out.push_str(&serde_json::to_string(&Value::Object(obj)).unwrap_or_default());
        }
        out.push(']');
    } else {
        out.push_str(&cols.iter().map(|(_, n)| csv_field(n)).collect::<Vec<_>>().join(","));
        out.push('\n');
        for rid in &row_ids {
            let mut map = std::collections::HashMap::new();
            let mut cq = cellq.query(params![rid]).map_err(es)?;
            while let Some(c) = cq.next().map_err(es)? {
                let ord: i64 = c.get(0).map_err(es)?;
                let v: Option<String> = c.get(1).map_err(es)?;
                map.insert(ord, v.unwrap_or_default());
            }
            out.push_str(&cols.iter().map(|(ord, _)| csv_field(map.get(ord).map(|s| s.as_str()).unwrap_or(""))).collect::<Vec<_>>().join(","));
            out.push('\n');
        }
    }
    Ok(json!({"text": out, "rows": row_ids.len() as i64, "truncated": row_ids.len() as i64 >= cap}))
}

// ==================================================================
// JSON Schema (draft-07) — inference and validation over the index
// ==================================================================

fn doc_root(conn: &Connection) -> i64 {
    meta_get(conn, "root_id").and_then(|s| s.parse().ok()).unwrap_or(1)
}

fn is_integer_text(v: &str) -> bool {
    !v.contains('.') && !v.contains('e') && !v.contains('E')
}

// ---------- generate ----------
fn op_schema(conn: &Connection, req: &Value) -> Result<Value, String> {
    let format = meta_get(conn, "format").unwrap_or_else(|| "json".into());
    if format == "xml" {
        return Err(String::from(
            "JSON Schema generation supports JSON, NDJSON and CSV documents",
        ));
    }
    let node = geti(req, "node", doc_root(conn));
    let mut budget: i64 = geti(req, "budget", 200_000);
    let info = fetch_node(conn, node)?;
    let mut schema = infer_schema(conn, &info, &mut budget)?;
    if let Value::Object(ref mut m) = schema {
        m.insert(
            "$schema".into(),
            json!("http://json-schema.org/draft-07/schema#"),
        );
    }
    Ok(json!({"schema": schema, "sampled": budget <= 0}))
}

fn infer_schema(conn: &Connection, n: &NodeRow, budget: &mut i64) -> Result<Value, String> {
    *budget -= 1;
    if *budget < 0 {
        return Ok(json!({}));
    }
    match n.kind {
        0 => {
            let kids = fetch_children_page(conn, n.id, 0, 1000)?;
            let mut props = serde_json::Map::new();
            let mut required: Vec<Value> = Vec::new();
            for k in &kids {
                let name = k.name.clone().unwrap_or_default();
                let sch = infer_schema(conn, k, budget)?;
                let merged = match props.get(&name) {
                    Some(prev) => merge_schema(prev.clone(), sch),
                    None => {
                        required.push(json!(name.clone()));
                        sch
                    }
                };
                props.insert(name, merged);
            }
            Ok(json!({"type": "object", "properties": props, "required": required}))
        }
        1 => {
            // Sample up to 100 elements — enough to capture heterogeneity.
            let kids = fetch_children_page(conn, n.id, 0, 100)?;
            let mut items: Option<Value> = None;
            for k in &kids {
                let sch = infer_schema(conn, k, budget)?;
                items = Some(match items {
                    Some(prev) => merge_schema(prev, sch),
                    None => sch,
                });
            }
            match items {
                Some(it) => Ok(json!({"type": "array", "items": it})),
                None => Ok(json!({"type": "array"})),
            }
        }
        2 => Ok(json!({"type": "string"})),
        3 => {
            if is_integer_text(n.value.as_deref().unwrap_or("")) {
                Ok(json!({"type": "integer"}))
            } else {
                Ok(json!({"type": "number"}))
            }
        }
        4 => Ok(json!({"type": "boolean"})),
        5 => Ok(json!({"type": "null"})),
        _ => Ok(json!({})),
    }
}

fn merge_schema(a: Value, b: Value) -> Value {
    if a == b {
        return a;
    }
    let mut out = serde_json::Map::new();
    let mut types: Vec<String> = Vec::new();
    for v in [&a, &b] {
        match v.get("type") {
            Some(Value::String(s)) => {
                if !types.contains(s) {
                    types.push(s.clone());
                }
            }
            Some(Value::Array(arr)) => {
                for x in arr {
                    if let Some(s) = x.as_str() {
                        if !types.iter().any(|y| y == s) {
                            types.push(s.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if types.iter().any(|t| t == "number") {
        types.retain(|t| t != "integer");
    }
    if types.len() == 1 {
        out.insert("type".into(), json!(types[0]));
    } else if !types.is_empty() {
        out.insert("type".into(), json!(types));
    }
    let ap = a.get("properties").cloned();
    let bp = b.get("properties").cloned();
    if ap.is_some() || bp.is_some() {
        let mut props = serde_json::Map::new();
        if let Some(Value::Object(m)) = ap.clone() {
            for (k, v) in m {
                props.insert(k, v);
            }
        }
        if let Some(Value::Object(m)) = bp.clone() {
            for (k, v) in m {
                let nv = match props.get(&k) {
                    Some(prev) => merge_schema(prev.clone(), v),
                    None => v,
                };
                props.insert(k, nv);
            }
        }
        out.insert("properties".into(), Value::Object(props));
        let reqs = |v: &Value| -> Vec<String> {
            v.get("required")
                .and_then(|r| r.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        let ra = reqs(&a);
        let rb = reqs(&b);
        let req: Vec<String> = if ap.is_some() && bp.is_some() {
            ra.into_iter().filter(|k| rb.contains(k)).collect()
        } else if ap.is_some() {
            ra
        } else {
            rb
        };
        if !req.is_empty() {
            out.insert("required".into(), json!(req));
        }
    }
    match (a.get("items"), b.get("items")) {
        (Some(x), Some(y)) => {
            out.insert("items".into(), merge_schema(x.clone(), y.clone()));
        }
        (Some(x), None) | (None, Some(x)) => {
            out.insert("items".into(), x.clone());
        }
        _ => {}
    }
    Value::Object(out)
}

// ---------- validate ----------
struct VState<'a> {
    conn: &'a Connection,
    root_schema: Value,
    errors: Vec<Value>,
    max_errors: usize,
    budget: i64,
    truncated: bool,
}

fn op_validate(conn: &Connection, req: &Value) -> Result<Value, String> {
    let format = meta_get(conn, "format").unwrap_or_else(|| "json".into());
    if format == "xml" {
        return Err(String::from(
            "JSON Schema validation supports JSON, NDJSON and CSV documents",
        ));
    }
    let schema = req
        .get("schema")
        .cloned()
        .ok_or_else(|| String::from("missing schema"))?;
    let node = geti(req, "node", doc_root(conn));
    let info = fetch_node(conn, node)?;
    let mut st = VState {
        conn,
        root_schema: schema.clone(),
        errors: Vec::new(),
        max_errors: 1000,
        budget: 2_000_000,
        truncated: false,
    };
    validate_value(&mut st, &info, "$", &schema, 0)?;
    let count = st.errors.len();
    Ok(json!({
        "errors": st.errors,
        "count": count,
        "truncated": st.truncated || count >= st.max_errors
    }))
}

fn push_err(st: &mut VState, path: &str, msg: String) {
    if st.errors.len() < st.max_errors {
        st.errors.push(json!({"path": path, "message": msg}));
    }
}

fn type_name_of(n: &NodeRow) -> &'static str {
    match n.kind {
        0 => "object",
        1 => "array",
        2 => "string",
        3 => "number",
        4 => "boolean",
        5 => "null",
        _ => "unknown",
    }
}

fn type_matches(n: &NodeRow, t: &str) -> bool {
    match t {
        "object" => n.kind == 0,
        "array" => n.kind == 1,
        "string" => n.kind == 2,
        "number" => n.kind == 3,
        "integer" => n.kind == 3 && is_integer_text(n.value.as_deref().unwrap_or("")),
        "boolean" => n.kind == 4,
        "null" => n.kind == 5,
        _ => true,
    }
}

fn is_scalar_kind(k: i64) -> bool {
    matches!(k, 2 | 3 | 4 | 5)
}

fn scalar_eq(n: &NodeRow, cand: &Value) -> bool {
    match cand {
        Value::Null => n.kind == 5,
        Value::Bool(b) => n.kind == 4 && (n.value.as_deref() == Some("true")) == *b,
        Value::Number(num) => {
            n.kind == 3
                && n.value
                    .as_deref()
                    .and_then(|v| v.parse::<f64>().ok())
                    .map(|x| Some(x) == num.as_f64())
                    .unwrap_or(false)
        }
        Value::String(s) => n.kind == 2 && n.value.as_deref() == Some(s.as_str()),
        _ => false,
    }
}

fn resolve_ref(st: &VState, schema: &Value) -> Value {
    if let Some(r) = schema.get("$ref").and_then(|v| v.as_str()) {
        if let Some(p) = r.strip_prefix("#/") {
            let mut cur = &st.root_schema;
            for seg in p.split('/') {
                let seg = seg.replace("~1", "/").replace("~0", "~");
                match cur.get(&seg) {
                    Some(v) => cur = v,
                    None => return schema.clone(),
                }
            }
            return cur.clone();
        }
    }
    schema.clone()
}

fn count_sub_errors(st: &mut VState, node: &NodeRow, path: &str, schema: &Value, depth: u32) -> usize {
    let saved = std::mem::take(&mut st.errors);
    let saved_max = st.max_errors;
    st.max_errors = 20;
    let ok = validate_value(st, node, path, schema, depth);
    let n = if ok.is_err() { 1 } else { st.errors.len() };
    st.errors = saved;
    st.max_errors = saved_max;
    n
}

fn validate_value(
    st: &mut VState,
    node: &NodeRow,
    path: &str,
    schema: &Value,
    depth: u32,
) -> Result<(), String> {
    if st.errors.len() >= st.max_errors || st.truncated || depth > 64 {
        return Ok(());
    }
    st.budget -= 1;
    if st.budget < 0 {
        st.truncated = true;
        return Ok(());
    }
    if let Value::Bool(b) = schema {
        if !*b {
            push_err(st, path, String::from("schema is 'false' — no value allowed here"));
        }
        return Ok(());
    }
    let resolved = resolve_ref(st, schema);
    let s = match resolved.as_object() {
        Some(o) => o,
        None => return Ok(()),
    };

    if let Some(tv) = s.get("type") {
        let ok = match tv {
            Value::String(x) => type_matches(node, x),
            Value::Array(arr) => arr
                .iter()
                .any(|x| x.as_str().map(|x| type_matches(node, x)).unwrap_or(false)),
            _ => true,
        };
        if !ok {
            push_err(st, path, format!("expected type {}, found {}", tv, type_name_of(node)));
        }
    }
    if let Some(en) = s.get("enum").and_then(|v| v.as_array()) {
        if is_scalar_kind(node.kind) && !en.iter().any(|c| scalar_eq(node, c)) {
            push_err(st, path, String::from("value is not one of the enum values"));
        }
    }
    if let Some(c) = s.get("const") {
        if is_scalar_kind(node.kind) && !scalar_eq(node, c) {
            push_err(st, path, String::from("value differs from const"));
        }
    }
    if node.kind == 2 {
        let len = node.value.as_deref().map(|v| v.chars().count()).unwrap_or(0) as i64;
        if let Some(m) = s.get("minLength").and_then(|v| v.as_i64()) {
            if len < m {
                push_err(st, path, format!("string length {} < minLength {}", len, m));
            }
        }
        if let Some(m) = s.get("maxLength").and_then(|v| v.as_i64()) {
            if len > m {
                push_err(st, path, format!("string length {} > maxLength {}", len, m));
            }
        }
    }
    if node.kind == 3 {
        if let Ok(x) = node.value.as_deref().unwrap_or("").parse::<f64>() {
            if let Some(m) = s.get("minimum").and_then(|v| v.as_f64()) {
                if x < m {
                    push_err(st, path, format!("{} < minimum {}", x, m));
                }
            }
            if let Some(m) = s.get("maximum").and_then(|v| v.as_f64()) {
                if x > m {
                    push_err(st, path, format!("{} > maximum {}", x, m));
                }
            }
            if let Some(m) = s.get("exclusiveMinimum").and_then(|v| v.as_f64()) {
                if x <= m {
                    push_err(st, path, format!("{} <= exclusiveMinimum {}", x, m));
                }
            }
            if let Some(m) = s.get("exclusiveMaximum").and_then(|v| v.as_f64()) {
                if x >= m {
                    push_err(st, path, format!("{} >= exclusiveMaximum {}", x, m));
                }
            }
            if let Some(m) = s.get("multipleOf").and_then(|v| v.as_f64()) {
                if m > 0.0 && ((x / m) - (x / m).round()).abs() > 1e-9 {
                    push_err(st, path, format!("{} is not a multiple of {}", x, m));
                }
            }
        }
    }
    if let Some(all) = s.get("allOf").and_then(|v| v.as_array()) {
        for sub in all {
            validate_value(st, node, path, sub, depth + 1)?;
        }
    }
    if let Some(any) = s.get("anyOf").and_then(|v| v.as_array()) {
        let passed = any
            .iter()
            .any(|sub| count_sub_errors(st, node, path, sub, depth + 1) == 0);
        if !passed {
            push_err(st, path, String::from("value does not match anyOf"));
        }
    }
    if let Some(one) = s.get("oneOf").and_then(|v| v.as_array()) {
        let passes = one
            .iter()
            .filter(|sub| count_sub_errors(st, node, path, sub, depth + 1) == 0)
            .count();
        if passes != 1 {
            push_err(st, path, format!("value matches {} of oneOf schemas (need exactly 1)", passes));
        }
    }
    if let Some(not) = s.get("not") {
        if count_sub_errors(st, node, path, not, depth + 1) == 0 {
            push_err(st, path, String::from("value must not match the 'not' schema"));
        }
    }

    if node.kind == 0 {
        if let Some(m) = s.get("minProperties").and_then(|v| v.as_i64()) {
            if node.n < m {
                push_err(st, path, format!("{} properties < minProperties {}", node.n, m));
            }
        }
        if let Some(m) = s.get("maxProperties").and_then(|v| v.as_i64()) {
            if node.n > m {
                push_err(st, path, format!("{} properties > maxProperties {}", node.n, m));
            }
        }
        let props = s.get("properties").and_then(|v| v.as_object());
        let addl = s.get("additionalProperties");
        let required: Vec<&str> = s
            .get("required")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let mut seen: Vec<String> = Vec::new();
        let mut offset: i64 = 0;
        loop {
            let kids = fetch_children_page(st.conn, node.id, offset, 2000)?;
            if kids.is_empty() {
                break;
            }
            offset += kids.len() as i64;
            for k in &kids {
                let name = k.name.clone().unwrap_or_default();
                if seen.len() < 100_000 {
                    seen.push(name.clone());
                }
                let child_path = format!("{}.{}", path, name);
                let mut matched = false;
                if let Some(p) = props {
                    if let Some(sub) = p.get(&name) {
                        matched = true;
                        validate_value(st, k, &child_path, sub, depth + 1)?;
                    }
                }
                if !matched {
                    match addl {
                        Some(Value::Bool(false)) => {
                            push_err(st, &child_path, String::from("additional property not allowed"));
                        }
                        Some(v) if v.is_object() => {
                            validate_value(st, k, &child_path, v, depth + 1)?;
                        }
                        _ => {}
                    }
                }
                if st.truncated || st.errors.len() >= st.max_errors {
                    return Ok(());
                }
            }
        }
        for r in required {
            if !seen.iter().any(|x| x == r) {
                push_err(st, path, format!("missing required property '{}'", r));
            }
        }
    } else if node.kind == 1 {
        if let Some(m) = s.get("minItems").and_then(|v| v.as_i64()) {
            if node.n < m {
                push_err(st, path, format!("{} items < minItems {}", node.n, m));
            }
        }
        if let Some(m) = s.get("maxItems").and_then(|v| v.as_i64()) {
            if node.n > m {
                push_err(st, path, format!("{} items > maxItems {}", node.n, m));
            }
        }
        if let Some(items) = s.get("items") {
            if items.is_object() || items.is_boolean() {
                let mut offset: i64 = 0;
                loop {
                    let kids = fetch_children_page(st.conn, node.id, offset, 2000)?;
                    if kids.is_empty() {
                        break;
                    }
                    for (i, k) in kids.iter().enumerate() {
                        let child_path = format!("{}[{}]", path, offset + i as i64);
                        validate_value(st, k, &child_path, items, depth + 1)?;
                        if st.truncated || st.errors.len() >= st.max_errors {
                            return Ok(());
                        }
                    }
                    offset += kids.len() as i64;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod table_tests {
    use super::*;
    use rusqlite::Connection;

    // Build a tiny CSV-like DB: root(1) with 3 rows, each having columns
    // a (text) at ord 0 and n (numeric-as-text) at ord 1.
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent_id INTEGER, ord INTEGER NOT NULL, \
             depth INTEGER, kind INTEGER NOT NULL, name TEXT, value TEXT, n_children INTEGER NOT NULL DEFAULT 0);\
             CREATE INDEX idx_np ON nodes(parent_id, ord);",
        )
        .unwrap();
        let rows = [(2i64, "apple", "3"), (3, "banana", "10"), (4, "cherry", "2")];
        conn.execute("INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(1,NULL,0,0,1,NULL,NULL)", []).unwrap();
        let mut cid = 5i64;
        for (i, (rid, a, n)) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(?1,1,?2,1,0,NULL,NULL)",
                params![rid, i as i64],
            ).unwrap();
            conn.execute("INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(?1,?2,0,2,2,'a',?3)", params![cid, rid, a]).unwrap();
            conn.execute("INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(?1,?2,1,2,2,'n',?3)", params![cid + 1, rid, n]).unwrap();
            cid += 2;
        }
        conn
    }

    fn first_a(res: &Value) -> String {
        res["rows"][0]["cells"][0]["value"].as_str().unwrap().to_string()
    }

    #[test]
    fn plain_window() {
        let c = fixture();
        let r = op_table(&c, &json!({"node":1,"offset":0,"limit":100})).unwrap();
        assert_eq!(r["total"].as_i64().unwrap(), 3);
        assert_eq!(first_a(&r), "apple"); // document order
    }

    #[test]
    fn numeric_sort_asc() {
        let c = fixture();
        let r = op_table(&c, &json!({"node":1,"sort":{"col":1,"dir":"asc"},"offset":0,"limit":100})).unwrap();
        // n: 3,10,2 -> asc numeric -> cherry(2), apple(3), banana(10)
        assert_eq!(first_a(&r), "cherry");
    }

    #[test]
    fn numeric_filter_gt() {
        let c = fixture();
        let r = op_table(&c, &json!({"node":1,"filters":[{"col":1,"op":"gt","value":"2"}],"offset":0,"limit":100})).unwrap();
        assert_eq!(r["total"].as_i64().unwrap(), 2); // 3 and 10
    }

    #[test]
    fn text_contains_filter() {
        let c = fixture();
        let r = op_table(&c, &json!({"node":1,"filters":[{"col":0,"op":"contains","value":"an"}],"offset":0,"limit":100})).unwrap();
        assert_eq!(r["total"].as_i64().unwrap(), 1); // banana
        assert_eq!(first_a(&r), "banana");
    }
}
