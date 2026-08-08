# NARIKJSON

**A rapid JSON · XML · CSV loading engine, built for gigabytes.**

NARIKJSON is a desktop app (macOS, Windows, Linux) for opening and exploring the data files that freeze ordinary editors — multi‑gigabyte JSON, NDJSON, XML, YAML, CSV, TSV and Parquet, with files in the gigabytes and hundreds of millions of rows. It streams and indexes on ingest so browsing, search, sort and pagination stay instant no matter the file size, and reopening an unchanged file is near‑instant from cache.

---

## Table of contents

- [Highlights](#highlights)
- [Supported formats](#supported-formats)
- [Architecture](#architecture)
- [Opening files](#opening-files)
- [Tree view (hierarchical data)](#tree-view-hierarchical-data)
- [Table view (tabular data)](#table-view-tabular-data)
- [SQL console](#sql-console)
- [Compare & diff](#compare--diff)
- [Search](#search)
- [Source & Raw File views](#source--raw-file-views)
- [Flow diagram](#flow-diagram)
- [Data tools (Actions)](#data-tools-actions)
- [Convert & export](#convert--export)
- [URL / API workbench](#url--api-workbench)
- [Bookmarks manager](#bookmarks-manager)
- [Import / export formats](#import--export-formats)
- [Workspace & tabs](#workspace--tabs)
- [Recent files](#recent-files)
- [Cache manager](#cache-manager)
- [Engine mode & fast load](#engine-mode--fast-load)
- [Welcome dashboard](#welcome-dashboard)
- [Theming](#theming)
- [Networking & corporate proxies](#networking--corporate-proxies)
- [Licensing](#licensing)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Menu reference](#menu-reference)
- [Build & run](#build--run)
- [Packaging & distribution](#packaging--distribution)

---

## Highlights

- **Dual engine.** A native **Rust** engine handles hierarchical data (JSON/NDJSON/XML/YAML); a **DuckDB** engine handles tabular data (CSV/TSV/PSV/Parquet). Each is picked automatically per file.
- **Built for gigabytes.** Streaming ingest with constant memory; opens files that crash other viewers, then pages through them instantly.
- **Two ways to see any file.** A virtualized tree for structure, a spreadsheet‑style grid for tables — plus a syntax‑highlighted Source pane and a full Raw File view.
- **Query, filter, search, diff.** Full‑text search across enormous files, a built‑in SQL console over tabular data, column profiling, dataset diff, jq filtering, and JSON‑Schema generate/validate.
- **API workbench + bookmarks.** A Postman‑style request builder opens live responses as explorable data, with a bookmarks manager and import/export for Postman, Insomnia, OpenAPI/Swagger and NARIK's own format.
- **Local & private.** Everything runs on your machine; data never leaves it. Auth secrets in bookmarks are encrypted with the OS keychain.

---

## Supported formats

**Hierarchical (Rust engine):** JSON · NDJSON / JSON Lines (`.ndjson`, `.jsonl`) · XML · YAML / YML

**Tabular (DuckDB engine):** CSV · TSV · PSV (pipe‑delimited) · TAB · DAT · other delimited text · **Parquet**

**Plain text (read‑only, Monaco):** TXT · MD · LOG · JS · MJS · HTML / HTM · PY, and any text a delimited parse can't structure.

Delimiters (`, ; tab |` and custom) are auto‑detected. **Excel** files (`.xlsx/.xls/.xlsm/.xltx/.xlsb`) are intentionally not supported — export to CSV or JSON first (the app tells you so instead of failing silently).

If a file with a JSON/XML/YAML extension can't be parsed, NARIKJSON **falls back to a read‑only text view** and tells you why (e.g. "Could not parse … (unterminated string at byte …) — opened as read‑only text") instead of just erroring.

---

## Architecture

```
Electron (renderer)  ─IPC→  Node.js (main)  ─stdio→  Rust engine   ─→  SQLite / mmap index
   virtualized UI            routing / spawn   ─fork→  DuckDB engine ─→  Parquet cache
```

- **Rust engine** streams hierarchical files with iterative, recursion‑free parsers. XML is parsed with a streaming pull parser (**quick‑xml**) in constant memory. It runs in one of two modes:
  - **Memory mode** — an mmap‑based index (`oxj-core`); no ingest, fastest, for files that fit comfortably in RAM.
  - **Database mode** — streams into **SQLite**; flat memory, for anything larger. A long‑lived `serve` process answers one JSON request/response per line, so paging and search are instant. The SQLite DB is cached and keyed on the file's path, size and mtime, so reopening skips ingestion.
- **DuckDB engine** (bundled, runs as a `utilityProcess`) ingests delimited/Parquet files into a **Parquet cache** with a manifest, then serves O(1) deep‑scroll paging, filtering, sorting, SQL, profiling and diff. Cache Parquet is written with **snappy** compression for fast ingest.
- **Monaco** (the editor core behind VS Code) renders the Source pane and Raw File view, with a custom theme matched to the app's palette in both light and dark mode.

---

## Opening files

- **Open File…**, **Open URL…**, **Open Clipboard**, or **drag‑and‑drop** anywhere in the window (multi‑file drop opens multiple tabs).
- Delimited files open **in Table mode by default**; ambiguous cases show a **Table / Text** prompt so you can choose.
- `Open Recent` and a synced recents system make reopening one click.

---

## Tree view (hierarchical data)

- **Virtualized tree** that stays smooth on huge documents; expand/collapse nodes, with windowed loading and a "Load all remaining rows" option for very large arrays (with a confirmation on huge loads).
- **Vim‑style keyboard navigation** — `h/j/k/l`, jump to parent/root, and **yank** the value, key, path, or whole node to the clipboard.
- **Jump to Path…** — navigate directly to a JSON path.
- **Copy Row**, **Copy as cURL** (for URL‑loaded documents).

---

## Table view (tabular data)

CSV/TSV/PSV/Parquet open as a real grid backed by DuckDB:

- **Numbered row gutter** and virtualized rendering over hundreds of millions of rows.
- **Columns** — show/hide (via the Columns drawer or header menu), **reorder** by drag, **pin** to the left (frozen), auto‑fit width by double‑clicking a header grip.
- **Filter** and **sort** millions of rows (eq/ne/lt/lte/gt/gte/contains/startswith/endswith/isnull/notnull/in/regex/between); Clear Filters / Clear Sort.
- **Cell selection** with keyboard navigation and **Cmd/Ctrl‑C** block copy.
- **Source button** shows the selected row as formatted JSON.
- **Column Profile** — one‑click stats per column (distinct / empty / fill %, top values).
- **Column Coverage** — value‑coverage breakdown for a column.
- **Render URLs as Hyperlinks** — turn `http`/`https` cell values into clickable links that open in your default browser (never in‑app; http/https only). Two ways:
  - **Global** — Actions ▾ → *Render URLs as Hyperlinks* (auto‑detects URL cells across all columns; remembered across sessions).
  - **Per‑column** — right‑click a column header → *Render as links* (only that column; precise and predictable).
- Status bar shows format · row count · size, and "from cache" on cache hits.

---

## SQL console

Available for any tabular file (Actions ▾ → **SQL Console…**). Query the file as the table `data` using full DuckDB SQL:

```sql
SELECT "category", count(*) AS c
FROM data
GROUP BY 1
ORDER BY c DESC
LIMIT 50;
```

- Clickable **example queries** (preview, count, sort, group‑by count, group‑by with an aggregate, and a HAVING "find duplicates" query), auto‑filled with your file's real column names.
- **Open the result as a new table tab** (to keep filtering/sorting/exporting) or **as JSON**.
- Modal console with Close/Cancel.

---

## Compare & diff

- **Dataset diff (tables)** — compare two open delimited tables (Actions ▾ → *Compare with…*); shows added / removed / modified rows in a virtualized report.
- **Document compare (JSON/hierarchical)** — Tools → *Compare With Open Tab…* produces a rich, virtualized visual diff with HTML/TXT/JSON/CSV exporters and Open‑in‑Browser.

---

## Search

- **Fast full‑text search** — trigram‑indexed (SQLite FTS5) across enormous files with keyset pagination.
- **Match‑to‑match stepping** with amber highlights (Find Next / Find Previous, `F3` / `⇧F3`, `⌘G` / `⇧⌘G`).
- **Scope** — All / Keys / Values (hierarchical data).
- **Modes** — Contains / Exact / Regex, plus `"double‑quoted"` for an exact match. Table search runs across **every column**.

---

## Source & Raw File views

- **Source panel** — the pretty‑printed, syntax‑highlighted source of the selected node/row, reconstructed by the engine (Monaco).
- **Raw File** — open the complete original file read‑only in Monaco, size‑gated for safety, with highlighting for JSON, XML, YAML, Markdown, JS, HTML, Python and plain text. A **Back to top** button appears on long documents.

---

## Flow diagram

Visualizes the structure of the selected node as a flow diagram (JSON/CSV), with zoom/controls.

---

## Data tools (Actions)

- **jq filtering** — run full jq expressions on JSON in‑app (raw / compact / slurp / sort‑keys options); the result opens in a new tab. If the system `jq` binary is missing, the app detects it and shows install guidance.
- **Generate JSON Schema** — produce a JSON Schema from the current document.
- **Validate Against JSON Schema…** — validate a document against a schema file.
- **JSON DeepDive → New Tab…** — pick fields from the document's schema (field‑tree picker) and **project just those fields** into a new tab, with a progress modal for large documents.
- **Compare With Open Tab…** — the document diff described above.

---

## Convert & export

- **Cross‑format conversion** — convert freely across **JSON ↔ CSV ↔ XML ↔ YAML**.
- **Export menu** — Raw copy, Pretty JSON, XML, CSV, YAML; plus **Selection as JSON/Text**, **Search Matches as JSON/CSV**, and **Open in Browser**.
- **Table export** — Export ▾ → CSV / JSON (DuckDB writes CSV directly; JSON assembled from pages). The engine also supports TSV/PSV/Parquet/xlsx‑CSV exports.

---

## URL / API workbench

A Postman‑style request builder (File → Open URL…, or the welcome button):

- **Method, URL, query params, headers, auth, body** — auth types No Auth / Bearer / Basic / API Key (header or query); body as raw or form‑urlencoded.
- **Send** and open the **live response as structured, searchable data** (tree or table), with content‑type/sniff‑based format detection.
- **Edit URL** round‑trip and **Copy as cURL** from any URL‑loaded document.
- Handles redirects and gzip/deflate/br decompression; uses the OS trust store and system proxy (see below).

---

## Bookmarks manager

Save API requests and reopen them in one click (Tools → **Bookmarks Manager…**, `⇧⌘B`, or the ☆ in the request builder):

- A single tabbed modal with **Request · Bookmarks · Recents**. The Open URL button opens it on Request; the menu opens it on Bookmarks.
- Bookmarks store the **whole request** (method/URL/params/headers/auth/body), with **search**, **sort** (recent / most used / name / date added), **pin to top**, and Open / Edit / Delete per row. A **Bookmarks tab is also in the side dock**.
- **Encrypted secrets** — bearer tokens, basic passwords and API‑key values are encrypted with the OS keychain (`safeStorage`) and never stored in plain text.

---

## Import / export formats

From the Bookmarks tab, **Import ▾ / Export ▾** dropdowns support four formats each:

- **Postman collection** (v2.1) — folders become name prefixes; collection `{{variables}}` are resolved (environment‑only vars left literal); method/URL/query/headers/auth (bearer/basic/API‑key)/raw & urlencoded bodies mapped.
- **Insomnia export** (v4) — folders, auth, parameters, JSON & form bodies.
- **OpenAPI / Swagger** (3.x and 2.0 on import) — each operation becomes a request built from `servers[0]` + path, with query/header params and requestBody examples. Export is best‑effort (bookmarks aren't a formal spec).
- **NARIK bookmarks** (native) — lossless round‑trip, preserves pinned state.

> Exported files contain auth secrets in plain text (as Postman/Insomnia do) — treat them as sensitive.

---

## Workspace & tabs

- **Up to 12 tabs**, each with its own engine session, with a **+** button on the tab strip to open more.
- **Duplicate Tab**, **Reload**, **Close Tab**, **Close All Tabs**, **New Window**.
- Table‑only tools (Columns / Actions / Export) appear only on tabular tabs — never on plain‑text (md/html/txt) tabs.

---

## Recent files

- A synced recents system across the **menu**, the **welcome side dock**, and the modal **Recents tab**.
- The dock and the modal group recents **by file type** (JSON / CSV / XML / TEXT …) with collapsible sections and counts.
- Per‑row remove; remembers "opened as table"; only real user‑opened files (never URLs or generated temp files).

---

## Cache manager

Cache Manager menu and welcome card:

- Two caches — **JSON** (SQLite documents) and **CSV** (DuckDB Parquet) — shown as tabs, with cached‑file count and sizes.
- **Clear Cache** (friendly confirmation), **Prune Now**, **Delete Search Indexes**, **Open Cache Folder**.
- **Size Limit** (5 / 10 / 20 / 50 GB / Unlimited) with automatic LRU pruning on startup.

---

## Engine mode & fast load

- **Engine Mode** (Cache Manager menu) — Auto / Always Memory / Always Database. **Applies to JSON, XML & YAML only**; tabular files always use the DuckDB table engine. The welcome card shows the active engine, available RAM and the in‑RAM limit.
- **Fast load (may reorder rows)** — a toggle that ingests large tabular files with `preserve_insertion_order=false` for a big speedup on slower machines; rows may not appear in exact file order (filtering/search/SQL are unaffected). Off by default.

---

## Welcome dashboard

Cards on the welcome screen: **Membership** (when licensed), **Engine Mode**, **Supported Files**, **Built for GIGABYTES**, **File Activity** (a donut chart of opened file types — counts every format, tabular and hierarchical), **Cache Manager**, and the animated **{N}ARIK** brand card.

---

## Theming

Full **light / dark** support across the whole UI, including report overlays, dialogs and the Monaco editor (custom `narik-dark` / `narik-light` themes so the editor blends into the app). Appearance: System / Light / Dark.

---

## Networking & corporate proxies

All of the app's own network calls — license activation/re‑verify, the URL request builder, and URL downloads — go through Electron's `net` stack, so TLS validates against the **OS trust store** and the **system proxy** is honored. This means it works behind corporate TLS‑inspecting proxies that would otherwise fail with "unable to get local issuer certificate."

---

## Licensing

- **Activation** — email + license key against the live `/verify` backend, scoped with `product: "narik"` and a `Narik / Unbxd` tier backstop; keys are normalized (case/dashes/spaces tolerant).
- **Entitlement** — re‑verifies at most every 24 h (lifetime keys never), tolerates outages via the local cache, derives a plan label (Annual / Lifetime / N‑day Trial) from the key term, and shows expiry nudges and Manage / Renew on the Membership card.
- **Key signer** — a standalone `scripts/sign-key.mjs` mints keys in the documented format (single NARIK edition).

---

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open… | `⌘/Ctrl+O` |
| Open URL… | `⌥⇧O` |
| Open Clipboard | `⇧⌘/Ctrl+V` |
| New Window | `⇧⌘/Ctrl+N` |
| Find | `⌘/Ctrl+F` |
| Find Next / Previous | `F3` / `⇧F3`, `⌘G` / `⇧⌘G` |
| Bookmarks Manager | `⇧⌘/Ctrl+B` |
| Copy cell/row block | `⌘/Ctrl+C` |
| Tree navigation | `h/j/k/l`, yank key/value/path/node |

---

## Menu reference

- **File** — New Window · Open… · Open URL… · Open Clipboard · Open Recent (+ Clear Menu) · Reload · Duplicate Tab · Close Tab · Close All Tabs · Close Window
- **Edit / Search** — Find · Find Next · Find Previous · Jump to Path… · Copy Row · Copy as cURL
- **Export** — Raw Copy · Pretty JSON · XML · CSV · YAML · Selection as JSON/Text · Search Matches as JSON/CSV
- **Tools** — Generate JSON Schema · Validate Against JSON Schema… · JSON DeepDive → New Tab… · Compare With Open Tab… · Bookmarks Manager…
- **View** — Appearance (System/Light/Dark) · Reload · Force Reload · Zoom
- **Cache Manager** — Cache Size · Clear Cache… · Prune Now · Delete Search Indexes… · Size Limit · Engine Mode · Fast load (may reorder rows) · Open Cache Folder
- **Help** — Activate License… · Check for Updates… · About

---

## Build & run

Requirements: **Rust** (`rustup`), **Node.js 18+**, and on macOS the Xcode Command Line Tools (`xcode-select --install`, since SQLite is compiled into the engine).

```bash
# Rust engine (JSON/XML/YAML)
npm run build:engine        # cd rust-engine && cargo build --release

# DuckDB engine bundle (CSV/TSV/PSV/Parquet)
npm run build:duck

# both at once
npm run build:all

# install deps and launch
npm install
npm start
```

---

## Packaging & distribution

- **Cross‑platform builds** via GitHub Actions: **macOS** (dmg/zip, code‑signed + notarized when secrets are present), **Windows** (NSIS), **Linux** (AppImage).
- **macOS is per‑architecture**: arm64 builds natively on Apple Silicon; the Intel (x64) DMG is cross‑built on Apple Silicon with the matching x64 DuckDB binding, and a CI step verifies the packaged binaries are the correct arch. The Intel job is best‑effort and never blocks the arm64 release.
- **Auto‑update** via electron‑updater against a GitHub releases feed (a merged `latest-mac.yml` serves both macOS architectures).
- `npm run dist` builds and packages; `npm run dist:fast` skips notarization for quick local iteration.

---

*NARIKJSON — open and explore multi‑gigabyte JSON, XML, CSV and Parquet files that freeze every other editor.*
