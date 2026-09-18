//! PTY management on top of `portable-pty` (Unix PTYs and Windows ConPTY).
//!
//! A [`PtyHandle`] owns one child process. Output is fanned out over a
//! broadcast channel and mirrored into a bounded scrollback ring buffer so a
//! client attaching later can restore the screen.

use anyhow::{Context, Result};
use bytes::Bytes;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{broadcast, watch};

pub const DEFAULT_SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct PtySpec {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub scrollback_bytes: usize,
}

impl PtySpec {
    pub fn new(argv: Vec<String>, cwd: impl Into<String>) -> Self {
        Self {
            argv,
            cwd: cwd.into(),
            env: vec![],
            cols: 120,
            rows: 40,
            scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
        }
    }
}

/// The user's login shell (argv), falling back to `sh` / `powershell`.
pub fn default_shell() -> Vec<String> {
    #[cfg(windows)]
    {
        return vec!["powershell.exe".into()];
    }
    #[allow(unreachable_code)]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        vec![sh, "-l".into()]
    }
}

pub struct Scrollback {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Scrollback {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::with_capacity(cap.min(1 << 20)), cap }
    }
    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(data);
    }
    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
    pub fn replace(&mut self, data: &[u8]) {
        self.buf.clear();
        self.push(data);
    }
    pub fn len(&self) -> usize {
        self.buf.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

struct Inner {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    scrollback: Mutex<Scrollback>,
    output: broadcast::Sender<Bytes>,
    exit: watch::Sender<Option<i32>>,
    exit_rx: watch::Receiver<Option<i32>>,
    size: Mutex<(u16, u16)>,
}

#[derive(Clone)]
pub struct PtyHandle {
    inner: Arc<Inner>,
}

impl PtyHandle {
    pub fn spawn(spec: PtySpec) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;
        let (prog, args) = spec.argv.split_first().context("empty argv")?;
        let mut cmd = CommandBuilder::new(prog);
        cmd.args(args);
        cmd.cwd(&spec.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("AURA_SESSION", "1");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).context("spawn in pty")?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().context("clone reader")?;
        let writer = pair.master.take_writer().context("take writer")?;
        let (output, _) = broadcast::channel::<Bytes>(1024);
        let (exit, exit_rx) = watch::channel(None);
        let inner = Arc::new(Inner {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            scrollback: Mutex::new(Scrollback::new(spec.scrollback_bytes)),
            output,
            exit,
            exit_rx,
            size: Mutex::new((spec.cols, spec.rows)),
        });
        let handle = Self { inner: inner.clone() };

        // Reader thread: blocking reads -> scrollback + broadcast.
        let reader_inner = inner.clone();
        std::thread::Builder::new()
            .name("aura-pty-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = Bytes::copy_from_slice(&buf[..n]);
                            reader_inner.scrollback.lock().push(&chunk);
                            let _ = reader_inner.output.send(chunk);
                        }
                        Err(e) => {
                            tracing::debug!("pty reader ended: {e}");
                            break;
                        }
                    }
                }
            })
            .context("spawn reader thread")?;

        // Waiter thread: child exit -> watch channel.
        let wait_inner = inner.clone();
        std::thread::Builder::new()
            .name("aura-pty-waiter".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => Some(status.exit_code() as i32),
                    Err(e) => {
                        tracing::warn!("pty wait failed: {e}");
                        Some(-1)
                    }
                };
                let _ = wait_inner.exit.send(code);
            })
            .context("spawn waiter thread")?;

        Ok(handle)
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.inner.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        *self.inner.size.lock() = (cols, rows);
        self.inner
            .master
            .lock()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("resize")
    }

    pub fn size(&self) -> (u16, u16) {
        *self.inner.size.lock()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Bytes> {
        self.inner.output.subscribe()
    }

    pub fn scrollback(&self) -> Vec<u8> {
        self.inner.scrollback.lock().snapshot()
    }

    /// Seed the scrollback (e.g. restored from disk) before new output arrives.
    pub fn seed_scrollback(&self, data: &[u8]) {
        let mut sb = self.inner.scrollback.lock();
        let current = sb.snapshot();
        sb.replace(data);
        sb.push(&current);
    }

    pub fn exit_code(&self) -> Option<i32> {
        *self.inner.exit_rx.borrow()
    }

    pub fn has_exited(&self) -> bool {
        self.exit_code().is_some()
    }

    /// Resolves when the child exits.
    pub async fn wait(&self) -> Option<i32> {
        let mut rx = self.inner.exit_rx.clone();
        loop {
            if let Some(code) = *rx.borrow() {
                return Some(code);
            }
            if rx.changed().await.is_err() {
                return *rx.borrow();
            }
        }
    }

    pub fn kill(&self) -> Result<()> {
        self.inner.killer.lock().kill().context("kill")
    }

    /// True when both handles refer to the same PTY.
    pub fn same(&self, other: &PtyHandle) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_ring_keeps_tail() {
        let mut sb = Scrollback::new(8);
        sb.push(b"abcdef");
        sb.push(b"ghij");
        assert_eq!(sb.snapshot(), b"cdefghij");
        sb.push(b"0123456789ab");
        assert_eq!(sb.snapshot(), b"456789ab");
    }

    #[tokio::test]
    async fn spawn_echo_and_exit() {
        let spec = PtySpec::new(vec!["/bin/sh".into(), "-c".into(), "printf hello; exit 3".into()], "/tmp");
        let h = PtyHandle::spawn(spec).unwrap();
        let code = tokio::time::timeout(std::time::Duration::from_secs(10), h.wait()).await.unwrap();
        assert_eq!(code, Some(3));
        // give the reader a moment to drain
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let sb = String::from_utf8_lossy(&h.scrollback()).to_string();
        assert!(sb.contains("hello"), "scrollback was {sb:?}");
    }

    #[tokio::test]
    async fn write_and_read_roundtrip() {
        let spec = PtySpec::new(vec!["/bin/cat".into()], "/tmp");
        let h = PtyHandle::spawn(spec).unwrap();
        let mut rx = h.subscribe();
        h.write(b"ping\n").unwrap();
        let mut got = String::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !got.contains("ping") && tokio::time::Instant::now() < deadline {
            if let Ok(Ok(chunk)) = tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
                got.push_str(&String::from_utf8_lossy(&chunk));
            }
        }
        assert!(got.contains("ping"), "got {got:?}");
        h.kill().unwrap();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h.wait()).await;
    }
}
