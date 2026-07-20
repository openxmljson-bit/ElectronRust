// SQLite writer tuned for bulk streaming ingest.
use rusqlite::{params, Connection};

pub const K_OBJ: i64 = 0;
pub const K_ARR: i64 = 1;
pub const K_STR: i64 = 2;
pub const K_NUM: i64 = 3;
pub const K_BOOL: i64 = 4;
pub const K_NULL: i64 = 5;
pub const K_ELEM: i64 = 6;
pub const K_ATTR: i64 = 7;
pub const K_TEXT: i64 = 8;

const BATCH: u32 = 50_000;

pub fn e2s(e: rusqlite::Error) -> String {
    e.to_string()
}

pub struct DbWriter {
    conn: Connection,
    in_txn: bool,
    pending: u32,
}

impl DbWriter {
    pub fn create(path: &str) -> Result<Self, String> {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}-wal", path));
        let _ = std::fs::remove_file(format!("{}-shm", path));
        let _ = std::fs::remove_file(format!("{}-journal", path));
        let conn = Connection::open(path).map_err(e2s)?;
        conn.execute_batch(
            "PRAGMA journal_mode=OFF;\n\
             PRAGMA synchronous=OFF;\n\
             PRAGMA cache_size=-262144;\n\
             PRAGMA temp_store=1;\n\
             PRAGMA page_size=8192;\n\
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);\n\
             CREATE TABLE nodes(\n\
               id INTEGER PRIMARY KEY,\n\
               parent_id INTEGER,\n\
               ord INTEGER NOT NULL,\n\
               depth INTEGER NOT NULL,\n\
               kind INTEGER NOT NULL,\n\
               name TEXT,\n\
               value TEXT,\n\
               n_children INTEGER NOT NULL DEFAULT 0\n\
             );",
        )
        .map_err(e2s)?;
        Ok(DbWriter { conn, in_txn: false, pending: 0 })
    }

    fn begin_if_needed(&mut self) -> Result<(), String> {
        if !self.in_txn {
            self.conn.execute_batch("BEGIN").map_err(e2s)?;
            self.in_txn = true;
        }
        Ok(())
    }

    fn maybe_commit(&mut self) -> Result<(), String> {
        self.pending += 1;
        if self.pending >= BATCH {
            self.conn.execute_batch("COMMIT").map_err(e2s)?;
            self.in_txn = false;
            self.pending = 0;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_node(
        &mut self,
        id: i64,
        parent: Option<i64>,
        ord: i64,
        depth: i64,
        kind: i64,
        name: Option<&str>,
        value: Option<&str>,
    ) -> Result<(), String> {
        self.begin_if_needed()?;
        {
            let mut st = self
                .conn
                .prepare_cached(
                    "INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                )
                .map_err(e2s)?;
            st.execute(params![id, parent, ord, depth, kind, name, value])
                .map_err(e2s)?;
        }
        self.maybe_commit()
    }

    pub fn set_children(&mut self, id: i64, n: i64) -> Result<(), String> {
        self.begin_if_needed()?;
        {
            let mut st = self
                .conn
                .prepare_cached("UPDATE nodes SET n_children=?1 WHERE id=?2")
                .map_err(e2s)?;
            st.execute(params![n, id]).map_err(e2s)?;
        }
        self.maybe_commit()
    }

    pub fn put_meta(&mut self, key: &str, value: &str) -> Result<(), String> {
        self.begin_if_needed()?;
        {
            let mut st = self
                .conn
                .prepare_cached("INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)")
                .map_err(e2s)?;
            st.execute(params![key, value]).map_err(e2s)?;
        }
        Ok(())
    }

    // Commit remaining rows and build the parent index.
    pub fn finish(&mut self) -> Result<(), String> {
        if self.in_txn {
            self.conn.execute_batch("COMMIT").map_err(e2s)?;
            self.in_txn = false;
            self.pending = 0;
        }
        self.conn
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);",
            )
            .map_err(e2s)?;
        Ok(())
    }
}
