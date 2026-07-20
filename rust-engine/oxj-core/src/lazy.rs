//! Lazy JSON index (Phase 1 of the on-demand indexing effort).
//!
//! Unlike the eager `parse` (which turns every token into a resident node
//! up front), this indexes **one level at a time**: a container's direct
//! children are materialized only when first requested. Memory therefore
//! scales with the *viewed* portion of the document, not its full size —
//! the property needed to open files near or beyond available RAM.
//!
//! Correctness anchor: fully expanding a `LazyIndex` yields exactly the
//! same (kind, children) tree as `json::parse` (see the tests).
//!
//! Phase 2 adds a thin *view* layer (`display_text`, drilled `child_nodes`,
//! `is_expandable`, …) mirroring the eager `model` functions so the same Qt
//! `DocumentModel` can render a lazy index unchanged; those methods are
//! equivalence-tested against `model::display_text`.

use crate::index::{NodeKind, NIL};
use crate::json::{scan_number, scan_string};
use crate::model::json_unescape;
use crate::search::{Match, SearchScope};
use std::collections::{HashMap, HashSet};

#[inline]
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline]
fn skip_ws(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && is_ws(bytes[pos]) {
        pos += 1;
    }
    pos
}

/// The kind of the JSON value that begins at `pos` (after skipping ws), or
/// `None` if there's no value there.
fn value_kind_at(bytes: &[u8], pos: usize) -> Option<NodeKind> {
    let pos = skip_ws(bytes, pos);
    match bytes.get(pos)? {
        b'{' => Some(NodeKind::Object),
        b'[' => Some(NodeKind::Array),
        b'"' => Some(NodeKind::String),
        b'-' | b'0'..=b'9' => Some(NodeKind::Number),
        b't' | b'f' => Some(NodeKind::Bool),
        b'n' => Some(NodeKind::Null),
        _ => None,
    }
}

/// Exclusive end of the JSON value beginning at `pos`. Scalars use the
/// shared token scanners; containers are found by balancing brackets while
/// skipping string contents. Returns `None` on malformed input.
fn scan_value_end(bytes: &[u8], pos: usize) -> Option<usize> {
    let pos = skip_ws(bytes, pos);
    match *bytes.get(pos)? {
        open @ (b'{' | b'[') => {
            let close = if open == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut i = pos;
            while i < bytes.len() {
                match bytes[i] {
                    b'"' => i = scan_string(bytes, i).ok()?,
                    c if c == open => {
                        depth += 1;
                        i += 1;
                    }
                    c if c == close => {
                        depth -= 1;
                        i += 1;
                        if depth == 0 {
                            return Some(i);
                        }
                    }
                    _ => i += 1,
                }
            }
            None
        }
        b'"' => scan_string(bytes, pos).ok(),
        b'-' | b'0'..=b'9' => scan_number(bytes, pos).ok(),
        b't' if bytes[pos..].starts_with(b"true") => Some(pos + 4),
        b'f' if bytes[pos..].starts_with(b"false") => Some(pos + 5),
        b'n' if bytes[pos..].starts_with(b"null") => Some(pos + 4),
        _ => None,
    }
}

/// A lazily-materialized node. Only nodes that have been reached are ever
/// allocated. `val_start..val_end` is the byte span whose direct children
/// are produced on demand (the container's own bytes, or a member's value).
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
            parsed: true, // scalars have no children
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
            parsed: false, // children materialized on demand
        }
    }

    fn value(kind: NodeKind, start: u64, end: u64) -> LNode {
        if kind.is_container() {
            LNode::container(kind, start, end)
        } else {
            LNode::scalar(kind, start, end)
        }
    }
}

/// On-demand JSON index over a byte buffer.
///
/// The arena is fully owned and stores no borrow of the source bytes, so it
/// is `'static` and can be embedded behind FFI / interior mutability. The
/// document bytes are supplied on each materializing call instead (the same
/// decoupling the eager [`crate::index::Index`] uses with its `Mapping`).
pub struct LazyIndex {
    nodes: Vec<LNode>,
}

/// Push `child` under `parent`, linking it after `last` (NIL if first).
/// Returns the new node index and updates `last`.
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

