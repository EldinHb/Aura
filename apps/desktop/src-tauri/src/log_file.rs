//! The app's log file: `aura-desktop.log` in the data directory, next to
//! `aurad.log`, so what the shell and the webview log (update failures among
//! it) is kept when Aura runs from Finder or the Start menu, where stderr goes
//! nowhere. It rotates by size: at [`MAX_BYTES`] the file becomes `.1`, `.1`
//! becomes `.2` and so on, keeping [`KEEP`] files in all.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP: usize = 5;

/// The log file's name. A development build has its own: it shares the data
/// directory (`~/.aura`) with an installed Aura, and two processes rotating
/// one file would lose lines.
pub fn file_name() -> &'static str {
    if cfg!(debug_assertions) {
        "aura-desktop-dev.log"
    } else {
        "aura-desktop.log"
    }
}

/// A file that starts over in a new file once it holds `max_bytes`, keeping
/// `keep` files: `path`, `path.1` (the newest older one) up to `path.{keep-1}`.
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: File,
    written: u64,
}

impl RotatingFile {
    pub fn open(path: &Path, max_bytes: u64, keep: usize) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let written = file.metadata()?.len();
        Ok(Self {
            path: path.to_path_buf(),
            max_bytes,
            keep: keep.max(1),
            file,
            written,
        })
    }

    fn numbered(&self, n: usize) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        if self.keep > 1 {
            let _ = std::fs::remove_file(self.numbered(self.keep - 1));
            for n in (1..self.keep - 1).rev() {
                let from = self.numbered(n);
                if from.exists() {
                    std::fs::rename(&from, self.numbered(n + 1))?;
                }
            }
            std::fs::rename(&self.path, self.numbered(1))?;
        }
        // keep == 1: start the one file over.
        self.file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // A line goes whole into one file: rotate before it, not in it.
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// The log file in `data_dir`, rotating at [`MAX_BYTES`] and keeping [`KEEP`].
pub fn open(data_dir: &Path) -> io::Result<RotatingFile> {
    RotatingFile::open(&data_dir.join(file_name()), MAX_BYTES, KEEP)
}

/// Log a panic before the default hook prints it to stderr: a panic in the
/// shell would otherwise leave no trace in the log.
pub fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        tracing::error!("panic{location}: {message}");
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aura-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn files(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn rotates_by_size_and_keeps_five_files() {
        let d = dir("rotate");
        let path = d.join("app.log");
        let mut f = RotatingFile::open(&path, 100, 5).unwrap();
        // 40 lines of 25 bytes: 4 lines per file, 10 files' worth.
        for i in 0..40 {
            writeln!(f, "line {i:03} ...............").unwrap();
        }
        f.flush().unwrap();
        assert_eq!(
            files(&d),
            [
                "app.log",
                "app.log.1",
                "app.log.2",
                "app.log.3",
                "app.log.4"
            ]
        );
        for name in files(&d) {
            let len = std::fs::metadata(d.join(&name)).unwrap().len();
            assert!(len <= 100, "{name}: {len} bytes");
        }
        // The newest lines are in the file itself, the ones before in .1.
        let current = std::fs::read_to_string(&path).unwrap();
        assert!(current.ends_with("line 039 ...............\n"), "{current}");
        assert!(current.starts_with("line 036"), "{current}");
        let previous = std::fs::read_to_string(d.join("app.log.1")).unwrap();
        assert!(previous.starts_with("line 032") && previous.contains("line 035"));
        // Lines are never split across files.
        for name in files(&d) {
            let text = std::fs::read_to_string(d.join(&name)).unwrap();
            assert!(text.lines().all(|l| l.len() == 24), "{name}: {text:?}");
        }
    }

    #[test]
    fn continues_an_existing_file_and_counts_it() {
        let d = dir("append");
        let path = d.join("app.log");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(&path, "x".repeat(90)).unwrap();
        let mut f = RotatingFile::open(&path, 100, 5).unwrap();
        f.write_all(b"0123456789\n").unwrap();
        // 90 + 11 > 100: the earlier run's file moved to .1 first.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "0123456789\n");
        assert_eq!(
            std::fs::read_to_string(d.join("app.log.1")).unwrap().len(),
            90
        );
    }

    #[test]
    fn a_line_longer_than_the_limit_still_goes_in() {
        let d = dir("long");
        let path = d.join("app.log");
        let mut f = RotatingFile::open(&path, 10, 2).unwrap();
        f.write_all(b"a line longer than ten bytes\n").unwrap();
        f.write_all(b"next\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "next\n");
        assert_eq!(files(&d), ["app.log", "app.log.1"]);
    }

    #[test]
    fn tracing_lines_land_in_the_file_without_colours() {
        use tracing_subscriber::layer::SubscriberExt;
        let d = dir("tracing");
        let writer = std::sync::Mutex::new(open(&d).unwrap());
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(kind = "network", "update check failed: offline");
        });
        let text = std::fs::read_to_string(d.join(file_name())).unwrap();
        assert!(text.contains("WARN"), "{text}");
        assert!(
            text.contains("update check failed: offline kind=\"network\""),
            "{text}"
        );
        assert!(!text.contains('\u{1b}'), "no colour codes: {text:?}");
    }
}
