//! Measure parse (index-build) time for a file — the same work the app's
//! "Load:" badge reports. Run on each branch with the SAME file to compare:
//!
//!   cargo run -p oxj-core --release --example loadtime -- /path/to/file.json
//!
//! Repeats a few times and prints the best/median wall time and node count.

use std::time::Instant;

use oxj_core::{parse_document, Format, Mapping};

fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: loadtime <file>");
            std::process::exit(2);
        }
    };
    let runs: usize = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let format = Format::from_path(std::path::Path::new(&path));
    let mut times = Vec::new();
    let mut nodes = 0usize;
    let mut bytes = 0u64;

    for _ in 0..runs {
        // Fresh mapping each run so the parse isn't reusing a warm Index.
        let mapping = Mapping::open(std::path::Path::new(&path))
            .expect("open failed");
        bytes = mapping.len();
        let t0 = Instant::now();
        let index = parse_document(mapping.bytes(), format).expect("parse failed");
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        nodes = index.len();
        times.push(ms);
    }

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let best = times[0];
    let median = times[times.len() / 2];
    let mb = bytes as f64 / 1e6;
    println!(
        "{} · {:.1} MB · {} nodes · {} runs",
        format.name(),
        mb,
        nodes,
        runs
    );
    println!(
        "parse: best {:.1} ms · median {:.1} ms · {:.0} MB/s",
        best,
        median,
        mb / (best / 1000.0)
    );
}
