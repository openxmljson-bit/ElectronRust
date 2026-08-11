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

// ---------------------------------------------------------------------------
// Whole-document streaming conversion: JSON/NDJSON source -> JSON/XML/YAML/CSV.
//
// Reuses the same streaming reader as `project` (one array element / ndjson line
// at a time), so converting a multi-GB document never materialises it in memory
// — the output is written straight to a file. YAML sources arrive here already
// converted to a temp JSON by the host; CSV/TSV sources are handled by DuckDB.
// ---------------------------------------------------------------------------

fn ys(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// A YAML flow scalar. Anything that could be misread (looks numeric/boolean,
// has structural chars or leading/trailing space) is double-quoted via JSON,
// which is a valid YAML scalar too.
fn yaml_scalar(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            let risky = s.is_empty()
                || s.trim() != s.as_str()
                || s.parse::<f64>().is_ok()
                || matches!(
                    s.to_ascii_lowercase().as_str(),
                    "true" | "false" | "null" | "yes" | "no" | "~"
                )
                || s.chars()
                    .any(|c| ":#{}[]&*!|>'\"%@`,".contains(c) || c == '\n' || c == '\t');
            if risky {
                serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""))
            } else {
                s.clone()
            }
        }
        _ => String::new(),
    }
}

fn write_yaml<W: Write>(w: &mut W, v: &Value, indent: usize) -> Result<(), String> {
    let pad = "  ".repeat(indent);
    match v {
        Value::Array(a) => {
            if a.is_empty() {
                writeln!(w, "{}[]", pad).map_err(ys)?;
            }
            for it in a {
                if it.is_object() || it.is_array() {
                    writeln!(w, "{}-", pad).map_err(ys)?;
                    write_yaml(w, it, indent + 1)?;
                } else {
                    writeln!(w, "{}- {}", pad, yaml_scalar(it)).map_err(ys)?;
                }
            }
        }
        Value::Object(m) => {
            if m.is_empty() {
                writeln!(w, "{}{{}}", pad).map_err(ys)?;
            }
            for (k, val) in m {
                if val.is_object() || val.is_array() {
                    writeln!(w, "{}{}:", pad, k).map_err(ys)?;
                    write_yaml(w, val, indent + 1)?;
                } else {
                    writeln!(w, "{}{}: {}", pad, k, yaml_scalar(val)).map_err(ys)?;
                }
            }
        }
        _ => {
            writeln!(w, "{}{}", pad, yaml_scalar(v)).map_err(ys)?;
        }
    }
    Ok(())
}

fn xml_esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            _ => o.push(c),
        }
    }
    o
}

// A safe XML element name from an arbitrary key.
fn xml_name(k: &str) -> String {
    let n: String = k
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    match n.chars().next() {
        Some(c) if c.is_alphabetic() || c == '_' => n,
        _ => format!("_{}", n),
    }
}

fn write_xml<W: Write>(w: &mut W, v: &Value, name: &str, indent: usize) -> Result<(), String> {
    let pad = "  ".repeat(indent);
    let tag = xml_name(name);
    match v {
        Value::Array(a) => {
            for it in a {
                write_xml(w, it, name, indent)?;
            }
        }
        Value::Object(m) => {
            if m.is_empty() {
                writeln!(w, "{}<{}/>", pad, tag).map_err(ys)?;
                return Ok(());
            }
            writeln!(w, "{}<{}>", pad, tag).map_err(ys)?;
            for (k, val) in m {
                write_xml(w, val, k, indent + 1)?;
            }
            writeln!(w, "{}</{}>", pad, tag).map_err(ys)?;
        }
        Value::Null => {
            writeln!(w, "{}<{}></{}>", pad, tag, tag).map_err(ys)?;
        }
        other => {
            let s = match other {
                Value::String(s) => s.clone(),
                _ => other.to_string(),
            };
            writeln!(w, "{}<{}>{}</{}>", pad, tag, xml_esc(&s), tag).map_err(ys)?;
        }
    }
    Ok(())
}

