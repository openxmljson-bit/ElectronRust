// JSON DeepDive projection — stream the source file record-by-record and keep
// only the selected (array-transparent) field paths, writing a projected copy.
// Works on JSON (root array or object) and NDJSON without loading the whole
// document into memory. Progress + errors are emitted as JSONL on stdout.
//
// See docs/PROJECT_SUBCOMMAND.md for the full contract.

use serde_json::{json, Map, Value};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};

// One segment of a selected path: an object key, or an array-transparency step.
enum Seg {
    Key(String),
    Arr,
}

fn emit(v: &Value) {
    println!("{}", v);
    let _ = io::stdout().flush();
}

// Parse "items[].meta.sku" / "start" / "[\"a b\"].x" into segments.
fn parse_path(p: &str) -> Vec<Seg> {
    let b = p.as_bytes();
    let mut i = 0;
    let mut segs = Vec::new();
    while i < b.len() {
        match b[i] {
            b'.' => i += 1,
            b'[' => {
                if i + 1 < b.len() && b[i + 1] == b']' {
                    segs.push(Seg::Arr);
                    i += 2;
                } else {
                    let end = p[i..].find(']').map(|x| i + x).unwrap_or(b.len());
                    let inner = &p[i + 1..end];
                    let key = serde_json::from_str::<String>(inner).unwrap_or_else(|_| inner.to_string());
                    segs.push(Seg::Key(key));
                    i = end + 1;
                }
            }
            _ => {
                let start = i;
                while i < b.len() && b[i] != b'.' && b[i] != b'[' {
                    i += 1;
                }
                segs.push(Seg::Key(p[start..i].to_string()));
            }
        }
    }
    segs
}

// Keep only the selected paths within `val`. Mirrors the JS reference
// (renderer projectValue) and the fixtures in rust-engine/tests/fixtures.
fn project_value(val: &Value, specs: &[&[Seg]]) -> Option<Value> {
    // A path that ends here selects the whole value.
    if specs.iter().any(|s| s.is_empty()) {
        return Some(val.clone());
    }
    match val {
        Value::Array(arr) => {
            // Array-transparent: consume one Arr segment, apply the rest to each element.
            let next: Vec<&[Seg]> = specs
                .iter()
                .filter(|s| matches!(s.first(), Some(Seg::Arr)))
                .map(|s| &s[1..])
                .collect();
            if next.is_empty() {
                return None;
            }
            let mut out = Vec::new();
            for el in arr {
                if let Some(v) = project_value(el, &next) {
                    out.push(v);
                }
            }
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let for_k: Vec<&[Seg]> = specs
                    .iter()
                    .filter(|s| matches!(s.first(), Some(Seg::Key(kk)) if kk == k))
                    .map(|s| &s[1..])
                    .collect();
                if !for_k.is_empty() {
                    if let Some(r) = project_value(v, &for_k) {
                        out.insert(k.clone(), r);
                    }
                }
            }
            Some(Value::Object(out))
        }
        _ => None, // scalar with remaining segments → nothing to keep
    }
}

enum Fmt {
    Ndjson,
    JsonArray,
    JsonObject,
}

fn skip_bom<R: BufRead>(r: &mut R) {
    let has = {
        let b = r.fill_buf().unwrap_or(&[]);
        b.len() >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF
    };
    if has {
        let mut d = [0u8; 3];
        let _ = r.read_exact(&mut d);
    }
}

fn detect_format<R: BufRead>(fmt: &str, r: &mut R) -> Result<Fmt, String> {
    if fmt == "ndjson" {
        return Ok(Fmt::Ndjson);
    }
    // json / auto: peek first non-whitespace byte without consuming.
    let buf = r.fill_buf().map_err(|e| e.to_string())?;
    let mut i = 0;
    while i < buf.len() && (buf[i] as char).is_whitespace() {
        i += 1;
    }
    let c = buf.get(i).copied().unwrap_or(b'{');
    Ok(if c == b'[' { Fmt::JsonArray } else { Fmt::JsonObject })
}

fn is_blank(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| (*b as char).is_whitespace())
}

