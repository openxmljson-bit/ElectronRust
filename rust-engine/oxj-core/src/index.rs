//! The structural index: a flat array of fixed-size 32-byte node records
//! holding byte offsets into the mapping rather than copied data (SPEC §5).

/// "No such node" link sentinel.
pub const NIL: u32 = u32::MAX;

/// Hard cap on document nesting depth (SPEC §7.1).
pub const MAX_DEPTH: usize = 4096;

/// One-byte node tag shared by all three formats. Discriminants are stable
/// (SPEC §5.1); the Python binding exposes the name↔code map.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NodeKind {
    /// Synthetic root owning all top-level values.
    Document = 0,
    /// JSON object.
    Object = 1,
    /// JSON array.
    Array = 2,
    /// Object member name; owns its value as its single child.
    Key = 3,
    /// JSON/CSV string, XML attribute value.
    String = 4,
    /// Numeric scalar.
    Number = 5,
    /// `true` / `false`.
    Bool = 6,
    /// `null`.
    Null = 7,
    /// XML element; window = tag name; owns attrs/text/children.
    ElementOpen = 8,
    /// Reserved.
    ElementClose = 9,
    /// Reserved.
    ElementSelfClose = 10,
    /// XML character data.
    Text = 11,
    /// XML attribute name; owns its value string as child.
    Attribute = 12,
    /// XML `<![CDATA[…]]>` inner content.
    CData = 13,
    /// Reserved.
    Comment = 14,
}

impl NodeKind {
    pub const ALL: [NodeKind; 15] = [
        NodeKind::Document,
        NodeKind::Object,
        NodeKind::Array,
        NodeKind::Key,
        NodeKind::String,
        NodeKind::Number,
        NodeKind::Bool,
        NodeKind::Null,
        NodeKind::ElementOpen,
        NodeKind::ElementClose,
        NodeKind::ElementSelfClose,
        NodeKind::Text,
        NodeKind::Attribute,
        NodeKind::CData,
        NodeKind::Comment,
    ];

    #[inline]
    pub fn is_container(self) -> bool {
        matches!(
            self,
            NodeKind::Document
                | NodeKind::Object
                | NodeKind::Array
                | NodeKind::Key
                | NodeKind::ElementOpen
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            NodeKind::Document => "Document",
            NodeKind::Object => "Object",
            NodeKind::Array => "Array",
            NodeKind::Key => "Key",
            NodeKind::String => "String",
            NodeKind::Number => "Number",
            NodeKind::Bool => "Bool",
            NodeKind::Null => "Null",
            NodeKind::ElementOpen => "ElementOpen",
            NodeKind::ElementClose => "ElementClose",
            NodeKind::ElementSelfClose => "ElementSelfClose",
            NodeKind::Text => "Text",
            NodeKind::Attribute => "Attribute",
            NodeKind::CData => "CData",
            NodeKind::Comment => "Comment",
        }
    }
}

/// A node record (SPEC §5.2). No node owns heap data; a value is read by
/// slicing the mapping at `offset .. offset + len`.
///
/// Packed to 24 bytes (was 32): the byte offset is split into a 32-bit low
/// word plus an 8-bit high word, so the struct's alignment drops from 8
/// (a `u64` field) to 4 and the trailing padding disappears. This supports
/// offsets up to 2^40 (1 TiB) — far beyond the ~10 GB target — while
/// cutting the index's memory footprint by 25% (e.g. 4.6 GB → 3.5 GB for
/// 145M nodes), which relieves memory pressure on very large files.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Node {
    /// Byte length of the raw token window.
    pub len: u32,
    /// Parent node index, or NIL.
    pub parent: u32,
    /// First child index, or NIL.
    pub first_child: u32,
    /// Next sibling index, or NIL.
    pub next_sibling: u32,
    /// Low 32 bits of the absolute byte offset.
    offset_lo: u32,
    /// One-byte kind tag.
    pub kind: NodeKind,
    /// High 8 bits of the absolute byte offset (offset = hi<<32 | lo).
    offset_hi: u8,
}

// Compile-time layout guarantee (packed layout; requirement N2 updated).
const _: () = assert!(std::mem::size_of::<Node>() == 24);

