# NARIKJSON — DuckDB Migration Plan (delimited files)

**Decision:** All delimited files (CSV, TSV, PSV, and delimited `.txt`/`.dat`/
`.tab`, plus Parquet as a bonus) move to a **DuckDB-in-Node** engine, ported from
the existing **GigaTables** project. The current Rust CSV path is retired. The
Rust engine stays for the hierarchical formats (JSON, NDJSON, XML, YAML).

This is a design doc only — no code yet. It maps out the target architecture, the
op-by-op wiring, what gets deleted, build/packaging changes, risks, and a phased
rollout.

---

## 1. Why

The Rust engine stores every CSV cell as a node (root array → row objects → cell
nodes). That model is what caused the multi-GB blow-ups, the 1 GB/3 GB routing
hacks, and the fragile header sniffing (e.g. the numeric `10000` column that
duplicated as row 0). DuckDB is columnar, vectorized, spills to disk, and has a
battle-tested CSV reader. GigaTables already wraps it into a complete, benchmarked
(76 tests) engine with a Parquet cache and O(1) deep-scroll paging. Porting proven
code beats rewriting it in Rust.

---

## 2. Target architecture

```
┌──────────────── Electron main process ─────────────────┐
│  window · native menu · dialogs · settings · recents    │
│  licensing (/verify) · Cache Manager                    │
│  ROUTER: pick engine by file format                     │
└──────┬───────────────────────────┬──────────────────────┘
       │ IPC (preload)             │
┌──────▼─────────────┐   ┌─────────▼──────────────────────┐
│ Renderer (existing)│   │ Two engines, per session:      │
│ tree · flow · table│   │                                │
│ source · search    │   │  (a) Rust engine  (unchanged)  │
└────────────────────┘   │      JSON/NDJSON/XML/YAML       │
                         │      tree, flow, schema, subtree│
                         │                                │
                         │  (b) DuckDB engine (NEW, Node   │
                         │      utilityProcess, ported     │
                         │      from GigaTables)           │
                         │      CSV/TSV/PSV/delimited/parq  │
                         └────────────────────────────────┘
```

Both engines run as separate OS processes (the Rust one already does via `spawn`;
the DuckDB one via Electron `utilityProcess`, exactly as GigaTables does). The
main process routes each opened file to the right engine and keeps the renderer's
op protocol stable so the UI changes stay small.

---

## 3. Engine API mapping (NARIK op → GigaTables `EngineApi`)

GigaTables' surface is nearly a superset of what NARIK's table view already asks
for, so most of the renderer keeps working through a thin adapter.

| NARIK need (today)                       | GigaTables method                          | Notes |
|------------------------------------------|--------------------------------------------|-------|
| open + `meta` (headers, row count)       | `detect` + `openDataset` → `DatasetManifest` | manifest carries columns, types, row count, ingest strategy |
| `op:'table'` paged rows (+sort/filter)   | `buildView(view)` + `getPage(view,row)`    | sort/filter/search live in the `ViewSpec`; paging is O(1) via `file_row_number` |
| Source row-as-JSON (the row inspector)   | `getRowJson(view, viewRow)`                | already returns `{ json, sourceRow }` |
| search / match stepping                  | `findNextMatch(view, fromRow, dir)`        | replaces the FTS trigram index for delimited |
| Column Coverage report                   | `profileColumn(column, topN)`              | distinct values + counts |
| Column Profile report                    | `profileAll()`                             | per-column stats |
| Export CSV / JSON                         | `exportView(...)`                          | also Parquet/other targets for free |
| Compare / diff two files                 | `diffDatasets(...)`                        | bonus: real dataset diff |
| Raw File peek                            | `rawSlice(path, offset, length)`           | byte-range read, no full load |
| Cache Manager                            | `cacheInfo` / `clearCache` / `setCacheLimit` | unify with the existing Cache Manager UI |
| cancel long ingest                       | `cancel(jobId)`                            | ingest runs on its own connection |
| **new:** SQL console                     | `runSql(datasetId, sql, limit)`            | optional feature to expose later |

---

## 4. Routing (main process)

A small router decides the engine when a file is opened:

- Delimited/tabular → **DuckDB engine**: extensions `csv`, `tsv`, `psv`, `tab`,
  `dat`, `parquet`, or a `.txt`/no-extension file the user chose to "Open as
  Table". (This subsumes today's `openAsCsv` / `format:'csv'` path.)
- Everything else (`json`, `ndjson`, `jsonl`, `xml`, `yaml`, `yml`) → **Rust
  engine**, unchanged.

Per-tab sessions already exist in NARIK (`sessions`/`lastDb` keyed by tabId); we
add a parallel notion for DuckDB datasets (`datasetId`) and remember which engine
owns each tab.

---

## 5. What gets removed / retired

- Rust `csvp.rs` (the hand-rolled CSV/TSV parser) and its header sniffing.
- Cell-node table ops in `serve.rs` / `serve_mem.rs` (`op_table`, `op_distinct`,
  `op_profile`, and the CSV branches of `op_subtree`).
