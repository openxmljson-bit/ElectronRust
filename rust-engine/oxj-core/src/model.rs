//! Tree / virtualization layer (SPEC §8). Presents the index as a display
//! tree, independent of format; the only surface the UI needs.
//!
//! Drilling: the display tree drills through `Key` and `Attribute` nodes —
//! expanding one reveals the children of its *value*, not the intermediate
//! value node.
//!
//! Virtualization: `visible_row_count()` and `rows(start, len)` walk only
//! visible nodes, so the row count and any viewport slice are computed
//! without materializing the whole tree. This reference implementation is
//! O(start + len) visible nodes; a Fenwick/prefix-sum over expanded
//! subtrees can make random access O(log n + len) behind the same API.

use crate::index::{Index, NodeKind, NIL};
use crate::Format;
use std::collections::HashSet;

/// The container whose children a node reveals when expanded (SPEC §8):
/// for `Key`/`Attribute` the value if the value is a container, else `None`;
/// for `Object`/`Array`/`Document`/`ElementOpen` the node itself.
pub fn container_for(index: &Index, node: u32) -> Option<u32> {
    let n = index.node(node);
    match n.kind {
        NodeKind::Key | NodeKind::Attribute => {
            let value = n.first_child;
            if value == NIL {
                return None;
            }
            if index.node(value).kind.is_container() {
                Some(value)
            } else {
                None
            }
        }
        NodeKind::Document | NodeKind::Object | NodeKind::Array | NodeKind::ElementOpen => {
            Some(node)
        }
        _ => None,
    }
}

/// A node is expandable iff its display container has any child.
pub fn is_expandable(index: &Index, node: u32) -> bool {
    match container_for(index, node) {
        Some(c) => index.node(c).first_child != NIL,
        None => false,
    }
}

/// The drilled display children of `node`.
pub fn display_children(index: &Index, node: u32) -> Vec<u32> {
    match container_for(index, node) {
        Some(c) => index.children(c).collect(),
        None => Vec::new(),
    }
}

/// The node whose token starts at or nearest before `target` — the source
/// panel's byte→node lookup. Nodes are appended in document order during
/// the single forward parse, so offsets are non-decreasing for JSON and
/// XML and a binary search suffices. (CSV breaks this: header-window Key
/// nodes repeat earlier offsets — use `record_at_offset` there.)
pub fn node_at_offset(index: &Index, target: u64) -> u32 {
    let n = index.len();
    if n <= 1 {
        return index.root();
    }
    let mut lo = 1usize;
    let mut hi = n;
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if index.node(mid as u32).offset() <= target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    (lo - 1) as u32 // lo ≥ 1; target before every token → the root (0)
}

