//! Locating provider CLIs. GUI apps on macOS start with a minimal `PATH`
//! (no Homebrew, no `~/.local/bin`), so a bare PATH lookup misses tools the
//! user's shell finds without trouble. Well-known install directories are
//! searched as well.

use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Find `name`, honouring `env_override` first (an explicit path), then `PATH`,
/// then the usual per-user and system install directories.
pub fn find_binary(name: &str, env_override: &str, extra: &[PathBuf]) -> Option<String> {
    if let Ok(p) = std::env::var(env_override) {
        if PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = vec![];
    if let Ok(path) = std::env::var("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|d| d.join(name)));
    }
    candidates.extend(extra.iter().cloned());
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".volta/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".cargo/bin",
            ".nix-profile/bin",
        ] {
            candidates.push(home.join(rel).join(name));
        }
    }
    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/run/current-system/sw/bin",
    ] {
        candidates.push(PathBuf::from(dir).join(name));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

/// How long a detection result is trusted before the CLI is probed again.
const PROBE_TTL: Duration = Duration::from_secs(5);

/// Where a provider CLI is and what version it reports.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Detected {
    pub binary: Option<String>,
    pub version: Option<String>,
}

/// Locates a provider CLI and reads its `--version`, re-probing once the cached
/// result goes stale.
///
/// Providers used to detect once in their constructor and keep the result for
/// the process lifetime. `aurad` outlives the desktop app, so a CLI upgraded
/// underneath a running daemon kept being reported at its old version — and one
/// installed after the daemon started stayed "not found" — until the daemon
/// itself was restarted. Anything user-installed has to be re-checked.
pub struct BinaryProbe {
    lookup: Option<Lookup>,
    pinned: Option<String>,
    parse_version: fn(&str) -> Option<String>,
    ttl: Duration,
    state: parking_lot::Mutex<(Detected, Option<Instant>)>,
}

#[derive(Clone)]
struct Lookup {
    name: String,
    env_override: String,
    extra: Vec<PathBuf>,
}

impl BinaryProbe {
    /// Probe that searches for `name` the way [`find_binary`] does.
    pub fn search(
        name: &str,
        env_override: &str,
        extra: Vec<PathBuf>,
        parse_version: fn(&str) -> Option<String>,
    ) -> Self {
        Self {
            lookup: Some(Lookup {
                name: name.to_string(),
                env_override: env_override.to_string(),
                extra,
            }),
            pinned: None,
            parse_version,
            ttl: PROBE_TTL,
            state: parking_lot::Mutex::new((Detected::default(), None)),
        }
    }

    /// Probe for an explicit path. The path is fixed; the version is still re-read.
    pub fn pinned(binary: impl Into<String>, parse_version: fn(&str) -> Option<String>) -> Self {
        Self {
            lookup: None,
            pinned: Some(binary.into()),
            parse_version,
            ttl: PROBE_TTL,
            state: parking_lot::Mutex::new((Detected::default(), None)),
        }
    }

    /// Override the staleness window.
    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    /// Last known detection. Never blocks, so it is safe from `Provider::info`.
    pub fn cached(&self) -> Detected {
        self.state.lock().0.clone()
    }

    pub fn binary(&self) -> Option<String> {
        self.cached().binary
    }

    pub fn version(&self) -> Option<String> {
        self.cached().version
    }

    /// Detect now, on the calling thread. Used at construction so a provider is
    /// usable before anything awaits it.
    pub fn probe_blocking(&self) {
        let d = self.detect();
        *self.state.lock() = (d, Some(Instant::now()));
    }

    /// Re-detect when the cached result is older than [`PROBE_TTL`]. Spawning a
    /// process is blocking work, so it runs on the blocking pool.
    pub async fn refresh(&self) {
        let fresh = matches!(self.state.lock().1, Some(at) if at.elapsed() < self.ttl);
        if fresh {
            return;
        }
        let (lookup, pinned, parse) =
            (self.lookup.clone(), self.pinned.clone(), self.parse_version);
        match tokio::task::spawn_blocking(move || {
            detect_with(lookup.as_ref(), pinned.as_deref(), parse)
        })
        .await
        {
            Ok(d) => *self.state.lock() = (d, Some(Instant::now())),
            // A join error means the probe panicked or was cancelled; keep the
            // last known result rather than reporting the CLI as missing.
            Err(e) => tracing::warn!("provider detection failed: {e}"),
        }
    }

