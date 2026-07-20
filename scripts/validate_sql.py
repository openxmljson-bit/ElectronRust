#!/usr/bin/env python3
"""Validates the exact schema and SQL statements used by the Rust engine
against a real SQLite database, so SQL errors are caught without compiling.
Builds a tiny DB with the ingest schema, then runs every query from serve.rs.
"""
import json
import sqlite3
import sys

SCHEMA = """
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
PRAGMA cache_size=-262144;
PRAGMA temp_store=1;
PRAGMA page_size=8192;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE nodes(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  ord INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  name TEXT,
  value TEXT,
  n_children INTEGER NOT NULL DEFAULT 0
);
"""

INSERT = "INSERT INTO nodes(id,parent_id,ord,depth,kind,name,value) VALUES(?1,?2,?3,?4,?5,?6,?7)"
SET_CHILDREN = "UPDATE nodes SET n_children=?1 WHERE id=?2"
PUT_META = "INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)"
INDEX = "CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);"

CHILDREN = (
    "SELECT id, ord, kind, name, substr(value,1,4096), "
    "CASE WHEN value IS NULL THEN 0 ELSE length(value) END, n_children "
    "FROM nodes WHERE parent_id=?1 ORDER BY ord LIMIT ?2 OFFSET ?3"
)
NODE = (
    "SELECT id, ord, kind, name, substr(value,1,10000000), "
    "CASE WHEN value IS NULL THEN 0 ELSE length(value) END, n_children, parent_id, depth "
    "FROM nodes WHERE id=?1"
)
PATH_STEP = "SELECT ord, name, kind, parent_id FROM nodes WHERE id=?1"
SEARCH_ALL = (
    "SELECT id, kind, name, substr(value,1,200), parent_id FROM nodes "
    "WHERE (name LIKE ?1 ESCAPE '\\' OR value LIKE ?1 ESCAPE '\\') "
    "ORDER BY id LIMIT ?2 OFFSET ?3"
)
SEARCH_KEYS = (
    "SELECT id, kind, name, substr(value,1,200), parent_id FROM nodes "
    "WHERE name LIKE ?1 ESCAPE '\\' ORDER BY id LIMIT ?2 OFFSET ?3"
)
SEARCH_VALUES = (
    "SELECT id, kind, name, substr(value,1,200), parent_id FROM nodes "
    "WHERE value LIKE ?1 ESCAPE '\\' ORDER BY id LIMIT ?2 OFFSET ?3"
)
TABLE_ROWS = "SELECT id, ord FROM nodes WHERE parent_id=?1 ORDER BY ord LIMIT ?2 OFFSET ?3"
TABLE_CELLS = "SELECT name, substr(value,1,4096) FROM nodes WHERE parent_id=?1 ORDER BY ord"
SUBTREE_KIDS = "SELECT id, kind, name, value FROM nodes WHERE parent_id=?1 ORDER BY ord"
META_GET = "SELECT value FROM meta WHERE key=?1"
META_ALL = "SELECT key, value FROM meta"

K_OBJ, K_ARR, K_STR, K_NUM, K_BOOL, K_NULL = 0, 1, 2, 3, 4, 5


def ingest_json_like_rust(conn, doc):
    """Mimic the Rust ingest node layout for a Python-parsed JSON document."""
    state = {"next_id": 2, "nodes": 1}
    conn.execute(INSERT, (1, None, 0, 0, K_ARR, None, None))

    def walk(val, parent, ord_, depth, name):
        nid = state["next_id"]
        state["next_id"] += 1
        state["nodes"] += 1
        if isinstance(val, dict):
            conn.execute(INSERT, (nid, parent, ord_, depth, K_OBJ, name, None))
            for i, (k, v) in enumerate(val.items()):
                walk(v, nid, i, depth + 1, k)
            conn.execute(SET_CHILDREN, (len(val), nid))
        elif isinstance(val, list):
            conn.execute(INSERT, (nid, parent, ord_, depth, K_ARR, name, None))
            for i, v in enumerate(val):
                walk(v, nid, i, depth + 1, None)
            conn.execute(SET_CHILDREN, (len(val), nid))
        elif isinstance(val, bool):
            conn.execute(INSERT, (nid, parent, ord_, depth, K_BOOL, name, "true" if val else "false"))
        elif val is None:
            conn.execute(INSERT, (nid, parent, ord_, depth, K_NULL, name, None))
        elif isinstance(val, (int, float)):
            conn.execute(INSERT, (nid, parent, ord_, depth, K_NUM, name, json.dumps(val)))
        else:
            conn.execute(INSERT, (nid, parent, ord_, depth, K_STR, name, str(val)))

    walk(doc, 1, 0, 1, None)
    conn.execute(SET_CHILDREN, (1, 1))
    return state["nodes"]


