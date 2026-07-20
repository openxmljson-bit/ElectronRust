// Iterative (recursion-free) streaming JSON parser.
// A synthetic document root (id 1, kind array) is always created. Multiple
// top-level values (NDJSON / concatenated JSON) simply become additional
// children of the root, so .json and .ndjson share one code path.
use crate::db::{DbWriter, K_ARR, K_BOOL, K_NULL, K_NUM, K_OBJ, K_STR};
use crate::progress::Progress;
use crate::reader::{skip_ws, ByteReader};
use std::io::Read;

const MAX_DEPTH: usize = 512;

struct Frame {
    id: i64,
    is_obj: bool,
    count: i64,
}

enum St {
    Value,
    ObjKey,
    AfterValue,
}

fn err_at<R: Read>(r: &ByteReader<R>, msg: &str) -> String {
    format!("{} at byte {}", msg, r.consumed)
}

pub fn ingest<R: Read>(
    r: &mut ByteReader<R>,
    db: &mut DbWriter,
    prog: &mut Progress,
) -> Result<(u64, i64), String> {
    r.skip_bom();
    db.insert_node(1, None, 0, 0, K_ARR, None, None)?;
    let mut nodes: u64 = 1;
    let mut next_id: i64 = 2;
    let mut stack: Vec<Frame> = vec![Frame { id: 1, is_obj: false, count: 0 }];
    let mut pending_key: Option<String> = None;
    let mut st = St::Value;

    loop {
        match st {
            St::Value => {
                skip_ws(r);
                let b = match r.peek() {
                    Some(b) => b,
                    None => {
                        if stack.len() == 1 {
                            break;
                        }
                        return Err(err_at(r, "unexpected end of input"));
                    }
                };
                match b {
                    b'{' | b'[' => {
                        r.next_byte();
                        if stack.len() >= MAX_DEPTH {
                            return Err(err_at(r, "maximum nesting depth exceeded"));
                        }
                        let is_obj = b == b'{';
                        let kind = if is_obj { K_OBJ } else { K_ARR };
                        let id = next_id;
                        next_id += 1;
                        nodes += 1;
                        let (pid, ord) = {
                            let t = stack.last().unwrap();
                            (t.id, t.count)
                        };
                        let depth = stack.len() as i64;
                        let key = pending_key.take();
                        db.insert_node(id, Some(pid), ord, depth, kind, key.as_deref(), None)?;
                        stack.last_mut().unwrap().count += 1;
                        stack.push(Frame { id, is_obj, count: 0 });
                        st = if is_obj { St::ObjKey } else { St::Value };
                    }
                    b']' => {
                        // Empty array: `[` immediately followed by `]`.
                        let ok = stack.len() > 1 && {
                            let t = stack.last().unwrap();
                            !t.is_obj && t.count == 0
                        };
                        if !ok {
                            return Err(err_at(r, "unexpected ']'"));
                        }
                        r.next_byte();
                        let f = stack.pop().unwrap();
                        db.set_children(f.id, f.count)?;
                        st = St::AfterValue;
                    }
                    b'"' => {
                        let s = parse_string(r)?;
                        insert_scalar(db, &mut stack, &mut next_id, &mut nodes, &mut pending_key, K_STR, Some(&s))?;
                        st = St::AfterValue;
                    }
                    b't' => {
                        expect_lit(r, b"true")?;
                        insert_scalar(db, &mut stack, &mut next_id, &mut nodes, &mut pending_key, K_BOOL, Some("true"))?;
                        st = St::AfterValue;
                    }
                    b'f' => {
                        expect_lit(r, b"false")?;
                        insert_scalar(db, &mut stack, &mut next_id, &mut nodes, &mut pending_key, K_BOOL, Some("false"))?;
                        st = St::AfterValue;
                    }
                    b'n' => {
                        expect_lit(r, b"null")?;
                        insert_scalar(db, &mut stack, &mut next_id, &mut nodes, &mut pending_key, K_NULL, None)?;
                        st = St::AfterValue;
                    }
                    b'-' | b'0'..=b'9' => {
                        let s = parse_number(r)?;
                        insert_scalar(db, &mut stack, &mut next_id, &mut nodes, &mut pending_key, K_NUM, Some(&s))?;
                        st = St::AfterValue;
                    }
                    _ => return Err(err_at(r, "unexpected character")),
                }
                if nodes & 0x3FFF == 0 {
                    prog.tick(r.consumed, nodes);
                }
            }
            St::ObjKey => {
                skip_ws(r);
                match r.peek() {
                    Some(b'"') => {
                        let k = parse_string(r)?;
                        skip_ws(r);
                        if r.next_byte() != Some(b':') {
                            return Err(err_at(r, "expected ':' after object key"));
                        }
                        pending_key = Some(k);
                        st = St::Value;
                    }
                    Some(b'}') => {
                        r.next_byte();
                        let f = stack.pop().unwrap();
                        db.set_children(f.id, f.count)?;
                        st = St::AfterValue;
                    }
                    _ => return Err(err_at(r, "expected object key or '}'")),
                }
            }
            St::AfterValue => {
                if stack.len() == 1 {
                    // Document level: another top-level value may follow.
                    st = St::Value;
                    continue;
                }
                skip_ws(r);
                let is_obj = stack.last().unwrap().is_obj;
                match r.peek() {
                    Some(b',') => {
                        r.next_byte();
                        st = if is_obj { St::ObjKey } else { St::Value };
                    }
                    Some(b'}') if is_obj => {
                        r.next_byte();
                        let f = stack.pop().unwrap();
                        db.set_children(f.id, f.count)?;
                    }
                    Some(b']') if !is_obj => {
                        r.next_byte();
                        let f = stack.pop().unwrap();
                        db.set_children(f.id, f.count)?;
                    }
                    _ => return Err(err_at(r, "expected ',' or end of container")),
                }
            }
        }
    }

    let root_children = stack[0].count;
    db.set_children(1, root_children)?;
    prog.tick(r.consumed, nodes);
    Ok((nodes, root_children))
}

