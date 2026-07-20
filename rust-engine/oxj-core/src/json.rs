//! JSON / JSON-Lines / NDJSON parser (SPEC §7.1).
//!
//! An iterative state machine over an explicit mode stack — no recursion —
//! so deeply nested input cannot overflow the call stack. Single pass,
//! allocation-free per token; tokens are recorded as (offset, len) windows.
//!
//! The document root accepts one or more whitespace-separated top-level
//! values, so `{…}\n{…}\n` yields a root with one Object child per line.
//!
//! An object member is a `Key` container (window = the `"key"` token
//! including quotes) that owns its value as its single child.
//!
//! Escape sequences (`\u` and friends) are deliberately left raw in the
//! index and only interpreted for display (SPEC §2.2).

use crate::index::{Index, IndexBuilder, NodeKind, MAX_DEPTH};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub offset: u64,
    pub message: String,
}

impl ParseError {
    fn new(offset: usize, message: &str) -> ParseError {
        ParseError {
            offset: offset as u64,
            message: message.to_string(),
        }
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for ParseError {}

/// Parser modes (SPEC §7.1). One slot per open container; the slot cycles
/// through the container's expectation states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Bottom of the stack: expect a top-level value (one or more allowed).
    RootValues,
    /// Expect a value or `]` (array start — empty allowed).
    ArrValue,
    /// Expect a value only (just after a comma — `]` here is a trailing comma).
    ArrValueOnly,
    /// Expect `,` or `]`.
    ArrComma,
    /// Expect a key string or `}` (object start — empty allowed).
    ObjKey,
    /// Expect a key string only (just after a comma — `}` is a trailing comma).
    ObjKeyOnly,
    /// Expect `,` or `}`.
    ObjComma,
    /// Expect `:` after a key.
    KeyColon,
    /// Expect the member value.
    KeyValue,
}

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline]
fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

/// Scan a string token starting at the opening quote; returns the exclusive
/// end (one past the closing quote). Honors `\"` and `\\`; does not decode.
pub(crate) fn scan_string(bytes: &[u8], start: usize) -> Result<usize, ParseError> {
    debug_assert_eq!(bytes[start], b'"');
    let n = bytes.len();
    let mut i = start + 1;
    // SIMD (memchr2, SSE2/AVX2/NEON) jumps straight to the next `"` or `\`
    // instead of inspecting every byte — string interiors are usually the
    // bulk of JSON. Behaviour is identical to the scalar scan: on `\` we skip
    // the backslash and its escaped byte (so `\"` never closes the string);
    // a trailing `\` at EOF falls through to "unterminated".
    while i < n {
        match memchr::memchr2(b'"', b'\\', &bytes[i..n]) {
            Some(off) => {
                let j = i + off;
                if bytes[j] == b'"' {
                    return Ok(j + 1);
                }
                i = j + 2; // skip `\` and the escaped byte (may reach n or n+1)
            }
            None => break,
        }
    }
    Err(ParseError::new(start, "unterminated string"))
}

/// Scan a number token per the JSON numeric grammar; returns the exclusive
/// end. Rejects leading zeros (`01`), bare fractions (`1.`, `.5`) and signs
/// (`+1`).
pub(crate) fn scan_number(bytes: &[u8], start: usize) -> Result<usize, ParseError> {
    let n = bytes.len();
    let mut i = start;
    if i < n && bytes[i] == b'-' {
        i += 1;
    }
    if i >= n || !is_digit(bytes[i]) {
        return Err(ParseError::new(start, "invalid number"));
    }
    if bytes[i] == b'0' {
        i += 1;
    } else {
        while i < n && is_digit(bytes[i]) {
            i += 1;
        }
    }
    if i < n && bytes[i] == b'.' {
        i += 1;
        if i >= n || !is_digit(bytes[i]) {
            return Err(ParseError::new(start, "invalid number"));
        }
        while i < n && is_digit(bytes[i]) {
            i += 1;
        }
    }
    if i < n && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < n && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        if i >= n || !is_digit(bytes[i]) {
            return Err(ParseError::new(start, "invalid number"));
        }
        while i < n && is_digit(bytes[i]) {
            i += 1;
        }
    }
    Ok(i)
}

