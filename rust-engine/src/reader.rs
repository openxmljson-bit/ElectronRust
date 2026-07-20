// Buffered byte reader with peek support. Bounded memory: one fixed buffer.
use std::io::Read;

const BUF_SIZE: usize = 4 * 1024 * 1024;

pub struct ByteReader<R: Read> {
    inner: R,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    pub consumed: u64,
}

impl<R: Read> ByteReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, buf: vec![0u8; BUF_SIZE], pos: 0, len: 0, consumed: 0 }
    }

    fn refill(&mut self) -> bool {
        loop {
            match self.inner.read(&mut self.buf) {
                Ok(0) => return false,
                Ok(n) => {
                    self.pos = 0;
                    self.len = n;
                    return true;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return false,
            }
        }
    }

    #[inline]
    pub fn peek(&mut self) -> Option<u8> {
        if self.pos >= self.len {
            if !self.refill() {
                return None;
            }
        }
        Some(self.buf[self.pos])
    }

    #[inline]
    pub fn next_byte(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.pos += 1;
        self.consumed += 1;
        Some(b)
    }

    // Skip a UTF-8 BOM if present at the current position (call at file start).
    pub fn skip_bom(&mut self) {
        if self.peek() == Some(0xEF) {
            self.next_byte();
            if self.peek() == Some(0xBB) {
                self.next_byte();
                if self.peek() == Some(0xBF) {
                    self.next_byte();
                }
            }
        }
    }
}

pub fn skip_ws<R: Read>(r: &mut ByteReader<R>) {
    while let Some(b) = r.peek() {
        match b {
            b' ' | b'\t' | b'\r' | b'\n' => {
                r.next_byte();
            }
            _ => break,
        }
    }
}
