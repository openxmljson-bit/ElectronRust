# NARIKJSON — Feature Overview

A rapid JSON · XML · CSV loading engine, built for gigabytes. This document lists
the application's features at a high level, with a short summary of each.

---

## Engine & Performance

- **Dual-Engine Architecture** — Two backends: an in-memory engine (memory-mapped
  index) for speed and an on-disk SQLite engine for scale. The app auto-selects
  per file, and you can force the choice via the Engine Mode toggle
  (Auto / Memory / Database).
- **Rust Ingest Core** — A native Rust engine streams and indexes
  JSON/NDJSON/XML/CSV/TSV into its store, giving native-speed parsing and
  querying with disciplined memory use.
- **Built for Gigabytes** — Opens multi-GB files with hundreds of millions of
  rows that crash ordinary viewers.
- **Smart Delimited Routing** — Auto-detects the delimiter (`, ; tab |`); files
  over 3 GB automatically use the database engine to stay safe, with no hard
  size cap.

## Formats & Conversion

- **Multi-Format Loading** — JSON, NDJSON/JSON Lines, XML, YAML, CSV, TSV, and
  pipe/tab/custom-delimited text, all opened as an explorable structure.
- **YAML as Tree** — YAML loads as a navigable tree and can also be opened
  read-only with highlighting.
- **Cross-Format Conversion** — Convert freely across JSON ↔ CSV ↔ XML ↔ YAML.
- **Raw File View** — Open the complete file read-only in a Monaco editor with
  syntax highlighting (JSON, XML, YAML, Markdown, JS, HTML, Python, plain text).

## Views & Navigation

- **Virtualized Tree** — Handles huge documents smoothly, with Vim-style keyboard
  navigation (h/j/k/l, jump to parent/root, and yank value/key/path/node).
- **Spreadsheet Table View** — CSV/TSV open as a real grid: pin, hide, and
  reorder columns, filter and sort millions of rows, select cells and copy, with
  a numbered gutter.
- **Column Profile & Coverage** — One-click reports on every column
  (distinct/empty/fill %, top values) and value-coverage breakdowns.
- **Flow Diagram** — Visualizes the structure of the selected node.
- **Source Panel** — Shows the pretty-printed source of the selected node.

## Search

- **Fast Full-Text Search** — Trigram-indexed search across enormous files, with
  keyset pagination, match-to-match stepping, amber highlights, key/value
  scoping, and quoted exact matches.

## Data Tools (Actions menu)

- **jq Filtering** — Run full jq expressions on JSON in-app (raw/compact/slurp/
  sort-keys options); results open in a new tab. Detects a missing jq and shows
  install guidance.
- **Schema Generate & Validate** — Produce a JSON Schema from a document, or
  validate a document against a schema.
- **Compare / Diff** — Diff two open documents in a rich, virtualized visual
  report with exporters.
- **JSON DeepDive** — Pick fields from the schema and project them into a new tab.
- **Export** — Raw/pretty JSON, XML, CSV, YAML; plus selection-only,
  search-matches, and open-in-browser.

## Connectivity

- **Smart URL / API Workbench** — A Postman-style request builder (method, params,
  auth, headers, body) that sends requests and opens the live response as
  structured, searchable data, with an Edit-URL round-trip, gzip handling, and
  form encoding.
- **Flexible Open** — Open from file, URL, clipboard, or drag-and-drop, with a
  Table/Text prompt for delimited files.

## Workspace & UX

- **Multi-Tab Workspace** — Up to 12 tabs with duplicate, reload, and close-all.
- **Recent Files** — A synced recents system across the menu, welcome list, and a
  collapsible/resizable side dock (per-row remove; remembers "opened as table").
  Only real user-opened files, never URLs or generated files.
- **Cache Manager** — Shows cached documents, cache/index size, RAM and
  engine-mode info, and a size limit; clears cache and prunes automatically on
  startup.
- **Theming** — Full light/dark support across the UI, including the report
  overlays.
- **Welcome Dashboard** — Membership, Engine Mode, Supported Files, "Built for
  Gigabytes," and the animated NARIK brand card.

## Licensing

- **Activation & Editions** — Email + license-key activation against the live
  `/verify` backend, correctly scoped with `product: "narik"` and a
  `Narik/Unbxd` tier backstop; keys are normalized (case/dashes/spaces tolerant).
- **Entitlement Management** — Re-verifies at most every 24h (lifetime keys
  never), tolerates outages via cache, derives the plan label
  (Annual / Lifetime / N-day Trial) from the key term, and shows it all on the
  Membership card with expiry nudges and Manage/Renew.
- **Key Signer** — A standalone script to mint license keys matching the
  documented format.

## Packaging & Delivery

- **Cross-Platform Builds** — macOS (dmg/zip, signed + notarized), Windows (NSIS),
  Linux (AppImage), via GitHub Actions, with the Rust engine bundled per-OS.
- **Optimized Size** — Trimmed the packaged app (~77 MB off by pruning unused
  Monaco assets); ~295 MB installed on Apple Silicon. Includes a `dist:fast`
  build that skips notarization for quick local iteration.
- **Auto-Update** — Wired via electron-updater against a GitHub releases feed.
