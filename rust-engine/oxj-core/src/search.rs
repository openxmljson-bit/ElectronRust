//! Parallel regex search (SPEC §9).
//!
//! Two complementary paths:
//!
//! - **Raw parallel scan** over the mapped bytes: the buffer is split into
//!   8 MiB chunks with a 64 KiB overlap so a match straddling a boundary is
//!   found exactly once (a match is attributed to the chunk where it
//!   *starts*). Each chunk is scanned front-to-back by the `regex` crate
//!   (SIMD `memchr` prefilters), which is cache-friendly.
//! - **Scoped scan** using the index: the scope restricts scanning to nodes
//!   of the relevant kind, skipping irrelevant bytes entirely.
//!
//! Scope kind mapping: Keys → `Key`, `ElementOpen`; Values → `String`,
//! `Number`, `Bool`, `Null`, `Text`, `CData`; Attributes → `Attribute`;
//! All → every node except the synthetic `Document`.

use crate::index::{Index, NodeKind};
use rayon::prelude::*;
use regex::bytes::Regex;
use std::sync::mpsc::SyncSender;

/// Chunk size for the raw parallel scan.
pub const CHUNK: usize = 8 * 1024 * 1024;
/// Overlap so a match straddling a chunk boundary is still found. A single
/// match longer than this cannot be completed across a seam — a documented
/// bound, matching the single-token expectations of SPEC §17.1.
pub const OVERLAP: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Match {
    pub offset: u64,
    pub len: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchScope {
    All,
    Keys,
    Values,
    Attributes,
}

impl SearchScope {
    pub fn from_name(name: &str) -> Option<SearchScope> {
        match name.to_ascii_lowercase().as_str() {
            "all" => Some(SearchScope::All),
            "keys" => Some(SearchScope::Keys),
            "values" => Some(SearchScope::Values),
            "attributes" => Some(SearchScope::Attributes),
            _ => None,
        }
    }

    /// Whether a node kind participates in this scope (SPEC §9).
    #[inline]
    pub fn includes(self, kind: NodeKind) -> bool {
        match self {
            SearchScope::All => kind != NodeKind::Document,
            SearchScope::Keys => matches!(kind, NodeKind::Key | NodeKind::ElementOpen),
            SearchScope::Values => matches!(
                kind,
                NodeKind::String
                    | NodeKind::Number
                    | NodeKind::Bool
                    | NodeKind::Null
                    | NodeKind::Text
                    | NodeKind::CData
            ),
            SearchScope::Attributes => matches!(kind, NodeKind::Attribute),
        }
    }
}

/// Scan one chunk: matches must *start* inside `[start, start + CHUNK)`;
/// the overlap region only completes matches that straddle the boundary.
fn scan_chunk(bytes: &[u8], re: &Regex, chunk_start: usize) -> Vec<Match> {
    let end = (chunk_start + CHUNK + OVERLAP).min(bytes.len());
    let mut out = Vec::new();
    for m in re.find_iter(&bytes[chunk_start..end]) {
        if m.start() >= CHUNK {
            break; // attributed to the next chunk
        }
        out.push(Match {
            offset: (chunk_start + m.start()) as u64,
            len: (m.end() - m.start()) as u32,
        });
    }
    out
}

/// Raw parallel scan over the whole mapped buffer (scope: everything).
pub fn search_raw_parallel(bytes: &[u8], re: &Regex) -> Vec<Match> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let nchunks = (bytes.len() + CHUNK - 1) / CHUNK;
    let mut matches: Vec<Match> = (0..nchunks)
        .into_par_iter()
        .flat_map_iter(|i| scan_chunk(bytes, re, i * CHUNK))
        .collect();
    matches.sort_by_key(|m| (m.offset, m.len));
    // find_iter is non-overlapping *within* a chunk but chunks scan
    // independently, so a pattern that can self-overlap right at a seam
    // could be reported by both sides; dedup keeps "found exactly once".
    matches.dedup();
    matches
}

/// Unified search entry point (SPEC §10.1): `All` runs the raw chunked
/// scan; any narrower scope runs the index-guided scan over node windows.
pub fn search_parallel(
    bytes: &[u8],
    re: &Regex,
    scope: SearchScope,
    index: &Index,
) -> Vec<Match> {
    if scope == SearchScope::All {
        return search_raw_parallel(bytes, re);
    }
    let mut matches: Vec<Match> = (0..index.len() as u32)
        .into_par_iter()
        .flat_map_iter(|i| {
            let node = index.node(i);
            let mut out = Vec::new();
            if scope.includes(node.kind) {
                let start = node.offset() as usize;
                let end = start.checked_add(node.len as usize);
                if let Some(window) = end.and_then(|e| bytes.get(start..e)) {
                    for m in re.find_iter(window) {
                        out.push(Match {
                            offset: (start + m.start()) as u64,
                            len: (m.end() - m.start()) as u32,
                        });
                    }
                }
            }
            out
        })
        .collect();
    matches.sort_by_key(|m| (m.offset, m.len));
    matches.dedup();
    matches
}

