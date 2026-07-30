// serve_mem.rs — in-memory query server (hybrid mode, "like the previous app").
//
// For files that fit comfortably in RAM the file is memory-mapped and parsed
// once into oxj-core's flat structural index (24-byte nodes, byte offsets, no
// copies). Every op of the standard serve protocol is answered from that
// index: no ingest phase, no database on disk, parallel regex search.
//
// Protocol-compatible with serve.rs: meta, children, node, path, search,
// subtree, stats, table. Schema/validate/diff remain DB-mode features.
use oxj_core::model::{container_for, csv_unescape, json_unescape, xml_unescape};
use oxj_core::{
    parse, parse_csv, parse_xml, search_nodes, CsvOptions, Format, Index, Mapping, NodeKind,
    SearchScope, NIL,
};
use regex::bytes::RegexBuilder;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::Path;

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

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

struct Doc {
    map: Mapping,
    index: Index,
    format: Format,
    fmt_name: String,
    path: String,
}

impl Doc {
    fn window(&self, id: u32) -> &[u8] {
        let n = self.index.node(id);
        self.map.slice(n.offset(), n.len).unwrap_or(&[])
    }

    fn raw_text(&self, id: u32) -> String {
        lossy(self.window(id))
    }

    fn strip_quotes<'a>(w: &'a [u8]) -> &'a [u8] {
        if w.len() >= 2 && w[0] == b'"' && w[w.len() - 1] == b'"' {
            &w[1..w.len() - 1]
        } else {
            w
        }
    }

    fn scalar_value(&self, id: u32) -> String {
        let n = self.index.node(id);
        let w = self.window(id);
        match n.kind {
            NodeKind::String => match self.format {
                Format::Json => json_unescape(&lossy(Self::strip_quotes(w))),
                Format::Xml => xml_unescape(&lossy(w)),
                Format::Csv | Format::Tsv => csv_unescape(&lossy(w)),
            },
            NodeKind::Text => {
                if self.format == Format::Xml {
                    xml_unescape(&lossy(w))
                } else {
                    lossy(w)
                }
            }
            NodeKind::CData => lossy(w),
            NodeKind::Null => String::from("null"),
            _ => lossy(w),
        }
    }

    fn key_name(&self, id: u32) -> String {
        let w = self.window(id);
        match self.format {
            Format::Json => json_unescape(&lossy(Self::strip_quotes(w))),
            Format::Csv | Format::Tsv => csv_unescape(&lossy(w)),
            Format::Xml => lossy(w),
        }
    }

    // (kind code, name, value, n_children) for a display row, using the same
    // kind codes and drilled semantics as the SQLite schema.
    fn row_parts(&self, id: u32) -> (i64, Option<String>, Option<String>, i64) {
        let n = self.index.node(id);
        let count = |c: u32| self.index.child_count(c) as i64;
        match n.kind {
            NodeKind::Document => (1, None, None, count(id)),
            NodeKind::Object => (0, None, None, count(id)),
            NodeKind::Array => (1, None, None, count(id)),
            NodeKind::ElementOpen => (6, Some(self.raw_text(id)), None, count(id)),
            NodeKind::Attribute => {
                let v = n.first_child;
                let val = if v == NIL {
                    String::new()
                } else {
                    xml_unescape(&self.raw_text(v))
                };
                (7, Some(self.raw_text(id)), Some(val), 0)
            }
            NodeKind::Text | NodeKind::CData => (8, None, Some(self.scalar_value(id)), 0),
            NodeKind::Key => {
                let name = Some(self.key_name(id));
                let v = n.first_child;
                if v == NIL {
                    return (5, name, None, 0);
                }
                match self.index.node(v).kind {
                    NodeKind::Object => (0, name, None, count(v)),
                    NodeKind::Array => (1, name, None, count(v)),
                    NodeKind::Number => (3, name, Some(self.raw_text(v)), 0),
                    NodeKind::Bool => (4, name, Some(self.raw_text(v)), 0),
                    NodeKind::Null => (5, name, None, 0),
                    _ => (2, name, Some(self.scalar_value(v)), 0),
                }
            }
            NodeKind::Number => (3, None, Some(self.raw_text(id)), 0),
            NodeKind::Bool => (4, None, Some(self.raw_text(id)), 0),
            NodeKind::Null => (5, None, None, 0),
            _ => (2, None, Some(self.scalar_value(id)), 0),
        }
    }

    fn row_json(&self, id: u32, ord: i64, snippet: bool) -> Value {
        let (kind, name, value, n) = self.row_parts(id);
        let (val, vlen) = match value {
            None => (Value::Null, 0i64),
            Some(v) => {
                let chars = v.chars().count() as i64;
                let out = if snippet && chars > 4096 {
                    v.chars().take(4096).collect::<String>()
                } else {
                    v
                };
                (Value::String(out), chars)
            }
        };
        json!({
            "id": id as i64, "ord": ord, "kind": kind,
            "name": name, "value": val, "vlen": vlen, "n": n
        })
    }

    fn display_root(&self) -> u32 {
        let doc = self.index.root();
        if self.index.child_count(doc) == 1 {
            self.index.children(doc).next().unwrap_or(doc)
        } else {
            doc
        }
    }

    // The row that lists `id` among its display children.
    fn display_parent(&self, id: u32) -> Option<u32> {
        let p = self.index.node(id).parent;
        if p == NIL {
            return None;
        }
        match self.index.node(p).kind {
            NodeKind::Key | NodeKind::Attribute => Some(p),
            NodeKind::Object | NodeKind::Array | NodeKind::Document | NodeKind::ElementOpen => {
                let pp = self.index.node(p).parent;
                if pp != NIL
                    && matches!(
                        self.index.node(pp).kind,
                        NodeKind::Key | NodeKind::Attribute
                    )
                {
                    Some(pp)
                } else {
                    Some(p)
                }
            }
            _ => Some(p),
        }
    }

    fn ord_of(&self, parent_row: u32, child_row: u32) -> i64 {
        if let Some(c) = container_for(&self.index, parent_row) {
            for (i, ch) in self.index.children(c).enumerate() {
                if ch == child_row {
                    return i as i64;
                }
            }
        }
        0
    }

    // Map a raw match node to its display row (scalar under a Key -> the Key).
    fn match_row(&self, id: u32) -> u32 {
        match self.index.node(id).kind {
            NodeKind::String
            | NodeKind::Number
            | NodeKind::Bool
            | NodeKind::Null
            | NodeKind::Text
            | NodeKind::CData => {
                let p = self.index.node(id).parent;
                if p != NIL
                    && matches!(
                        self.index.node(p).kind,
                        NodeKind::Key | NodeKind::Attribute
                    )
                {
                    p
                } else {
                    id
                }
            }
            _ => id,
        }
    }
}

