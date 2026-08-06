// XML ingest built on quick-xml (streaming pull parser, constant memory).
// Maps events onto the same node model as before: synthetic document root
// (K_ARR), elements (K_ELEM), attributes (K_ATTR), text/CDATA (K_TEXT).
// Comments, PIs, the XML declaration and DOCTYPE are skipped.
use crate::db::{DbWriter, K_ARR, K_ATTR, K_ELEM, K_TEXT};
use crate::progress::Progress;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::io::BufRead;

const MAX_DEPTH: usize = 512;

struct EFrame {
    id: i64,
    count: i64,
}

fn parent_info(stack: &[EFrame], doc_count: i64) -> (i64, i64) {
    match stack.last() {
        Some(f) => (f.id, f.count),
        None => (1, doc_count),
    }
}

fn bump(stack: &mut [EFrame], doc_count: &mut i64) {
    match stack.last_mut() {
        Some(f) => f.count += 1,
        None => *doc_count += 1,
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_element(
    e: &BytesStart,
    self_close: bool,
    db: &mut DbWriter,
    stack: &mut Vec<EFrame>,
    next_id: &mut i64,
    nodes: &mut u64,
    doc_count: &mut i64,
) -> Result<(), String> {
    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
    let (pid, ord) = parent_info(stack, *doc_count);
    let depth = stack.len() as i64 + 1;
    let id = *next_id;
    *next_id += 1;
    *nodes += 1;
    db.insert_node(id, Some(pid), ord, depth, K_ELEM, Some(&name), None)?;
    bump(stack, doc_count);
    // Attributes become K_ATTR children of the element.
    let mut acount: i64 = 0;
    for a in e.attributes().with_checks(false) {
        let a = a.map_err(|x| x.to_string())?;
        let aname = String::from_utf8_lossy(a.key.as_ref()).into_owned();
        let aval = a.unescape_value().map_err(|x| x.to_string())?;
        db.insert_node(*next_id, Some(id), acount, depth + 1, K_ATTR, Some(&aname), Some(&aval))?;
        *next_id += 1;
        *nodes += 1;
        acount += 1;
    }
    if self_close {
        db.set_children(id, acount)?;
    } else {
        if stack.len() >= MAX_DEPTH {
            return Err(String::from("maximum nesting depth exceeded"));
        }
        stack.push(EFrame { id, count: acount });
    }
    Ok(())
}

pub fn ingest<R: BufRead>(mut rdr: R, db: &mut DbWriter, prog: &mut Progress) -> Result<(u64, i64), String> {
    // Strip a leading UTF-8 BOM if present.
    {
        let head = rdr.fill_buf().map_err(|e| e.to_string())?;
        if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
            rdr.consume(3);
        }
    }
    let mut reader = Reader::from_reader(rdr);

    db.insert_node(1, None, 0, 0, K_ARR, None, None)?; // synthetic document root
    let mut nodes: u64 = 1;
    let mut next_id: i64 = 2;
    let mut stack: Vec<EFrame> = Vec::new();
    let mut doc_count: i64 = 0;
    let mut buf: Vec<u8> = Vec::new();

    loop {
        match reader.read_event_into(&mut buf).map_err(|e| e.to_string())? {
            Event::Start(e) => emit_element(&e, false, db, &mut stack, &mut next_id, &mut nodes, &mut doc_count)?,
            Event::Empty(e) => emit_element(&e, true, db, &mut stack, &mut next_id, &mut nodes, &mut doc_count)?,
            Event::End(_) => {
                let f = stack.pop().ok_or_else(|| String::from("unexpected closing tag"))?;
                db.set_children(f.id, f.count)?;
            }
            Event::Text(e) => {
                let t = e.unescape().map_err(|x| x.to_string())?;
                let trimmed = t.trim();
                if !trimmed.is_empty() {
                    let (pid, ord) = parent_info(&stack, doc_count);
                    let depth = stack.len() as i64 + 1;
                    db.insert_node(next_id, Some(pid), ord, depth, K_TEXT, None, Some(trimmed))?;
                    next_id += 1;
                    nodes += 1;
                    bump(&mut stack, &mut doc_count);
                }
            }
            Event::CData(e) => {
                let raw = String::from_utf8_lossy(&e).into_owned();
                if !raw.is_empty() {
                    let (pid, ord) = parent_info(&stack, doc_count);
                    let depth = stack.len() as i64 + 1;
                    db.insert_node(next_id, Some(pid), ord, depth, K_TEXT, None, Some(&raw))?;
                    next_id += 1;
                    nodes += 1;
                    bump(&mut stack, &mut doc_count);
                }
            }
            Event::Eof => break,
            _ => {} // Comment / PI / Decl / DocType — skipped
        }
        buf.clear();
        if nodes & 0x3FFF == 0 {
            prog.tick(reader.buffer_position() as u64, nodes);
        }
    }

    if !stack.is_empty() {
        return Err(String::from("unexpected end of file: unclosed element"));
    }
    db.set_children(1, doc_count)?;
    prog.tick(reader.buffer_position() as u64, nodes);
    Ok((nodes, doc_count))
}