- The delimited size gates and routing in `main.js` (`DELIM_DB_BYTES`, the CSV
  branch of `decideMode`, `isDelimited`).
- The CSV **Tree view** in the renderer (confirmed: delimited is table-only now).
  Tree/flow/schema stay for hierarchical formats.
- `csv_headers` plumbing that fed the old table (replaced by the DuckDB manifest).

Cross-format converters (JSON↔CSV↔XML↔YAML) can stay for now (they operate on
already-loaded hierarchical data); revisit once DuckDB export covers the CSV side.

---

## 6. Renderer changes (kept deliberately small)

- Table view fetches rows from the DuckDB session adapter instead of `op:'table'`;
  the virtualized grid, Columns panel (pin/hide/reorder), cell selection + copy,
  and the Filter/Sort dialogs stay — they just drive a `ViewSpec` now.
- Source panel for delimited uses `getRowJson` (drop-in for the current
  subtree-of-row approach; already producing header-keyed JSON).
- Hide the Tree/Table toggle for delimited (table only).
- Optional, later: a **SQL console** panel (GigaTables `SqlConsole.tsx`) and a
  Parquet chip in Supported Files.

---

## 7. Features gained from GigaTables

- **Parquet cache + manifest:** first open streams once to a columnar cache;
  reopen is instant. Fits the existing "Reopened from cache" toast.
- **O(1) deep-scroll paging** via `file_row_number` (no `OFFSET` cliff).
- **Ingest fallback ladder:** `csv-auto` → `csv-lenient` → `csv-all-varchar` →
  `raw-lines`, so malformed files (the `10000` header, ragged rows, bad types)
  open instead of failing.
- **Parquet support** as a first-class format.
- **Dataset diff**, **raw byte-slice**, **cancellable ingest** with real progress,
  and a **connection pool** so painting the grid never blocks on a long job.

---

## 8. Cache & temp management

DuckDB's Parquet cache lives under `app.getPath('userData')` alongside the current
SQLite DB cache. The Cache Manager UI gets a unified view (`cacheInfo` from both
engines), one size limit, and startup pruning — reusing the existing panel.

---

## 9. Build / CI / packaging (the real cost)

- Add `@duckdb/node-api` (native addon). Needs `electron-builder install-app-deps`
  / `electron-rebuild` per Electron version and per architecture — GigaTables
  already does this via a `postinstall` hook and its `electron-builder.yml`.
- Bundle grows by the DuckDB native lib (tens of MB per arch). The monaco trim and
  `dist:fast` we already added still apply; measure the new installed size.
- CI: the existing `macos-dmg.yml` / `windows-installer.yml` / `linux-appimage.yml`
  each gain the addon rebuild step. Rust engine build stays.
- Two native runtimes now ship: the Rust engine binary **and** the DuckDB addon.

---

## 10. Unaffected

Licensing (`/verify`, tiers, Membership card), the Smart URL workbench, jq,
recents, theming, and all hierarchical-format features are untouched.

---

## 11. Risks & open questions

- **Two engines to maintain** (accepted trade for reuse + robustness).
- **NDJSON/JSON stay in Rust** — DuckDB *can* read them, but the tree/flow/schema
  UX is node-based; no reason to move them.
- **Feature parity check:** confirm the GigaTables `ViewSpec` expresses everything
  NARIK's Filter/Sort dialogs and Columns panel need (pin/hide/reorder, multi-col
  filter, numeric-aware sort). Likely yes; verify early.
- **Packaging on macOS**: the DuckDB addon must be signed + notarized along with
  the app (fold into the existing mac signing).
- **Disk usage**: Parquet cache for many/large files — surface + cap in Cache
  Manager.
- **GigaTables is React/Vite/TS**; NARIK's renderer is vanilla JS. We port the
  **engine** (Node/TS, compiles to a `.cjs` bundle like GigaTables already does),
  not GigaTables' React UI — NARIK keeps its own renderer.

---

## 12. Phased rollout

1. **Engine in, behind routing.** Vendor GigaTables' `src/engine/*` + `protocol`
   into NARIK, build it to a `.cjs`, spawn it as a `utilityProcess`, and add the
   main-process router + a DuckDB session adapter. Delimited files go to DuckDB;
   everything else stays Rust. Old CSV path still present as fallback.
2. **Wire the table UI** to the adapter (page/sort/filter/source-row/coverage/
   profile/export). Hide Tree for delimited.
3. **Delete the Rust CSV path** and delimited routing once parity is confirmed.
4. **Optional extras:** SQL console, Parquet chip, dataset diff via DuckDB.

Each phase is shippable on its own branch.

---

## 13. Open decisions for you

- SQL console: ship now or later?
- Parquet: advertise as supported immediately, or keep internal (cache only) first?
- Keep JSON↔CSV converters, or route CSV conversions through DuckDB export?