pub fn serve_mem(path: &str, fmt_arg: &str) -> Result<(), String> {
    let map = Mapping::open(Path::new(path)).map_err(|e| format!("cannot map file: {}", e))?;
    let lower = path.to_lowercase();
    let format = match fmt_arg {
        "xml" => Format::Xml,
        "csv" => Format::Csv,
        "tsv" => Format::Tsv,
        "json" | "ndjson" => Format::Json,
        _ => Format::from_path(Path::new(path)),
    };
    let fmt_name = match format {
        Format::Json => {
            if lower.ends_with(".ndjson") || lower.ends_with(".jsonl") {
                "ndjson"
            } else {
                "json"
            }
        }
        Format::Xml => "xml",
        Format::Csv => "csv",
        Format::Tsv => "tsv",
    }
    .to_string();

    let index = {
        let bytes = map.bytes();
        match format {
            Format::Json => parse(bytes).map_err(|e| e.to_string())?,
            Format::Xml => parse_xml(bytes).map_err(|e| e.to_string())?,
            Format::Csv => parse_csv(bytes, CsvOptions::default()),
            Format::Tsv => parse_csv(bytes, CsvOptions::tsv()),
        }
    };
    let doc = Doc {
        map,
        index,
        format,
        fmt_name,
        path: path.to_string(),
    };

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
        match handle(&doc, &req) {
            Ok(data) => emit(&json!({"id": id, "ok": true, "data": data})),
            Err(e) => emit(&json!({"id": id, "ok": false, "error": e})),
        }
    }
    Ok(())
}

fn handle(doc: &Doc, req: &Value) -> Result<Value, String> {
    match gets(req, "op", "") {
        "meta" => op_meta(doc),
        "children" => op_children(doc, req),
        "node" => op_node(doc, req),
        "path" => op_path(doc, req),
        "search" => op_search(doc, req),
        "subtree" => op_subtree(doc, req),
        "stats" => op_stats(doc, req),
        "table" => op_table(doc, req),
        "distinct" => op_distinct(doc, req),
        "profile" => op_profile(doc, req),
        "schema" | "validate" => Err(String::from(
            "this tool needs database mode (very large files); reopen via Engine Mode → Always Database",
        )),
        other => Err(format!("unknown op: {}", other)),
    }
}

