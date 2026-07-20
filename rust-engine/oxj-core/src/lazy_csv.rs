//! Lazy CSV/TSV index (Phase 4a) — on-demand row/cell materialization.
//!
//! Mirrors the eager [`crate::csv`] structure: records are the Document's
//! children; with a header each record is an `Object` of `Key → value`,
//! otherwise an `Array` of values. But unlike the eager parser this
//! enumerates only record *boundaries* when the root is expanded (one
//! 24-byte node per row, no cell contents) and tokenizes a record's cells
//! only when that record is first accessed. Memory therefore tracks the
//! rows actually viewed rather than rows × columns for the whole file.
//!
//! Correctness anchor: it reuses the eager tokenizer ([`crate::csv::next_record`])
//! and the same header-detection and typing rules, so a fully-expanded
//! lazy index is identical to [`crate::csv::parse_csv`] (see the tests).
//!
//! The arena/navigation machinery is deliberately a standalone copy of the
//! JSON [`crate::lazy::LazyIndex`] internals so the validated JSON path is
//! never touched; only materialization and display differ.

use crate::csv::{is_texty, next_record, sniff_delimiter, value_kind, CsvOptions, Record};
use crate::index::{NodeKind, NIL};
use crate::model::csv_unescape;
use crate::search::{Match, SearchScope};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug)]
struct LNode {
    offset: u64,
    len: u32,
    kind: NodeKind,
    parent: u32,
    first_child: u32,
    next_sibling: u32,
    val_start: u64,
    val_end: u64,
    parsed: bool,
}

impl LNode {
    fn scalar(kind: NodeKind, start: u64, end: u64) -> LNode {
        LNode {
            offset: start,
            len: (end - start).min(u32::MAX as u64) as u32,
            kind,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            val_start: start,
            val_end: end,
            parsed: true,
        }
    }

    fn container(kind: NodeKind, start: u64, end: u64) -> LNode {
        LNode {
            offset: start,
            len: (end - start).min(u32::MAX as u64) as u32,
            kind,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            val_start: start,
            val_end: end,
            parsed: false,
        }
    }
}

fn push_link(nodes: &mut Vec<LNode>, parent: u32, mut child: LNode, last: &mut u32) -> u32 {
    let idx = nodes.len() as u32;
    child.parent = parent;
    nodes.push(child);
    if *last == NIL {
        nodes[parent as usize].first_child = idx;
    } else {
        nodes[*last as usize].next_sibling = idx;
    }
    *last = idx;
    idx
}

/// On-demand CSV/TSV index over a byte buffer.
pub struct LazyCsv {
    nodes: Vec<LNode>,
    delim: u8,
    has_header: bool,
    /// Column windows `(offset, len)` (outer quotes excluded), shared as the
    /// window of every record's Key nodes — exactly like the eager parser.
    header: Vec<(u64, u32)>,
    body_start: u64,
}

impl LazyCsv {
    /// Open a CSV/TSV buffer for lazy indexing. `bytes` is scanned only to
    /// sniff the delimiter and detect/capture the header row; it is not
    /// retained. The same buffer must be passed to every subsequent call.
    pub fn open(bytes: &[u8], opts: CsvOptions) -> LazyCsv {
        let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
        let delim = opts.delimiter.unwrap_or_else(|| sniff_delimiter(&bytes[start..]));

        // Header detection mirrors csv::parse_csv: with >= 2 records and an
        // all-texty first row, row 1 supplies the column names.
        let (has_header, header) = match next_record(bytes, start, delim) {
            Some((rec1, after1)) => {
                let second = next_record(bytes, after1, delim);
                let hh = opts.has_header.unwrap_or_else(|| {
                    second.is_some() && rec1.cells.iter().all(|c| is_texty(bytes, c))
                });
                let cols = if hh {
                    rec1.cells
                        .iter()
                        .map(|c| (c.offset as u64, c.len as u32))
                        .collect()
                } else {
                    Vec::new()
                };
                (hh, cols)
            }
            None => (false, Vec::new()),
        };

        let root = LNode {
            offset: 0,
            len: 0,
            kind: NodeKind::Document,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            val_start: start as u64,
            val_end: bytes.len() as u64,
            parsed: false,
        };
        LazyCsv {
            nodes: vec![root],
            delim,
            has_header,
            header,
            body_start: start as u64,
        }
    }

    pub fn root(&self) -> u32 {
        0
    }

