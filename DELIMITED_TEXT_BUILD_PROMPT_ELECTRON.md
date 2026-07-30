# Build Prompt — Delimited Text Files (Electron + Rust)

Implementation-ready prompt to open **delimited plain-text files** (pipe /
semicolon / tab / comma, often `.txt`/`.dat`/`.psv`) as first-class **CSV
tables** on an Electron (TypeScript renderer) + Rust (streaming engine) stack.
Prepend the Shared Context from `TOOLS_BUILD_PROMPTS_ELECTRON.md`; this reuses
the CSV **Table View** feature for everything after the file is parsed.

---

## Extra context

> A "delimited text file" is a table whose delimiter isn't implied by its
> extension — e.g. a `.txt` export with `|`-separated fields. The goal is to let
> the user open such a file as a **structured table** (same engine, same Table
> View, same filter/sort/coverage/profile/export) rather than as read-only text.
>
> The **Rust engine already parses CSV with a configurable delimiter** — the DB
> ingest takes a delimiter byte and the in-memory parser sniffs a candidate set
> `[',', ';', '\t', '|']`. The work is: (1) **sniff the delimiter** on the
> database path too (not just memory), and (2) give the app the **entry points**
> and **guardrails** to open an arbitrary file as CSV.
>
> Because a delimited file stores **every cell as its own node**, a wide/tall
> table explodes into billions of nodes; the feature is **size-gated** and the
> memory-vs-database routing is made delimiter-aware.

---

## Prompt

> Add the ability to open a delimited text file as a CSV table, with detection,
> multiple entry points, and scale guardrails.
>
> ### Delimiter detection (Rust)
> - On the **database ingest** path, sniff the delimiter from the **first line**:
>   count candidates `,` `;` `\t` `|` and pick the most frequent, **preferring
>   comma on ties** (matches the in-memory sniffer's candidate order). TSV keeps
>   the tab. Store the chosen delimiter in `meta.csv_delimiter`.
> - The **in-memory** engine already sniffs via `CsvOptions::default()` — pass
>   `--format csv` so it treats the file as delimited (candidates include `|`).
> - No delimiter picker is required for the common cases; sniffing is enough.
>
> ### Forcing CSV format end-to-end (main + IPC)
> - Thread an optional **format override** from the renderer through the load
>   IPC to the engines: `loadFile(tabId, path, force, format)`. When
>   `format === 'csv'`, pass `--format csv` to **both** the DB `ingest` and the
>   `serve-mem` process so a `.txt` is parsed as a table regardless of extension.
> - The tab remembers the forced format so **Reload** keeps the table view.
>
> ### Entry points (renderer)
> 1. **File menu → "Open Delimited File as Table…"** — file dialog, loads the
>    chosen file forcing CSV.
> 2. **Drag-and-drop picker** — when a dropped file is **ambiguous** (extension
>    in `{txt, dat, log, psv, tab}` or no extension), show a confirm dialog:
>    **Open as Table** / **Open as Text** / **Cancel**. Unambiguous formats
>    (`.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, …) open directly with no prompt.
> 3. **Recents memory** — when a file is opened as a delimited table, persist the
>    forced format on its recents entry, so reopening it from the welcome list,
>    the side dock, or the native **Open Recent** menu restores the **table
>    view** (not plain text).
>
> ### Engine routing (memory vs database), delimiter-aware
> - The auto memory-vs-DB decision must estimate the **index size**, not the raw
>   file size, for delimited files: the in-memory node index is roughly **~5× the
>   file** (many tiny cell nodes at ~24 bytes each). Require the estimate to fit
>   in ~60% of available RAM, else use the streaming **database** engine. JSON/XML
>   keep their existing (file-size-based) threshold.
>
> ### Size gate
> - Delimited/CSV loads are **capped at 1 GB** (`.csv/.tsv/.tab/.psv` or a forced
>   CSV `.txt`). Above the cap, **refuse with a clear message** — e.g. "Delimited/
>   CSV files are supported up to 1 GB — this file is 6.0 GB. Very wide or tall
>   tables expand into billions of cells." — instead of a doomed ingest that
>   fails partway and silently falls back to truncated text.
>
> ### Robustness
> - If a **cached database** for the file is corrupt or partial (e.g. an earlier
>   interrupted ingest → SQLite "database disk image is malformed"), **discard it
>   and re-ingest** rather than failing the open.
>
> ### Inherited behavior (no new code)
> - Once parsed as CSV, the file uses the existing **Table View**: virtualized
>   grid, columns panel / reorder / pin, cell selection + copy, server-side
>   filter + numeric sort, column coverage, whole-file profile, and export — in
>   both engine modes.
> - **Raw File** still opens the original file read-only with text highlighting.
>
> ### Acceptance
> - A `|`-delimited `.txt` opens as a proper multi-column table via the File
>   menu, via the drag-drop **Open as Table** choice, and via Recents (which
>   remembers the choice); comma/semicolon/tab files also detect correctly, and a
>   normal `.csv` is unaffected.
> - Ambiguous drops prompt Table/Text/Cancel; clear formats never prompt.
> - Files > 1 GB are refused with the size message; delimited files route to the
>   database engine when their index wouldn't fit in RAM.
> - A corrupt cached DB self-heals by re-ingesting.
> - Rust `#[test]`/unit tests cover delimiter sniffing (pipe header → `|`, plain
>   CSV → `,`); a renderer test covers the ambiguous-extension routing rule.

---

## PySide6 → Electron mapping (delimited text)

| Concern | PySide6 build | Electron + Rust build |
|---|---|---|
| Delimiter | `csv.Sniffer` on first line | sniff `,;\t\|` in `run_ingest` + oxj-core `CsvOptions` |
| Force format | open dialog "as CSV" | `loadFile(..., format:'csv')` → `--format csv` to both engines |
| Ambiguous open | modal on drop | HTML confirm dialog (Table / Text / Cancel) |
| Remember choice | `QSettings` recent w/ role | recents entry `{ path, size, format }` |
| Routing | in-memory vs on-disk model | `decideMode` estimates index ≈ 5× file for delimited |
| Size guard | row-count cap | 1 GB byte cap with a clear message |
| Corrupt cache | rebuild index | catch open failure → delete DB → re-ingest |