fn node_arg(doc: &Doc, req: &Value, key: &str) -> Result<u32, String> {
    let v = geti(req, key, doc.display_root() as i64);
    if v < 0 || v as usize >= doc.index.len() {
        return Err(String::from("node not found"));
    }
    Ok(v as u32)
}

fn op_meta(doc: &Doc) -> Result<Value, String> {
    let mut m = serde_json::Map::new();
    m.insert("format".into(), json!(doc.fmt_name));
    m.insert("mode".into(), json!("memory"));
    m.insert("root_id".into(), json!(doc.display_root().to_string()));
    m.insert("total_nodes".into(), json!(doc.index.len().to_string()));
    m.insert("source_path".into(), json!(doc.path));
    m.insert("source_bytes".into(), json!(doc.map.len().to_string()));
    if matches!(doc.format, Format::Csv | Format::Tsv) {
        let root = doc.index.root();
        // Header names = the first record's key names.
        let headers: Vec<String> = doc
            .index
            .children(root)
            .next()
            .map(|rec| {
                doc.index
                    .children(rec)
                    .map(|k| doc.key_name(k))
                    .collect()
            })
            .unwrap_or_default();
        m.insert(
            "csv_headers".into(),
            json!(serde_json::to_string(&headers).unwrap_or_default()),
        );
    }
    Ok(Value::Object(m))
}

fn op_children(doc: &Doc, req: &Value) -> Result<Value, String> {
    let node = node_arg(doc, req, "node")?;
    let offset = geti(req, "offset", 0).max(0) as usize;
    let limit = geti(req, "limit", 200).clamp(1, 1000) as usize;
    let mut items: Vec<Value> = Vec::new();
    if let Some(c) = container_for(&doc.index, node) {
        for (i, ch) in doc
            .index
            .children(c)
            .skip(offset)
            .take(limit)
            .enumerate()
        {
            items.push(doc.row_json(ch, (offset + i) as i64, true));
        }
    }
    Ok(json!({"items": items}))
}

fn op_node(doc: &Doc, req: &Value) -> Result<Value, String> {
    let node = node_arg(doc, req, "node")?;
    let mut v = doc.row_json(node, 0, false);
    if let Some(o) = v.as_object_mut() {
        let parent = doc.display_parent(node).map(|p| p as i64);
        o.insert("parent_id".into(), json!(parent));
        o.insert("depth".into(), json!(0));
    }
    Ok(v)
}

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_' || c == '$').unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn op_path(doc: &Doc, req: &Value) -> Result<Value, String> {
    let node = node_arg(doc, req, "node")?;
    let root = doc.display_root();
    let mut chain: Vec<u32> = Vec::new();
    let mut cur = node;
    loop {
        chain.push(cur);
        if cur == root {
            break;
        }
        match doc.display_parent(cur) {
            Some(p) => cur = p,
            None => break,
        }
        if chain.len() > 8192 {
            return Err(String::from("path too deep"));
        }
    }
    chain.reverse();

    let is_xml = doc.format == Format::Xml;
    let mut path = String::new();
    if !is_xml {
        path.push('$');
    }
    let mut ancestors: Vec<Value> = Vec::new();
    for (i, &row) in chain.iter().enumerate() {
        let ord = if i == 0 {
            0
        } else {
            doc.ord_of(chain[i - 1], row)
        };
        ancestors.push(json!({"id": row as i64, "ord": ord}));
        if i == 0 {
            continue;
        }
        let kind = doc.index.node(row).kind;
        if is_xml {
            match kind {
                NodeKind::Attribute => {
                    path.push_str("/@");
                    path.push_str(&doc.raw_text(row));
                }
                NodeKind::Text | NodeKind::CData => path.push_str("/text()"),
                NodeKind::ElementOpen => {
                    path.push('/');
                    path.push_str(&doc.raw_text(row));
                }
                _ => path.push_str(&format!("[{}]", ord)),
            }
        } else if kind == NodeKind::Key {
            let name = doc.key_name(row);
            if is_ident(&name) {
                path.push('.');
                path.push_str(&name);
            } else {
                path.push_str(&format!(
                    "[{}]",
                    serde_json::to_string(&name).unwrap_or_default()
                ));
            }
        } else {
            path.push_str(&format!("[{}]", ord));
        }
    }
    Ok(json!({"path": path, "ancestors": ancestors, "root_id": root as i64}))
}