// Split a JSON array's top-level elements, invoking `f` with each element's raw
// bytes. Tracks nesting depth and string state so commas/brackets inside
// elements are not treated as separators. Streams one element at a time.
fn for_each_array_element<R: BufRead, F: FnMut(&[u8]) -> Result<(), String>>(
    r: &mut R,
    mut f: F,
) -> Result<(), String> {
    let mut cur: Vec<u8> = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut esc = false;
    let mut started = false;
    for byte in r.bytes() {
        let c = byte.map_err(|e| e.to_string())?;
        if !started {
            if c == b'[' {
                started = true;
            } else if (c as char).is_whitespace() {
                continue;
            } else {
                return Err("expected a JSON array".into());
            }
            continue;
        }
        if in_str {
            cur.push(c);
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        if depth == 0 {
            if c == b',' {
                if !is_blank(&cur) {
                    f(&cur)?;
                }
                cur.clear();
                continue;
            }
            if c == b']' {
                if !is_blank(&cur) {
                    f(&cur)?;
                }
                return Ok(());
            }
            if (c as char).is_whitespace() {
                if !cur.is_empty() {
                    cur.push(c);
                }
                continue;
            }
        }
        cur.push(c);
        match c {
            b'"' => in_str = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
    }
    if !is_blank(&cur) {
        f(&cur)?;
    }
    Ok(())
}

pub fn run_project(file: &str, format: &str, paths_file: &str, out: &str) -> Result<(), String> {
    let paths_txt = fs::read_to_string(paths_file).map_err(|e| format!("cannot read paths: {e}"))?;
    let paths: Vec<String> = serde_json::from_str(&paths_txt).map_err(|e| format!("bad paths file: {e}"))?;
    let parsed: Vec<Vec<Seg>> = paths.iter().map(|p| parse_path(p)).collect();
    let specs: Vec<&[Seg]> = parsed.iter().map(|v| v.as_slice()).collect();
    let kept = paths.len();

    let f = File::open(file).map_err(|e| format!("cannot open source: {e}"))?;
    let mut reader = BufReader::new(f);
    skip_bom(&mut reader);
    let fmt = detect_format(format, &mut reader)?;

    let mut outf = BufWriter::new(File::create(out).map_err(|e| format!("cannot create output: {e}"))?);
    emit(&json!({"event": "start", "total": Value::Null}));
    let mut records: u64 = 0;

    match fmt {
        Fmt::Ndjson => {
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                let s = line.trim();
                if s.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(s).map_err(|e| format!("line {}: {e}", records + 1))?;
                let pv = project_value(&v, &specs).unwrap_or_else(|| Value::Object(Map::new()));
                serde_json::to_writer(&mut outf, &pv).map_err(|e| e.to_string())?;
                outf.write_all(b"\n").map_err(|e| e.to_string())?;
                records += 1;
                if records % 5000 == 0 {
                    emit(&json!({"event": "progress", "done": records, "total": Value::Null}));
                }
            }
        }
        Fmt::JsonArray => {
            outf.write_all(b"[").map_err(|e| e.to_string())?;
            let mut first = true;
            for_each_array_element(&mut reader, |bytes| {
                let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("element {}: {e}", records + 1))?;
                if let Some(pv) = project_value(&v, &specs) {
                    if !first {
                        outf.write_all(b",").map_err(|e| e.to_string())?;
                    }
                    serde_json::to_writer(&mut outf, &pv).map_err(|e| e.to_string())?;
                    first = false;
                }
                records += 1;
                if records % 5000 == 0 {
                    emit(&json!({"event": "progress", "done": records, "total": Value::Null}));
                }
                Ok(())
            })?;
            outf.write_all(b"]").map_err(|e| e.to_string())?;
        }
        Fmt::JsonObject => {
            let v: Value = serde_json::from_reader(&mut reader).map_err(|e| format!("parse error: {e}"))?;
            let pv = project_value(&v, &specs).unwrap_or_else(|| Value::Object(Map::new()));
            serde_json::to_writer(&mut outf, &pv).map_err(|e| e.to_string())?;
            records = 1;
        }
    }

    outf.flush().map_err(|e| e.to_string())?;
    emit(&json!({"event": "done", "records": records, "kept": kept}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj(v: &Value, paths: &[&str]) -> Value {
        let parsed: Vec<Vec<Seg>> = paths.iter().map(|p| parse_path(p)).collect();
        let specs: Vec<&[Seg]> = parsed.iter().map(|v| v.as_slice()).collect();
        project_value(v, &specs).unwrap()
    }

    #[test]
    fn project_value_basic() {
        let v = json!({"a": {"b": 1, "c": 2}, "d": 3});
        assert_eq!(proj(&v, &["a.b", "d"]), json!({"a": {"b": 1}, "d": 3}));
    }

    #[test]
    fn project_value_array_transparent() {
        let v = json!({"items": [{"price": 1, "junk": 9}, {"price": 2}], "tags": ["a", "b"]});
        assert_eq!(
            proj(&v, &["items[].price", "tags[]"]),
            json!({"items": [{"price": 1}, {"price": 2}], "tags": ["a", "b"]})
        );
    }

    #[test]
    fn project_value_quoted_key_and_missing() {
        let v = json!({"a b": 1, "other": 2});
        assert_eq!(proj(&v, &["[\"a b\"]"]), json!({"a b": 1}));
        assert_eq!(proj(&json!({"a": 1}), &["a", "b.c"]), json!({"a": 1}));
    }

    // Shared fixtures — the same expected outputs the renderer's reference
    // projectValue is tested against (rust-engine/tests/fixtures/project_cases.json).
    #[test]
    fn fixtures_match() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/project_cases.json");
        let txt = std::fs::read_to_string(path).expect("read fixtures");
        let cases: Value = serde_json::from_str(&txt).unwrap();
        for c in cases.as_array().unwrap() {
            let paths: Vec<&str> = c["paths"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let got = proj(&c["value"], &paths);
            assert_eq!(&got, &c["expected"], "case {}", c["name"]);
        }
    }
}