impl Node {
    #[inline]
    fn new(kind: NodeKind, offset: u64, len: u32) -> Node {
        debug_assert!(offset < (1u64 << 40), "offset exceeds 1 TiB");
        Node {
            len,
            parent: NIL,
            first_child: NIL,
            next_sibling: NIL,
            offset_lo: offset as u32,
            kind,
            offset_hi: (offset >> 32) as u8,
        }
    }

    /// Absolute byte offset of the token in the mapping.
    #[inline]
    pub fn offset(&self) -> u64 {
        ((self.offset_hi as u64) << 32) | self.offset_lo as u64
    }
}

/// The structural index. Node 0 is always the `Document` root.
#[derive(Debug)]
pub struct Index {
    nodes: Vec<Node>,
}

impl Index {
    #[inline]
    pub fn root(&self) -> u32 {
        0
    }

    #[inline]
    pub fn node(&self, i: u32) -> &Node {
        &self.nodes[i as usize]
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Iterate the children of `parent` in document order.
    pub fn children(&self, parent: u32) -> Children<'_> {
        Children {
            index: self,
            cur: self.node(parent).first_child,
        }
    }

    pub fn child_count(&self, parent: u32) -> usize {
        self.children(parent).count()
    }

    /// Bytes cost of the index: `size_of::<Node>()` (24) bytes per node.
    pub fn byte_size(&self) -> u64 {
        self.nodes.len() as u64 * std::mem::size_of::<Node>() as u64
    }
}

pub struct Children<'a> {
    index: &'a Index,
    cur: u32,
}

impl<'a> Iterator for Children<'a> {
    type Item = u32;

    #[inline]
    fn next(&mut self) -> Option<u32> {
        if self.cur == NIL {
            None
        } else {
            let c = self.cur;
            self.cur = self.index.node(c).next_sibling;
            Some(c)
        }
    }
}

/// Builds the index during one forward pass (SPEC §5.3). Keeps a stack of
/// open containers, each with its last-appended child, so linking a new
/// child is O(1). No recursion anywhere (requirement N3).
pub struct IndexBuilder {
    nodes: Vec<Node>,
    /// Open container node indices; entry 0 is the Document root.
    stack: Vec<u32>,
    /// Last-appended child of each open container (parallel to `stack`).
    last_child: Vec<u32>,
}

impl IndexBuilder {
    pub fn new() -> IndexBuilder {
        IndexBuilder {
            nodes: vec![Node::new(NodeKind::Document, 0, 0)],
            stack: vec![0],
            last_child: vec![NIL],
        }
    }

    /// Create a node and link it as the next child of the open container.
    fn push_node(&mut self, kind: NodeKind, offset: u64, len: u32) -> u32 {
        let idx = self.nodes.len() as u32;
        let parent = *self.stack.last().expect("builder stack never empty");
        let mut node = Node::new(kind, offset, len);
        node.parent = parent;
        self.nodes.push(node);
        let last = *self.last_child.last().unwrap();
        if last == NIL {
            self.nodes[parent as usize].first_child = idx;
        } else {
            self.nodes[last as usize].next_sibling = idx;
        }
        *self.last_child.last_mut().unwrap() = idx;
        idx
    }

    /// Append a scalar/text node.
    pub fn leaf(&mut self, kind: NodeKind, offset: u64, len: u32) -> u32 {
        self.push_node(kind, offset, len)
    }

    /// Open a container whose byte span is `end − start` (set by `close`).
    pub fn open(&mut self, kind: NodeKind, offset: u64) -> u32 {
        let idx = self.push_node(kind, offset, 0);
        self.stack.push(idx);
        self.last_child.push(NIL);
        idx
    }

    /// Open a container whose window length is known up front and must be
    /// preserved — used for `Key`, `Attribute` and `ElementOpen`, whose
    /// window is just the name. Close it with `pop`.
    pub fn open_fixed(&mut self, kind: NodeKind, offset: u64, len: u32) -> u32 {
        let idx = self.push_node(kind, offset, len);
        self.stack.push(idx);
        self.last_child.push(NIL);
        idx
    }

