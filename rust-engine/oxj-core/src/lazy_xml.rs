//! Lazy XML index (Phase 4b) — on-demand element materialization.
//!
//! Mirrors the eager [`crate::xml`] structure: `<Tag …>…</Tag>` is an
//! `ElementOpen` whose window is the tag name and whose children are its
//! attributes, text, CDATA and child elements; `name="v"` is an `Attribute`
//! (window = name) owning a `String` value; character data is `Text`;
//! `<![CDATA[…]]>` is `CData`; comments / PIs / the doctype are skipped and
//! whitespace-only text is dropped.
//!
//! Unlike the eager parser it materializes **one level at a time**: an
//! element's attributes and direct children are produced only when the
//! element is first accessed, and each child element records just its byte
//! extent (found by a depth-balanced close-tag scan) until it too is
//! expanded. Memory therefore tracks the viewed subtree, not the whole file.
//!
//! Correctness anchor: fully expanding a `LazyXml` yields the same
//! (kind, window, children, label) tree as [`crate::xml::parse_xml`] on
//! well-formed input (see the tests). Unlike the eager parser it is
//! *lenient*: it does not validate well-formedness (mismatched/unclosed
//! tags are tolerated best-effort rather than raising), which is acceptable
//! for a read-only large-file viewer.
//!
//! The arena/navigation machinery is a standalone copy of the JSON
//! [`crate::lazy::LazyIndex`] internals so the validated JSON path is never
//! touched; only scanning, materialization and display differ.

use crate::index::{NodeKind, NIL};
use crate::model::xml_unescape;
use crate::search::{Match, SearchScope};
use std::collections::HashSet;

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline]
fn is_name_end(b: u8) -> bool {
    is_ws(b) || matches!(b, b'/' | b'>' | b'=')
}

fn all_ws(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| is_ws(b))
}

fn find_from(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TagKind {
    Open,
    SelfClose,
    Close,
    Skip, // comment / PI / CDATA / doctype
}

/// Consume one `<…>` construct starting at `pos` (which must be `<`).
/// Returns its kind and the byte position just past it, or `None` if
/// unterminated.
fn skip_tag(bytes: &[u8], pos: usize) -> Option<(TagKind, usize)> {
    let n = bytes.len();
    let rest = &bytes[pos..];
    if rest.starts_with(b"<!--") {
        return find_from(bytes, pos + 4, b"-->").map(|e| (TagKind::Skip, e + 3));
    }
    if rest.starts_with(b"<![CDATA[") {
        return find_from(bytes, pos + 9, b"]]>").map(|e| (TagKind::Skip, e + 3));
    }
    if rest.starts_with(b"<?") {
        return find_from(bytes, pos + 2, b"?>").map(|e| (TagKind::Skip, e + 2));
    }
    if rest.starts_with(b"<!") {
        // Doctype (with a possible internal subset in [ … ]).
        let mut i = pos + 2;
        let mut brackets = 0i32;
        while i < n {
            match bytes[i] {
                b'[' => brackets += 1,
                b']' => brackets -= 1,
                b'>' if brackets == 0 => return Some((TagKind::Skip, i + 1)),
                _ => {}
            }
            i += 1;
        }
        return None;
    }
    if rest.starts_with(b"</") {
        let mut i = pos + 2;
        while i < n && bytes[i] != b'>' {
            i += 1;
        }
        if i >= n {
            return None;
        }
        return Some((TagKind::Close, i + 1));
    }
    // Open or self-closing tag: scan to the terminating '>' outside quotes.
    let mut i = pos + 1;
    let mut quote = 0u8;
    while i < n {
        let b = bytes[i];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            let self_close = i > pos + 1 && bytes[i - 1] == b'/';
            return Some((
                if self_close {
                    TagKind::SelfClose
                } else {
                    TagKind::Open
                },
                i + 1,
            ));
        }
        i += 1;
    }
    None
}

/// The full byte extent of the element whose open tag starts at `start`
/// (which must be `<name…`): the position just past its matching close
/// tag, or past `/>` for a self-closing element. Depth-balanced; nested
/// elements, comments, CDATA and PIs are handled. On malformed/unterminated
/// input it returns end-of-input (lenient).
fn scan_element_extent(bytes: &[u8], start: usize) -> usize {
    let n = bytes.len();
    let (kind0, mut i) = match skip_tag(bytes, start) {
        Some(t) => t,
        None => return n,
    };
    if kind0 != TagKind::Open {
        return i; // self-closing (or degenerate): no content
    }
    let mut depth = 1usize;
    while i < n {
        while i < n && bytes[i] != b'<' {
            i += 1;
        }
        if i >= n {
            return n;
        }
        match skip_tag(bytes, i) {
            Some((TagKind::Open, next)) => {
                depth += 1;
                i = next;
            }
            Some((TagKind::Close, next)) => {
                depth -= 1;
                i = next;
                if depth == 0 {
                    return i;
                }
            }
            Some((_, next)) => i = next, // SelfClose / Skip: depth unchanged
            None => return n,
        }
    }
    n
}