/// CSV/TSV byte→node lookup: the record (row) containing `target`.
/// Records are the root's children and their spans are monotonic.
pub fn record_at_offset(index: &Index, target: u64) -> u32 {
    let mut best = index.root();
    for child in index.children(index.root()) {
        if index.node(child).offset() <= target {
            best = child;
        } else {
            break;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Source-panel highlight spans. Most nodes highlight their raw window, but
// XML needs reconstruction: an ElementOpen window is just the tag name
// (SPEC §5.1), while users expect the whole `<tag …>…</tag>` extent.
// ---------------------------------------------------------------------------

/// End of a leaf's raw representation (CDATA includes its `]]>`).
fn leaf_raw_end(index: &Index, node: u32) -> u64 {
    let n = index.node(node);
    match n.kind {
        NodeKind::CData => n.offset() + n.len as u64 + 3,
        NodeKind::Attribute => match n.first_child {
            NIL => n.offset() + n.len as u64,
            value => {
                let v = index.node(value);
                v.offset() + v.len as u64 + 1 // include the closing quote
            }
        },
        _ => n.offset() + n.len as u64,
    }
}

/// Position just past the next unquoted `>` (end of an open tag).
fn scan_gt(bytes: &[u8], mut pos: usize) -> usize {
    let mut quote = 0u8;
    while pos < bytes.len() {
        let b = bytes[pos];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            return pos + 1;
        }
        pos += 1;
    }
    bytes.len()
}

/// Skip whitespace/comments/PIs, then consume one close tag; returns the
/// position after its `>`. Anything unexpected returns `pos` unchanged
/// (graceful shorter highlight rather than a wrong one).
fn scan_close_tag(bytes: &[u8], mut pos: usize) -> usize {
    let n = bytes.len();
    loop {
        while pos < n && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
            pos += 1;
        }
        if bytes[pos..].starts_with(b"<!--") {
            match bytes[pos + 4..]
                .windows(3)
                .position(|w| w == b"-->")
            {
                Some(p) => pos = pos + 4 + p + 3,
                None => return pos,
            }
        } else if bytes[pos..].starts_with(b"<?") {
            match bytes[pos + 2..].windows(2).position(|w| w == b"?>") {
                Some(p) => pos = pos + 2 + p + 2,
                None => return pos,
            }
        } else if bytes[pos..].starts_with(b"</") {
            let mut i = pos + 2;
            while i < n && bytes[i] != b'>' {
                i += 1;
            }
            return (i + 1).min(n);
        } else {
            return pos;
        }
    }
}

/// The byte span `(offset, len)` to highlight for a node in the raw
/// source. Elements cover `<tag …>…</tag>`; attributes cover
/// `name="value"`; CDATA covers `<![CDATA[…]]>`; everything else (JSON,
/// CSV, scalars) is the plain token window.
pub fn highlight_span(bytes: &[u8], index: &Index, node: u32) -> (u64, u64) {
    let nd = index.node(node);
    match nd.kind {
        NodeKind::ElementOpen => {
            let start = nd.offset().saturating_sub(1); // the '<'
            // Descend along last *body* (non-attribute) children.
            let mut stack = vec![node];
            let mut leaf_end: Option<u64> = None;
            loop {
                let cur = *stack.last().unwrap();
                let mut last_body = NIL;
                for c in index.children(cur) {
                    if index.node(c).kind != NodeKind::Attribute {
                        last_body = c;
                    }
                }
                if last_body == NIL {
                    break;
                }
                if index.node(last_body).kind == NodeKind::ElementOpen {
                    stack.push(last_body);
                } else {
                    leaf_end = Some(leaf_raw_end(index, last_body));
                    break;
                }
            }
            let mut pos = match leaf_end {
                Some(end) => end as usize,
                None => {
                    // Deepest element has no body: finish its open tag.
                    let deepest = *stack.last().unwrap();
                    let dn = index.node(deepest);
                    let after =
                        scan_gt(bytes, (dn.offset() + dn.len as u64) as usize);
                    if after >= 2 && bytes.get(after - 2) == Some(&b'/') {
                        stack.pop(); // self-closing: already closed
                    }
                    after
                }
            };
            // Unwind: one close tag per open element on the stack.
            for _ in 0..stack.len() {
                pos = scan_close_tag(bytes, pos);
            }
            (start, pos as u64 - start)
        }
        NodeKind::Attribute => {
            (nd.offset(), leaf_raw_end(index, node) - nd.offset())
        }
        NodeKind::CData => {
            let start = nd.offset().saturating_sub(9); // "<![CDATA["
            (start, nd.offset() + nd.len as u64 + 3 - start)
        }
        _ => (nd.offset(), nd.len as u64),
    }
}

// ---------------------------------------------------------------------------
// Display-time decoding. Escapes are left raw in the index and interpreted
// only here, for on-screen rows (SPEC §2.2).
// ---------------------------------------------------------------------------

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode JSON string escapes (`\" \\ \/ \b \f \n \r \t \uXXXX`, including
/// surrogate pairs) for display. Malformed escapes are kept verbatim.
pub fn json_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('b') => out.push('\u{0008}'),
            Some('f') => out.push('\u{000C}'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16) {
                    Ok(cp) if (0xD800..0xDC00).contains(&cp) => {
                        // High surrogate: try to pair with \uXXXX low.
                        let mut clone = chars.clone();
                        if clone.next() == Some('\\') && clone.next() == Some('u') {
                            let lo_hex: String = clone.by_ref().take(4).collect();
                            if let Ok(lo) = u32::from_str_radix(&lo_hex, 16) {
                                if (0xDC00..0xE000).contains(&lo) {
                                    let combined =
                                        0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                    if let Some(ch) = char::from_u32(combined) {
                                        out.push(ch);
                                        chars = clone;
                                        continue;
                                    }
                                }
                            }
                        }
                        out.push('\u{FFFD}');
                    }
                    Ok(cp) => out.push(char::from_u32(cp).unwrap_or('\u{FFFD}')),
                    Err(_) => {
                        out.push_str("\\u");
                        out.push_str(&hex);
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Decode the five predefined XML entities plus numeric character
/// references for display. Unknown entities are kept verbatim.
pub fn xml_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        match tail.find(';') {
            Some(semi) => {
                let ent = &tail[1..semi];
                let decoded = match ent {
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "amp" => Some('&'),
                    "apos" => Some('\''),
                    "quot" => Some('"'),
                    _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                        u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                    }
                    _ if ent.starts_with('#') => {
                        ent[1..].parse::<u32>().ok().and_then(char::from_u32)
                    }
                    _ => None,
                };
                match decoded {
                    Some(ch) => {
                        out.push(ch);
                        rest = &tail[semi + 1..];
                    }
                    None => {
                        out.push_str(&tail[..semi + 1]);
                        rest = &tail[semi + 1..];
                    }
                }
            }
            None => {
                out.push_str(tail);
                rest = "";
            }
        }
        if rest.is_empty() {
            break;
        }
    }
    out.push_str(rest);
    out
}

/// Unescape CSV `""` → `"` for display.
pub fn csv_unescape(raw: &str) -> String {
    raw.replace("\"\"", "\"")
}

fn window<'a>(bytes: &'a [u8], index: &Index, node: u32) -> &'a [u8] {
    // Fully bounds-checked (incl. the add) so a corrupt index cannot
    // panic the process (SPEC §12).
    let n = index.node(node);
    let start = n.offset() as usize;
    start
        .checked_add(n.len as usize)
        .and_then(|end| bytes.get(start..end))
        .unwrap_or(b"")
}

