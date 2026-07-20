//! oxj-core — the OPENXMLJSON engine.
//!
//! A zero-copy, memory-mapped structural index for very large JSON, XML and
//! CSV/TSV documents. The file is mapped once, parsed once into a flat array
//! of fixed-size (32-byte) node records holding byte offsets, and every
//! subsequent operation (tree navigation, display, search, export) works on
//! those offsets. See SPEC.md at the repository root.

pub mod csv;
pub mod index;
pub mod json;
pub mod lazy;
pub mod lazy_csv;
pub mod lazy_xml;
pub mod mapping;
pub mod model;
pub mod search;
pub mod xml;

pub use csv::{parse_csv, CsvOptions};
pub use index::{Index, IndexBuilder, Node, NodeKind, MAX_DEPTH, NIL};
pub use json::{parse, ParseError};
pub use mapping::Mapping;
pub use model::{
    container_for, display_text, highlight_span, is_expandable, node_at_offset,
    record_at_offset, Row, TreeModel,
};
pub use search::{
    search_nodes, search_parallel, search_raw_parallel, search_streaming, Match, SearchScope,
};
pub use xml::{parse_xml, XmlError};

use std::path::Path;

/// Detected / requested document format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Json,
    Xml,
    Csv,
    Tsv,
}

impl Format {
    /// Choose the parser from the file extension (requirement F8).
    ///
    /// `.xml` → Xml, `.csv` → Csv, `.tsv`/`.tab` → Tsv, everything else
    /// (including `.json`, `.jsonl`, `.ndjson`) → Json.
    pub fn from_path(path: &Path) -> Format {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "xml" => Format::Xml,
            "csv" => Format::Csv,
            "tsv" | "tab" => Format::Tsv,
            _ => Format::Json,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Format::Json => "JSON",
            Format::Xml => "XML",
            Format::Csv => "CSV",
            Format::Tsv => "TSV",
        }
    }
}

/// Unified parse entry point. Errors are normalized to `String` with the
/// byte offset embedded in the message (requirement F9).
pub fn parse_document(bytes: &[u8], format: Format) -> Result<Index, String> {
    match format {
        Format::Json => json::parse(bytes).map_err(|e| e.to_string()),
        Format::Xml => xml::parse_xml(bytes).map_err(|e| e.to_string()),
        Format::Csv => Ok(csv::parse_csv(bytes, CsvOptions::default())),
        Format::Tsv => Ok(csv::parse_csv(bytes, CsvOptions::tsv())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_from_path() {
        assert_eq!(Format::from_path(Path::new("a.xml")), Format::Xml);
        assert_eq!(Format::from_path(Path::new("a.csv")), Format::Csv);
        assert_eq!(Format::from_path(Path::new("a.tsv")), Format::Tsv);
        assert_eq!(Format::from_path(Path::new("a.tab")), Format::Tsv);
        assert_eq!(Format::from_path(Path::new("a.json")), Format::Json);
        assert_eq!(Format::from_path(Path::new("a.jsonl")), Format::Json);
        assert_eq!(Format::from_path(Path::new("a.ndjson")), Format::Json);
        assert_eq!(Format::from_path(Path::new("noext")), Format::Json);
        assert_eq!(Format::from_path(Path::new("a.XML")), Format::Xml);
    }

    #[test]
    fn parse_document_normalizes_errors() {
        assert!(parse_document(b"[1,2,]", Format::Json).is_err());
        assert!(parse_document(b"<a></b>", Format::Xml).is_err());
        // CSV never hard-fails on structure.
        assert!(parse_document(b"\"unterminated", Format::Csv).is_ok());
    }
}