    fn detect(&self) -> Detected {
        detect_with(
            self.lookup.as_ref(),
            self.pinned.as_deref(),
            self.parse_version,
        )
    }
}

fn detect_with(
    lookup: Option<&Lookup>,
    pinned: Option<&str>,
    parse_version: fn(&str) -> Option<String>,
) -> Detected {
    let binary = match (lookup, pinned) {
        (_, Some(p)) => Some(p.to_string()),
        (Some(l), None) => find_binary(&l.name, &l.env_override, &l.extra),
        (None, None) => None,
    };
    let version = binary
        .as_deref()
        .and_then(|b| read_version(b, parse_version));
    Detected { binary, version }
}

fn read_version(binary: &str, parse_version: fn(&str) -> Option<String>) -> Option<String> {
    let out = std::process::Command::new(binary)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn write_cli(path: &std::path::Path, version: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        writeln!(f, "#!/bin/sh\necho \"tool {version}\"").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn parse(stdout: &str) -> Option<String> {
        let v = stdout.trim();
        (!v.is_empty()).then(|| v.strip_prefix("tool ").unwrap_or(v).to_string())
    }

    #[tokio::test]
    async fn rereads_version_after_the_cli_is_upgraded() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tool");
        write_cli(&cli, "1.0.0");

        let probe =
            BinaryProbe::pinned(cli.to_str().unwrap(), parse).with_ttl(Duration::from_millis(1));
        probe.probe_blocking();
        assert_eq!(probe.version().as_deref(), Some("1.0.0"));

        write_cli(&cli, "2.0.0");
        tokio::time::sleep(Duration::from_millis(5)).await;
        probe.refresh().await;
        assert_eq!(
            probe.version().as_deref(),
            Some("2.0.0"),
            "upgrade picked up once the probe went stale"
        );
    }

    #[tokio::test]
    async fn serves_the_cached_version_inside_the_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tool");
        write_cli(&cli, "1.0.0");

        let probe =
            BinaryProbe::pinned(cli.to_str().unwrap(), parse).with_ttl(Duration::from_secs(600));
        probe.probe_blocking();
        write_cli(&cli, "2.0.0");
        probe.refresh().await;
        assert_eq!(
            probe.version().as_deref(),
            Some("1.0.0"),
            "no re-probe while the cached result is fresh"
        );
    }

    #[tokio::test]
    async fn detects_a_cli_that_appears_after_startup() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("tool");

        let probe =
            BinaryProbe::pinned(cli.to_str().unwrap(), parse).with_ttl(Duration::from_millis(1));
        probe.probe_blocking();
        assert_eq!(probe.version(), None, "nothing installed yet");

        write_cli(&cli, "1.0.0");
        tokio::time::sleep(Duration::from_millis(5)).await;
        probe.refresh().await;
        assert_eq!(
            probe.version().as_deref(),
            Some("1.0.0"),
            "install after startup is noticed"
        );
    }
}