def main():
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    doc = {
        "users": [
            {"name": "alice", "zip": "00420", "tags": ["a", "b"], "ok": True},
            {"name": "bob 100%", "zip": "99999", "tags": [], "ok": None},
        ],
        "count": 2,
        "weird key!": "va_lue",
    }
    total = ingest_json_like_rust(conn, doc)
    conn.execute(PUT_META, ("format", "json"))
    conn.execute(PUT_META, ("root_id", "2"))
    conn.execute(PUT_META, ("total_nodes", str(total)))
    conn.executescript(INDEX)

    fails = []

    def check(label, cond):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            fails.append(label)

    # meta
    m = dict(conn.execute(META_ALL).fetchall())
    check("meta all", m["format"] == "json" and m["root_id"] == "2")
    check("meta get", conn.execute(META_GET, ("format",)).fetchone()[0] == "json")

    # node (root)
    root = conn.execute(NODE, (2,)).fetchone()
    check("node op: root is object w/ 3 children", root[2] == K_OBJ and root[6] == 3)

    # children of root
    kids = conn.execute(CHILDREN, (2, 200, 0)).fetchall()
    check("children op: 3 kids ordered", len(kids) == 3 and kids[0][3] == "users" and kids[0][6] == 2)

    # children pagination
    page = conn.execute(CHILDREN, (2, 1, 1)).fetchall()
    check("children offset/limit", len(page) == 1 and page[0][3] == "count")

    # path walk: find node 'alice'
    alice = conn.execute("SELECT id FROM nodes WHERE value='alice'").fetchone()[0]
    chain = []
    cur = alice
    while cur is not None:
        ordv, name, kind, parent = conn.execute(PATH_STEP, (cur,)).fetchone()
        chain.append((cur, ordv, name, kind))
        cur = parent
    check("path walk reaches synthetic root", chain[-1][0] == 1 and len(chain) == 5)

    # search with LIKE escape: find '100%' literally
    pat = "%" + "100%".replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    hits = conn.execute(SEARCH_ALL, (pat, 101, 0)).fetchall()
    check("search escaped %", len(hits) == 1 and "100%" in hits[0][3])
    pat2 = "%va\\_lue%"
    hits2 = conn.execute(SEARCH_VALUES, (pat2, 101, 0)).fetchall()
    check("search escaped _", len(hits2) == 1)
    hits3 = conn.execute(SEARCH_KEYS, ("%name%", 101, 0)).fetchall()
    check("search keys", len(hits3) == 2)

    # table ops (simulate csv rows = children of users array)
    users = conn.execute("SELECT id FROM nodes WHERE name='users'").fetchone()[0]
    rows = conn.execute(TABLE_ROWS, (users, 100, 0)).fetchall()
    check("table rows", len(rows) == 2)
    cells = conn.execute(TABLE_CELLS, (rows[0][0],)).fetchall()
    check("table cells preserve leading zero", any(c[1] == "00420" for c in cells))

    # subtree reconstruction query
    kids2 = conn.execute(SUBTREE_KIDS, (users,)).fetchall()
    check("subtree kids", len(kids2) == 2)

    print()
    if fails:
        print("FAILURES:", fails)
        sys.exit(1)
    print(f"All SQL statements validated OK ({total} nodes)")


if __name__ == "__main__":
    main()