    pub fn materialized(&self) -> usize {
        self.nodes.len()
    }

    pub fn arena_bytes(&self) -> u64 {
        (self.nodes.len() * std::mem::size_of::<LNode>()) as u64
    }

    pub fn kind(&self, node: u32) -> NodeKind {
        self.nodes[node as usize].kind
    }

    pub fn parent(&self, node: u32) -> u32 {
        self.nodes[node as usize].parent
    }

    pub fn window_of(&self, node: u32) -> (u64, u32) {
        let n = &self.nodes[node as usize];
        (n.offset, n.len)
    }

    // -- materialization ----------------------------------------------------

    fn ensure_parsed(&mut self, bytes: &[u8], node: u32) {
        if self.nodes[node as usize].parsed {
            return;
        }
        let kind = self.nodes[node as usize].kind;
        let vs = self.nodes[node as usize].val_start as usize;
        match kind {
            NodeKind::Document => {
                // Enumerate record boundaries only (no cell contents), one
                // node per row; skip the header row when present.
                let mut cursor = self.body_start as usize;
                if self.has_header {
                    if let Some((_, after)) = next_record(bytes, cursor, self.delim) {
                        cursor = after;
                    }
                }
                let rec_kind = if self.has_header {
                    NodeKind::Object
                } else {
                    NodeKind::Array
                };
                let mut last = NIL;
                while let Some((rec, after)) = next_record(bytes, cursor, self.delim) {
                    let recnode = LNode::container(rec_kind, rec.start as u64, rec.end as u64);
                    push_link(&mut self.nodes, node, recnode, &mut last);
                    cursor = after;
                }
            }
            NodeKind::Object | NodeKind::Array => {
                // Re-tokenize this one record and materialize its cells.
                if let Some((rec, _)) = next_record(bytes, vs, self.delim) {
                    self.emit_cells(node, bytes, &rec);
                }
            }
            _ => {}
        }
        self.nodes[node as usize].parsed = true;
    }

    fn emit_cells(&mut self, record: u32, bytes: &[u8], rec: &Record) {
        let mut last = NIL;
        if self.has_header {
            for (i, cell) in rec.cells.iter().enumerate() {
                let vkind = value_kind(bytes, cell);
                let vstart = cell.offset as u64;
                let vend = (cell.offset + cell.len) as u64;
                if i < self.header.len() {
                    let (hoff, hlen) = self.header[i];
                    let key = LNode::scalar(NodeKind::Key, hoff, hoff + hlen as u64);
                    let key_idx = push_link(&mut self.nodes, record, key, &mut last);
                    let mut kl = NIL;
                    push_link(
                        &mut self.nodes,
                        key_idx,
                        LNode::scalar(vkind, vstart, vend),
                        &mut kl,
                    );
                    self.nodes[key_idx as usize].parsed = true;
                } else {
                    // Extra columns (ragged rows) become unlabeled values.
                    push_link(
                        &mut self.nodes,
                        record,
                        LNode::scalar(vkind, vstart, vend),
                        &mut last,
                    );
                }
            }
        } else {
            for cell in &rec.cells {
                let vkind = value_kind(bytes, cell);
                let vstart = cell.offset as u64;
                let vend = (cell.offset + cell.len) as u64;
                push_link(
                    &mut self.nodes,
                    record,
                    LNode::scalar(vkind, vstart, vend),
                    &mut last,
                );
            }
        }
    }

    // -- navigation (mirrors lazy::LazyIndex) -------------------------------

    pub fn children(&mut self, bytes: &[u8], node: u32) -> Vec<u32> {
        self.ensure_parsed(bytes, node);
        let mut out = Vec::new();
        let mut cur = self.nodes[node as usize].first_child;
        while cur != NIL {
            out.push(cur);
            cur = self.nodes[cur as usize].next_sibling;
        }
        out
    }

    pub fn child_count(&mut self, bytes: &[u8], node: u32) -> usize {
        self.children(bytes, node).len()
    }

    /// The display container whose children `node` reveals. CSV values are
    /// never containers, so a Key never drills further.
    pub fn container_for(&mut self, bytes: &[u8], node: u32) -> Option<u32> {
        match self.nodes[node as usize].kind {
            NodeKind::Key => {
                self.ensure_parsed(bytes, node);
                let v = self.nodes[node as usize].first_child;
                if v != NIL && self.nodes[v as usize].kind.is_container() {
                    Some(v)
                } else {
                    None
                }
            }
            NodeKind::Document | NodeKind::Object | NodeKind::Array => Some(node),
            _ => None,
        }
    }