fn csv_cell(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

struct ConvState {
    first: bool,
    header: Vec<String>,
    header_done: bool,
}

// Emit one top-level record (an array element or ndjson line) in the target
// format. CSV takes its column set from the first record's object keys.
fn emit_record<W: Write>(w: &mut W, to: &str, v: &Value, st: &mut ConvState) -> Result<(), String> {
    match to {
        "json" | "rawjson" => {
            if !st.first {
                w.write_all(b",\n").map_err(ys)?;
            }
            let s = serde_json::to_string_pretty(v).map_err(ys)?;
            w.write_all("  ".as_bytes()).map_err(ys)?;
            w.write_all(s.replace('\n', "\n  ").as_bytes()).map_err(ys)?;
        }
        "xml" => write_xml(w, v, "item", 1)?,
        "yaml" => {
            if v.is_object() || v.is_array() {
                writeln!(w, "-").map_err(ys)?;
                write_yaml(w, v, 1)?;
            } else {
                writeln!(w, "- {}", yaml_scalar(v)).map_err(ys)?;
            }
        }
        "csv" => {
            if !st.header_done {
                st.header = match v {
                    Value::Object(m) => m.keys().cloned().collect(),
                    _ => vec!["value".into()],
                };
                let hs: Vec<String> = st
                    .header
                    .iter()
                    .map(|h| csv_cell(&Value::String(h.clone())))
                    .collect();
                w.write_all(hs.join(",").as_bytes()).map_err(ys)?;
                w.write_all(b"\n").map_err(ys)?;
                st.header_done = true;
            }
            let row: Vec<String> = st
                .header
                .iter()
                .map(|h| {
                    let cell = match v {
                        Value::Object(m) => m.get(h).cloned().unwrap_or(Value::Null),
                        other => {
                            if st.header.len() == 1 {
                                other.clone()
                            } else {
                                Value::Null
                            }
                        }
                    };
                    csv_cell(&cell)
                })
                .collect();
            w.write_all(row.join(",").as_bytes()).map_err(ys)?;
            w.write_all(b"\n").map_err(ys)?;
        }
        _ => return Err(format!("unsupported target format: {}", to)),
    }
    st.first = false;
    Ok(())
}

pub fn run_convert(file: &str, format: &str, to: &str, out: &str) -> Result<(), String> {
    if !matches!(to, "json" | "rawjson" | "xml" | "yaml" | "csv") {
        return Err(format!("unsupported target format: {}", to));
    }
    let f = File::open(file).map_err(|e| format!("cannot open source: {e}"))?;
    let mut reader = BufReader::new(f);
    skip_bom(&mut reader);
    let fmt = detect_format(format, &mut reader)?;
    let mut outf =
        BufWriter::new(File::create(out).map_err(|e| format!("cannot create output: {e}"))?);
    emit(&json!({"event": "start", "total": Value::Null}));
    let mut records: u64 = 0;
    let mut st = ConvState {
        first: true,
        header: Vec::new(),
        header_done: false,
    };

    // A single top-level object is one value, not a stream of records.
    if let Fmt::JsonObject = fmt {
        let v: Value =
            serde_json::from_reader(&mut reader).map_err(|e| format!("parse error: {e}"))?;
        match to {
            "json" | "rawjson" => {
                let s = serde_json::to_string_pretty(&v).map_err(ys)?;
                outf.write_all(s.as_bytes()).map_err(ys)?;
            }
            "xml" => write_xml(&mut outf, &v, "root", 0)?,
            "yaml" => write_yaml(&mut outf, &v, 0)?,
            "csv" => emit_record(&mut outf, "csv", &v, &mut st)?,
            _ => unreachable!(),
        }
        records = 1;
        outf.flush().map_err(ys)?;
        emit(&json!({"event": "done", "records": records}));
        return Ok(());
    }

    // Array / NDJSON: prefix, one record at a time, suffix.
    match to {
        "json" | "rawjson" => outf.write_all(b"[\n").map_err(ys)?,
        "xml" => outf.write_all(b"<root>\n").map_err(ys)?,
        _ => {}
    }

    match fmt {
        Fmt::Ndjson => {
            let mut line = String::new();
            loop {
                line.clear();
                let n = reader.read_line(&mut line).map_err(ys)?;
                if n == 0 {
                    break;
                }
                let s = line.trim();
                if s.is_empty() {
                    continue;
                }
                let v: Value =
                    serde_json::from_str(s).map_err(|e| format!("line {}: {e}", records + 1))?;
                emit_record(&mut outf, to, &v, &mut st)?;
                records += 1;
                if records % 5000 == 0 {
                    emit(&json!({"event": "progress", "done": records, "total": Value::Null}));
                }
            }
        }
        Fmt::JsonArray => {
            for_each_array_element(&mut reader, |bytes| {
                let v: Value = serde_json::from_slice(bytes)
                    .map_err(|e| format!("element {}: {e}", records + 1))?;
                emit_record(&mut outf, to, &v, &mut st)?;
                records += 1;
                if records % 5000 == 0 {
                    emit(&json!({"event": "progress", "done": records, "total": Value::Null}));
                }
                Ok(())
            })?;
        }
        Fmt::JsonObject => unreachable!(),
    }

    match to {
        "json" | "rawjson" => outf.write_all(b"\n]\n").map_err(ys)?,
        "xml" => outf.write_all(b"</root>\n").map_err(ys)?,
        _ => {}
    }
    outf.flush().map_err(ys)?;
    emit(&json!({"event": "done", "records": records}));
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
