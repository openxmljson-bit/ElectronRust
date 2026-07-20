// Throttled JSONL progress reporting on stdout.
use std::io::Write;
use std::time::Instant;

pub struct Progress {
    total: u64,
    last: Instant,
    started: Instant,
    emitted_first: bool,
}

fn flush() {
    let _ = std::io::stdout().flush();
}

impl Progress {
    pub fn new(total: u64) -> Self {
        Self { total, last: Instant::now(), started: Instant::now(), emitted_first: false }
    }

    pub fn emit_start(&self, format: &str) {
        println!(
            "{}",
            serde_json::json!({"event":"start","total_bytes":self.total,"format":format})
        );
        flush();
    }

    pub fn tick(&mut self, consumed: u64, nodes: u64) {
        if !self.emitted_first || self.last.elapsed().as_millis() >= 200 {
            self.emitted_first = true;
            self.last = Instant::now();
            println!(
                "{}",
                serde_json::json!({
                    "event":"progress",
                    "bytes": consumed,
                    "total_bytes": self.total,
                    "nodes": nodes,
                    "elapsed_ms": self.started.elapsed().as_millis() as u64
                })
            );
            flush();
        }
    }

    pub fn emit_phase(&self, phase: &str) {
        println!("{}", serde_json::json!({"event":"phase","phase":phase}));
        flush();
    }

    pub fn emit_done(&self, nodes: u64, root_id: i64) {
        println!(
            "{}",
            serde_json::json!({
                "event":"done",
                "nodes": nodes,
                "root_id": root_id,
                "elapsed_ms": self.started.elapsed().as_millis() as u64
            })
        );
        flush();
    }
}
