// Streaming RFC-4180 CSV/TSV parser. All cell values are stored as text so
// leading zeros (ZIP codes, IDs) are never corrupted.
use crate::db::{DbWriter, K_ARR, K_OBJ, K_STR};
use crate::progress::Progress;
use crate::reader::ByteReader;
use std::io::Read;

pub fn ingest<R: Read>(
    r: &mut ByteReader<R>,
    db: &mut DbWriter,
    prog: &mut Progress,
    delim: u8,
) -> Result<(u64, i64), String> {
    r.skip_bom();
    db.insert_node(1, None, 0, 0, K_ARR, None, None)?;
    let mut nodes: u64 = 1;
    let mut next_id: i64 = 2;
    let mut headers: Vec<String> = Vec::new();
    let mut row_count: i64 = 0;
    let mut first = true;

    loop {
        let rec = match read_record(r, delim)? {
            Some(x) => x,
            None => break,
        };
        if first {
            first = false;
            if looks_like_header(&rec) {
                headers = rec;
                db.put_meta(
                    "csv_headers",
                    &serde_json::to_string(&headers).unwrap_or_default(),
                )?;
                db.put_meta("csv_header_row", "1")?;
                continue;
            } else {
                headers = (1..=rec.len()).map(|i| format!("col_{}", i)).collect();
                db.put_meta(
                    "csv_headers",
                    &serde_json::to_string(&headers).unwrap_or_default(),
                )?;
                db.put_meta("csv_header_row", "0")?;
                // fall through: first record is data
            }
        }
        let row_id = next_id;
        next_id += 1;
        nodes += 1;
        db.insert_node(row_id, Some(1), row_count, 1, K_OBJ, None, None)?;
        for (i, cell) in rec.iter().enumerate() {
            // More cells than headers: extend headers on the fly.
            while i >= headers.len() {
                headers.push(format!("col_{}", headers.len() + 1));
            }
            let name = headers[i].clone();
            db.insert_node(
                next_id,
                Some(row_id),
                i as i64,
                2,
                K_STR,
                Some(&name),
                Some(cell),
            )?;
            next_id += 1;
            nodes += 1;
        }
        db.set_children(row_id, rec.len() as i64)?;
        row_count += 1;
        if row_count & 0xFFF == 0 {
            prog.tick(r.consumed, nodes);
        }
    }

    db.set_children(1, row_count)?;
    prog.tick(r.consumed, nodes);
    Ok((nodes, row_count))
}

fn bytes_to_string(v: Vec<u8>) -> String {
    match String::from_utf8(v) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

// Returns Ok(None) at end of input. Blank lines are skipped.
fn read_record<R: Read>(r: &mut ByteReader<R>, delim: u8) -> Result<Option<Vec<String>>, String> {
    loop {
        if r.peek().is_none() {
            return Ok(None);
        }
        let mut fields: Vec<String> = Vec::new();
        let mut field: Vec<u8> = Vec::new();
        let mut in_q = false;
        let mut any = false;
        loop {
            let b = match r.next_byte() {
                Some(b) => b,
                None => break, // EOF terminates the record
            };
            if in_q {
                if b == b'"' {
                    if r.peek() == Some(b'"') {
                        r.next_byte();
                        field.push(b'"');
                    } else {
                        in_q = false;
                    }
                } else {
                    field.push(b);
                }
            } else if b == b'"' && field.is_empty() {
                in_q = true;
                any = true;
            } else if b == delim {
                fields.push(bytes_to_string(std::mem::take(&mut field)));
                any = true;
            } else if b == b'\n' {
                break;
            } else if b == b'\r' {
                if r.peek() == Some(b'\n') {
                    r.next_byte();
                }
                break;
            } else {
                field.push(b);
            }
        }
        fields.push(bytes_to_string(field));
        if fields.len() == 1 && fields[0].is_empty() && !any {
            continue; // blank line
        }
        return Ok(Some(fields));
    }
}

fn looks_like_header(rec: &[String]) -> bool {
    if rec.is_empty() {
        return false;
    }
    if rec.iter().any(|f| f.trim().is_empty()) {
        return false;
    }
    // At least one field must be non-numeric.
    rec.iter().any(|f| f.trim().parse::<f64>().is_err())
}