    pub fn is_expandable(&mut self, bytes: &[u8], node: u32) -> bool {
        match self.container_for(bytes, node) {
            Some(c) => {
                self.ensure_parsed(bytes, c);
                self.nodes[c as usize].first_child != NIL
            }
            None => false,
        }
    }

    pub fn display_children(&mut self, bytes: &[u8], node: u32) -> Vec<u32> {
        match self.container_for(bytes, node) {
            Some(c) => self.children(bytes, c),
            None => Vec::new(),
        }
    }

    pub fn display_child_count(&mut self, bytes: &[u8], node: u32) -> usize {
        match self.container_for(bytes, node) {
            Some(c) => self.child_count(bytes, c),
            None => 0,
        }
    }

    // -- display (mirrors crate::model for CSV/TSV) -------------------------

    fn window<'b>(&self, bytes: &'b [u8], node: u32) -> &'b [u8] {
        let n = &self.nodes[node as usize];
        let start = n.offset as usize;
        start
            .checked_add(n.len as usize)
            .and_then(|end| bytes.get(start..end))
            .unwrap_or(b"")
    }

    fn key_name(&self, bytes: &[u8], node: u32) -> String {
        csv_unescape(&String::from_utf8_lossy(self.window(bytes, node)))
    }

    fn scalar_display(&self, bytes: &[u8], node: u32) -> String {
        let w = self.window(bytes, node);
        match self.nodes[node as usize].kind {
            NodeKind::String => format!("\"{}\"", csv_unescape(&String::from_utf8_lossy(w))),
            _ => String::from_utf8_lossy(w).into_owned(),
        }
    }

    /// Row label — matches the eager `model::display_text` for CSV/TSV.
    pub fn display_text(&mut self, bytes: &[u8], node: u32) -> String {
        let kind = self.nodes[node as usize].kind;
        match kind {
            NodeKind::Document => format!("document [{}]", self.children(bytes, node).len()),
            NodeKind::Object => format!("{{{}}}", self.children(bytes, node).len()),
            NodeKind::Array => format!("[{}]", self.children(bytes, node).len()),
            NodeKind::Key => {
                let name = self.key_name(bytes, node);
                self.ensure_parsed(bytes, node);
                let v = self.nodes[node as usize].first_child;
                if v == NIL {
                    return name;
                }
                // CSV member values are always scalars.
                format!("{}: {}", name, self.scalar_display(bytes, v))
            }
            _ => self.scalar_display(bytes, node),
        }
    }

    // -- search (mirrors lazy::LazyIndex) -----------------------------------

    /// The deepest node whose span contains byte `offset`, materializing
    /// only the path. (See `lazy::LazyIndex::locate`.)
    pub fn locate(&mut self, bytes: &[u8], offset: u64) -> u32 {
        let mut node = self.root();
        loop {
            let kids = self.children(bytes, node);
            let mut next: Option<u32> = None;
            for &c in &kids {
                if self.nodes[c as usize].kind == NodeKind::Key {
                    let ks = self.nodes[c as usize].val_start;
                    let ke = self.nodes[c as usize].val_end;
                    if ks <= offset && offset < ke {
                        return c;
                    }
                    self.ensure_parsed(bytes, c);
                    let v = self.nodes[c as usize].first_child;
                    if v != NIL {
                        let vs = self.nodes[v as usize].val_start;
                        let ve = self.nodes[v as usize].val_end;
                        if vs <= offset && offset < ve {
                            next = Some(v);
                            break;
                        }
                    }
                } else {
                    let cs = self.nodes[c as usize].val_start;
                    let ce = self.nodes[c as usize].val_end;
                    if cs <= offset && offset < ce {
                        next = Some(c);
                        break;
                    }
                }
            }
            match next {
                Some(c) => node = c,
                None => return node,
            }
        }
    }

    pub fn locate_matches(
        &mut self,
        bytes: &[u8],
        matches: &[Match],
        scope: SearchScope,
        cap: usize,
    ) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        for m in matches {
            if out.len() >= cap {
                break;
            }
            let node = self.locate(bytes, m.offset);
            let kind = self.nodes[node as usize].kind;
            if scope.includes(kind) && seen.insert(node) {
                out.push(node);
            }
        }
        out.sort_unstable();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::csv::parse_csv;
    use crate::index::Index;
    use crate::model::display_text as eager_display_text;
    use crate::Format;

    /// Recursively compare a fully-expanded lazy CSV tree to eager parse_csv:
    /// same kind, windows, child count, and rendered label at every node.
    fn assert_same(lz: &mut LazyCsv, ln: u32, idx: &Index, en: u32, src: &[u8]) {
        assert_eq!(lz.kind(ln), idx.node(en).kind, "kind mismatch");
        if lz.kind(ln) != NodeKind::Document {
            let (off, len) = lz.window_of(ln);
            assert_eq!(off, idx.node(en).offset(), "offset mismatch");
            assert_eq!(len, idx.node(en).len, "len mismatch");
        }
        assert_eq!(
            lz.display_text(src, ln),
            eager_display_text(src, idx, Format::Csv, en),
            "display_text mismatch"
        );
        let lkids = lz.children(src, ln);
        let ekids: Vec<u32> = idx.children(en).collect();
        assert_eq!(lkids.len(), ekids.len(), "child count mismatch");
        for (lc, ec) in lkids.into_iter().zip(ekids) {
            assert_same(lz, lc, idx, ec, src);
        }
    }

    fn check_equivalent(src: &[u8]) {
        let eager = parse_csv(src, CsvOptions::default());
        let mut lazy = LazyCsv::open(src, CsvOptions::default());
        let lroot = lazy.root();
        assert_same(&mut lazy, lroot, &eager, eager.root(), src);
    }

    #[test]
    fn equivalent_to_eager_with_header() {
        check_equivalent(b"name,age,city\nalice,30,NYC\nbob,25,LA\n");
        check_equivalent(b"a,b\n1,2\n3,4");
        // Quoted cells with embedded delimiter, newline and escaped quote.
        check_equivalent(b"name,note\n\"x,y\",\"he said \"\"hi\"\"\"\n\"a\nb\",z\n");
        // Ragged row: extra column becomes an unlabeled value.
        check_equivalent(b"a,b\n1,2,3\n");
        // Leading-zero cell stays a String (ZIP code rule).
        check_equivalent(b"id,zip\n1,00123\n2,90210\n");
    }

    #[test]
    fn equivalent_to_eager_without_header() {
        // Numeric first row → no header; records are Arrays.
        check_equivalent(b"1,2,3\n4,5,6\n");
        check_equivalent(b"1,2,3");
    }

    #[test]
    fn materialization_is_lazy() {
        let src = b"name,age\nalice,30\nbob,25\ncarol,40\n";
        let mut lazy = LazyCsv::open(src, CsvOptions::default());
        assert_eq!(lazy.materialized(), 1); // root only
        let root = lazy.root();
        let records = lazy.children(src, root);
        assert_eq!(records.len(), 3, "3 data rows (header excluded)");
        // Record nodes exist, but their cells are not materialized yet.
        let after_records = lazy.materialized();
        assert_eq!(after_records, 1 + 3);
        // Expanding one record materializes only its cells.
        let cells = lazy.children(src, records[0]);
        assert_eq!(cells.len(), 2, "two columns");
        assert_eq!(lazy.kind(cells[0]), NodeKind::Key);
        // The other two records stay un-tokenized.
        assert!(lazy.materialized() < after_records + 10);
    }

    #[test]
    fn locate_and_search_scopes() {
        use crate::search::search_raw_parallel;
        use regex::bytes::Regex;

        let src = b"name,city\nalice,NYC\nbob,alice\n";
        let s = std::str::from_utf8(src).unwrap();

        // A value in the second data row.
        let mut lazy = LazyCsv::open(src, CsvOptions::default());
        // "bob" is a value in row 2.
        let bob = s.find("bob").unwrap() as u64;
        let n = lazy.locate(src, bob);
        assert_eq!(lazy.kind(n), NodeKind::String);

        // Values-scoped search for "alice": the value in row 1 and the value
        // in row 2 (the header "name" match, if any, is not a value).
        let re = Regex::new("alice").unwrap();
        let matches = search_raw_parallel(src, &re);
        let vals = lazy.locate_matches(src, &matches, SearchScope::Values, 1000);
        assert_eq!(vals.len(), 2, "two cell values equal 'alice'");
        for v in &vals {
            assert_eq!(lazy.kind(*v), NodeKind::String);
        }
    }
}
