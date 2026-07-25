# NARIKJSON

A desktop viewer for very large JSON, NDJSON, XML, CSV and TSV files (tested design target: up to ~25 GB), built on a streaming architecture that never loads the file into memory.

## Architecture

Electron renders the UI. The Node.js main process coordinates file paths and spawns the background worker. A native Rust engine does the heavy lifting: it streams the file chunk-by-chunk with iterative, recursion-free parsers and writes every node directly into SQLite in batched transactions. Once ingested, the UI queries SQLite through a long-lived engine process (one JSON request/response per line over stdin/stdout), so browsing, search and pagination are instant regardless of file size — and reopening an unchanged file skips ingestion entirely because the database is cached and keyed on the file's path, size and mtime.

```
Electron (renderer)  ←IPC→  Node.js (main)  ←stdio→  Rust engine  ←→  SQLite
   virtualized tree           spawn/progress          ingest | serve      nodes table
```

The Monaco editor (the editor core that powers VS Code) renders the Source pane, giving syntax-highlighted, pretty-printed JSON/XML for any selected node, reconstructed from the database by the Rust engine.

## Requirements

Rust (`rustup`), Node.js 18+, and on macOS the Xcode Command Line Tools (`xcode-select --install`) — needed because SQLite is compiled into the engine.

## Build and run

```bash
./build.sh          # builds engine, installs deps, launches app
```

Or step by step:

```bash
cd rust-engine && cargo build --release && cd ..
npm install
npm start
```

## Test data

```bash
python3 scripts/generate_samples.py --rows 1000000 --out samples
```

creates `sample.json`, `sample.ndjson`, `sample.csv`, `sample.xml` (~250 MB of JSON at 1M rows; raise `--rows` for bigger tests).

`scripts/validate_sql.py` checks every SQL statement the engine uses against a real SQLite database.

## Features (current core)

Open via dialog, drag & drop, or recent-files list. Streaming ingest with a progress bar showing percent, throughput, node count and ETA, plus an indexing phase and cancel. Instant reopen of unchanged files from the cached database. Virtualized lazy tree view (only visible rows are rendered; children load in pages of 200 with "load more"/"show previous" for huge arrays). CSV table view with header detection and leading-zero preservation. Search over keys and/or values with result pagination and reveal-in-tree. Path readout (`$.a[0].b` / `/root/item/@attr`) and type/size in the status bar. Monaco-powered Source pane with pretty JSON/XML reconstruction and copy. Keyboard navigation (arrows, Enter). Dark theme.

## Engine CLI (usable standalone)

```bash
openjsonxml-engine ingest big.json --db out.db [--format auto|json|ndjson|xml|csv|tsv]
openjsonxml-engine serve --db out.db
```

Ingest emits JSONL progress on stdout (`start`, `progress`, `phase`, `done`, `error`). Serve answers ops: `meta`, `children`, `node`, `path`, `search`, `table`, `subtree`.

## SQLite schema

```sql
nodes(id INTEGER PRIMARY KEY,  -- document order
      parent_id INTEGER, ord INTEGER, depth INTEGER,
      kind INTEGER,            -- 0 obj, 1 arr, 2 str, 3 num, 4 bool, 5 null,
                               -- 6 element, 7 attribute, 8 text
      name TEXT, value TEXT, n_children INTEGER);
CREATE INDEX idx_nodes_parent ON nodes(parent_id, ord);  -- built after ingest
meta(key TEXT PRIMARY KEY, value TEXT);
```

## Notes on scale

The database stores a full copy of the data, so expect roughly 1–2× the source size in `~/Library/Application Support/NARIKJSON/dbcache` (clear it freely; files re-ingest on demand). Ingest is disk-bound: on an SSD expect very roughly 50–150 MB/s. Search is a sequential scan (fast, multi-GB/s in SQLite, but a no-match search on a 25 GB file takes a while); an FTS index is a natural next step. Single values larger than ~1 GB exceed SQLite's default limit and are unsupported.

## Packaging installers

```bash
npm i -D electron-builder
npm run dist        # .dmg on macOS, .exe (NSIS) on Windows
```

The `build` section of package.json already bundles the engine binary as an extra resource.

## Roadmap (from FEATURES_FULL.md)

Next candidates on this foundation: multi-tab, JSONPath/XPath + unified filter box, jq integration, flow diagram, compare/diff, JSON Schema generate/validate, follow-tail, export menus, editions/update system.
