//! CSV / TSV parser (SPEC §7.3). RFC-4180-style reader.
//!
//! Delimiter is auto-sniffed from the first line among `, ; \t |` (override
//! via `CsvOptions`; the TSV preset forces tab). Header detection is
//! automatic: with ≥2 records, an all-text first row becomes the column
//! names; otherwise rows are arrays of cells (overridable).
//!
//! With a header, each record is an `Object` and each cell is a `Key`
//! (window = the header cell's bytes, shared across rows) owning a typed
//! value — so a CSV renders like a JSON array-of-objects. Without a header,
//! each record is an `Array` of cells.
//!
//! Typing: an unquoted cell matching a strict numeric grammar becomes
//! `Number`; leading-zero values (ZIP codes) deliberately stay `String`;
//! quoted cells are always `String`.
//!
//! Field windows stay zero-copy: outer quotes are excluded; embedded `""`
//! remains literal and is unescaped only for on-screen rows. CSV never
//! hard-fails on structure — malformed quoting resyncs at the next
//! delimiter/newline boundary (SPEC §12).

use crate::index::{Index, IndexBuilder, NodeKind};
use crate::json::is_number_token;

/// Candidate delimiters, in preference order on ties.
const CANDIDATES: [u8; 4] = [b',', b';', b'\t', b'|'];

#[derive(Clone, Copy, Debug, Default)]
pub struct CsvOptions {
    /// Force a delimiter instead of sniffing.
    pub delimiter: Option<u8>,
    /// Force header presence instead of auto-detecting.
    pub has_header: Option<bool>,
}

impl CsvOptions {
    /// TSV preset: forces the tab delimiter.
    pub fn tsv() -> CsvOptions {
        CsvOptions {
            delimiter: Some(b'\t'),
            has_header: None,
        }
    }
}

/// A tokenized cell: a zero-copy window plus whether it was quoted.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Cell {
    pub(crate) offset: usize,
    pub(crate) len: usize,
    pub(crate) quoted: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Record {
    pub(crate) cells: Vec<Cell>,
    pub(crate) start: usize,
    pub(crate) end: usize,
}

/// Sniff the delimiter from the first line: count candidate occurrences
/// outside quotes; highest count wins, preferring `, ; \t |` order on ties;
/// all-zero falls back to comma.
pub fn sniff_delimiter(bytes: &[u8]) -> u8 {
    let mut counts = [0usize; 4];
    let mut in_quotes = false;
    for &b in bytes {
        if b == b'"' {
            in_quotes = !in_quotes;
        } else if b == b'\n' && !in_quotes {
            break;
        } else if !in_quotes {
            for (i, &c) in CANDIDATES.iter().enumerate() {
                if b == c {
                    counts[i] += 1;
                }
            }
        }
    }
    let mut best = 0usize;
    for i in 1..4 {
        if counts[i] > counts[best] {
            best = i;
        }
    }
    if counts[best] == 0 {
        b','
    } else {
        CANDIDATES[best]
    }
}

#[inline]
fn at_newline(bytes: &[u8], pos: usize) -> bool {
    bytes[pos] == b'\n' || (bytes[pos] == b'\r' && pos + 1 < bytes.len() && bytes[pos + 1] == b'\n')
}

/// Skip the newline sequence at `pos` (`\n` or `\r\n`).
#[inline]
fn skip_newline(bytes: &[u8], pos: usize) -> usize {
    if bytes[pos] == b'\r' {
        pos + 2
    } else {
        pos + 1
    }
}

/// Tokenize the next record starting at `pos`. Blank lines at record
/// boundaries are skipped. Returns `None` at EOF.
pub(crate) fn next_record(bytes: &[u8], mut pos: usize, delim: u8) -> Option<(Record, usize)> {
    let n = bytes.len();
    // Skip blank lines.
    while pos < n && at_newline(bytes, pos) {
        pos = skip_newline(bytes, pos);
    }
    if pos >= n {
        return None;
    }
    let start = pos;
    let mut cells = Vec::new();
    loop {
        // ---- one cell ---------------------------------------------------
        if pos < n && bytes[pos] == b'"' {
            // Quoted field: may contain the delimiter and newlines; "" is an
            // escaped quote (left literal in the window).
            pos += 1;
            let v_start = pos;
            let v_end;
            loop {
                if pos >= n {
                    v_end = pos; // unterminated quote: resync at EOF
                    break;
                }
                if bytes[pos] == b'"' {
                    if pos + 1 < n && bytes[pos + 1] == b'"' {
                        pos += 2; // escaped quote, stays literal
                    } else {
                        v_end = pos;
                        pos += 1;
                        break;
                    }
                } else {
                    pos += 1;
                }
            }
            cells.push(Cell {
                offset: v_start,
                len: v_end - v_start,
                quoted: true,
            });
            // Resync: tolerate junk after the closing quote up to the next
            // delimiter / newline boundary.
            while pos < n && bytes[pos] != delim && !at_newline(bytes, pos) {
                pos += 1;
            }
        } else {
            let v_start = pos;
            while pos < n && bytes[pos] != delim && !at_newline(bytes, pos) {
                pos += 1;
            }
            cells.push(Cell {
                offset: v_start,
                len: pos - v_start,
                quoted: false,
            });
        }
        // ---- cell terminator --------------------------------------------
        if pos >= n {
            return Some((
                Record {
                    cells,
                    start,
                    end: pos,
                },
                pos,
            ));
        }
        if bytes[pos] == delim {
            pos += 1;
            continue;
        }
        // Newline: record ends before it.
        let end = pos;
        pos = skip_newline(bytes, pos);
        return Some((Record { cells, start, end }, pos));
    }
}