/// A JSON Key window includes quotes; strip them and unescape for display.
fn key_name(bytes: &[u8], index: &Index, format: Format, node: u32) -> String {
    let w = window(bytes, index, node);
    if w.len() >= 2 && w[0] == b'"' && w[w.len() - 1] == b'"' {
        json_unescape(&lossy(&w[1..w.len() - 1]))
    } else if format == Format::Csv || format == Format::Tsv {
        csv_unescape(&lossy(w))
    } else {
        lossy(w)
    }
}

fn scalar_display(bytes: &[u8], index: &Index, format: Format, node: u32) -> String {
    let n = index.node(node);
    let w = window(bytes, index, node);
    match n.kind {
        NodeKind::String => match format {
            Format::Json => {
                // Window includes quotes.
                if w.len() >= 2 && w[0] == b'"' && w[w.len() - 1] == b'"' {
                    format!("\"{}\"", json_unescape(&lossy(&w[1..w.len() - 1])))
                } else {
                    lossy(w)
                }
            }
            Format::Xml => format!("\"{}\"", xml_unescape(&lossy(w))),
            Format::Csv | Format::Tsv => format!("\"{}\"", csv_unescape(&lossy(w))),
        },
        NodeKind::Text | NodeKind::CData => {
            if format == Format::Xml && n.kind == NodeKind::Text {
                xml_unescape(&lossy(w))
            } else {
                lossy(w)
            }
        }
        _ => lossy(w),
    }
}