    /// Close the innermost `open` container, setting its span to
    /// `end − offset`. Saturates at u32::MAX for pathological >4 GiB spans
    /// (single-token size is capped; SPEC §17.1).
    pub fn close(&mut self, end: u64) {
        let idx = self.stack.pop().expect("close without open");
        self.last_child.pop();
        let start = self.nodes[idx as usize].offset();
        let node = &mut self.nodes[idx as usize];
        node.len = (end.saturating_sub(start)).min(u32::MAX as u64) as u32;
    }

    /// Close the innermost `open_fixed` container, preserving its window.
    pub fn pop(&mut self) {
        self.stack.pop().expect("pop without open");
        self.last_child.pop();
    }

    /// Current nesting depth (open containers, excluding the root).
    #[inline]
    pub fn depth(&self) -> usize {
        self.stack.len() - 1
    }

    /// Number of children appended so far to the Document root.
    pub fn root_child_count(&self) -> usize {
        // Root is node 0; walk its child list.
        let mut n = 0usize;
        let mut cur = self.nodes[0].first_child;
        while cur != NIL {
            n += 1;
            cur = self.nodes[cur as usize].next_sibling;
        }
        n
    }

    /// Window (offset, len) of the innermost open container — used by the
    /// XML parser to match close tags without copying names.
    pub fn top_window(&self) -> (NodeKind, u64, u32) {
        let idx = *self.stack.last().unwrap();
        let n = &self.nodes[idx as usize];
        (n.kind, n.offset(), n.len)
    }

    /// Byte offset of the innermost open container.
    pub fn top_offset(&self) -> u64 {
        let idx = *self.stack.last().unwrap();
        self.nodes[idx as usize].offset()
    }

    /// Finish the build: the Document root spans the whole input
    /// (saturating at u32::MAX for >4 GiB files — the root window is
    /// informational only; navigation never slices it).
    pub fn finish(mut self, total_len: u64) -> Index {
        debug_assert_eq!(self.stack.len(), 1, "unclosed containers at finish");
        self.nodes[0].len = total_len.min(u32::MAX as u64) as u32;
        Index { nodes: self.nodes }
    }
}

impl Default for IndexBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_is_exactly_24_bytes() {
        assert_eq!(std::mem::size_of::<Node>(), 24);
    }

    #[test]
    fn offset_round_trips_beyond_4gb() {
        // The split lo/hi offset must reconstruct large offsets exactly.
        let n = Node::new(NodeKind::String, 5_000_000_000, 7);
        assert_eq!(n.offset(), 5_000_000_000);
        assert_eq!(n.len, 7);
    }

    #[test]
    fn builder_links_children_in_order() {
        let mut b = IndexBuilder::new();
        let arr = b.open(NodeKind::Array, 0);
        let a = b.leaf(NodeKind::Number, 1, 1);
        let c = b.leaf(NodeKind::Number, 3, 1);
        b.close(5);
        let idx = b.finish(5);
        assert_eq!(idx.node(idx.root()).first_child, arr);
        let kids: Vec<u32> = idx.children(arr).collect();
        assert_eq!(kids, vec![a, c]);
        assert_eq!(idx.child_count(arr), 2);
        assert_eq!(idx.node(arr).len, 5);
        assert_eq!(idx.node(a).parent, arr);
        assert_eq!(idx.node(c).parent, arr);
    }

    #[test]
    fn open_fixed_preserves_window() {
        let mut b = IndexBuilder::new();
        let k = b.open_fixed(NodeKind::Key, 1, 5);
        b.leaf(NodeKind::Null, 8, 4);
        b.pop();
        let idx = b.finish(13);
        assert_eq!(idx.node(k).offset(), 1);
        assert_eq!(idx.node(k).len, 5);
        assert_eq!(idx.child_count(k), 1);
    }

    #[test]
    fn depth_tracks_open_containers() {
        let mut b = IndexBuilder::new();
        assert_eq!(b.depth(), 0);
        b.open(NodeKind::Array, 0);
        assert_eq!(b.depth(), 1);
        b.open(NodeKind::Object, 1);
        assert_eq!(b.depth(), 2);
        b.close(2);
        b.close(3);
        assert_eq!(b.depth(), 0);
    }
}