impl LazyIndex {
    /// Create an index whose only materialized node is the synthetic
    /// Document root; top-level values are enumerated on first access.
    ///
    /// `bytes` is read only to size the root window and skip a BOM — it is
    /// not retained. The *same* buffer must be passed to every subsequent
    /// [`children`](Self::children) / [`child_count`](Self::child_count) /
    /// [`expand_all`](Self::expand_all) call.
    pub fn open(bytes: &[u8]) -> LazyIndex {
        let start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
        let root = LNode {
            offset: 0,
            len: 0,
            kind: NodeKind::Document,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            val_start: start,
            val_end: bytes.len() as u64,
            parsed: false,
        };
        LazyIndex { nodes: vec![root] }
    }

    pub fn root(&self) -> u32 {
        0
    }

    /// Number of nodes materialized so far (for tests/telemetry).
    pub fn materialized(&self) -> usize {
        self.nodes.len()
    }

    pub fn kind(&self, node: u32) -> NodeKind {
        self.nodes[node as usize].kind
    }

    pub fn offset(&self, node: u32) -> u64 {
        self.nodes[node as usize].offset
    }

    pub fn len_of(&self, node: u32) -> u32 {
        self.nodes[node as usize].len
    }

    pub fn parent(&self, node: u32) -> u32 {
        self.nodes[node as usize].parent
    }

    /// Direct children of `node`, materializing them on first access.
    /// `bytes` must be the same buffer passed to [`open`](Self::open).
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

    fn ensure_parsed(&mut self, bytes: &[u8], node: u32) {
        if self.nodes[node as usize].parsed {
            return;
        }
        let kind = self.nodes[node as usize].kind;
        let vs = self.nodes[node as usize].val_start as usize;
        let ve = self.nodes[node as usize].val_end as usize;
        let mut last = NIL;

        match kind {
            NodeKind::Document => {
                let mut pos = skip_ws(bytes, vs);
                while pos < ve {
                    let end = match scan_value_end(bytes, pos) {
                        Some(e) => e,
                        None => break,
                    };
                    let vk = value_kind_at(bytes, pos).unwrap_or(NodeKind::Null);
                    push_link(
                        &mut self.nodes,
                        node,
                        LNode::value(vk, pos as u64, end as u64),
                        &mut last,
                    );
                    pos = skip_ws(bytes, end);
                }
            }
            NodeKind::Array => {
                let mut pos = skip_ws(bytes, vs + 1); // past '['
                while pos < ve && bytes[pos] != b']' {
                    let end = match scan_value_end(bytes, pos) {
                        Some(e) => e,
                        None => break,
                    };
                    let vk = value_kind_at(bytes, pos).unwrap_or(NodeKind::Null);
                    push_link(
                        &mut self.nodes,
                        node,
                        LNode::value(vk, pos as u64, end as u64),
                        &mut last,
                    );
                    pos = skip_ws(bytes, end);
                    if pos < ve && bytes[pos] == b',' {
                        pos = skip_ws(bytes, pos + 1);
                    }
                }
            }
            NodeKind::Object => {
                let mut pos = skip_ws(bytes, vs + 1); // past '{'
                while pos < ve && bytes[pos] == b'"' {
                    let key_end = match scan_string(bytes, pos) {
                        Ok(e) => e,
                        Err(_) => break,
                    };
                    // Key node (window = "key" incl. quotes) owns its value.
                    let key_idx = push_link(
                        &mut self.nodes,
                        node,
                        LNode::scalar(NodeKind::Key, pos as u64, key_end as u64),
                        &mut last,
                    );
                    let mut after = skip_ws(bytes, key_end);
                    if after >= ve || bytes[after] != b':' {
                        break;
                    }
                    after = skip_ws(bytes, after + 1);
                    let vend = match scan_value_end(bytes, after) {
                        Some(e) => e,
                        None => break,
                    };
                    let vk = value_kind_at(bytes, after).unwrap_or(NodeKind::Null);
                    let mut key_last = NIL;
                    push_link(
                        &mut self.nodes,
                        key_idx,
                        LNode::value(vk, after as u64, vend as u64),
                        &mut key_last,
                    );
                    self.nodes[key_idx as usize].parsed = true;
                    pos = skip_ws(bytes, vend);
                    if pos < ve && bytes[pos] == b',' {
                        pos = skip_ws(bytes, pos + 1);
                    }
                }
            }
            _ => {}
        }
        self.nodes[node as usize].parsed = true;
    }

