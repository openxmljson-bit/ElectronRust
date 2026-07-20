// Streaming XML parser: elements, attributes, text, CDATA, comments,
// processing instructions and DOCTYPE (skipped). Iterative, bounded depth.
use crate::db::{DbWriter, K_ARR, K_ATTR, K_ELEM, K_TEXT};
use crate::progress::Progress;
use crate::reader::{skip_ws, ByteReader};
use std::io::Read;

const MAX_DEPTH: usize = 512;

struct EFrame {
    id: i64,
    name: String,
    count: i64,
}

fn err_at<R: Read>(r: &ByteReader<R>, msg: &str) -> String {
    format!("{} at byte {}", msg, r.consumed)
}

enum BangResult {
    Skip,
    Cdata(Vec<u8>),
}

pub fn ingest<R: Read>(
    r: &mut ByteReader<R>,
    db: &mut DbWriter,
    prog: &mut Progress,
) -> Result<(u64, i64), String> {
    r.skip_bom();
    db.insert_node(1, None, 0, 0, K_ARR, None, None)?; // synthetic document root
    let mut nodes: u64 = 1;
    let mut next_id: i64 = 2;
    let mut stack: Vec<EFrame> = Vec::new();
    let mut doc_count: i64 = 0;
    let mut text: Vec<u8> = Vec::new();

    loop {
        let b = match r.next_byte() {
            Some(b) => b,
            None => break,
        };
        if b != b'<' {
            text.push(b);
            continue;
        }
        flush_text(db, &mut stack, &mut next_id, &mut nodes, &mut doc_count, &mut text, false)?;
        match r.peek() {
            Some(b'/') => {
                r.next_byte();
                let name = read_name(r)?;
                skip_until_gt(r)?;
                let f = match stack.pop() {
                    Some(f) => f,
                    None => return Err(err_at(r, "unexpected closing tag")),
                };
                if f.name != name {
                    return Err(format!(
                        "mismatched closing tag </{}> (expected </{}>) at byte {}",
                        name, f.name, r.consumed
                    ));
                }
                db.set_children(f.id, f.count)?;
            }
            Some(b'?') => {
                r.next_byte();
                skip_pi(r)?;
            }
            Some(b'!') => {
                r.next_byte();
                match handle_bang(r)? {
                    BangResult::Skip => {}
                    BangResult::Cdata(raw) => {
                        if !raw.is_empty() {
                            let (pid, ord) = parent_info(&stack, doc_count);
                            let depth = stack.len() as i64 + 1;
                            let s = String::from_utf8_lossy(&raw).into_owned();
                            db.insert_node(next_id, Some(pid), ord, depth, K_TEXT, None, Some(&s))?;
                            next_id += 1;
                            nodes += 1;
                            bump_count(&mut stack, &mut doc_count);
                        }
                    }
                }
            }
            _ => {
                // Element start tag.
                let name = read_name(r)?;
                if name.is_empty() {
                    return Err(err_at(r, "malformed tag"));
                }
                let (pid, ord) = parent_info(&stack, doc_count);
                let depth = stack.len() as i64 + 1;
                let id = next_id;
                next_id += 1;
                nodes += 1;
                db.insert_node(id, Some(pid), ord, depth, K_ELEM, Some(&name), None)?;
                bump_count(&mut stack, &mut doc_count);
                let mut acount: i64 = 0;
                let self_close =
                    parse_attrs(r, db, id, depth + 1, &mut next_id, &mut nodes, &mut acount)?;
                if self_close {
                    db.set_children(id, acount)?;
                } else {
                    if stack.len() >= MAX_DEPTH {
                        return Err(err_at(r, "maximum nesting depth exceeded"));
                    }
                    stack.push(EFrame { id, name, count: acount });
                }
            }
        }
        if nodes & 0x3FFF == 0 {
            prog.tick(r.consumed, nodes);
        }
    }

    flush_text(db, &mut stack, &mut next_id, &mut nodes, &mut doc_count, &mut text, true)?;
    if !stack.is_empty() {
        return Err(format!(
            "unexpected end of file: unclosed element <{}>",
            stack.last().unwrap().name
        ));
    }
    db.set_children(1, doc_count)?;
    prog.tick(r.consumed, nodes);
    Ok((nodes, doc_count))
}

