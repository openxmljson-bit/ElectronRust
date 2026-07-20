// Builds a full-text search index (FTS5, trigram tokenizer) over the nodes
// table. Trigram FTS gives true substring matching for queries of 3+ chars
// with millisecond lookups, no matter the document size. Runs as a separate
// process so the viewer stays responsive; progress is emitted as JSONL.
use rusqlite::{params, Connection};
use serde_json::json;
use std::io::Write;

fn flush() {
    let _ = std::io::stdout().flush();
}

fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn run(dbp: &str) -> Result<(), String> {
    let conn = Connection::open(dbp).map_err(e2s)?;
    conn.execute_batch(
        "PRAGMA synchronous=OFF;\n\
         PRAGMA cache_size=-262144;\n\
         PRAGMA busy_timeout=60000;\n\
         PRAGMA temp_store=1;",
    )
    .map_err(e2s)?;
    println!("{}", json!({"event":"start"}));
    flush();

    // Clear the completion stamp first: if this run is interrupted, searches
    // must fall back to the scan path rather than a partial index.
    let _ = conn.execute("DELETE FROM meta WHERE key='fts_built'", []);
    conn.execute_batch("DROP TABLE IF EXISTS nodes_fts;").map_err(e2s)?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE nodes_fts USING fts5(\
         name, value, content='nodes', content_rowid='id', tokenize='trigram');",
    )
    .map_err(|e| format!("FTS5 trigram unavailable in this SQLite build: {}", e))?;

    let max_id: i64 = conn
        .query_row("SELECT COALESCE(MAX(id),0) FROM nodes", [], |r| r.get(0))
        .map_err(e2s)?;
    let step: i64 = 250_000;
    let mut a: i64 = 1;
    while a <= max_id {
        let b = a + step - 1;
        conn.execute(
            "INSERT INTO nodes_fts(rowid, name, value) \
             SELECT id, name, value FROM nodes \
             WHERE id BETWEEN ?1 AND ?2 AND (name IS NOT NULL OR value IS NOT NULL)",
            params![a, b],
        )
        .map_err(e2s)?;
        a = b + 1;
        println!(
            "{}",
            json!({"event":"progress","done": b.min(max_id), "total": max_id})
        );
        flush();
    }
    let _ = conn.execute_batch("INSERT INTO nodes_fts(nodes_fts) VALUES('optimize');");
    conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES('fts_built','1')",
        [],
    )
    .map_err(e2s)?;
    println!("{}", json!({"event":"done"}));
    flush();
    Ok(())
}