/// Format a row on demand — only ever called for visible rows (SPEC §8).
pub fn display_text(bytes: &[u8], index: &Index, format: Format, node: u32) -> String {
    let n = index.node(node);
    match n.kind {
        NodeKind::Document => format!("document [{}]", index.child_count(node)),
        NodeKind::Object => format!("{{{}}}", index.child_count(node)),
        NodeKind::Array => format!("[{}]", index.child_count(node)),
        NodeKind::Key => {
            let name = key_name(bytes, index, format, node);
            let value = n.first_child;
            if value == NIL {
                return name;
            }
            match index.node(value).kind {
                NodeKind::Object => {
                    format!("{} {{{}}}", name, index.child_count(value))
                }
                NodeKind::Array => format!("{} [{}]", name, index.child_count(value)),
                _ => format!("{}: {}", name, scalar_display(bytes, index, format, value)),
            }
        }
        NodeKind::ElementOpen => format!("<{}>", lossy(window(bytes, index, node))),
        NodeKind::Attribute => {
            let name = lossy(window(bytes, index, node));
            let value = n.first_child;
            if value == NIL {
                format!("@{}", name)
            } else {
                format!(
                    "@{} = \"{}\"",
                    name,
                    xml_unescape(&lossy(window(bytes, index, value)))
                )
            }
        }
        _ => scalar_display(bytes, index, format, node),
    }
}

/// One visible row, formatted for the viewport.
#[derive(Clone, Debug)]
pub struct Row {
    pub node: u32,
    pub depth: u32,
    pub text: String,
    pub expandable: bool,
    pub expanded: bool,
    pub kind: NodeKind,
}

/// Virtualized display tree with expand/collapse state. Frame cost is
/// proportional to visible rows, never document size (requirement N4).
pub struct TreeModel<'a> {
    bytes: &'a [u8],
    index: &'a Index,
    format: Format,
    expanded: HashSet<u32>,
}