fn parent_info(stack: &[EFrame], doc_count: i64) -> (i64, i64) {
    match stack.last() {
        Some(t) => (t.id, t.count),
        None => (1, doc_count),
    }
}

fn bump_count(stack: &mut [EFrame], doc_count: &mut i64) {
    match stack.last_mut() {
        Some(t) => t.count += 1,
        None => *doc_count += 1,
    }
}

#[allow(clippy::too_many_arguments)]
fn flush_text(
    db: &mut DbWriter,
    stack: &mut Vec<EFrame>,
    next_id: &mut i64,
    nodes: &mut u64,
    doc_count: &mut i64,
    text: &mut Vec<u8>,
    _at_eof: bool,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    let ws_only = text
        .iter()
        .all(|&b| b == b' ' || b == b'\t' || b == b'\r' || b == b'\n');
    if !ws_only {
        let decoded = decode_entities(text);
        let trimmed = decoded.trim();
        if !trimmed.is_empty() {
            let (pid, ord) = parent_info(stack, *doc_count);
            let depth = stack.len() as i64 + 1;
            db.insert_node(*next_id, Some(pid), ord, depth, K_TEXT, None, Some(trimmed))?;
            *next_id += 1;
            *nodes += 1;
            bump_count(stack, doc_count);
        }
    }
    text.clear();
    Ok(())
}