/// Marker around the PATH we ask the login shell for, so a noisy rc file that
/// prints banners or escape codes cannot be mistaken for the answer.
const PATH_SENTINEL_START: &str = "__AURA_PATH_START__";
const PATH_SENTINEL_END: &str = "__AURA_PATH_END__";
const PATH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// PATH as the user's shell reports it, or `None` when it cannot be determined.
///
/// macOS starts GUI apps through Launch Services, which does not read the
/// user's shell profile: an app launched from Finder gets `/usr/bin:/bin:
/// /usr/sbin:/sbin` and nothing more. `aurad` is spawned by the desktop app, so
/// every provider CLI, PTY shell and `git` call it starts inherits that stripped
/// PATH and cannot see Homebrew, volta, cargo or `~/.local/bin`.
///
/// The shell is run both as a login shell and interactively (`-lic`), because
/// the two read different files — Homebrew's `shellenv` typically lands in
/// `.zprofile` (login) while version managers like volta and nvm write to
/// `.zshrc` (interactive). Asking for only one of the two misses half the PATH.
pub fn login_path() -> Option<String> {
    if !cfg!(unix) {
        return None;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    probe_login_path(&shell)
}

fn probe_login_path(shell: &str) -> Option<String> {
    let script = format!("printf '{PATH_SENTINEL_START}%s{PATH_SENTINEL_END}' \"$PATH\"");
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-lic", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    // An rc file can hang or wait on input; never let that block daemon startup.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    let out = match rx.recv_timeout(PATH_PROBE_TIMEOUT) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            tracing::warn!("login shell PATH probe failed: {e}");
            return None;
        }
        Err(_) => {
            tracing::warn!("login shell PATH probe timed out after {PATH_PROBE_TIMEOUT:?}");
            return None;
        }
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let start = text.find(PATH_SENTINEL_START)? + PATH_SENTINEL_START.len();
    let end = text[start..].find(PATH_SENTINEL_END)? + start;
    let path = text[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Union of `current` and `extra`, keeping first-seen order and dropping repeats.
fn merge_paths(current: &str, extra: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for entry in extra.split(':').chain(current.split(':')) {
        if !entry.is_empty() && seen.insert(entry) {
            out.push(entry);
        }
    }
    out.join(":")
}

/// Replace this process's PATH with the login shell's, so every child inherits
/// it. Returns the PATH in effect afterwards. Call once, early in startup.
///
/// Entries already present are kept — the login shell's come first — so nothing
/// deliberately put on PATH before launch is lost.
pub fn adopt_login_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    match login_path() {
        Some(from_shell) => {
            let merged = merge_paths(&current, &from_shell);
            if merged != current {
                std::env::set_var("PATH", &merged);
                tracing::info!(
                    entries = merged.split(':').count(),
                    "adopted login shell PATH"
                );
            }
            merged
        }
        None => current,
    }
}

#[cfg(all(test, unix))]
mod path_tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in shell that prints noise before the answer, like a real rc file.
    fn fake_shell(dir: &std::path::Path, path_value: &str) -> std::path::PathBuf {
        let p = dir.join("fakeshell");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "echo 'welcome to your shell'").unwrap();
        writeln!(
            f,
            "printf '{PATH_SENTINEL_START}{path_value}{PATH_SENTINEL_END}'"
        )
        .unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn reads_path_past_rc_file_noise() {
        let dir = tempfile::tempdir().unwrap();
        let sh = fake_shell(dir.path(), "/opt/homebrew/bin:/usr/bin");
        assert_eq!(
            probe_login_path(sh.to_str().unwrap()).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn missing_sentinel_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("quiet");
        std::fs::write(&p, "#!/bin/sh\necho nothing useful\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(probe_login_path(p.to_str().unwrap()), None);
    }

    /// Diagnostic against the real machine, so it is not part of the normal run:
    /// `cargo test -p aura-core -- --ignored --nocapture recovers_the_real`
    #[test]
    #[ignore = "depends on the developer's own shell profile"]
    fn recovers_the_real_login_path() {
        let before = std::env::var("PATH").unwrap_or_default();
        let after = adopt_login_path();
        let gained: Vec<&str> = after
            .split(':')
            .filter(|e| !before.split(':').any(|b| b == *e))
            .collect();
        println!("gained {} entries: {gained:?}", gained.len());
        // Counting entries would be wrong: merging removes duplicates, and an
        // inherited PATH can repeat the same directory many times. What must
        // hold is that nothing present before is dropped.
        for entry in before.split(':').filter(|e| !e.is_empty()) {
            assert!(
                after.split(':').any(|e| e == entry),
                "adopting dropped {entry}"
            );
        }
    }

    #[test]
    fn merge_keeps_order_and_drops_duplicates() {
        // Login entries win the front; existing ones survive; no repeats.
        assert_eq!(
            merge_paths("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin"),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
        assert_eq!(merge_paths("", "/a:/a:/b"), "/a:/b");
    }
}