/// Header-detection "texty" test: non-empty and not numeric-typed.
pub(crate) fn is_texty(bytes: &[u8], cell: &Cell) -> bool {
    if cell.len == 0 {
        return false;
    }
    if cell.quoted {
        return true;
    }
    !is_number_token(&bytes[cell.offset..cell.offset + cell.len])
}

pub(crate) fn value_kind(bytes: &[u8], cell: &Cell) -> NodeKind {
    if !cell.quoted && is_number_token(&bytes[cell.offset..cell.offset + cell.len]) {
        NodeKind::Number
    } else {
        NodeKind::String
    }
}

fn emit(builder: &mut IndexBuilder, bytes: &[u8], rec: &Record, header: Option<&[Cell]>) {
    match header {
        Some(cols) => {
            // Record → Object; cell → Key (window = header cell bytes,
            // shared across rows) owning a typed value. Short rows yield
            // fewer keys; extra columns become unlabeled value rows.
            builder.open(NodeKind::Object, rec.start as u64);
            for (i, cell) in rec.cells.iter().enumerate() {
                let kind = value_kind(bytes, cell);
                if i < cols.len() {
                    let h = &cols[i];
                    builder.open_fixed(NodeKind::Key, h.offset as u64, h.len as u32);
                    builder.leaf(kind, cell.offset as u64, cell.len as u32);
                    builder.pop();
                } else {
                    builder.leaf(kind, cell.offset as u64, cell.len as u32);
                }
            }
            builder.close(rec.end as u64);
        }
        None => {
            builder.open(NodeKind::Array, rec.start as u64);
            for cell in &rec.cells {
                let kind = value_kind(bytes, cell);
                builder.leaf(kind, cell.offset as u64, cell.len as u32);
            }
            builder.close(rec.end as u64);
        }
    }
}