/// The tag-name window `(offset, len)` of an open tag at `pos` (`<name…`).
fn tag_name(bytes: &[u8], pos: usize) -> (u64, u32) {
    let n = bytes.len();
    let start = pos + 1;
    let mut i = start;
    while i < n && !is_name_end(bytes[i]) {
        i += 1;
    }
    (start as u64, (i - start) as u32)
}

/// A parsed open tag: attribute `(name_off, name_len, val_off, val_len)`
/// windows, whether it self-closes, and the position after `>`.
struct OpenTag {
    attrs: Vec<(u64, u32, u64, u32)>,
    self_closing: bool,
    after: usize,
}

fn parse_open_tag(bytes: &[u8], pos: usize) -> OpenTag {
    let n = bytes.len();
    let mut i = pos + 1;
    while i < n && !is_name_end(bytes[i]) {
        i += 1; // skip the element name
    }
    let mut attrs = Vec::new();
    loop {
        while i < n && is_ws(bytes[i]) {
            i += 1;
        }
        if i >= n {
            return OpenTag {
                attrs,
                self_closing: false,
                after: n,
            };
        }
        match bytes[i] {
            b'>' => {
                return OpenTag {
                    attrs,
                    self_closing: false,
                    after: i + 1,
                }
            }
            b'/' => {
                let after = if i + 1 < n && bytes[i + 1] == b'>' {
                    i + 2
                } else {
                    i + 1
                };
                return OpenTag {
                    attrs,
                    self_closing: true,
                    after,
                };
            }
            b'=' => {
                // Malformed (value with no name); bail out best-effort.
                return OpenTag {
                    attrs,
                    self_closing: false,
                    after: skip_tag(bytes, pos).map(|(_, a)| a).unwrap_or(n),
                };
            }
            _ => {
                let aname_start = i;
                while i < n && !is_name_end(bytes[i]) {
                    i += 1;
                }
                let aname_len = i - aname_start;
                while i < n && is_ws(bytes[i]) {
                    i += 1;
                }
                if i >= n || bytes[i] != b'=' {
                    return OpenTag {
                        attrs,
                        self_closing: false,
                        after: skip_tag(bytes, pos).map(|(_, a)| a).unwrap_or(n),
                    };
                }
                i += 1;
                while i < n && is_ws(bytes[i]) {
                    i += 1;
                }
                if i >= n || (bytes[i] != b'"' && bytes[i] != b'\'') {
                    return OpenTag {
                        attrs,
                        self_closing: false,
                        after: skip_tag(bytes, pos).map(|(_, a)| a).unwrap_or(n),
                    };
                }
                let quote = bytes[i];
                i += 1;
                let v_start = i;
                while i < n && bytes[i] != quote {
                    i += 1;
                }
                let v_len = i - v_start;
                if i < n {
                    i += 1; // consume the closing quote
                }
                attrs.push((
                    aname_start as u64,
                    aname_len as u32,
                    v_start as u64,
                    v_len as u32,
                ));
            }
        }
    }
}

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
    /// A leaf / already-complete node (Text, CData, String, Attribute).
    fn leaf(kind: NodeKind, start: u64, end: u64) -> LNode {
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

    /// An element whose display window is the tag name but whose materialized
    /// span (for children) is the full element extent `[<, past-close)`.
    fn element(name_off: u64, name_len: u32, ext_start: u64, ext_end: u64) -> LNode {
        LNode {
            offset: name_off,
            len: name_len,
            kind: NodeKind::ElementOpen,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            val_start: ext_start,
            val_end: ext_end,
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

/// On-demand XML index over a byte buffer.
pub struct LazyXml {
    nodes: Vec<LNode>,
    body_start: u64,
}

impl LazyXml {
    pub fn open(bytes: &[u8]) -> LazyXml {
        let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
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
        LazyXml {
            nodes: vec![root],
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
                let mut last = NIL;
                self.scan_children(bytes, node, self.body_start as usize, &mut last);
            }
            NodeKind::ElementOpen => {
                let ot = parse_open_tag(bytes, vs);
                let mut last = NIL;
                for (aoff, alen, voff, vlen) in ot.attrs {
                    let attr = LNode::leaf(NodeKind::Attribute, aoff, aoff + alen as u64);
                    let ai = push_link(&mut self.nodes, node, attr, &mut last);
                    let mut al = NIL;
                    push_link(
                        &mut self.nodes,
                        ai,
                        LNode::leaf(NodeKind::String, voff, voff + vlen as u64),
                        &mut al,
                    );
                    self.nodes[ai as usize].parsed = true;
                }
                if !ot.self_closing {
                    self.scan_children(bytes, node, ot.after, &mut last);
                }
            }
            _ => {}
        }
        self.nodes[node as usize].parsed = true;
    }

    /// Emit the direct children found in the content starting at `from`,
    /// linking them after `*last`. Stops at the enclosing element's close
    /// tag (`</…`) or end-of-input. Child elements are recorded with their
    /// full extent but left un-materialized.
    fn scan_children(&mut self, bytes: &[u8], parent: u32, from: usize, last: &mut u32) {
        let n = bytes.len();
        let mut i = from;
        loop {
            // Character data up to the next '<'.
            let text_start = i;
            while i < n && bytes[i] != b'<' {
                i += 1;
            }
            if i > text_start && !all_ws(&bytes[text_start..i]) {
                push_link(
                    &mut self.nodes,
                    parent,
                    LNode::leaf(NodeKind::Text, text_start as u64, i as u64),
                    last,
                );
            }
            if i >= n {
                return;
            }
            let rest = &bytes[i..];
            if rest.starts_with(b"<!--") {
                match find_from(bytes, i + 4, b"-->") {
                    Some(e) => i = e + 3,
                    None => return,
                }
            } else if rest.starts_with(b"<![CDATA[") {
                let inner = i + 9;
                match find_from(bytes, inner, b"]]>") {
                    Some(e) => {
                        push_link(
                            &mut self.nodes,
                            parent,
                            LNode::leaf(NodeKind::CData, inner as u64, e as u64),
                            last,
                        );
                        i = e + 3;
                    }
                    None => return,
                }
            } else if rest.starts_with(b"<?") {
                match find_from(bytes, i + 2, b"?>") {
                    Some(e) => i = e + 2,
                    None => return,
                }
            } else if rest.starts_with(b"<!") {
                match skip_tag(bytes, i) {
                    Some((_, next)) => i = next,
                    None => return,
                }
            } else if rest.starts_with(b"</") {
                return; // the enclosing element's close tag
            } else {
                // A child element: record its extent, leave unparsed.
                let ext_end = scan_element_extent(bytes, i);
                let (name_off, name_len) = tag_name(bytes, i);
                push_link(
                    &mut self.nodes,
                    parent,
                    LNode::element(name_off, name_len, i as u64, ext_end as u64),
                    last,
                );
                i = ext_end;
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

    /// Drill through an Attribute to its value only if that value is a
    /// container (never, for XML) — so an Attribute is a display leaf, an
    /// Element/Document reveals its own children.
    pub fn container_for(&mut self, bytes: &[u8], node: u32) -> Option<u32> {
        match self.nodes[node as usize].kind {
            NodeKind::Attribute => {
                self.ensure_parsed(bytes, node);
                let v = self.nodes[node as usize].first_child;
                if v != NIL && self.nodes[v as usize].kind.is_container() {
                    Some(v)
                } else {
                    None
                }
            }
            NodeKind::Document | NodeKind::ElementOpen => Some(node),
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

    // -- display (mirrors crate::model for XML) -----------------------------

    fn window<'b>(&self, bytes: &'b [u8], node: u32) -> &'b [u8] {
        let n = &self.nodes[node as usize];
        let start = n.offset as usize;
        start
            .checked_add(n.len as usize)
            .and_then(|end| bytes.get(start..end))
            .unwrap_or(b"")
    }

    fn scalar_display(&self, bytes: &[u8], node: u32) -> String {
        let w = self.window(bytes, node);
        match self.nodes[node as usize].kind {
            NodeKind::String => format!("\"{}\"", xml_unescape(&String::from_utf8_lossy(w))),
            NodeKind::Text => xml_unescape(&String::from_utf8_lossy(w)),
            _ => String::from_utf8_lossy(w).into_owned(), // CData: raw
        }
    }

    /// Row label — matches the eager `model::display_text` for XML.
    pub fn display_text(&mut self, bytes: &[u8], node: u32) -> String {
        let kind = self.nodes[node as usize].kind;
        match kind {
            NodeKind::Document => format!("document [{}]", self.children(bytes, node).len()),
            NodeKind::ElementOpen => {
                format!("<{}>", String::from_utf8_lossy(self.window(bytes, node)))
            }
            NodeKind::Attribute => {
                let name = String::from_utf8_lossy(self.window(bytes, node)).into_owned();
                self.ensure_parsed(bytes, node);
                let v = self.nodes[node as usize].first_child;
                if v == NIL {
                    format!("@{}", name)
                } else {
                    format!(
                        "@{} = \"{}\"",
                        name,
                        xml_unescape(&String::from_utf8_lossy(self.window(bytes, v)))
                    )
                }
            }
            _ => self.scalar_display(bytes, node),
        }
    }

    // -- search (mirrors lazy::LazyIndex; Attribute behaves like Key) -------

    pub fn locate(&mut self, bytes: &[u8], offset: u64) -> u32 {
        let mut node = self.root();
        loop {
            let kids = self.children(bytes, node);
            let mut next: Option<u32> = None;
            for &c in &kids {
                if self.nodes[c as usize].kind == NodeKind::Attribute {
                    // Match the attribute *name* window, else descend to its
                    // value string (which sits under the attribute, like a Key).
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
    use crate::index::Index;
    use crate::model::display_text as eager_display_text;
    use crate::xml::parse_xml;
    use crate::Format;

    fn assert_same(lx: &mut LazyXml, ln: u32, idx: &Index, en: u32, src: &[u8]) {
        assert_eq!(lx.kind(ln), idx.node(en).kind, "kind mismatch");
        if lx.kind(ln) != NodeKind::Document {
            let (off, len) = lx.window_of(ln);
            assert_eq!(off, idx.node(en).offset(), "offset mismatch");
            assert_eq!(len, idx.node(en).len, "len mismatch");
        }
        assert_eq!(
            lx.display_text(src, ln),
            eager_display_text(src, idx, Format::Xml, en),
            "display_text mismatch"
        );
        let lkids = lx.children(src, ln);
        let ekids: Vec<u32> = idx.children(en).collect();
        assert_eq!(lkids.len(), ekids.len(), "child count mismatch");
        for (lc, ec) in lkids.into_iter().zip(ekids) {
            assert_same(lx, lc, idx, ec, src);
        }
    }

    fn check_equivalent(src: &[u8]) {
        let eager = parse_xml(src).expect("eager parse");
        let mut lazy = LazyXml::open(src);
        let lroot = lazy.root();
        assert_same(&mut lazy, lroot, &eager, eager.root(), src);
    }

    #[test]
    fn equivalent_to_eager_on_samples() {
        check_equivalent(b"<root><child a=\"1\">hi</child></root>");
        check_equivalent(b"<a name='va&lue'/>");
        check_equivalent(b"<a><b/><c x=\"1\"/></a>");
        check_equivalent(b"<r><x>1</x><x>2</x><y><z>deep</z></y></r>");
        check_equivalent(b"<!-- c --><?pi ?><root>text<![CDATA[<not a tag>]]>more</root>");
        check_equivalent(b"<doc><p>a<b>bold</b>c</p></doc>");
        check_equivalent(b"<ns:tag ns:attr=\"v\"><child/></ns:tag>");
        // Attribute value containing '>' and nested same-name elements.
        check_equivalent(b"<a t=\"x>y\"><a><a>deep</a></a></a>");
        // Leading whitespace / newlines between elements (dropped).
        check_equivalent(b"<r>\n  <c>1</c>\n  <c>2</c>\n</r>");
    }

    #[test]
    fn materialization_is_lazy() {
        let src = b"<r><a><deep><x>1</x></deep></a><b>2</b></r>";
        let mut lazy = LazyXml::open(src);
        assert_eq!(lazy.materialized(), 1);
        let root = lazy.root();
        let top = lazy.children(src, root);
        assert_eq!(top.len(), 1); // <r>
        assert_eq!(lazy.kind(top[0]), NodeKind::ElementOpen);
        let before = lazy.materialized();
        // Expanding <r> materializes only <a> and <b>, not their subtrees.
        let rkids = lazy.children(src, top[0]);
        assert_eq!(rkids.len(), 2);
        assert!(lazy.materialized() < before + 20);
    }

    #[test]
    fn locate_and_search_scopes() {
        use crate::search::search_raw_parallel;
        use regex::bytes::Regex;

        // Distinct strings for tag name / attr name / attr value / text so
        // each match offset is unambiguous.
        let src = b"<root id=\"aval\"><item>tval</item></root>";
        let s = std::str::from_utf8(src).unwrap();

        // Offset inside the <item> text → the Text node.
        let mut lazy = LazyXml::open(src);
        let text_pos = s.find("tval").unwrap() as u64;
        let n = lazy.locate(src, text_pos);
        assert_eq!(lazy.kind(n), NodeKind::Text);

        // Offset inside the attribute value → the String value node.
        let attr_val_pos = s.find("aval").unwrap() as u64;
        let n = lazy.locate(src, attr_val_pos);
        assert_eq!(lazy.kind(n), NodeKind::String);

        // Values-scoped search matches the attribute value (String) and the
        // element text (Text) — not the tag name / attribute name.
        let re = Regex::new("aval|tval").unwrap();
        let matches = search_raw_parallel(src, &re);
        let vals = lazy.locate_matches(src, &matches, SearchScope::Values, 1000);
        assert_eq!(vals.len(), 2);
        for v in &vals {
            assert!(matches!(lazy.kind(*v), NodeKind::String | NodeKind::Text));
        }
    }
}