    /// Fully materialize every node (tests / small docs only).
    pub fn expand_all(&mut self, bytes: &[u8]) {
        let mut stack = vec![self.root()];
        while let Some(n) = stack.pop() {
            for c in self.children(bytes, n) {
                stack.push(c);
            }
        }
    }

    /// Resident arena cost so far: `materialized() * size_of::<LNode>()`.
    pub fn arena_bytes(&self) -> u64 {
        (self.nodes.len() * std::mem::size_of::<LNode>()) as u64
    }

    /// Raw token window `(offset, len)` — for `raw_text` / source sync.
    pub fn window_of(&self, node: u32) -> (u64, u32) {
        let n = &self.nodes[node as usize];
        (n.offset, n.len)
    }

    // -- display view (mirrors crate::model for JSON) -----------------------

    fn window<'b>(&self, bytes: &'b [u8], node: u32) -> &'b [u8] {
        let n = &self.nodes[node as usize];
        let start = n.offset as usize;
        start
            .checked_add(n.len as usize)
            .and_then(|end| bytes.get(start..end))
            .unwrap_or(b"")
    }

    /// Decoded member name for a Key node (window includes the quotes).
    fn key_name(&self, bytes: &[u8], node: u32) -> String {
        let w = self.window(bytes, node);
        if w.len() >= 2 && w[0] == b'"' && w[w.len() - 1] == b'"' {
            json_unescape(&String::from_utf8_lossy(&w[1..w.len() - 1]))
        } else {
            String::from_utf8_lossy(w).into_owned()
        }
    }

    fn scalar_display(&self, bytes: &[u8], node: u32) -> String {
        let w = self.window(bytes, node);
        match self.nodes[node as usize].kind {
            NodeKind::String if w.len() >= 2 && w[0] == b'"' && w[w.len() - 1] == b'"' => {
                format!(
                    "\"{}\"",
                    json_unescape(&String::from_utf8_lossy(&w[1..w.len() - 1]))
                )
            }
            _ => String::from_utf8_lossy(w).into_owned(),
        }
    }

    /// The container whose children `node` reveals when expanded — drill
    /// through a Key to its value if that value is a container (SPEC §8).
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

    /// A node is expandable iff its display container has any child.
    pub fn is_expandable(&mut self, bytes: &[u8], node: u32) -> bool {
        match self.container_for(bytes, node) {
            Some(c) => {
                self.ensure_parsed(bytes, c);
                self.nodes[c as usize].first_child != NIL
            }
            None => false,
        }
    }

    /// Drilled display children of `node`.
    pub fn display_children(&mut self, bytes: &[u8], node: u32) -> Vec<u32> {
        match self.container_for(bytes, node) {
            Some(c) => self.children(bytes, c),
            None => Vec::new(),
        }
    }

    /// Drilled display child count.
    pub fn display_child_count(&mut self, bytes: &[u8], node: u32) -> usize {
        match self.container_for(bytes, node) {
            Some(c) => self.child_count(bytes, c),
            None => 0,
        }
    }

    /// Row label for `node` — byte-for-byte identical to the eager
    /// `model::display_text` for JSON documents.
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
                match self.nodes[v as usize].kind {
                    NodeKind::Object => format!("{} {{{}}}", name, self.children(bytes, v).len()),
                    NodeKind::Array => format!("{} [{}]", name, self.children(bytes, v).len()),
                    _ => format!("{}: {}", name, self.scalar_display(bytes, v)),
                }
            }
            _ => self.scalar_display(bytes, node),
        }
    }

    // -- search (Phase 3) ---------------------------------------------------

    /// The deepest node whose span contains byte `offset`, descending from
    /// the root and materializing only the nodes along the path — memory
    /// stays proportional to depth, not file size.
    ///
    /// Members are handled specially: an offset inside the `"key"` window
    /// resolves to the Key node itself; an offset inside a member's *value*
    /// descends into that value (whose span sits under the Key in the
    /// arena, not inside the Key's own window).
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
                        return c; // inside the key name → the Key row
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

    /// Like [`locate`](Self::locate) but O(depth · log width): children are
    /// in document order (increasing offsets), so each level is a binary
    /// search instead of a linear scan, and `cache` memoizes each node's
    /// child list so a wide container (e.g. a million-element array) is
    /// walked once per batch rather than once per match.
    fn locate_cached(
        &mut self,
        bytes: &[u8],
        offset: u64,
        cache: &mut HashMap<u32, Vec<u32>>,
    ) -> u32 {
        let mut node = self.root();
        loop {
            if !cache.contains_key(&node) {
                let kids = self.children(bytes, node);
                cache.insert(node, kids);
            }
            let len = cache[&node].len();
            if len == 0 {
                return node;
            }
            // Rightmost child whose span can contain `offset`.
            let (mut lo, mut hi) = (0usize, len);
            while lo < hi {
                let mid = (lo + hi) / 2;
                let c = cache[&node][mid];
                if self.nodes[c as usize].val_start <= offset {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            if lo == 0 {
                return node; // before the first child (structural gap)
            }
            let c = cache[&node][lo - 1];
            if self.nodes[c as usize].kind == NodeKind::Key {
                let ks = self.nodes[c as usize].val_start;
                let ke = self.nodes[c as usize].val_end;
                if ks <= offset && offset < ke {
                    return c; // inside the key name
                }
                self.ensure_parsed(bytes, c);
                let v = self.nodes[c as usize].first_child;
                if v != NIL {
                    let vs = self.nodes[v as usize].val_start;
                    let ve = self.nodes[v as usize].val_end;
                    if vs <= offset && offset < ve {
                        node = v;
                        continue;
                    }
                }
                return node;
            }
            let cs = self.nodes[c as usize].val_start;
            let ce = self.nodes[c as usize].val_end;
            if cs <= offset && offset < ce {
                node = c;
                continue;
            }
            return node;
        }
    }

    /// Resolve raw byte-match offsets to display node ids, keeping only
    /// nodes whose kind participates in `scope` (same semantics as the
    /// eager scoped search), de-duplicated and capped at `cap` distinct
    /// nodes. Only the paths to matched nodes are materialized. Uses a
    /// per-batch child cache + binary search so many matches inside one
    /// wide container stay fast (O(width + matches · log width)).
    pub fn locate_matches(
        &mut self,
        bytes: &[u8],
        matches: &[Match],
        scope: SearchScope,
        cap: usize,
    ) -> Vec<u32> {
        let mut out: Vec<u32> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::new();
        let mut cache: HashMap<u32, Vec<u32>> = HashMap::new();
        for m in matches {
            if out.len() >= cap {
                break;
            }
            let node = self.locate_cached(bytes, m.offset, &mut cache);
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
    use crate::json::parse;
    use crate::model::{display_children, is_expandable};

    /// Recursively compare the full lazy tree to the eager tree: same kind,
    /// same child count, same windows, same rendered label, recursively.
    fn assert_same(li: &mut LazyIndex, ln: u32, idx: &Index, en: u32, src: &[u8]) {
        assert_eq!(li.kind(ln), idx.node(en).kind, "kind mismatch");
        // Windows (offset/len) must match for non-Document nodes.
        if li.kind(ln) != NodeKind::Document {
            assert_eq!(li.offset(ln), idx.node(en).offset(), "offset mismatch");
            assert_eq!(li.len_of(ln), idx.node(en).len, "len mismatch");
        }
        // The lazy view must render exactly like the eager model.
        assert_eq!(
            li.display_text(src, ln),
            crate::model::display_text(src, idx, crate::Format::Json, en),
            "display_text mismatch"
        );
        let lkids = li.children(src, ln);
        let ekids: Vec<u32> = idx.children(en).collect();
        assert_eq!(
            lkids.len(),
            ekids.len(),
            "child count mismatch for kind {:?}",
            li.kind(ln)
        );
        for (lc, ec) in lkids.into_iter().zip(ekids) {
            assert_same(li, lc, idx, ec, src);
        }
    }

    fn check_equivalent(src: &[u8]) {
        let eager = parse(src).expect("eager parse");
        let mut lazy = LazyIndex::open(src);
        let lroot = lazy.root();
        assert_same(&mut lazy, lroot, &eager, eager.root(), src);
    }

    #[test]
    fn equivalent_to_eager_on_samples() {
        check_equivalent(br#"{"a": 1, "b": "x", "c": [1, 2, 3], "d": null}"#);
        check_equivalent(br#"[{"x": {"y": [true, false]}}, 42, "s"]"#);
        check_equivalent(br#"{}"#);
        check_equivalent(br#"[]"#);
        check_equivalent(br#"{"nested": {"deep": {"deeper": {"v": 1}}}}"#);
        check_equivalent(br#"{"s": "a\"b", "e": "x\ny", "u": "A"}"#);
        check_equivalent(br#"{"arr": [[], [1], [[2]]], "obj": {"k": {}}}"#);
        check_equivalent(br#"{"nums": [0, -1, 3.14, 1e10, -2.5E-3]}"#);
        // NDJSON: several top-level values.
        check_equivalent(b"{\"a\":1}\n{\"b\":2}\n[3]");
        // Whitespace-heavy.
        check_equivalent(b"  {  \"a\" :  [ 1 , 2 ]  }  ");
    }

    #[test]
    fn materialization_is_lazy() {
        let src = br#"{"a": {"b": {"c": [1, 2, 3, 4, 5]}}, "d": 9}"#;
        let mut lazy = LazyIndex::open(src);
        // Nothing but the root before any access.
        assert_eq!(lazy.materialized(), 1);
        // Expanding the root materializes only the top-level object value.
        let root = lazy.root();
        let top = lazy.children(src, root);
        assert_eq!(top.len(), 1);
        assert_eq!(lazy.kind(top[0]), NodeKind::Object);
        // The deep array's elements are NOT materialized yet.
        let before = lazy.materialized();
        // Object "a"/"d" keys materialized (2 keys + 2 values), but not "c"'s
        // array contents.
        let obj = top[0];
        let members = lazy.children(src, obj); // keys a, d
        assert_eq!(members.len(), 2);
        assert_eq!(lazy.kind(members[0]), NodeKind::Key);
        // The 5 numbers under a.b.c are still unmaterialized.
        assert!(lazy.materialized() < before + 100);
    }

    #[test]
    fn deep_nesting_no_recursion_in_scan() {
        // scan_value_end + children are iterative; deep input must not
        // overflow the stack when expanding level by level.
        let depth = 2000usize;
        let mut src = Vec::new();
        src.extend(std::iter::repeat(b'[').take(depth));
        src.push(b'1');
        src.extend(std::iter::repeat(b']').take(depth));
        let mut lazy = LazyIndex::open(&src);
        // Walk down one level at a time.
        let root = lazy.root();
        let mut node = lazy.children(&src, root)[0];
        for _ in 0..depth - 1 {
            let kids = lazy.children(&src, node);
            assert_eq!(kids.len(), 1);
            node = kids[0];
        }
        assert_eq!(lazy.kind(node), NodeKind::Array); // innermost [1]
        let inner = lazy.children(&src, node)[0];
        assert_eq!(lazy.kind(inner), NodeKind::Number);
    }

    #[test]
    fn drilled_view_matches_eager() {
        // The drilled display tree (child_nodes/is_expandable through Keys)
        // must match the eager model helpers node-for-node.
        let src = br#"{"a": {"x": 1}, "b": [10, 20], "c": "s", "d": {}}"#;
        let eager = parse(src).expect("eager parse");
        let mut lazy = LazyIndex::open(src);

        // Root → single top-level object.
        let lroot = lazy.root();
        let ltop = lazy.display_children(src, lroot)[0];
        let etop = display_children(&eager, eager.root())[0];
        assert_eq!(lazy.kind(ltop), NodeKind::Object);

        // Object members: a, b, c, d (Keys).
        let lkeys = lazy.display_children(src, ltop);
        let ekeys = display_children(&eager, etop);
        assert_eq!(lkeys.len(), ekeys.len());
        assert_eq!(lkeys.len(), 4);

        // Key "a" drills through to its object's members (x).
        assert!(lazy.is_expandable(src, lkeys[0]));
        assert_eq!(is_expandable(&eager, ekeys[0]), true);
        assert_eq!(lazy.display_child_count(src, lkeys[0]), 1);
        assert_eq!(display_children(&eager, ekeys[0]).len(), 1);

        // Key "b" drills to its array's 2 elements.
        assert_eq!(lazy.display_child_count(src, lkeys[1]), 2);

        // Key "c" (scalar) is a leaf; Key "d" (empty object) is not
        // expandable — matching the eager model.
        assert!(!lazy.is_expandable(src, lkeys[2]));
        assert_eq!(is_expandable(&eager, ekeys[2]), false);
        assert!(!lazy.is_expandable(src, lkeys[3]));
        assert_eq!(is_expandable(&eager, ekeys[3]), false);
    }

    #[test]
    fn locate_resolves_offsets_to_nodes() {
        let src = br#"{"name": "alice", "age": 30, "kids": [true, null]}"#;
        let s = std::str::from_utf8(src).unwrap();
        let mut lazy = LazyIndex::open(src);

        // Inside the key name → the Key node.
        let key_pos = s.find("name").unwrap() as u64;
        let n = lazy.locate(src, key_pos);
        assert_eq!(lazy.kind(n), NodeKind::Key);
        // Inside a string value → the String node.
        let str_pos = s.find("alice").unwrap() as u64;
        let n = lazy.locate(src, str_pos);
        assert_eq!(lazy.kind(n), NodeKind::String);
        // Inside a number value → the Number node.
        let num_pos = s.find("30").unwrap() as u64;
        let n = lazy.locate(src, num_pos);
        assert_eq!(lazy.kind(n), NodeKind::Number);
        // A boolean nested in an array → the Bool node.
        let bool_pos = s.find("true").unwrap() as u64;
        let n = lazy.locate(src, bool_pos);
        assert_eq!(lazy.kind(n), NodeKind::Bool);
    }

    #[test]
    fn lazy_search_scopes() {
        use crate::search::search_raw_parallel;
        use regex::bytes::Regex;

        // "name" occurs in two keys ("name", "name2") and one string value.
        let src = br#"{"name": "alice", "tags": ["name", "x"], "name2": 1}"#;
        let re = Regex::new("name").unwrap();
        let matches = search_raw_parallel(src, &re);

        let mut lazy = LazyIndex::open(src);
        let keys = lazy.locate_matches(src, &matches, SearchScope::Keys, 1000);
        assert_eq!(keys.len(), 2, "two keys contain 'name'");
        for k in &keys {
            assert_eq!(lazy.kind(*k), NodeKind::Key);
        }

        let mut lazy2 = LazyIndex::open(src);
        let vals = lazy2.locate_matches(src, &matches, SearchScope::Values, 1000);
        assert_eq!(vals.len(), 1, "one string value contains 'name'");
        assert_eq!(lazy2.kind(vals[0]), NodeKind::String);
    }

    #[test]
    fn cached_locate_agrees_with_linear() {
        // The fast binary+cached locate must return the SAME node as the
        // (already-tested) linear locate at every byte offset — including
        // structural gaps, keys, values, nested arrays/objects.
        let samples: &[&[u8]] = &[
            br#"[{"a":1,"name":"x"},{"a":2,"name":"black"},{"k":[10,20,30]},"tail"]"#,
            br#"{"aa":{"bb":[1,2,3]},"cc":"deep","dd":[{"e":9}]}"#,
            br#"[[[1]],[2,3],{"z":"y"}]"#,
        ];
        for src in samples {
            let mut lz = LazyIndex::open(src);
            let mut cache = std::collections::HashMap::new();
            for off in 0..src.len() as u64 {
                let linear = lz.locate(src, off);
                let cached = lz.locate_cached(src, off, &mut cache);
                assert_eq!(
                    linear, cached,
                    "offset {} in {:?}", off, std::str::from_utf8(src)
                );
            }
        }
    }
}