/// Parse CSV/TSV into a structural index. Never hard-fails on structure.
pub fn parse_csv(bytes: &[u8], opts: CsvOptions) -> Index {
    let mut pos = 0usize;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        pos = 3;
    }
    let body = &bytes[pos..];
    let delim = opts.delimiter.unwrap_or_else(|| sniff_delimiter(body));

    let mut builder = IndexBuilder::new();

    // Buffer the first two records to decide on the header.
    let first = next_record(bytes, pos, delim);
    let (rec1, after1) = match first {
        Some(r) => r,
        None => return builder.finish(bytes.len() as u64), // empty file
    };
    let second = next_record(bytes, after1, delim);

    let has_header = opts.has_header.unwrap_or_else(|| {
        second.is_some() && rec1.cells.iter().all(|c| is_texty(bytes, c))
    });

    let header: Option<Vec<Cell>> = if has_header {
        Some(rec1.cells.clone())
    } else {
        None
    };
    let header_ref = header.as_deref();

    if !has_header {
        emit(&mut builder, bytes, &rec1, header_ref);
    }
    let mut cursor = after1;
    if let Some((rec2, after2)) = second {
        emit(&mut builder, bytes, &rec2, header_ref);
        cursor = after2;
    }
    while let Some((rec, after)) = next_record(bytes, cursor, delim) {
        emit(&mut builder, bytes, &rec, header_ref);
        cursor = after;
    }

    builder.finish(bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window<'a>(bytes: &'a [u8], idx: &Index, node: u32) -> &'a [u8] {
        let n = idx.node(node);
        &bytes[n.offset() as usize..n.offset() as usize + n.len as usize]
    }

    #[test]
    fn sniffs_common_delimiters() {
        assert_eq!(sniff_delimiter(b"a,b,c\n1,2,3"), b',');
        assert_eq!(sniff_delimiter(b"a;b;c\n1;2;3"), b';');
        assert_eq!(sniff_delimiter(b"a\tb\tc"), b'\t');
        assert_eq!(sniff_delimiter(b"a|b|c"), b'|');
        assert_eq!(sniff_delimiter(b"plain"), b',');
        // Delimiters inside quotes don't count.
        assert_eq!(sniff_delimiter(b"\"a;;;;\",b\n1,2"), b',');
    }

    #[test]
    fn header_makes_objects_with_shared_key_windows() {
        let src = b"name,age\nalice,30\nbob,41";
        let idx = parse_csv(src, CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(recs.len(), 2);
        for &r in &recs {
            assert_eq!(idx.node(r).kind, NodeKind::Object);
        }
        let keys: Vec<u32> = idx.children(recs[0]).collect();
        assert_eq!(window(src, &idx, keys[0]), b"name");
        assert_eq!(window(src, &idx, keys[1]), b"age");
        // Key windows are shared across rows (same header bytes).
        let keys2: Vec<u32> = idx.children(recs[1]).collect();
        assert_eq!(idx.node(keys2[0]).offset(), idx.node(keys[0]).offset());
        // Values are typed.
        let age = idx.node(keys[1]).first_child;
        assert_eq!(idx.node(age).kind, NodeKind::Number);
        assert_eq!(window(src, &idx, age), b"30");
    }

    #[test]
    fn no_header_makes_arrays() {
        let src = b"1,2\n3,4";
        let idx = parse_csv(src, CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(recs.len(), 2);
        assert_eq!(idx.node(recs[0]).kind, NodeKind::Array);
        assert_eq!(idx.child_count(recs[0]), 2);
    }

    #[test]
    fn single_record_is_not_a_header() {
        let src = b"alpha,beta";
        let idx = parse_csv(src, CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(recs.len(), 1);
        assert_eq!(idx.node(recs[0]).kind, NodeKind::Array);
    }

    #[test]
    fn leading_zero_stays_string() {
        let src = b"zip,n\n02134,5\n10001,7";
        let idx = parse_csv(src, CsvOptions::default());
        let rec = idx.node(idx.root()).first_child;
        let key = idx.node(rec).first_child;
        let zip = idx.node(key).first_child;
        assert_eq!(idx.node(zip).kind, NodeKind::String);
        assert_eq!(window(src, &idx, zip), b"02134");
    }

    #[test]
    fn quoted_cells_are_strings_with_quotes_excluded() {
        let src = b"a,b\n\"123\",\"x,y\nz\"\n1,2";
        let idx = parse_csv(src, CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(recs.len(), 2);
        let keys: Vec<u32> = idx.children(recs[0]).collect();
        let v0 = idx.node(keys[0]).first_child;
        assert_eq!(idx.node(v0).kind, NodeKind::String); // quoted → String
        assert_eq!(window(src, &idx, v0), b"123");
        let v1 = idx.node(keys[1]).first_child;
        assert_eq!(window(src, &idx, v1), b"x,y\nz"); // delimiter+newline inside quotes
    }

    #[test]
    fn escaped_quotes_stay_literal_in_window() {
        let src = b"a,b\n\"he said \"\"hi\"\"\",2\n3,4";
        let idx = parse_csv(src, CsvOptions::default());
        let rec = idx.node(idx.root()).first_child;
        let key = idx.node(rec).first_child;
        let v = idx.node(key).first_child;
        assert_eq!(window(src, &idx, v), b"he said \"\"hi\"\"");
    }

    #[test]
    fn ragged_rows_drop_no_data() {
        let src = b"a,b\n1\n2,3,4";
        let idx = parse_csv(src, CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(idx.child_count(recs[0]), 1); // short row → fewer keys
        // Extra column beyond the header → unlabeled value row.
        let kids: Vec<u32> = idx.children(recs[1]).collect();
        assert_eq!(kids.len(), 3);
        assert_eq!(idx.node(kids[2]).kind, NodeKind::Number);
        assert_eq!(window(src, &idx, kids[2]), b"4");
    }

    #[test]
    fn blank_lines_and_crlf() {
        let src = b"a,b\r\n\r\n1,2\r\n\r\n\r\n3,4\r\n";
        let idx = parse_csv(src, CsvOptions::default());
        assert_eq!(idx.child_count(idx.root()), 2);
    }

    #[test]
    fn tsv_preset_forces_tab() {
        let src = b"a\tb\n1\t2";
        let idx = parse_csv(src, CsvOptions::tsv());
        let rec = idx.node(idx.root()).first_child;
        assert_eq!(idx.child_count(rec), 2);
    }

    #[test]
    fn header_override() {
        let src = b"a,b\n1,2";
        let idx = parse_csv(
            src,
            CsvOptions {
                delimiter: None,
                has_header: Some(false),
            },
        );
        let rec = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(rec).kind, NodeKind::Array);
    }

    #[test]
    fn unterminated_quote_resyncs_at_eof() {
        let src = b"a,b\n\"oops,2";
        let idx = parse_csv(src, CsvOptions::default());
        assert_eq!(idx.child_count(idx.root()), 1); // no hard failure
    }

    #[test]
    fn empty_file() {
        let idx = parse_csv(b"", CsvOptions::default());
        assert_eq!(idx.child_count(idx.root()), 0);
    }
}
