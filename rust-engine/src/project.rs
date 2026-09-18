// JSON DeepDive projection — stream the source file record-by-record and keep
// only the selected (array-transparent) field paths, writing a projected copy.
// Works on JSON (root array or object) and NDJSON without loading the whole
// document into memory. Progress + errors are emitted as JSONL on stdout.
//
// See docs/PROJECT_SUBCOMMAND.md for the full contract.

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
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

// ---- XML source (streaming) ------------------------------------------------
// XML has no streaming array like JSON; the records are the repeating child
// element (e.g. <item> in an RSS/Shopping feed). We find that element in a cheap
// first pass, then a second pass materialises one record at a time — so a feed
// of any size converts in constant memory, with no node cap.

// Merge a child into an element object, turning repeats into arrays. Mirrors the
// renderer's xmlTextToObj so JSON/CSV output matches the in-memory path.
fn xml_insert(obj: &mut Map<String, Value>, name: String, val: Value) {
    match obj.get_mut(&name) {
        Some(Value::Array(a)) => a.push(val),
        Some(slot) => {
            let old = slot.take();
            *slot = Value::Array(vec![old, val]);
        }
        None => {
            obj.insert(name, val);
        }
    }
}

// Attributes become "@name" keys. Escaping is decoded; malformed entities degrade
// to the raw bytes rather than failing the whole conversion.
fn xml_attrs(start: &BytesStart, obj: &mut Map<String, Value>) -> Result<(), String> {
    for a in start.attributes().with_checks(false) {
        let a = a.map_err(|e| e.to_string())?;
        let k = format!("@{}", String::from_utf8_lossy(a.key.as_ref()));
        let v = a
            .unescape_value()
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        xml_insert(obj, k, Value::String(v));
    }
    Ok(())
}

// Read one element's subtree into a Value. `start` is the already-read opening
// tag; consumes events up to and including its matching End. All leaf values are
// strings (XML is untyped), matching xmlTextToObj.
fn xml_read_element<R: BufRead>(reader: &mut Reader<R>, start: &BytesStart) -> Result<Value, String> {
    let mut obj = Map::new();
    xml_attrs(start, &mut obj)?;
    let mut text = String::new();
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                let child = xml_read_element(reader, &e)?;
                xml_insert(&mut obj, name, child);
            }
            Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                let mut cobj = Map::new();
                xml_attrs(&e, &mut cobj)?;
                let cv = if cobj.is_empty() {
                    Value::String(String::new())
                } else {
                    Value::Object(cobj)
                };
                xml_insert(&mut obj, name, cv);
            }
            Event::Text(e) => {
                let t = e
                    .unescape()
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(&e).into_owned());
                if !t.trim().is_empty() {
                    text.push_str(&t);
                }
            }
            Event::CData(e) => {
                text.push_str(&String::from_utf8_lossy(&e));
            }
            Event::End(_) => break,
            Event::Eof => return Err(String::from("unexpected end of file in element")),
            _ => {}
        }
        buf.clear();
    }
    let txt = text.trim().to_string();
    if obj.is_empty() {
        return Ok(Value::String(txt));
    }
    if !txt.is_empty() {
        obj.insert(String::from("#text"), Value::String(txt));
    }
    Ok(Value::Object(obj))
}

// Append a name to an ordered, de-duplicated column list.
fn push_unique(v: &mut Vec<String>, name: &str) {
    if !v.iter().any(|x| x == name) {
        v.push(name.to_string());
    }
}

// Pass 1: the record element is the shallowest element name that occurs more than
// once (ties broken by highest count). If nothing repeats, the whole document is
// a single record (its root element). Also collects, per element name, the ordered
// union of its attribute (@name) and direct-child columns — used to seed a
// complete CSV header so optional fields present on only some records aren't lost.
fn xml_scan(file: &str) -> Result<(usize, String, Vec<String>), String> {
    let f = File::open(file).map_err(|e| format!("cannot open source: {e}"))?;
    let mut r = BufReader::new(f);
    skip_bom(&mut r);
    let mut reader = Reader::from_reader(r);
    let mut buf = Vec::new();
    let mut depth = 0usize;
    let mut counts: HashMap<(usize, String), u64> = HashMap::new();
    let mut cols: HashMap<String, Vec<String>> = HashMap::new();
    let mut stack: Vec<String> = Vec::new();
    let mut first_root: Option<String> = None;
    // Record a child element / the element's attributes against their owners.
    fn note_element(
        name: &str,
        e: &BytesStart,
        stack: &[String],
        cols: &mut HashMap<String, Vec<String>>,
    ) -> Result<(), String> {
        if let Some(parent) = stack.last() {
            push_unique(cols.entry(parent.clone()).or_default(), name);
        }
        for a in e.attributes().with_checks(false) {
            let a = a.map_err(|x| x.to_string())?;
            let k = format!("@{}", String::from_utf8_lossy(a.key.as_ref()));
            push_unique(cols.entry(name.to_string()).or_default(), &k);
        }
        Ok(())
    }
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if depth == 0 && first_root.is_none() {
                    first_root = Some(name.clone());
                }
                note_element(&name, &e, &stack, &mut cols)?;
                *counts.entry((depth, name.clone())).or_insert(0) += 1;
                stack.push(name);
                depth += 1;
            }
            Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if depth == 0 && first_root.is_none() {
                    first_root = Some(name.clone());
                }
                note_element(&name, &e, &stack, &mut cols)?;
                *counts.entry((depth, name)).or_insert(0) += 1;
            }
            Event::End(_) => {
                stack.pop();
                depth = depth.saturating_sub(1);
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    let mut best: Option<(usize, String, u64)> = None;
    for ((d, name), c) in counts.into_iter() {
        if c <= 1 {
            continue;
        }
        let better = match &best {
            None => true,
            Some((bd, _, bc)) => d < *bd || (d == *bd && c > *bc),
        };
        if better {
            best = Some((d, name, c));
        }
    }
    let (depth, name) = match best {
        Some((d, name, _)) => (d, name),
        None => (0, first_root.unwrap_or_else(|| String::from("root"))),
    };
    let columns = cols.remove(&name).unwrap_or_default();
    Ok((depth, name, columns))
}