fn read_name<R: Read>(r: &mut ByteReader<R>) -> Result<String, String> {
    let mut out: Vec<u8> = Vec::new();
    while let Some(b) = r.peek() {
        match b {
            b' ' | b'\t' | b'\r' | b'\n' | b'=' | b'>' | b'/' => break,
            _ => {
                out.push(b);
                r.next_byte();
            }
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn skip_until_gt<R: Read>(r: &mut ByteReader<R>) -> Result<(), String> {
    loop {
        match r.next_byte() {
            Some(b'>') => return Ok(()),
            Some(_) => {}
            None => return Err(String::from("unexpected end of file in tag")),
        }
    }
}

fn skip_pi<R: Read>(r: &mut ByteReader<R>) -> Result<(), String> {
    let mut prev = 0u8;
    loop {
        match r.next_byte() {
            Some(b'>') if prev == b'?' => return Ok(()),
            Some(b) => prev = b,
            None => return Err(String::from("unterminated processing instruction")),
        }
    }
}

fn handle_bang<R: Read>(r: &mut ByteReader<R>) -> Result<BangResult, String> {
    match r.peek() {
        Some(b'-') => {
            // Comment: <!-- ... -->
            r.next_byte();
            if r.next_byte() != Some(b'-') {
                return Err(err_at(r, "malformed comment"));
            }
            let mut dashes = 0u32;
            loop {
                match r.next_byte() {
                    Some(b'-') => dashes += 1,
                    Some(b'>') if dashes >= 2 => return Ok(BangResult::Skip),
                    Some(_) => dashes = 0,
                    None => return Err(String::from("unterminated comment")),
                }
            }
        }
        Some(b'[') => {
            // CDATA: <![CDATA[ ... ]]>
            for &c in b"[CDATA[" {
                if r.next_byte() != Some(c) {
                    return Err(err_at(r, "malformed CDATA section"));
                }
            }
            let mut raw: Vec<u8> = Vec::new();
            let mut brackets = 0usize;
            loop {
                match r.next_byte() {
                    Some(b']') => brackets += 1,
                    Some(b'>') if brackets >= 2 => {
                        // Extra ']' beyond the closing pair belong to content.
                        for _ in 0..brackets.saturating_sub(2) {
                            raw.push(b']');
                        }
                        return Ok(BangResult::Cdata(raw));
                    }
                    Some(b) => {
                        for _ in 0..brackets {
                            raw.push(b']');
                        }
                        brackets = 0;
                        raw.push(b);
                    }
                    None => return Err(String::from("unterminated CDATA section")),
                }
            }
        }
        _ => {
            // DOCTYPE or other declaration: skip, honoring [ ... ] internal subset.
            let mut depth: i64 = 0;
            loop {
                match r.next_byte() {
                    Some(b'[') => depth += 1,
                    Some(b']') => depth -= 1,
                    Some(b'>') if depth <= 0 => return Ok(BangResult::Skip),
                    Some(_) => {}
                    None => return Err(String::from("unterminated declaration")),
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_attrs<R: Read>(
    r: &mut ByteReader<R>,
    db: &mut DbWriter,
    parent: i64,
    depth: i64,
    next_id: &mut i64,
    nodes: &mut u64,
    count: &mut i64,
) -> Result<bool, String> {
    loop {
        skip_ws(r);
        match r.peek() {
            Some(b'>') => {
                r.next_byte();
                return Ok(false);
            }
            Some(b'/') => {
                r.next_byte();
                skip_ws(r);
                if r.next_byte() == Some(b'>') {
                    return Ok(true);
                }
                return Err(err_at(r, "malformed self-closing tag"));
            }
            Some(_) => {
                let name = read_name(r)?;
                if name.is_empty() {
                    return Err(err_at(r, "malformed attribute"));
                }
                skip_ws(r);
                let mut val = String::new();
                if r.peek() == Some(b'=') {
                    r.next_byte();
                    skip_ws(r);
                    let q = r.next_byte();
                    let qc = match q {
                        Some(b'"') => b'"',
                        Some(b'\'') => b'\'',
                        _ => return Err(err_at(r, "expected quoted attribute value")),
                    };
                    let mut raw: Vec<u8> = Vec::new();
                    loop {
                        match r.next_byte() {
                            Some(b) if b == qc => break,
                            Some(b) => raw.push(b),
                            None => return Err(String::from("unterminated attribute value")),
                        }
                    }
                    val = decode_entities(&raw);
                }
                db.insert_node(*next_id, Some(parent), *count, depth, K_ATTR, Some(&name), Some(&val))?;
                *next_id += 1;
                *nodes += 1;
                *count += 1;
            }
            None => return Err(String::from("unexpected end of file inside tag")),
        }
    }
}

fn decode_entities(raw: &[u8]) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(raw.len());
    let mut i = 0usize;
    while i < raw.len() {
        let b = raw[i];
        if b != b'&' {
            out.push(b);
            i += 1;
            continue;
        }
        // Find ';' within a reasonable distance.
        let mut end = 0usize;
        let mut j = i + 1;
        while j < raw.len() && j - i <= 12 {
            if raw[j] == b';' {
                end = j;
                break;
            }
            j += 1;
        }
        if end == 0 {
            out.push(b);
            i += 1;
            continue;
        }
        let ent = &raw[i + 1..end];
        let mut replaced = true;
        match ent {
            b"amp" => out.push(b'&'),
            b"lt" => out.push(b'<'),
            b"gt" => out.push(b'>'),
            b"quot" => out.push(b'"'),
            b"apos" => out.push(b'\''),
            _ => {
                if ent.first() == Some(&b'#') {
                    let body = &ent[1..];
                    let code: Option<u32> = if body.first() == Some(&b'x') || body.first() == Some(&b'X') {
                        u32::from_str_radix(&String::from_utf8_lossy(&body[1..]), 16).ok()
                    } else {
                        String::from_utf8_lossy(body).parse::<u32>().ok()
                    };
                    match code.and_then(char::from_u32) {
                        Some(c) => {
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                        }
                        None => replaced = false,
                    }
                } else {
                    replaced = false;
                }
            }
        }
        if replaced {
            i = end + 1;
        } else {
            out.push(b'&');
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