fn op_search(doc: &Doc, req: &Value) -> Result<Value, String> {
    let q = gets(req, "q", "");
    if q.is_empty() {
        return Err(String::from("empty query"));
    }
    let exact = req.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);
    let offset = geti(req, "offset", 0).max(0) as usize;
    let limit = geti(req, "limit", 100).clamp(1, 500) as usize;
    let scope = match gets(req, "scope", "all") {
        "keys" => SearchScope::Keys,
        "values" => SearchScope::Values,
        _ => SearchScope::All,
    };
    let re = RegexBuilder::new(&regex::escape(q))
        .case_insensitive(true)
        .unicode(false)
        .build()
        .map_err(|e| format!("bad pattern: {}", e))?;
    let raw = search_nodes(doc.map.bytes(), &re, scope, &doc.index);
    let mut rows: Vec<u32> = raw.iter().map(|&i| doc.match_row(i)).collect();
    rows.sort_unstable();
    rows.dedup();
    if exact {
        rows.retain(|&r| {
            let (_, name, value, _) = doc.row_parts(r);
            name.as_deref() == Some(q) || value.as_deref() == Some(q)
        });
    }
    let total = rows.len() as i64;
    let page: Vec<Value> = rows
        .iter()
        .skip(offset)
        .take(limit)
        .map(|&r| doc.row_json(r, 0, true))
        .collect();
    let has_more = (offset + page.len()) < rows.len();
    Ok(json!({"items": page, "hasMore": has_more, "indexed": true, "total": total}))
}

const SUBTREE_MAX_BYTES: u32 = 30 * 1024 * 1024;

// XML: element windows only cover the tag name, so markup must be rebuilt
// from the index. Raw windows are used for text/attribute values, keeping
// the original escaping intact.
fn build_xml_mem(doc: &Doc, id: u32, out: &mut String, indent: usize, budget: &mut i64) -> Result<(), String> {
    *budget -= 1;
    if *budget < 0 {
        return Err(String::from("subtree too large to render as source"));
    }
    if indent > 512 {
        return Err(String::from("subtree too deep"));
    }
    let n = doc.index.node(id);
    let pad = "  ".repeat(indent);
    match n.kind {
        NodeKind::Document => {
            for ch in doc.index.children(id) {
                build_xml_mem(doc, ch, out, indent, budget)?;
            }
        }
        NodeKind::ElementOpen => {
            let name = doc.raw_text(id);
            out.push_str(&pad);
            out.push('<');
            out.push_str(&name);
            let mut content: Vec<u32> = Vec::new();
            for ch in doc.index.children(id) {
                let c = doc.index.node(ch);
                if c.kind == NodeKind::Attribute {
                    *budget -= 1;
                    let av = c.first_child;
                    out.push(' ');
                    out.push_str(&doc.raw_text(ch));
                    out.push_str("=\"");
                    if av != NIL {
                        out.push_str(&doc.raw_text(av));
                    }
                    out.push('"');
                } else {
                    content.push(ch);
                }
            }
            if content.is_empty() {
                out.push_str("/>\n");
            } else if content.len() == 1
                && matches!(
                    doc.index.node(content[0]).kind,
                    NodeKind::Text | NodeKind::CData
                )
            {
                out.push('>');
                let c = content[0];
                if doc.index.node(c).kind == NodeKind::CData {
                    out.push_str("<![CDATA[");
                    out.push_str(&doc.raw_text(c));
                    out.push_str("]]>");
                } else {
                    out.push_str(doc.raw_text(c).trim());
                }
                out.push_str("</");
                out.push_str(&name);
                out.push_str(">\n");
            } else {
                out.push_str(">\n");
                for c in content {
                    build_xml_mem(doc, c, out, indent + 1, budget)?;
                }
                out.push_str(&pad);
                out.push_str("</");
                out.push_str(&name);
                out.push_str(">\n");
            }
        }
        NodeKind::Text => {
            out.push_str(&pad);
            out.push_str(doc.raw_text(id).trim());
            out.push('\n');
        }
        NodeKind::CData => {
            out.push_str(&pad);
            out.push_str("<![CDATA[");
            out.push_str(&doc.raw_text(id));
            out.push_str("]]>\n");
        }
        NodeKind::Attribute => {
            let av = n.first_child;
            out.push_str(&pad);
            out.push_str(&doc.raw_text(id));
            out.push_str("=\"");
            if av != NIL {
                out.push_str(&doc.raw_text(av));
            }
            out.push_str("\"\n");
        }
        _ => {}
    }
    Ok(())
}

