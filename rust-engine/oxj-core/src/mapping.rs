//! Memory-mapped I/O (SPEC §6). The file is opened read-only and mapped
//! once; the parser, every search worker and the UI share one mapping
//! (wrapped in `Arc` by callers) with no copies. The 1:1 RAM property comes
//! from the OS: only touched pages are resident.

#[cfg(unix)]
use memmap2::Advice;
use memmap2::{Mmap, MmapOptions};
use std::fs::File;
use std::io;
use std::path::Path;

enum Backing {
    Mapped(Mmap),
    /// mmap(2) rejects zero-length maps; represent an empty file explicitly.
    Empty,
}

pub struct Mapping {
    backing: Backing,
}

impl Mapping {
    /// Open `path` read-only and memory-map it. On Unix, advise the kernel
    /// that the initial parse will read sequentially.
    pub fn open(path: &Path) -> io::Result<Mapping> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        if len == 0 {
            return Ok(Mapping {
                backing: Backing::Empty,
            });
        }
        // SAFETY: the file is opened read-only and never written through the
        // map. Externally-truncated files can SIGBUS (SPEC §16); the planned
        // log-tailing feature only ever grows files.
        let mmap = unsafe { MmapOptions::new().map(&file)? };
        #[cfg(unix)]
        {
            let _ = mmap.advise(Advice::Sequential);
        }
        Ok(Mapping {
            backing: Backing::Mapped(mmap),
        })
    }

    #[inline]
    pub fn bytes(&self) -> &[u8] {
        match &self.backing {
            Backing::Mapped(m) => &m[..],
            Backing::Empty => &[],
        }
    }

    #[inline]
    pub fn len(&self) -> u64 {
        self.bytes().len() as u64
    }

    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bounds-checked zero-copy slice: a corrupt index cannot crash the
    /// process — out-of-range requests return `None` (SPEC §6, §12).
    #[inline]
    pub fn slice(&self, offset: u64, len: u32) -> Option<&[u8]> {
        let bytes = self.bytes();
        let start = usize::try_from(offset).ok()?;
        let end = start.checked_add(len as usize)?;
        bytes.get(start..end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn temp_file(contents: &[u8]) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "oxj-mapping-test-{}-{}",
            std::process::id(),
            contents.len()
        ));
        let mut f = File::create(&path).unwrap();
        f.write_all(contents).unwrap();
        path
    }

    #[test]
    fn maps_and_slices() {
        let path = temp_file(b"hello world");
        let m = Mapping::open(&path).unwrap();
        assert_eq!(m.bytes(), b"hello world");
        assert_eq!(m.slice(6, 5).unwrap(), b"world");
        assert_eq!(m.slice(6, 6), None); // out of range → None, not panic
        assert_eq!(m.slice(u64::MAX, 1), None);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn empty_file_is_ok() {
        let path = temp_file(b"");
        let m = Mapping::open(&path).unwrap();
        assert!(m.is_empty());
        assert_eq!(m.bytes(), b"");
        assert_eq!(m.slice(0, 0).unwrap(), b"");
        assert_eq!(m.slice(0, 1), None);
        std::fs::remove_file(path).ok();
    }
}