fn insert_scalar(
    db: &mut DbWriter,
    stack: &mut Vec<Frame>,
    next_id: &mut i64,
    nodes: &mut u64,
    pending_key: &mut Option<String>,
    kind: i64,
    val: Option<&str>,
) -> Result<(), String> {
    let id = *next_id;
    *next_id += 1;
    *nodes += 1;
    let (pid, ord) = {
        let t = stack.last().unwrap();
        (t.id, t.count)
    };
    let depth = stack.len() as i64;
    let key = pending_key.take();
    db.insert_node(id, Some(pid), ord, depth, kind, key.as_deref(), val)?;
    stack.last_mut().unwrap().count += 1;
    Ok(())
}

fn expect_lit<R: Read>(r: &mut ByteReader<R>, lit: &[u8]) -> Result<(), String> {
    for &c in lit {
        if r.next_byte() != Some(c) {
            return Err(err_at(r, "invalid literal"));
        }
    }
    Ok(())
}

fn read_hex4<R: Read>(r: &mut ByteReader<R>) -> Result<u32, String> {
    let mut v: u32 = 0;
    for _ in 0..4 {
        let b = r
            .next_byte()
            .ok_or_else(|| String::from("unterminated \\u escape"))?;
        let d = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            _ => return Err(err_at(r, "invalid \\u escape")),
        };
        v = v * 16 + d as u32;
    }
    Ok(v)
}

fn parse_string<R: Read>(r: &mut ByteReader<R>) -> Result<String, String> {
    r.next_byte(); // consume opening quote
    let mut out = String::new();
    loop {
        let b = match r.next_byte() {
            Some(b) => b,
            None => return Err(err_at(r, "unterminated string")),
        };
        match b {
            b'"' => return Ok(out),
            b'\\' => {
                let e = match r.next_byte() {
                    Some(e) => e,
                    None => return Err(err_at(r, "unterminated escape")),
                };
                match e {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let u = read_hex4(r)?;
                        if (0xD800..=0xDBFF).contains(&u) {
                            // High surrogate: expect \uXXXX low surrogate.
                            let mut done = false;
                            if r.peek() == Some(b'\\') {
                                r.next_byte();
                                if r.next_byte() == Some(b'u') {
                                    let lo = read_hex4(r)?;
                                    if (0xDC00..=0xDFFF).contains(&lo) {
                                        let c = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
                                        out.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
                                        done = true;
                                    }
                                }
                            }
                            if !done {
                                out.push('\u{FFFD}');
                            }
                        } else if (0xDC00..=0xDFFF).contains(&u) {
                            out.push('\u{FFFD}');
                        } else {
                            out.push(char::from_u32(u).unwrap_or('\u{FFFD}'));
                        }
                    }
                    _ => return Err(err_at(r, "invalid escape")),
                }
            }
            0x00..=0x7F => out.push(b as char),
            _ => {
                // Multi-byte UTF-8 sequence: collect continuation bytes.
                let need = if b >= 0xF0 {
                    3
                } else if b >= 0xE0 {
                    2
                } else {
                    1
                };
                let mut tmp: [u8; 4] = [b, 0, 0, 0];
                let mut got = 1usize;
                for _ in 0..need {
                    match r.peek() {
                        Some(nb) if nb & 0xC0 == 0x80 => {
                            tmp[got] = nb;
                            got += 1;
                            r.next_byte();
                        }
                        _ => break,
                    }
                }
                match std::str::from_utf8(&tmp[..got]) {
                    Ok(s) => out.push_str(s),
                    Err(_) => out.push('\u{FFFD}'),
                }
            }
        }
    }
}

fn parse_number<R: Read>(r: &mut ByteReader<R>) -> Result<String, String> {
    let mut s = String::new();
    while let Some(b) = r.peek() {
        match b {
            b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E' => {
                s.push(b as char);
                r.next_byte();
            }
            _ => break,
        }
    }
    if s.is_empty() || s == "-" {
        return Err(err_at(r, "invalid number"));
    }
    Ok(s)
}