/// Node-id search used by the bindings: returns the (sorted) ids of nodes
/// whose window contains a match, so the UI can highlight rows.
pub fn search_nodes(bytes: &[u8], re: &Regex, scope: SearchScope, index: &Index) -> Vec<u32> {
    let mut ids: Vec<u32> = (0..index.len() as u32)
        .into_par_iter()
        .filter(|&i| {
            let node = index.node(i);
            if !scope.includes(node.kind) {
                return false;
            }
            // Skip Object/Array container windows: their window spans the
            // whole subtree, so testing them is both redundant (any real hit
            // is caught by a leaf/Key inside) and O(subtree) — under the All
            // scope this re-scans the entire file once per nesting level,
            // which is catastrophic on huge nested documents. The app also
            // discards container node ids from All-scope results anyway.
            // (ElementOpen is kept: its window is just the tag name.)
            if matches!(node.kind, NodeKind::Object | NodeKind::Array) {
                return false;
            }
            let start = node.offset() as usize;
            match start
                .checked_add(node.len as usize)
                .and_then(|end| bytes.get(start..end))
            {
                Some(window) => re.is_match(window),
                None => false,
            }
        })
        .collect();
    ids.sort_unstable();
    ids
}

/// Streaming raw scan: delivers batches of matches through a bounded
/// channel so the UI can highlight incrementally with no progress bar.
/// Chunks are scanned in parallel; each sends its batch as it finishes.
pub fn search_streaming(bytes: &[u8], re: &Regex, sender: SyncSender<Vec<Match>>) {
    if bytes.is_empty() {
        return;
    }
    let nchunks = (bytes.len() + CHUNK - 1) / CHUNK;
    (0..nchunks).into_par_iter().for_each_with(sender, |s, i| {
        let batch = scan_chunk(bytes, re, i * CHUNK);
        if !batch.is_empty() {
            // A closed receiver just stops delivery; not an error.
            let _ = s.send(batch);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn scope_kind_mapping() {
        assert!(SearchScope::All.includes(NodeKind::String));
        assert!(!SearchScope::All.includes(NodeKind::Document));
        assert!(SearchScope::Keys.includes(NodeKind::Key));
        assert!(SearchScope::Keys.includes(NodeKind::ElementOpen));
        assert!(!SearchScope::Keys.includes(NodeKind::String));
        assert!(SearchScope::Values.includes(NodeKind::Number));
        assert!(SearchScope::Values.includes(NodeKind::CData));
        assert!(!SearchScope::Values.includes(NodeKind::Attribute));
        assert!(SearchScope::Attributes.includes(NodeKind::Attribute));
    }

    #[test]
    fn raw_scan_finds_all_matches() {
        let bytes = b"abc needle def needle ghi";
        let re = Regex::new("needle").unwrap();
        let matches = search_raw_parallel(bytes, &re);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0], Match { offset: 4, len: 6 });
        assert_eq!(matches[1], Match { offset: 15, len: 6 });
    }

    #[test]
    fn scoped_search_restricts_kinds() {
        let src = br#"{"needle": "needle", "x": ["needle", 1]}"#;
        let idx = parse(src).unwrap();
        let re = Regex::new("needle").unwrap();
        // Keys: only the "needle" key window matches.
        let keys = search_nodes(src, &re, SearchScope::Keys, &idx);
        assert_eq!(keys.len(), 1);
        assert_eq!(idx.node(keys[0]).kind, NodeKind::Key);
        // Values: the two string values.
        let values = search_nodes(src, &re, SearchScope::Values, &idx);
        assert_eq!(values.len(), 2);
        for &v in &values {
            assert_eq!(idx.node(v).kind, NodeKind::String);
        }
        // All: keys, values and every enclosing container window.
        let all = search_nodes(src, &re, SearchScope::All, &idx);
        assert!(all.len() > values.len());
    }

    #[test]
    fn scoped_matches_have_absolute_offsets() {
        let src = br#"{"a": "xxneedlexx"}"#;
        let idx = parse(src).unwrap();
        let re = Regex::new("needle").unwrap();
        let ms = search_parallel(src, &re, SearchScope::Values, &idx);
        assert_eq!(ms.len(), 1);
        let m = &ms[0];
        assert_eq!(
            &src[m.offset as usize..m.offset as usize + m.len as usize],
            b"needle"
        );
    }

    #[test]
    fn streaming_delivers_batches() {
        let bytes = b"one needle two needle";
        let re = Regex::new("needle").unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(16);
        search_streaming(bytes, &re, tx);
        let total: usize = rx.iter().map(|b: Vec<Match>| b.len()).sum();
        assert_eq!(total, 2);
    }

    // Chunk-boundary behavior is exercised with a shrunken chunk size via
    // scan_chunk directly (allocating >8 MiB in unit tests is wasteful).
    #[test]
    fn boundary_match_attributed_to_starting_chunk() {
        // Simulate: match starts inside the chunk, ends in the overlap.
        let mut bytes = vec![b'a'; CHUNK + 16];
        let tail = CHUNK - 3; // "needle" starts 3 bytes before the boundary
        bytes[tail..tail + 6].copy_from_slice(b"needle");
        let re = Regex::new("needle").unwrap();
        let first = scan_chunk(&bytes, &re, 0);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].offset as usize, tail);
        // The second chunk must NOT re-report it (start < its chunk base).
        let second = scan_chunk(&bytes, &re, CHUNK);
        assert!(second.is_empty());
        // End-to-end.
        let all = search_raw_parallel(&bytes, &re);
        assert_eq!(all.len(), 1);
    }
}