// CSV: record windows are the raw line, so rows are presented as JSON
// objects ({header: value}) exactly like DB mode.
fn build_csv_json(doc: &Doc, id: u32, out: &mut String, indent: usize, budget: &mut i64) -> Result<(), String> {
    *budget -= 1;
    if *budget < 0 {
        return Err(String::from("subtree too large to render as source"));
    }
    let n = doc.index.node(id);
    let pad = "  ".repeat(indent + 1);
    let pad_end = "  ".repeat(indent);
    match n.kind {
        NodeKind::Document => {
            let kids: Vec<u32> = doc.index.children(id).collect();
            if kids.is_empty() {
                out.push_str("[]");
                return Ok(());
            }
            out.push_str("[\n");
            for (i, rec) in kids.iter().enumerate() {
                out.push_str(&pad);
                build_csv_json(doc, *rec, out, indent + 1, budget)?;
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push(']');
        }
        NodeKind::Object => {
            let kids: Vec<u32> = doc.index.children(id).collect();
            if kids.is_empty() {
                out.push_str("{}");
                return Ok(());
            }
            out.push_str("{\n");
            for (i, k) in kids.iter().enumerate() {
                *budget -= 1;
                out.push_str(&pad);
                out.push_str(&serde_json::to_string(&doc.key_name(*k)).unwrap_or_default());
                out.push_str(": ");
                let v = doc.index.node(*k).first_child;
                if v == NIL {
                    out.push_str("null");
                } else {
                    out.push_str(&serde_json::to_string(&doc.scalar_value(v)).unwrap_or_default());
                }
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push('}');
        }
        NodeKind::Key => {
            let v = n.first_child;
            if v == NIL {
                out.push_str("null");
            } else {
                out.push_str(&serde_json::to_string(&doc.scalar_value(v)).unwrap_or_default());
            }
        }
        _ => out.push_str(&serde_json::to_string(&doc.scalar_value(id)).unwrap_or_default()),
    }
    Ok(())
}

// Pretty-print JSON from the index using raw token windows: key order,
// escapes and number formatting stay exactly as authored.
fn build_json_mem(doc: &Doc, id: u32, out: &mut String, indent: usize, budget: &mut i64) -> Result<(), String> {
    *budget -= 1;
    if *budget < 0 {
        return Err(String::from("subtree too large to render as source"));
    }
    if indent > 512 {
        return Err(String::from("subtree too deep"));
    }
    let n = doc.index.node(id);
    let pad = "  ".repeat(indent + 1);
    let pad_end = "  ".repeat(indent);
    match n.kind {
        NodeKind::Document => {
            let kids: Vec<u32> = doc.index.children(id).collect();
            if kids.len() == 1 {
                build_json_mem(doc, kids[0], out, indent, budget)?;
            } else {
                out.push_str("[\n");
                for (i, k) in kids.iter().enumerate() {
                    out.push_str(&pad);
                    build_json_mem(doc, *k, out, indent + 1, budget)?;
                    if i + 1 < kids.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                out.push_str(&pad_end);
                out.push(']');
            }
        }
        NodeKind::Object => {
            let kids: Vec<u32> = doc.index.children(id).collect();
            if kids.is_empty() {
                out.push_str("{}");
                return Ok(());
            }
            out.push_str("{\n");
            for (i, k) in kids.iter().enumerate() {
                *budget -= 1;
                out.push_str(&pad);
                out.push_str(&doc.raw_text(*k)); // key window includes quotes
                out.push_str(": ");
                let v = doc.index.node(*k).first_child;
                if v == NIL {
                    out.push_str("null");
                } else {
                    build_json_mem(doc, v, out, indent + 1, budget)?;
                }
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push('}');
        }
        NodeKind::Array => {
            let kids: Vec<u32> = doc.index.children(id).collect();
            if kids.is_empty() {
                out.push_str("[]");
                return Ok(());
            }
            out.push_str("[\n");
            for (i, k) in kids.iter().enumerate() {
                out.push_str(&pad);
                build_json_mem(doc, *k, out, indent + 1, budget)?;
                if i + 1 < kids.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&pad_end);
            out.push(']');
        }
        NodeKind::Key => {
            let v = n.first_child;
            if v == NIL {
                out.push_str("null");
            } else {
                build_json_mem(doc, v, out, indent, budget)?;
            }
        }
        NodeKind::Null => out.push_str("null"),
        _ => out.push_str(&doc.raw_text(id)), // scalars: raw token (strings keep quotes)
    }
    Ok(())
}

fn op_subtree(doc: &Doc, req: &Value) -> Result<Value, String> {
    let node = node_arg(doc, req, "node")?;
    let mut budget = geti(req, "budget", 50_000).clamp(100, 300_000);

    // On budget exhaustion, show what was built plus a marker rather than
    // failing or dumping raw bytes — a formatted preview beats a wall of text.
    fn finish(mut out: String, res: Result<(), String>, lang: &str) -> Result<Value, String> {
        match res {
            Ok(()) => Ok(json!({"text": out, "language": lang, "truncated": false})),
            Err(e) if !out.is_empty() => {
                out.push_str("\n\n… truncated preview — select a smaller node to see its full source");
                let _ = e;
                Ok(json!({"text": out, "language": lang, "truncated": true}))
            }
            Err(e) => Err(e),
        }
    }

    // XML and CSV need reconstruction (their windows don't span subtrees).
    if doc.format == Format::Xml {
        let mut out = String::new();
        let r = build_xml_mem(doc, node, &mut out, 0, &mut budget);
        return finish(out, r, "xml");
    }
    if matches!(doc.format, Format::Csv | Format::Tsv) {
        let mut out = String::new();
        let r = build_csv_json(doc, node, &mut out, 0, &mut budget);
        return finish(out, r, "json");
    }

    // JSON: container windows cover the entire subtree — slice the source.
    let n = doc.index.node(node);
    let target = match n.kind {
        NodeKind::Key | NodeKind::Attribute => {
            let v = n.first_child;
            if v == NIL {
                return Ok(json!({"text": "null", "language": "json", "truncated": false}));
            }
            v
        }
        _ => node,
    };
    let t = doc.index.node(target);
    if t.len > SUBTREE_MAX_BYTES {
        // Too big to show raw — containers still get a formatted preview.
        if matches!(t.kind, NodeKind::Object | NodeKind::Array | NodeKind::Document) {
            let mut out = String::new();
            let r = build_json_mem(doc, target, &mut out, 0, &mut budget);
            return finish(out, r, "json");
        }
        return Err(String::from("subtree too large to render as source"));
    }
    let text = match t.kind {
        NodeKind::String => doc.raw_text(target), // includes quotes
        NodeKind::Null => String::from("null"),
        _ => doc.raw_text(target),
    };
    // Minified or line-delimited container (typical for API responses and
    // NDJSON-style dumps): rebuild pretty from the index. Properly formatted
    // sources keep their original layout.
    fn looks_minified(text: &str) -> bool {
        text.lines().take(200).any(|l| l.len() > 240)
    }
    if matches!(t.kind, NodeKind::Object | NodeKind::Array | NodeKind::Document)
        && text.len() > 120
        && looks_minified(&text)
    {
        let mut out = String::new();
        let r = build_json_mem(doc, target, &mut out, 0, &mut budget);
        return finish(out, r, "json");
    }
    Ok(json!({"text": text, "language": "json", "truncated": false}))
}

fn op_stats(doc: &Doc, req: &Value) -> Result<Value, String> {
    let node = node_arg(doc, req, "node")?;
    let mut kinds: std::collections::BTreeMap<&'static str, i64> = Default::default();
    let mut total: i64 = 0;
    let mut distinct: std::collections::HashSet<String> = Default::default();
    let mut ncount: i64 = 0;
    let mut nmin = f64::INFINITY;
    let mut nmax = f64::NEG_INFINITY;
    let mut nsum = 0f64;
    if let Some(c) = container_for(&doc.index, node) {
        for ch in doc.index.children(c).take(5_000_000) {
            let (kind, _name, value, _n) = doc.row_parts(ch);
            total += 1;
            let kname = match kind {
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
            *kinds.entry(kname).or_insert(0) += 1;
            if let Some(v) = value {
                if kind == 3 {
                    if let Ok(x) = v.parse::<f64>() {
                        ncount += 1;
                        nmin = nmin.min(x);
                        nmax = nmax.max(x);
                        nsum += x;
                    }
                }
                if distinct.len() < 100_000 {
                    distinct.insert(v);
                }
            }
        }
    }
    Ok(json!({
        "children": total,
        "kinds": kinds,
        "distinct_values": distinct.len() as i64,
        "numeric": {
            "count": ncount,
            "min": if ncount > 0 { Some(nmin) } else { None },
            "max": if ncount > 0 { Some(nmax) } else { None },
            "avg": if ncount > 0 { Some(nsum / ncount as f64) } else { None }
        }
    }))
}

fn parse_num(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(0.0)
}

// Numeric-aware sort key: numeric primary (non-numeric collapse to 0.0), then
// case-insensitive text — matches the DB engine's CAST-then-NOCASE ordering.
fn sort_key(s: &str) -> (f64, String) {
    (parse_num(s), s.to_lowercase())
}

// Does a cell value satisfy one filter (semantics match the SQL engine)?
fn cell_matches(cv: &str, op: &str, val: &str) -> bool {
    match op {
        "equals" => cv == val,
        "not-equals" => cv != val,
        "starts-with" => cv.to_lowercase().starts_with(&val.to_lowercase()),
        "gt" => parse_num(cv) > parse_num(val),
        "lt" => parse_num(cv) < parse_num(val),
        "between" => {
            let mut it = val.splitn(2, ',');
            let a = parse_num(it.next().unwrap_or("").trim());
            let b = parse_num(it.next().unwrap_or("").trim());
            let x = parse_num(cv);
            x >= a && x <= b
        }
        _ => cv.to_lowercase().contains(&val.to_lowercase()), // contains
    }
}

fn cell_value(doc: &Doc, rec: u32, col: usize) -> Option<String> {
    doc.index.children(rec).nth(col).and_then(|k| doc.row_parts(k).2)
}

// Column header names = the first record's key names (same as op_meta).
fn doc_headers(doc: &Doc) -> Vec<String> {
    let root = doc.index.root();
    doc.index
        .children(root)
        .next()
        .map(|rec| doc.index.children(rec).map(|k| doc.key_name(k)).collect())
        .unwrap_or_default()
}

// Apply the request's `filters` (AND) to a row list in place.
fn apply_filters(doc: &Doc, rows: &mut Vec<u32>, req: &Value) {
    let filters: Vec<(usize, String, String)> = req
        .get("filters")
        .and_then(|v| v.as_array())
        .map(|fs| {
            fs.iter()
                .filter_map(|f| {
                    let col = f.get("col").and_then(|v| v.as_i64())?;
                    if col < 0 { return None; }
                    Some((
                        col as usize,
                        f.get("op").and_then(|v| v.as_str()).unwrap_or("contains").to_string(),
                        f.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    if filters.is_empty() {
        return;
    }
    rows.retain(|&rec| {
        filters.iter().all(|(col, op, val)| {
            cell_matches(&cell_value(doc, rec, *col).unwrap_or_default(), op, val)
        })
    });
}

fn op_distinct(doc: &Doc, req: &Value) -> Result<Value, String> {
    use std::collections::HashMap;
    let col = geti(req, "col", 0).max(0) as usize;
    let top = geti(req, "top", 1000).clamp(1, 100_000) as usize;
    let ci = req.get("ci").and_then(|v| v.as_bool()).unwrap_or(false);
    let trim = req.get("trim").and_then(|v| v.as_bool()).unwrap_or(false);
    let root = doc.index.root();
    let mut rows: Vec<u32> = doc.index.children(root).collect();
    apply_filters(doc, &mut rows, req);
    let total_rows = rows.len() as i64;

    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut nonempty = 0i64;
    let mut numeric = 0i64;
    let (mut nmin, mut nmax, mut nsum) = (f64::INFINITY, f64::NEG_INFINITY, 0.0);
    for &rec in &rows {
        let mut k = cell_value(doc, rec, col).unwrap_or_default();
        if trim { k = k.trim().to_string(); }
        if ci { k = k.to_lowercase(); }
        if !k.is_empty() {
            nonempty += 1;
            if let Ok(f) = k.trim().parse::<f64>() {
                numeric += 1;
                nmin = nmin.min(f);
                nmax = nmax.max(f);
                nsum += f;
            }
        }
        *counts.entry(k).or_insert(0) += 1;
    }
    let distinct = counts.len() as i64;
    let mut pairs: Vec<(String, i64)> = counts.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    pairs.truncate(top);
    let items: Vec<Value> = pairs.into_iter().map(|(v, c)| json!({"value": v, "count": c})).collect();
    let num_block = if nonempty > 0 && (numeric as f64) / (nonempty as f64) >= 0.8 {
        json!({"min": nmin, "max": nmax, "mean": nsum / (numeric as f64)})
    } else {
        Value::Null
    };
    Ok(json!({"items": items, "total_rows": total_rows, "distinct": distinct, "numeric": num_block}))
}

fn op_profile(doc: &Doc, _req: &Value) -> Result<Value, String> {
    use std::collections::HashMap;
    let headers: Vec<String> = doc_headers(doc);
    let root = doc.index.root();
    let rows: Vec<u32> = doc.index.children(root).collect();
    let total_rows = rows.len() as i64;
    let mut cols: Vec<Value> = Vec::new();
    for (c, name) in headers.iter().enumerate() {
        let mut counts: HashMap<String, i64> = HashMap::new();
        let mut non_empty = 0i64;
        for &rec in &rows {
            let v = cell_value(doc, rec, c).unwrap_or_default();
            if !v.is_empty() {
                non_empty += 1;
                *counts.entry(v).or_insert(0) += 1;
            }
        }
        let distinct = counts.len() as i64;
        let (top_value, top_count) = counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
            .map(|(v, c)| (Value::String(v), c))
            .unwrap_or((Value::Null, 0));
        cols.push(json!({
            "column": name, "distinct": distinct,
            "non_empty": non_empty, "empty": total_rows - non_empty,
            "top_value": top_value, "top_count": top_count
        }));
    }
    Ok(json!({"columns": cols, "total_rows": total_rows}))
}

fn op_table(doc: &Doc, req: &Value) -> Result<Value, String> {
    let offset = geti(req, "offset", 0).max(0) as usize;
    let limit = geti(req, "limit", 100).clamp(1, 500) as usize;
    let root = doc.index.root();
    let mut rows: Vec<u32> = doc.index.children(root).collect();
    apply_filters(doc, &mut rows, req);

    // Optional numeric-aware sort.
    if let Some(sort) = req.get("sort").filter(|s| s.is_object()) {
        let col = sort.get("col").and_then(|v| v.as_i64()).unwrap_or(-1);
        if col >= 0 {
            let col = col as usize;
            let desc = sort.get("dir").and_then(|v| v.as_str()) == Some("desc");
            rows.sort_by(|&a, &b| {
                let ord = sort_key(&cell_value(doc, a, col).unwrap_or_default())
                    .partial_cmp(&sort_key(&cell_value(doc, b, col).unwrap_or_default()))
                    .unwrap_or(std::cmp::Ordering::Equal);
                if desc { ord.reverse() } else { ord }
            });
        }
    }

    let total = rows.len() as i64;
    let mut out: Vec<Value> = Vec::new();
    for (i, &rec) in rows.iter().skip(offset).take(limit).enumerate() {
        let cells: Vec<Value> = doc
            .index
            .children(rec)
            .map(|k| {
                let (_, name, value, _) = doc.row_parts(k);
                json!({"name": name, "value": value})
            })
            .collect();
        out.push(json!({"id": rec as i64, "ord": (offset + i) as i64, "cells": cells}));
    }
    Ok(json!({"rows": out, "total": total}))
}

#[cfg(test)]
mod table_filter_tests {
    use super::{cell_matches, sort_key};

    #[test]
    fn matches_ops() {
        assert!(cell_matches("banana", "contains", "AN")); // case-insensitive
        assert!(cell_matches("apple", "equals", "apple"));
        assert!(!cell_matches("apple", "equals", "Apple")); // equals is case-sensitive
        assert!(cell_matches("apple", "starts-with", "APP"));
        assert!(cell_matches("10", "gt", "2"));   // numeric, not lexicographic
        assert!(cell_matches("2", "lt", "10"));
        assert!(cell_matches("5", "between", "1,9"));
        assert!(!cell_matches("12", "between", "1,9"));
    }

    #[test]
    fn numeric_sort_key_order() {
        // "2" sorts before "10" numerically (lexicographic would reverse it)
        assert!(sort_key("2") < sort_key("10"));
        // non-numeric collapse to 0.0 then compare text
        assert!(sort_key("apple") < sort_key("banana"));
    }
}
