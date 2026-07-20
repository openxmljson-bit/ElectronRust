//! XML parser (SPEC §7.2).
//!
//! `<Tag …>…</Tag>` becomes an `ElementOpen` container whose window is just
//! the tag name; its children are its attributes, text, CDATA, and child
//! elements. `name="value"` becomes an `Attribute` node (window = name)
//! owning a `String` value child (window = inner value). Character data
//! becomes `Text`; `<![CDATA[…]]>` becomes `CData`. Comments, processing
//! instructions, and the doctype/declaration are recognized and skipped.
//! Whitespace-only text between elements is dropped as layout noise.
//!
//! Namespaces are NOT resolved (prefixes preserved verbatim) and entity
//! references are NOT decoded — deferred by design (SPEC §7.2).

use crate::index::{Index, IndexBuilder, NodeKind, MAX_DEPTH};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XmlError {
    pub offset: u64,
    pub message: String,
}

impl XmlError {
    fn new(offset: usize, message: &str) -> XmlError {
        XmlError {
            offset: offset as u64,
            message: message.to_string(),
        }
    }
}

impl fmt::Display for XmlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at byte {}", self.message, self.offset)
    }
}

impl std::error::Error for XmlError {}

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

/// Find `needle` in `haystack[from..]`; returns the absolute index.
fn find_from(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Parse well-formed XML into a structural index.
pub fn parse_xml(bytes: &[u8]) -> Result<Index, XmlError> {
    let n = bytes.len();
    let mut pos = 0usize;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        pos = 3;
    }

    let mut builder = IndexBuilder::new();

    while pos < n {
        // ---- character data up to the next '<' -------------------------
        let text_start = pos;
        while pos < n && bytes[pos] != b'<' {
            pos += 1;
        }
        if pos > text_start && !all_ws(&bytes[text_start..pos]) {
            builder.leaf(
                NodeKind::Text,
                text_start as u64,
                (pos - text_start) as u32,
            );
        }
        if pos >= n {
            break;
        }

        // ---- markup, bytes[pos] == '<' ---------------------------------
        let rest = &bytes[pos..];
        if rest.starts_with(b"<!--") {
            match find_from(bytes, pos + 4, b"-->") {
                Some(end) => pos = end + 3, // comments are skipped
                None => return Err(XmlError::new(pos, "unterminated comment")),
            }
        } else if rest.starts_with(b"<![CDATA[") {
            let inner = pos + 9;
            match find_from(bytes, inner, b"]]>") {
                Some(end) => {
                    // Window = the inner content only.
                    builder.leaf(NodeKind::CData, inner as u64, (end - inner) as u32);
                    pos = end + 3;
                }
                None => return Err(XmlError::new(pos, "unterminated CDATA section")),
            }
        } else if rest.starts_with(b"<!") {
            // Doctype (possibly with an internal subset in [ ... ]) — skipped.
            let mut i = pos + 2;
            let mut brackets = 0i32;
            loop {
                if i >= n {
                    return Err(XmlError::new(pos, "unterminated doctype"));
                }
                match bytes[i] {
                    b'[' => brackets += 1,
                    b']' => brackets -= 1,
                    b'>' if brackets == 0 => break,
                    _ => {}
                }
                i += 1;
            }
            pos = i + 1;
        } else if rest.starts_with(b"<?") {
            // XML declaration / processing instruction — skipped.
            match find_from(bytes, pos + 2, b"?>") {
                Some(end) => pos = end + 2,
                None => return Err(XmlError::new(pos, "unterminated processing instruction")),
            }
        } else if rest.starts_with(b"</") {
            // Close tag: must match the element on top of the stack.
            let mut i = pos + 2;
            let name_start = i;
            while i < n && !is_ws(bytes[i]) && bytes[i] != b'>' {
                i += 1;
            }
            if i == name_start {
                return Err(XmlError::new(name_start, "expected tag name"));
            }
            let name = &bytes[name_start..i];
            while i < n && is_ws(bytes[i]) {
                i += 1;
            }
            if i >= n || bytes[i] != b'>' {
                return Err(XmlError::new(i.min(n), "expected '>'"));
            }
            if builder.depth() == 0 {
                return Err(XmlError::new(pos, "unexpected close tag"));
            }
            let (kind, off, len) = builder.top_window();
            let open_name = &bytes[off as usize..off as usize + len as usize];
            if kind != NodeKind::ElementOpen || open_name != name {
                return Err(XmlError::new(pos, "mismatched close tag"));
            }
            builder.pop();
            pos = i + 1;
        } else {
            // Open tag.
            let mut i = pos + 1;
            let name_start = i;
            while i < n && !is_name_end(bytes[i]) {
                i += 1;
            }
            if i == name_start {
                return Err(XmlError::new(name_start, "expected tag name"));
            }
            if builder.depth() >= MAX_DEPTH {
                return Err(XmlError::new(pos, "nesting too deep"));
            }
            // Window = just the tag name (SPEC §5.1).
            builder.open_fixed(
                NodeKind::ElementOpen,
                name_start as u64,
                (i - name_start) as u32,
            );
            // Attribute loop.
            loop {
                while i < n && is_ws(bytes[i]) {
                    i += 1;
                }
                if i >= n {
                    return Err(XmlError::new(pos, "unterminated tag"));
                }
                match bytes[i] {
                    b'>' => {
                        i += 1;
                        break; // children follow
                    }
                    b'/' => {
                        // Self-closing: an ElementOpen with no children.
                        if i + 1 >= n || bytes[i + 1] != b'>' {
                            return Err(XmlError::new(i + 1, "expected '>'"));
                        }
                        builder.pop();
                        i += 2;
                        break;
                    }
                    b'=' => return Err(XmlError::new(i, "expected attribute name")),
                    _ => {
                        // Attribute: name="value" or name='value'.
                        let aname_start = i;
                        while i < n && !is_name_end(bytes[i]) {
                            i += 1;
                        }
                        let aname_len = i - aname_start;
                        while i < n && is_ws(bytes[i]) {
                            i += 1;
                        }
                        if i >= n || bytes[i] != b'=' {
                            return Err(XmlError::new(i.min(n), "expected '='"));
                        }
                        i += 1;
                        while i < n && is_ws(bytes[i]) {
                            i += 1;
                        }
                        if i >= n || (bytes[i] != b'"' && bytes[i] != b'\'') {
                            return Err(XmlError::new(i.min(n), "expected quoted attribute value"));
                        }
                        let quote = bytes[i];
                        let q_off = i;
                        i += 1;
                        let v_start = i;
                        while i < n && bytes[i] != quote {
                            i += 1;
                        }
                        if i >= n {
                            return Err(XmlError::new(q_off, "unterminated attribute value"));
                        }
                        // Attribute node (window = name) owning a String
                        // value child (window = inner value).
                        builder.open_fixed(
                            NodeKind::Attribute,
                            aname_start as u64,
                            aname_len as u32,
                        );
                        builder.leaf(NodeKind::String, v_start as u64, (i - v_start) as u32);
                        builder.pop();
                        i += 1;
                    }
                }
            }
            pos = i;
        }
    }

    if builder.depth() > 0 {
        let off = builder.top_offset();
        return Err(XmlError::new(off as usize, "unclosed element"));
    }
    Ok(builder.finish(n as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window<'a>(bytes: &'a [u8], idx: &Index, node: u32) -> &'a [u8] {
        let n = idx.node(node);
        &bytes[n.offset() as usize..n.offset() as usize + n.len as usize]
    }

    #[test]
    fn element_window_is_tag_name() {
        let src = b"<root><child a=\"1\">hi</child></root>";
        let idx = parse_xml(src).unwrap();
        let root = idx.node(idx.root()).first_child;
        assert_eq!(idx.node(root).kind, NodeKind::ElementOpen);
        assert_eq!(window(src, &idx, root), b"root");
        let child = idx.node(root).first_child;
        assert_eq!(window(src, &idx, child), b"child");
        let kids: Vec<NodeKind> = idx.children(child).map(|c| idx.node(c).kind).collect();
        assert_eq!(kids, vec![NodeKind::Attribute, NodeKind::Text]);
    }

    #[test]
    fn attribute_owns_string_value() {
        let src = b"<a name='va&lue'/>";
        let idx = parse_xml(src).unwrap();
        let el = idx.node(idx.root()).first_child;
        let attr = idx.node(el).first_child;
        assert_eq!(idx.node(attr).kind, NodeKind::Attribute);
        assert_eq!(window(src, &idx, attr), b"name");
        let val = idx.node(attr).first_child;
        assert_eq!(idx.node(val).kind, NodeKind::String);
        // Entities are not decoded (SPEC §2.2).
        assert_eq!(window(src, &idx, val), b"va&lue");
        assert_eq!(idx.child_count(attr), 1);
    }

    #[test]
    fn self_closing_has_no_children() {
        let src = b"<a><b/><c x=\"1\"/></a>";
        let idx = parse_xml(src).unwrap();
        let a = idx.node(idx.root()).first_child;
        let kids: Vec<u32> = idx.children(a).collect();
        assert_eq!(kids.len(), 2);
        assert_eq!(idx.child_count(kids[0]), 0);
        assert_eq!(idx.child_count(kids[1]), 1); // just the attribute
    }

    #[test]
    fn cdata_window_is_inner_content() {
        let src = b"<a><![CDATA[5 < 6 & 7 > 3]]></a>";
        let idx = parse_xml(src).unwrap();
        let a = idx.node(idx.root()).first_child;
        let cd = idx.node(a).first_child;
        assert_eq!(idx.node(cd).kind, NodeKind::CData);
        assert_eq!(window(src, &idx, cd), b"5 < 6 & 7 > 3");
    }

    #[test]
    fn comments_pis_doctype_are_skipped() {
        let src = b"<?xml version=\"1.0\"?><!DOCTYPE a [ <!ENTITY x \"y\"> ]><!-- hi --><a>t</a><!-- bye -->";
        let idx = parse_xml(src).unwrap();
        assert_eq!(idx.child_count(idx.root()), 1);
        let a = idx.node(idx.root()).first_child;
        assert_eq!(window(src, &idx, a), b"a");
    }

    #[test]
    fn whitespace_only_text_is_dropped() {
        let src = b"<a>\n  <b>x</b>\n  <b>y</b>\n</a>";
        let idx = parse_xml(src).unwrap();
        let a = idx.node(idx.root()).first_child;
        let kinds: Vec<NodeKind> = idx.children(a).map(|c| idx.node(c).kind).collect();
        assert_eq!(kinds, vec![NodeKind::ElementOpen, NodeKind::ElementOpen]);
    }

    #[test]
    fn namespace_prefixes_kept_verbatim() {
        let src = b"<p:a xmlns:p=\"urn:x\"><p:b/></p:a>";
        let idx = parse_xml(src).unwrap();
        let a = idx.node(idx.root()).first_child;
        assert_eq!(window(src, &idx, a), b"p:a");
    }

    #[test]
    fn rejections_carry_byte_offsets() {
        assert_eq!(parse_xml(b"<a></b>").unwrap_err().offset, 3);
        assert!(parse_xml(b"<a>").unwrap_err().message.contains("unclosed"));
        assert!(parse_xml(b"<a b></a>").is_err()); // attribute without value
        assert!(parse_xml(b"<a b=c></a>").is_err()); // unquoted value
        assert!(parse_xml(b"<a b=\"c></a>").is_err()); // unterminated value
        assert!(parse_xml(b"</a>").is_err()); // close without open
        assert!(parse_xml(b"<!-- x").is_err());
        assert!(parse_xml(b"<![CDATA[ x").is_err());
        assert!(parse_xml(b"<a><![CDATA[x]]>").is_err()); // unclosed element
    }

    #[test]
    fn deep_nesting_no_stack_overflow() {
        let depth = 2500usize;
        let mut src = Vec::new();
        for _ in 0..depth {
            src.extend_from_slice(b"<a>");
        }
        for _ in 0..depth {
            src.extend_from_slice(b"</a>");
        }
        let idx = parse_xml(&src).unwrap();
        assert_eq!(idx.len(), depth + 1);
    }

    #[test]
    fn max_depth_is_enforced() {
        let depth = MAX_DEPTH + 10;
        let mut src = Vec::new();
        for _ in 0..depth {
            src.extend_from_slice(b"<a>");
        }
        for _ in 0..depth {
            src.extend_from_slice(b"</a>");
        }
        let err = parse_xml(&src).unwrap_err();
        assert_eq!(err.message, "nesting too deep");
    }

    #[test]
    fn bom_is_skipped() {
        assert!(parse_xml(b"\xEF\xBB\xBF<a/>").is_ok());
    }
}