// Pass 2: stream the file and emit each record element in the target format.
fn convert_xml_stream<W: Write>(file: &str, to: &str, outf: &mut W) -> Result<u64, String> {
    let (rec_depth, rec_name, columns) = xml_scan(file)?;
    match to {
        "json" | "rawjson" => outf.write_all(b"[\n").map_err(ys)?,
        "xml" => outf.write_all(b"<root>\n").map_err(ys)?,
        _ => {}
    }
    let mut st = ConvState {
        first: true,
        header: Vec::new(),
        header_done: false,
    };
    // Seed CSV with the complete, ordered column set so records missing an optional
    // field still line up (emit_record derives the header from the first record
    // only when we leave it empty here, e.g. scalar records).
    if to == "csv" && !columns.is_empty() {
        st.header = columns;
        st.header_done = true;
        let hs: Vec<String> = st
            .header
            .iter()
            .map(|h| csv_cell(&Value::String(h.clone())))
            .collect();
        outf.write_all(hs.join(",").as_bytes()).map_err(ys)?;
        outf.write_all(b"\n").map_err(ys)?;
    }
    let mut records: u64 = 0;
    let f = File::open(file).map_err(|e| format!("cannot open source: {e}"))?;
    let mut r = BufReader::new(f);
    skip_bom(&mut r);
    let mut reader = Reader::from_reader(r);
    let mut buf = Vec::new();
    let mut depth = 0usize;
    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) => {
                let qn = e.name();
                let nm = String::from_utf8_lossy(qn.as_ref());
                if depth == rec_depth && &*nm == rec_name.as_str() {
                    let v = xml_read_element(&mut reader, &e)?;
                    emit_record(outf, to, &v, &mut st)?;
                    records += 1;
                    if records % 5000 == 0 {
                        emit(&json!({"event": "progress", "done": records, "total": Value::Null}));
                    }
                } else {
                    depth += 1;
                }
            }
            Event::Empty(e) => {
                let qn = e.name();
                let nm = String::from_utf8_lossy(qn.as_ref());
                if depth == rec_depth && &*nm == rec_name.as_str() {
                    let mut obj = Map::new();
                    xml_attrs(&e, &mut obj)?;
                    let v = if obj.is_empty() {
                        Value::String(String::new())
                    } else {
                        Value::Object(obj)
                    };
                    emit_record(outf, to, &v, &mut st)?;
                    records += 1;
                }
            }
            Event::End(_) => depth = depth.saturating_sub(1),
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    match to {
        "json" | "rawjson" => outf.write_all(b"\n]\n").map_err(ys)?,
        "xml" => outf.write_all(b"</root>\n").map_err(ys)?,
        _ => {}
    }
    Ok(records)
}

pub fn run_convert(file: &str, format: &str, to: &str, out: &str) -> Result<(), String> {
    if !matches!(to, "json" | "rawjson" | "xml" | "yaml" | "csv") {
        return Err(format!("unsupported target format: {}", to));
    }
    let f = File::open(file).map_err(|e| format!("cannot open source: {e}"))?;
    let mut reader = BufReader::new(f);
    skip_bom(&mut reader);
    // XML source → dedicated streaming path (records = the repeating element).
    let is_xml = format.eq_ignore_ascii_case("xml") || {
        let b = reader.fill_buf().map_err(|e| e.to_string())?;
        let mut i = 0;
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        b.get(i).copied() == Some(b'<')
    };
    if is_xml {
        let mut outf =
            BufWriter::new(File::create(out).map_err(|e| format!("cannot create output: {e}"))?);
        emit(&json!({"event": "start", "total": Value::Null}));
        match convert_xml_stream(file, to, &mut outf) {
            Ok(records) => {
                outf.flush().map_err(ys)?;
                emit(&json!({"event": "done", "records": records}));
                return Ok(());
            }
            Err(e) => return Err(e),
        }
    }
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
