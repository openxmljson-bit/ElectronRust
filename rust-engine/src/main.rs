// OPENJSONXML engine — streaming ingest of very large JSON/NDJSON/XML/CSV/TSV
// files into SQLite, plus a query server for the Electron UI.
//
// Usage:
//   openjsonxml-engine ingest <file> --db <db-path> [--format auto|json|ndjson|xml|csv|tsv]
//   openjsonxml-engine serve --db <db-path>
mod csvp;
mod db;
mod diff;
mod ftsindex;
mod json;
mod progress;
mod reader;
mod serve;
mod xmlp;

use std::io::Write;
use std::process::exit;

fn emit_error(msg: &str) {
    println!("{}", serde_json::json!({"event":"error","message":msg}));
    let _ = std::io::stdout().flush();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        emit_error("usage: openjsonxml-engine <ingest|serve> ...");
        exit(2);
    }
    match args[1].as_str() {
        "ingest" => {
            let mut file = String::new();
            let mut dbp = String::new();
            let mut format = String::from("auto");
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--db" => {
                        i += 1;
                        dbp = args.get(i).cloned().unwrap_or_default();
                    }
                    "--format" => {
                        i += 1;
                        format = args.get(i).cloned().unwrap_or_default();
                    }
                    s => file = s.to_string(),
                }
                i += 1;
            }
            if file.is_empty() || dbp.is_empty() {
                emit_error("ingest requires <file> --db <db-path>");
                exit(2);
            }
            if let Err(e) = run_ingest(&file, &dbp, &format) {
                emit_error(&e);
                let _ = std::fs::remove_file(&dbp);
                exit(1);
            }
        }
        "deindex" => {
            let mut dbp = String::new();
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--db" {
                    i += 1;
                    dbp = args.get(i).cloned().unwrap_or_default();
                }
                i += 1;
            }
            if dbp.is_empty() {
                emit_error("deindex requires --db <db-path>");
                exit(2);
            }
            if let Err(e) = ftsindex::remove(&dbp) {
                emit_error(&e);
                exit(1);
            }
        }
        "index" => {
            let mut dbp = String::new();
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--db" {
                    i += 1;
                    dbp = args.get(i).cloned().unwrap_or_default();
                }
                i += 1;
            }
            if dbp.is_empty() {
                emit_error("index requires --db <db-path>");
                exit(2);
            }
            if let Err(e) = ftsindex::run(&dbp) {
                emit_error(&e);
                exit(1);
            }
        }
        "diff" => {
            let mut a = String::new();
            let mut b = String::new();
            let mut limit: usize = 5000;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--a" => {
                        i += 1;
                        a = args.get(i).cloned().unwrap_or_default();
                    }
                    "--b" => {
                        i += 1;
                        b = args.get(i).cloned().unwrap_or_default();
                    }
                    "--limit" => {
                        i += 1;
                        limit = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(5000);
                    }
                    _ => {}
                }
                i += 1;
            }
            if a.is_empty() || b.is_empty() {
                emit_error("diff requires --a <db> --b <db>");
                exit(2);
            }
            if let Err(e) = diff::run(&a, &b, limit) {
                emit_error(&e);
                exit(1);
            }
        }
        "serve" => {
            let mut dbp = String::new();
            let mut i = 2;
            while i < args.len() {
                if args[i] == "--db" {
                    i += 1;
                    dbp = args.get(i).cloned().unwrap_or_default();
                }
                i += 1;
            }
            if dbp.is_empty() {
                emit_error("serve requires --db <db-path>");
                exit(2);
            }
            if let Err(e) = serve::serve(&dbp) {
                emit_error(&e);
                exit(1);
            }
        }
        _ => {
            emit_error("unknown command (expected 'ingest' or 'serve')");
            exit(2);
        }
    }
}

fn detect_format(path: &str, requested: &str) -> String {
    if requested != "auto" && !requested.is_empty() {
        return requested.to_string();
    }
    let lower = path.to_lowercase();
    if lower.ends_with(".ndjson") || lower.ends_with(".jsonl") {
        "ndjson".into()
    } else if lower.ends_with(".xml") {
        "xml".into()
    } else if lower.ends_with(".csv") {
        "csv".into()
    } else if lower.ends_with(".tsv") || lower.ends_with(".tab") {
        "tsv".into()
    } else {
        "json".into()
    }
}

fn run_ingest(file: &str, dbp: &str, format: &str) -> Result<(), String> {
    let f = std::fs::File::open(file).map_err(|e| format!("cannot open file: {}", e))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    if total == 0 {
        return Err(String::from("file is empty"));
    }
    let fmt = detect_format(file, format);
    let mut r = reader::ByteReader::new(f);
    let mut dbw = db::DbWriter::create(dbp)?;
    let mut prog = progress::Progress::new(total);
    prog.emit_start(&fmt);

    let (total_nodes, root_children) = match fmt.as_str() {
        "json" | "ndjson" => json::ingest(&mut r, &mut dbw, &mut prog)?,
        "csv" => csvp::ingest(&mut r, &mut dbw, &mut prog, b',')?,
        "tsv" => csvp::ingest(&mut r, &mut dbw, &mut prog, b'\t')?,
        "xml" => xmlp::ingest(&mut r, &mut dbw, &mut prog)?,
        other => return Err(format!("unknown format: {}", other)),
    };
    if root_children == 0 {
        return Err(String::from("no data found in file"));
    }

    // If the document has exactly one top-level value, present it as the root.
    let root_id: i64 = if fmt != "csv" && fmt != "tsv" && root_children == 1 { 2 } else { 1 };
    dbw.put_meta("format", &fmt)?;
    dbw.put_meta("root_id", &root_id.to_string())?;
    dbw.put_meta("total_nodes", &total_nodes.to_string())?;
    dbw.put_meta("source_path", file)?;
    dbw.put_meta("source_bytes", &total.to_string())?;
    dbw.put_meta("engine_version", env!("CARGO_PKG_VERSION"))?;

    prog.emit_phase("indexing");
    dbw.finish()?;
    prog.emit_done(total_nodes, root_id);
    Ok(())
}
