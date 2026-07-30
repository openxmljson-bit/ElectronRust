# `project` engine subcommand — contract

The **JSON DeepDive** feature extracts a projected copy of a document (only the
fields the user selected) into a new tab. The projection runs entirely in Rust,
streaming record-by-record over the **source file** (not the SQLite db), so it
works the same for memory-mode and database-mode tabs and handles multi-GB
arrays without loading them into memory.

The renderer builds the field tree from the already-generated JSON Schema and
gathers the selected leaf paths. The Node main process then spawns this
subcommand. Everything except this subcommand already exists on the JS side.

---

## Invocation

```
openjsonxml-engine project \
  --file  <source-path> \
  --format <auto|json|ndjson> \
  --paths <paths-file> \
  --out   <out-path> \
  [--pretty]
```

- `--file`   Absolute path to the original document (JSON or NDJSON).
- `--format` `auto` (detect by extension/content), or force `json` / `ndjson`.
- `--paths`  Path to a UTF-8 file containing a **JSON array of selected leaf
             paths** (see grammar below). Passed as a file, not argv, so the
             number of fields is unbounded.
- `--out`    Absolute path the projected document is written to (temp file
             chosen by main; the subcommand creates/overwrites it).
- `--pretty` Optional. If present, pretty-print JSON output (2-space). Default
             is compact. (NDJSON output is always one record per line.)

Exit code `0` on success, non-zero on error or cancellation.

---

## Selected-path grammar (array-transparent)

Paths address fields **through** arrays without indices — an array is
transparent, so a selected path applies to every element of that array.

```
segment := key | key '[]'
path    := segment ( '.' segment )*
```

Examples against `{ "start": 0, "items": [ { "price": 1, "meta": { "sku": "x" } } ] }`:

| Selected path       | Keeps                                                        |
|---------------------|-------------------------------------------------------------|
| `start`             | top-level `start`                                            |
| `items[].price`     | `price` inside every element of `items`                      |
| `items[].meta.sku`  | `meta.sku` inside every element of `items`                   |
| `items[]`           | every element of `items` whole (rare; leaf array-of-scalars)|

Keys that are not identifiers are JSON-quoted: `foo["a b"].bar`,
`foo["a.b"]` (a literal dot inside quotes is part of the key, not a separator).
This matches the grammar the renderer emits from the schema field tree.

**Projection semantics (`project_value`):**

- Object: keep only keys that are a prefix of some selected path; recurse into
  each kept key with the remaining suffix. A key selected as a leaf keeps its
  entire value.
- Array (transparent): apply the remaining suffix to **each** element. If the
  path ends at the array (`items[]` with no suffix), keep elements whole.
- Scalar at a selected leaf: keep as-is.
- A key present in the selection but absent from a given record is simply
  omitted for that record (no error, no null padding).
- Key order follows the source record's order.

---

## Output shape

- **JSON, root is an array** → output is a JSON array of projected elements.
- **JSON, root is an object** → output is a single projected object.
- **NDJSON** → one projected record per line (records that project to empty `{}`
  are still emitted, to preserve line count/alignment).

Output format mirrors input (array→array, ndjson→ndjson).

---

## Progress protocol (JSONL on stdout)

One JSON object per line, flushed as it goes (same style as `ingest`):

```json
{"event":"start","total":<records or null>}
{"event":"progress","done":<records processed>,"total":<records or null>}
{"event":"done","records":<total processed>,"kept":<distinct leaf paths written>}
{"event":"error","message":"<text>"}
```

- `total` may be `null` when it can't be known cheaply up front (streaming);
  the UI shows an indeterminate bar in that case.
- Emit `progress` periodically (e.g. every N records or ~every 100 ms), not per
  record, to avoid flooding the pipe.
- `kept` = number of distinct selected leaf paths that matched at least once
  (drives the "kept N field(s)" toast). If cheaper, return the count of
  selected paths requested; the UI only needs a number.

---

## Cancellation & cleanup

- The main process cancels by killing the process (SIGTERM, then SIGKILL).
- On any early exit (cancel or error), **remove the partial `--out` file**
  before exiting if you created it. Main also deletes `--out` as a backstop,
  but the subcommand should not leave a half-written file on its own error.
- Respond promptly — check for termination between records / chunks.

---

## Errors

Emit `{"event":"error","message":...}` and exit non-zero for: unreadable source
file, malformed `--paths`, parse error in the source, or write failure. The UI
surfaces `message` and always closes the progress modal.

---

## Tests (Rust)

Against small fixtures (put under `rust-engine/tests/fixtures/`):

- `schema_field_tree` — if you also implement the streaming field-tree in Rust
  later; not required now (the renderer derives it from the schema).
- `all_paths` — enumerating leaf paths of a value in the array-transparent
  grammar.
- `project_value` — the core: given a value and a set of selected paths, assert
  the projected value. Cover: nested objects, `items[].x` over arrays of
  objects, arrays of scalars, missing keys, quoted non-identifier keys, and a
  path that selects a whole subtree.

A JS reference implementation of `project_value` + shared fixtures lives at
`rust-engine/tests/fixtures/project_cases.json` (see repo) so the Rust output
can be asserted against the same expected results the UI assumes.