impl<'a> TreeModel<'a> {
    pub fn new(bytes: &'a [u8], index: &'a Index, format: Format) -> TreeModel<'a> {
        TreeModel {
            bytes,
            index,
            format,
            expanded: HashSet::new(),
        }
    }

    pub fn index(&self) -> &Index {
        self.index
    }

    pub fn is_expandable(&self, node: u32) -> bool {
        is_expandable(self.index, node)
    }

    pub fn is_expanded(&self, node: u32) -> bool {
        self.expanded.contains(&node)
    }

    /// Flip a node's expansion; returns the new state.
    pub fn toggle(&mut self, node: u32) -> bool {
        if !self.is_expandable(node) {
            return false;
        }
        if !self.expanded.remove(&node) {
            self.expanded.insert(node);
            true
        } else {
            false
        }
    }

    pub fn display_text(&self, node: u32) -> String {
        display_text(self.bytes, self.index, self.format, node)
    }

    /// Iterative pre-order walk of *visible* rows (top-level rows are the
    /// Document's display children). `f` returns false to stop early.
    fn walk(&self, mut f: impl FnMut(u32, u32) -> bool) {
        let root = self.index.root();
        let first = match container_for(self.index, root) {
            Some(c) => self.index.node(c).first_child,
            None => NIL,
        };
        if first == NIL {
            return;
        }
        // Stack discipline: pop order is node → its subtree → its sibling,
        // so push the sibling before the first child. No recursion (N3).
        let mut stack: Vec<(u32, u32)> = vec![(first, 0)];
        while let Some((node, depth)) = stack.pop() {
            if !f(node, depth) {
                return;
            }
            let sib = self.index.node(node).next_sibling;
            if sib != NIL {
                stack.push((sib, depth));
            }
            if self.expanded.contains(&node) {
                if let Some(c) = container_for(self.index, node) {
                    let child = self.index.node(c).first_child;
                    if child != NIL {
                        stack.push((child, depth + 1));
                    }
                }
            }
        }
    }

    /// Total number of visible rows, without materializing them.
    pub fn visible_row_count(&self) -> usize {
        let mut count = 0usize;
        self.walk(|_, _| {
            count += 1;
            true
        });
        count
    }

    /// The viewport slice `[start, start+len)` of visible rows.
    pub fn rows(&self, start: usize, len: usize) -> Vec<Row> {
        let mut out = Vec::with_capacity(len);
        let mut i = 0usize;
        self.walk(|node, depth| {
            if i >= start {
                out.push(Row {
                    node,
                    depth,
                    text: self.display_text(node),
                    expandable: self.is_expandable(node),
                    expanded: self.is_expanded(node),
                    kind: self.index.node(node).kind,
                });
            }
            i += 1;
            i < start + len
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn drills_through_keys() {
        let src = br#"{"a": {"b": 1}, "c": 2}"#;
        let idx = parse(src).unwrap();
        let obj = idx.node(idx.root()).first_child;
        let key_a = idx.node(obj).first_child;
        // Expanding "a" reveals the children of its value object.
        assert!(is_expandable(&idx, key_a));
        let kids = display_children(&idx, key_a);
        assert_eq!(kids.len(), 1);
        assert_eq!(idx.node(kids[0]).kind, NodeKind::Key); // "b"
        // "c" has a scalar value → not expandable.
        let key_c = idx.node(key_a).next_sibling;
        assert!(!is_expandable(&idx, key_c));
    }

    #[test]
    fn virtualized_rows_and_count() {
        let src = br#"[{"a": 1}, {"b": 2}, 3]"#;
        let idx = parse(src).unwrap();
        let mut model = TreeModel::new(src, &idx, Format::Json);
        // Collapsed: one row (the array).
        assert_eq!(model.visible_row_count(), 1);
        let arr = idx.node(idx.root()).first_child;
        assert!(model.toggle(arr));
        assert_eq!(model.visible_row_count(), 4); // array + 3 children
        let rows = model.rows(1, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].depth, 1);
        assert_eq!(rows[0].text, "{1}");
        // Expand the first object → its key row appears.
        assert!(model.toggle(rows[0].node));
        assert_eq!(model.visible_row_count(), 5);
        let rows = model.rows(2, 1);
        assert_eq!(rows[0].text, "a: 1");
        assert_eq!(rows[0].depth, 2);
        // rows() beyond the end is empty, not a panic.
        assert!(model.rows(100, 5).is_empty());
    }

    #[test]
    fn display_texts() {
        let src = br#"{"s": "x\ny", "o": {"a": 1, "b": 2}, "l": [1, 2, 3], "n": null}"#;
        let idx = parse(src).unwrap();
        let obj = idx.node(idx.root()).first_child;
        let kids = display_children(&idx, obj);
        let texts: Vec<String> = kids
            .iter()
            .map(|&k| display_text(src, &idx, Format::Json, k))
            .collect();
        assert_eq!(texts[0], "s: \"x\ny\""); // \n decoded for display only
        assert_eq!(texts[1], "o {2}");
        assert_eq!(texts[2], "l [3]");
        assert_eq!(texts[3], "n: null");
    }

    #[test]
    fn xml_display_texts() {
        let src = b"<a href=\"x&amp;y\">hello</a>";
        let idx = crate::xml::parse_xml(src).unwrap();
        let a = idx.node(idx.root()).first_child;
        assert_eq!(display_text(src, &idx, Format::Xml, a), "<a>");
        let kids = display_children(&idx, a);
        assert_eq!(
            display_text(src, &idx, Format::Xml, kids[0]),
            "@href = \"x&y\""
        );
        assert_eq!(display_text(src, &idx, Format::Xml, kids[1]), "hello");
    }

    #[test]
    fn node_at_offset_finds_document_order_nodes() {
        let src = br#"{"a": [1, 22], "b": "x"}"#;
        //           0123456789012345678901234
        let idx = parse(src).unwrap();
        // Byte inside the "a" key token → the Key node.
        let key_a = node_at_offset(&idx, 2);
        assert_eq!(idx.node(key_a).kind, NodeKind::Key);
        // Byte inside 22 → the Number node.
        let n22 = node_at_offset(&idx, 11);
        assert_eq!(idx.node(n22).kind, NodeKind::Number);
        assert_eq!(idx.node(n22).offset(), 10);
        // Byte before everything → root.
        let obj = node_at_offset(&idx, 0);
        assert_eq!(idx.node(obj).kind, NodeKind::Object);
        // Byte at EOF-ish → last token region ("x").
        let sx = node_at_offset(&idx, 22);
        assert_eq!(idx.node(sx).kind, NodeKind::String);
    }

    #[test]
    fn highlight_spans_cover_whole_xml_elements() {
        fn span_str<'a>(src: &'a [u8], idx: &Index, node: u32) -> &'a str {
            let (off, len) = highlight_span(src, idx, node);
            std::str::from_utf8(&src[off as usize..(off + len) as usize]).unwrap()
        }

        let src = b"<root a=\"1\"><b>hi</b><c/><d x='2'></d>\n  <!-- t --> <e><f>y</f></e></root>";
        let idx = crate::xml::parse_xml(src).unwrap();
        let root = idx.node(idx.root()).first_child;
        assert_eq!(span_str(src, &idx, root), std::str::from_utf8(src).unwrap());
        let kids: Vec<u32> = crate::model::display_children(&idx, root)
            .into_iter()
            .filter(|&k| idx.node(k).kind == NodeKind::ElementOpen)
            .collect();
        assert_eq!(span_str(src, &idx, kids[0]), "<b>hi</b>");
        assert_eq!(span_str(src, &idx, kids[1]), "<c/>");
        assert_eq!(span_str(src, &idx, kids[2]), "<d x='2'></d>");
        assert_eq!(span_str(src, &idx, kids[3]), "<e><f>y</f></e>");

        // Attributes cover name="value".
        let attr = idx.node(root).first_child;
        assert_eq!(idx.node(attr).kind, NodeKind::Attribute);
        assert_eq!(span_str(src, &idx, attr), "a=\"1\"");

        // CDATA covers the whole wrapper.
        let src2 = b"<a><![CDATA[x < y]]></a>";
        let idx2 = crate::xml::parse_xml(src2).unwrap();
        let a = idx2.node(idx2.root()).first_child;
        let cd = idx2.node(a).first_child;
        assert_eq!(span_str(src2, &idx2, cd), "<![CDATA[x < y]]>");
        assert_eq!(span_str(src2, &idx2, a), std::str::from_utf8(src2).unwrap());

        // Tricky: attribute value containing '>'.
        let src3 = b"<a b=\"x>y\"><c/></a>";
        let idx3 = crate::xml::parse_xml(src3).unwrap();
        let a3 = idx3.node(idx3.root()).first_child;
        assert_eq!(span_str(src3, &idx3, a3), std::str::from_utf8(src3).unwrap());

        // JSON nodes are unchanged: plain token windows.
        let jsrc = br#"{"k": [1, 2]}"#;
        let jidx = crate::json::parse(jsrc).unwrap();
        let obj = jidx.node(jidx.root()).first_child;
        assert_eq!(highlight_span(jsrc, &jidx, obj), (0, jsrc.len() as u64));
    }

    #[test]
    fn record_at_offset_finds_csv_rows() {
        let src = b"a,b\n1,2\n3,4";
        let idx = crate::csv::parse_csv(src, crate::csv::CsvOptions::default());
        let recs: Vec<u32> = idx.children(idx.root()).collect();
        assert_eq!(record_at_offset(&idx, 5), recs[0]);
        assert_eq!(record_at_offset(&idx, 9), recs[1]);
    }

    #[test]
    fn unescape_helpers() {
        assert_eq!(json_unescape(r#"a\"b\\c\n"#), "a\"b\\c\n");
        assert_eq!(json_unescape(r#"Aé"#), "Aé");
        assert_eq!(json_unescape("\\ud83d\\ude00"), "😀"); // surrogate pair
        assert_eq!(json_unescape("\\u0041"), "A");
        assert_eq!(xml_unescape("a&lt;b&amp;c&#65;&#x42;"), "a<b&cAB");
        assert_eq!(xml_unescape("keep &unknown; raw"), "keep &unknown; raw");
        assert_eq!(csv_unescape("he said \"\"hi\"\""), "he said \"hi\"");
    }
}