/// True if `bytes` is exactly one JSON number token (used by the CSV typer).
pub(crate) fn is_number_token(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    match scan_number(bytes, 0) {
        Ok(end) => end == bytes.len(),
        Err(_) => false,
    }
}

fn len32(start: usize, end: usize, at: usize) -> Result<u32, ParseError> {
    u32::try_from(end - start).map_err(|_| ParseError::new(at, "token exceeds 4 GiB"))
}

/// Parse JSON / JSON-Lines / NDJSON into a structural index.
pub fn parse(bytes: &[u8]) -> Result<Index, ParseError> {
    let n = bytes.len();
    let mut pos = 0usize;
    // Skip a leading UTF-8 BOM.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        pos = 3;
    }

    let mut builder = IndexBuilder::new();
    let mut modes: Vec<Mode> = vec![Mode::RootValues];
    let mut root_values = 0usize;
    // End offset of the last completed top-level value; consecutive
    // top-level values must be whitespace-separated (so `01` cannot parse
    // as two adjacent values 0 and 1).
    let mut last_root_end = usize::MAX;

    // Called after a complete value: advance the owning container's mode.
    // `end` is the exclusive end offset of the value just parsed.
    #[inline]
    fn value_done(
        modes: &mut [Mode],
        builder: &mut IndexBuilder,
        end: usize,
        root_values: &mut usize,
        last_root_end: &mut usize,
    ) {
        let top = modes.last_mut().expect("mode stack never empty");
        match *top {
            Mode::RootValues => {
                *root_values += 1;
                *last_root_end = end;
            }
            Mode::ArrValue | Mode::ArrValueOnly => *top = Mode::ArrComma,
            Mode::KeyValue => {
                builder.pop(); // close the Key container (window preserved)
                *top = Mode::ObjComma;
            }
            _ => unreachable!("value completed in non-value mode"),
        }
    }

    macro_rules! done {
        ($end:expr) => {
            value_done(
                &mut modes,
                &mut builder,
                $end,
                &mut root_values,
                &mut last_root_end,
            )
        };
    }

    loop {
        while pos < n && is_ws(bytes[pos]) {
            pos += 1;
        }
        if pos >= n {
            break;
        }
        let c = bytes[pos];
        let mode = *modes.last().unwrap();

        // Modes that expect a value.
        let expects_value = matches!(
            mode,
            Mode::RootValues | Mode::ArrValue | Mode::ArrValueOnly | Mode::KeyValue
        );

        if expects_value {
            // `]` handling for arrays.
            if c == b']' {
                match mode {
                    Mode::ArrValue => {
                        builder.close(pos as u64 + 1);
                        modes.pop();
                        pos += 1;
                        done!(pos);
                        continue;
                    }
                    Mode::ArrValueOnly => {
                        return Err(ParseError::new(pos, "trailing comma"));
                    }
                    _ => return Err(ParseError::new(pos, "unexpected ']'")),
                }
            }
            if mode == Mode::RootValues && root_values > 0 && pos == last_root_end {
                return Err(ParseError::new(
                    pos,
                    "expected whitespace between top-level values",
                ));
            }
            match c {
                b'{' => {
                    if builder.depth() >= MAX_DEPTH {
                        return Err(ParseError::new(pos, "nesting too deep"));
                    }
                    builder.open(NodeKind::Object, pos as u64);
                    modes.push(Mode::ObjKey);
                    pos += 1;
                }
                b'[' => {
                    if builder.depth() >= MAX_DEPTH {
                        return Err(ParseError::new(pos, "nesting too deep"));
                    }
                    builder.open(NodeKind::Array, pos as u64);
                    modes.push(Mode::ArrValue);
                    pos += 1;
                }
                b'"' => {
                    let end = scan_string(bytes, pos)?;
                    builder.leaf(NodeKind::String, pos as u64, len32(pos, end, pos)?);
                    pos = end;
                    done!(pos);
                }
                b'-' | b'0'..=b'9' => {
                    let end = scan_number(bytes, pos)?;
                    builder.leaf(NodeKind::Number, pos as u64, len32(pos, end, pos)?);
                    pos = end;
                    done!(pos);
                }
                b't' => {
                    if bytes[pos..].starts_with(b"true") {
                        builder.leaf(NodeKind::Bool, pos as u64, 4);
                        pos += 4;
                        done!(pos);
                    } else {
                        return Err(ParseError::new(pos, "invalid literal"));
                    }
                }
                b'f' => {
                    if bytes[pos..].starts_with(b"false") {
                        builder.leaf(NodeKind::Bool, pos as u64, 5);
                        pos += 5;
                        done!(pos);
                    } else {
                        return Err(ParseError::new(pos, "invalid literal"));
                    }
                }
                b'n' => {
                    if bytes[pos..].starts_with(b"null") {
                        builder.leaf(NodeKind::Null, pos as u64, 4);
                        pos += 4;
                        done!(pos);
                    } else {
                        return Err(ParseError::new(pos, "invalid literal"));
                    }
                }
                _ => return Err(ParseError::new(pos, "unexpected character")),
            }
            continue;
        }

        match mode {
            Mode::ObjKey | Mode::ObjKeyOnly => match c {
                b'"' => {
                    let end = scan_string(bytes, pos)?;
                    if builder.depth() >= MAX_DEPTH {
                        return Err(ParseError::new(pos, "nesting too deep"));
                    }
                    // Window = the "key" token including quotes; the Key
                    // owns its value as its single child.
                    builder.open_fixed(NodeKind::Key, pos as u64, len32(pos, end, pos)?);
                    *modes.last_mut().unwrap() = Mode::KeyColon;
                    pos = end;
                }
                b'}' if mode == Mode::ObjKey => {
                    builder.close(pos as u64 + 1);
                    modes.pop();
                    pos += 1;
                    done!(pos);
                }
                b'}' => return Err(ParseError::new(pos, "trailing comma")),
                _ => {
                    return Err(ParseError::new(
                        pos,
                        if mode == Mode::ObjKey {
                            "expected '\"' or '}'"
                        } else {
                            "expected '\"'"
                        },
                    ))
                }
            },
            Mode::KeyColon => {
                if c == b':' {
                    *modes.last_mut().unwrap() = Mode::KeyValue;
                    pos += 1;
                } else {
                    return Err(ParseError::new(pos, "expected ':'"));
                }
            }
            Mode::ObjComma => match c {
                b',' => {
                    *modes.last_mut().unwrap() = Mode::ObjKeyOnly;
                    pos += 1;
                }
                b'}' => {
                    builder.close(pos as u64 + 1);
                    modes.pop();
                    pos += 1;
                    done!(pos);
                }
                _ => return Err(ParseError::new(pos, "expected ',' or '}'")),
            },
            Mode::ArrComma => match c {
                b',' => {
                    *modes.last_mut().unwrap() = Mode::ArrValueOnly;
                    pos += 1;
                }
                b']' => {
                    builder.close(pos as u64 + 1);
                    modes.pop();
                    pos += 1;
                    done!(pos);
                }
                _ => return Err(ParseError::new(pos, "expected ',' or ']'")),
            },
            _ => unreachable!(),
        }
    }

    // EOF.
    if modes.len() > 1 {
        return Err(ParseError::new(pos, "unexpected end of input"));
    }
    if root_values == 0 {
        return Err(ParseError::new(pos, "empty document"));
    }
    Ok(builder.finish(n as u64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::NIL;

    fn kinds_of_children(idx: &Index, node: u32) -> Vec<NodeKind> {
        idx.children(node).map(|c| idx.node(c).kind).collect()
    }

    #[test]
    fn scalars() {
        for (src, kind) in [
            ("42", NodeKind::Number),
            ("-1.5e+10", NodeKind::Number),
            ("\"hi\"", NodeKind::String),
            ("true", NodeKind::Bool),
            ("false", NodeKind::Bool),
            ("null", NodeKind::Null),
        ] {
            let idx = parse(src.as_bytes()).unwrap();
            assert_eq!(kinds_of_children(&idx, idx.root()), vec![kind], "{src}");
            let c = idx.node(idx.root()).first_child;
            assert_eq!(idx.node(c).offset(), 0);
            assert_eq!(idx.node(c).len as usize, src.len());
        }
    }

    #[test]
    fn key_owns_its_value() {
        let src = br#"{"name": {"a": [1, 2]}}"#;
        let idx = parse(src).unwrap();
        let obj = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(obj).kind, NodeKind::Object);
        let key = idx.node(obj).first_child;
        assert_eq!(idx.node(key).kind, NodeKind::Key);
        // Window = "name" including quotes.
        assert_eq!(&src[idx.node(key).offset() as usize..][..idx.node(key).len as usize], b"\"name\"");
        // Exactly one child: the value.
        assert_eq!(idx.child_count(key), 1);
        let val = idx.node(key).first_child;
        assert_eq!(idx.node(val).kind, NodeKind::Object);
        assert_eq!(idx.node(val).next_sibling, NIL);
    }

    #[test]
    fn ndjson_multiple_root_values() {
        let idx = parse(b"{\"a\":1}\n{\"b\":2}\n[3]\n").unwrap();
        assert_eq!(
            kinds_of_children(&idx, idx.root()),
            vec![NodeKind::Object, NodeKind::Object, NodeKind::Array]
        );
    }

    #[test]
    fn adjacent_root_values_need_whitespace() {
        assert!(parse(b"01").is_err()); // not 0 then 1
        assert!(parse(b"{}{}").is_err());
        assert!(parse(b"{} {}").is_ok());
    }

    #[test]
    fn rejects_with_byte_offsets() {
        for (src, offset) in [
            ("[1,2,]", 5u64),
            ("{\"a\":1,}", 7),
            ("{", 1),
            ("[", 1),
            ("\"abc", 0),
            ("{\"a\"}", 4),
            ("{\"a\":}", 5),
            ("{a:1}", 1),
            ("tru", 0),
            ("[1 2]", 3),
            ("]", 0),
        ] {
            let err = parse(src.as_bytes()).unwrap_err();
            assert_eq!(err.offset, offset, "{src}: {err}");
        }
    }

    #[test]
    fn rejects_bad_numbers() {
        for src in ["01", "1.", "-", "1e", "1e+", ".5", "+1"] {
            assert!(parse(src.as_bytes()).is_err(), "{src}");
        }
        for src in ["0", "-0", "0.5", "1e10", "1E-2", "123.456e+7"] {
            assert!(parse(src.as_bytes()).is_ok(), "{src}");
        }
    }

    #[test]
    fn empty_document_is_an_error() {
        assert!(parse(b"").is_err());
        assert!(parse(b"   \n  ").is_err());
    }

    #[test]
    fn bom_is_skipped() {
        let idx = parse(b"\xEF\xBB\xBF{\"a\": 1}").unwrap();
        let obj = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(obj).kind, NodeKind::Object);
        assert_eq!(idx.node(obj).offset(), 3);
    }

    #[test]
    fn escapes_left_raw() {
        let src = br#""a\"bA""#;
        let idx = parse(src).unwrap();
        let s = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(s).len as usize, src.len()); // whole raw token
    }

    #[test]
    fn deep_nesting_no_stack_overflow() {
        // 2,000+ levels must not overflow the call stack (SPEC §7.1).
        let depth = 2500usize;
        let mut src = Vec::new();
        src.extend(std::iter::repeat(b'[').take(depth));
        src.push(b'1');
        src.extend(std::iter::repeat(b']').take(depth));
        let idx = parse(&src).unwrap();
        assert_eq!(idx.len(), depth + 2); // root + arrays + number
    }

    #[test]
    fn max_depth_is_enforced() {
        let depth = MAX_DEPTH + 10;
        let mut src = Vec::new();
        src.extend(std::iter::repeat(b'[').take(depth));
        src.push(b'1');
        src.extend(std::iter::repeat(b']').take(depth));
        let err = parse(&src).unwrap_err();
        assert_eq!(err.message, "nesting too deep");
    }

    #[test]
    fn container_windows_span_their_text() {
        let src = br#"  [1, {"a": true}]  "#;
        let idx = parse(src).unwrap();
        let arr = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(arr).offset(), 2);
        assert_eq!(idx.node(arr).len as usize, src.len() - 4);
    }
}
