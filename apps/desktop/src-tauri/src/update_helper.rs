//! The installer helper, for Windows. The updater plugin would start the
//! installer and exit, and then nobody waits for it: a cancelled or failed
//! install would leave the daemon stopped and Aura closed, and nothing holds
//! the update lock while the installer copies `aurad.exe` and `aura.exe`.
//!
//! Instead the app copies its own executable to a temporary folder (so the
//! helper locks nothing the installer replaces) and starts it with
//! [`FLAG`]. The handover, over the helper's stdin and stdout:
//!
//! 1. the helper takes its folder's lock and the update lock
//!    ([`aura_rpc::update_lock`]) and says `locked`;
//! 2. the app stops the daemon, then says `go` (or `abort`, and the helper
//!    releases the lock and exits) and exits;
//! 3. its stdin closing tells the helper the app is gone. It stops any
//!    `aurad`/`aura` still running from the install folder, runs the
//!    installer and waits for it, checks what is installed, records how it
//!    went for the next app start, releases the lock, and starts Aura again,
//!    updated or not. The app's `ensure_daemon` then starts the daemon.
//!
//! What is guaranteed (see also `aura_rpc::update_lock`):
//!
//! - The installer runs contained (`aura_contain`): in a Job Object that
//!   Windows kills, with everything the installer started, when the helper
//!   exits however it exits. So a crashed helper never leaves an installer
//!   running unguarded.
//! - An installer still running after [`Limits::install`] (30 minutes) is
//!   stopped with its whole process tree, and the lock is released only once
//!   that tree has stopped. Stopping can block (a process with I/O pending in
//!   a driver ends only when that I/O does): if the tree is not confirmed
//!   stopped, the helper reports the failure, keeps the lock and its job,
//!   neither checks the files nor starts Aura, and keeps stopping the tree;
//!   only once it has stopped does it release the lock, and it exits without
//!   starting Aura.
//! - Only per-user installs update in place: they need no elevation, so the
//!   installer can join the helper's job. A per-machine or MSI install gets
//!   the "download" banner instead (`update::decide`).
//!
//! The protocol is plain std, built and tested on every platform; only
//! Windows uses it.

use aura_rpc::update_lock::{self, InstallResult};
use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

/// The first argument that turns the app's executable into the helper.
pub const FLAG: &str = "--aura-update-helper";

/// The first argument that makes the app print its version and exit: how the
/// helper reads the version of the app it just installed.
pub const VERSION_FLAG: &str = "--aura-version";

/// The helper's folder: its lifetime lock, and what marks the folder as one.
const FOLDER_LOCK: &str = "helper.lock";
const FOLDER_OWNER: &str = "aura-update-helper.json";
const OWNER: &str = "aura-update-helper";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallerKind {
    Nsis,
    Msi,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperArgs {
    pub data_dir: PathBuf,
    pub version: String,
    pub installer: PathBuf,
    pub kind: InstallerKind,
    /// The app to start once the installer is done; the install folder is its folder.
    pub relaunch: PathBuf,
}

impl HelperArgs {
    pub fn to_args(&self) -> Vec<OsString> {
        let kind = match self.kind {
            InstallerKind::Nsis => "nsis",
            InstallerKind::Msi => "msi",
        };
        vec![
            FLAG.into(),
            self.data_dir.clone().into(),
            self.version.clone().into(),
            self.installer.clone().into(),
            kind.into(),
            self.relaunch.clone().into(),
        ]
    }

    /// The arguments after the program name, as [`to_args`](Self::to_args) wrote them.
    pub fn parse(mut args: impl Iterator<Item = OsString>) -> Option<Self> {
        if args.next()? != FLAG {
            return None;
        }
        let data_dir = PathBuf::from(args.next()?);
        let version = args.next()?.into_string().ok()?;
        let installer = PathBuf::from(args.next()?);
        let kind = match args.next()?.to_str()? {
            "nsis" => InstallerKind::Nsis,
            "msi" => InstallerKind::Msi,
            _ => return None,
        };
        let relaunch = PathBuf::from(args.next()?);
        Some(Self {
            data_dir,
            version,
            installer,
            kind,
            relaunch,
        })
    }

    fn install_dir(&self) -> &Path {
        self.relaunch.parent().unwrap_or(Path::new("."))
    }

    fn folder(&self) -> &Path {
        self.installer.parent().unwrap_or(Path::new("."))
    }
}

/// How long the helper lets things take.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// The installer, from start to exit.
    pub install: Duration,
    /// What the installer started, once it has exited itself.
    pub leftovers: Duration,
    /// Each `--version` the install check runs.
    pub probe: Duration,
}

pub const LIMITS: Limits = Limits {
    install: Duration::from_secs(30 * 60),
    leftovers: Duration::from_secs(60),
    probe: Duration::from_secs(15),
};

/// Run as the helper when started with [`FLAG`]: the exit code, else None.
pub fn run_if_requested() -> Option<i32> {
    let args = HelperArgs::parse(std::env::args_os().skip(1))?;
    let stdin = std::io::stdin();
    Some(run(&args, stdin.lock(), std::io::stdout(), LIMITS))
}

/// Print the app's version when started with [`VERSION_FLAG`]; true if it was.
pub fn print_version_if_requested() -> bool {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|a| a == VERSION_FLAG)
    {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return true;
    }
    false
}

/// Hold the helper folder's lock for this process's life, so nothing cleans it up.
fn lock_folder(folder: &Path) -> std::io::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(folder.join(FOLDER_LOCK))?;
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => {
            std::io::Error::other("another update helper uses this folder")
        }
        std::fs::TryLockError::Error(e) => e,
    })?;
    Ok(file)
}

/// The helper's side of the handover; the exit code.
pub fn run(
    args: &HelperArgs,
    mut input: impl BufRead,
    mut output: impl Write,
    limits: Limits,
) -> i32 {
    let folder_lock = match lock_folder(args.folder()) {
        Ok(f) => f,
        Err(e) => {
            let _ = writeln!(output, "error {e}");
            return 2;
        }
    };
    let guard = match update_lock::begin_install(&args.data_dir, &args.version) {
        Ok(g) => g,
        Err(e) => {
            let _ = writeln!(output, "error {e:#}");
            return 2;
        }
    };
    if writeln!(output, "locked")
        .and_then(|_| output.flush())
        .is_err()
    {
        return 2;
    }
    drop(output);
    let mut line = String::new();
    if input.read_line(&mut line).is_err() || line.trim() != "go" {
        // Aborted, or the app died before the daemon was stopped: install nothing.
        guard.release();
        return 1;
    }
    // Until the app has exited (its end of the pipe closes with it): the
    // installer must not find it running.
    let mut rest = Vec::new();
    let _ = input.read_to_end(&mut rest);

    stop_sidecars(args.install_dir());
    let mut tree = match aura_contain::spawn(installer_command(args)) {
        Ok(t) => t,
        Err(e) => return finish(args, guard, folder_lock, Err(start_failure(&e)), limits),
    };
    let ran = supervise(&mut tree, args.kind, limits);
    if !ran.stopped {
        return hold_until_stopped(&mut tree, args, guard, folder_lock, ran.outcome, limits);
    }
    finish(args, guard, folder_lock, ran.outcome, limits)
}

/// After the installer's whole tree has stopped: check what is installed,
/// record it, release the lock, start Aura again.
fn finish(
    args: &HelperArgs,
    guard: update_lock::InstallGuard,
    folder_lock: std::fs::File,
    outcome: Result<(), String>,
    limits: Limits,
) -> i32 {
    let check = check_install(args.install_dir(), &args.relaunch, limits.probe);
    let mut result = InstallResult {
        version: args.version.clone(),
        ok: outcome.is_ok(),
        message: outcome.as_ref().err().cloned(),
        installed_version: check.version.clone(),
        complete: check.complete(),
    };
    if !result.complete {
        let problems = check.problems.join("; ");
        result.message = Some(match result.message.take() {
            Some(m) => format!("{m}; {problems}"),
            None => problems,
        });
    }
    let _ = update_lock::write_result(&args.data_dir, &result);
    guard.release();
    // Start Aura again, updated or not, whenever there is an app to start.
    if args.relaunch.exists() {
        if let Err(e) = relaunch(&args.relaunch) {
            let note = format!("Aura could not be started again: {e}");
            result.message = Some(match result.message.take() {
                Some(m) => format!("{m}; {note}"),
                None => note,
            });
            let _ = update_lock::write_result(&args.data_dir, &result);
        }
    }
    let _ = folder_lock.unlock();
    i32::from(outcome.is_err() || !result.complete)
}

/// Stop `aurad` and `aura` processes still running from the install folder:
/// the app stopped the daemon, but an `aura` command in a terminal, say,
/// would keep its file locked. Only processes whose image is one of those two
/// files, unlike the installer's own Restart Manager check (see
/// windows/installer-hooks.nsh), which closes any process holding them.
fn stop_sidecars(install_dir: &Path) {
    let images = sidecars(install_dir);
    for image in &images {
        for pid in aura_contain::processes_running(image) {
            aura_contain::terminate(pid);
        }
    }
    for _ in 0..100 {
        if images
            .iter()
            .all(|i| aura_contain::processes_running(i).is_empty())
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn sidecars(install_dir: &Path) -> [PathBuf; 2] {
    let exe = std::env::consts::EXE_SUFFIX;
    [
        install_dir.join(format!("aurad{exe}")),
        install_dir.join(format!("aura{exe}")),
    ]
}

/// The command that installs, without restarting Aura: the helper does that.
pub fn installer_command(args: &HelperArgs) -> Command {
    match args.kind {
        InstallerKind::Nsis => {
            // As the updater plugin runs it: passive (a progress bar only), update mode.
            let mut c = Command::new(&args.installer);
            c.args(["/P", "/UPDATE"]);
            c
        }
        InstallerKind::Msi => {
            let mut c = Command::new("msiexec");
            c.arg("/i")
                .arg(&args.installer)
                .args(["/passive", "/promptrestart"]);
            c
        }
    }
}

/// Exit codes that mean it installed: 0, and for msiexec "installed, restart
/// needed" (3010) and "installed, restart started" (1641).
pub fn installed(kind: InstallerKind, code: Option<i32>) -> bool {
    matches!(
        (kind, code),
        (_, Some(0)) | (InstallerKind::Msi, Some(3010 | 1641))
    )
}

/// What `aura_contain::Contained` does for the helper, so tests can stand in
/// a tree that will not stop.
pub(crate) trait Tree {
    fn wait_timeout(
        &mut self,
        limit: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>>;
    fn wait_tree(&mut self, limit: Duration) -> bool;
    fn kill_tree(&mut self, limit: Duration) -> bool;
}

impl Tree for aura_contain::Contained {
    fn wait_timeout(
        &mut self,
        limit: Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        aura_contain::Contained::wait_timeout(self, limit)
    }
    fn wait_tree(&mut self, limit: Duration) -> bool {
        aura_contain::Contained::wait_tree(self, limit)
    }
    fn kill_tree(&mut self, limit: Duration) -> bool {
        aura_contain::Contained::kill_tree(self, limit)
    }
}

/// How a run of the installer ended, and whether its whole tree is confirmed stopped.
pub(crate) struct Ran {
    outcome: Result<(), String>,
    stopped: bool,
}

const ERROR_ELEVATION_REQUIRED: i32 = 740;

fn start_failure(e: &std::io::Error) -> String {
    if e.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED) {
        // `update::decide` offers only per-user installs an update in place.
        "the installer needs administrator rights, which an update in place does not ask for; download it and run it yourself".into()
    } else {
        format!("the installer could not be started: {e}")
    }
}

/// Wait for the installer and what it started, within `limits`.
fn supervise(tree: &mut impl Tree, kind: InstallerKind, limits: Limits) -> Ran {
    let status = match tree.wait_timeout(limits.install) {
        Ok(Some(status)) => status,
        Ok(None) | Err(_) => {
            let stopped = tree.kill_tree(limits.leftovers);
            return Ran {
                outcome: Err(format!(
                    "the installer did not finish within {} and was stopped",
                    span(limits.install)
                )),
                stopped,
            };
        }
    };
    // What it started (an uninstaller of the previous version, say) finishes too.
    let stopped = tree.wait_tree(limits.leftovers) || tree.kill_tree(limits.leftovers);
    let outcome = if installed(kind, status.code()) {
        Ok(())
    } else {
        Err(describe_failure(status.code()))
    };
    Ran { outcome, stopped }
}

/// The installer's tree is not confirmed stopped: report that, and keep the
/// update lock and the job (so nothing starts, and nothing is checked or
/// started) while trying to stop it, as long as it takes. Once it has
/// stopped, release the lock and exit without starting Aura: what is
/// installed is unknown, and the next start says so.
fn hold_until_stopped(
    tree: &mut impl Tree,
    args: &HelperArgs,
    guard: update_lock::InstallGuard,
    folder_lock: std::fs::File,
    outcome: Result<(), String>,
    limits: Limits,
) -> i32 {
    let why = outcome
        .err()
        .unwrap_or_else(|| "the installer finished".into());
    let result = InstallResult {
        version: args.version.clone(),
        ok: false,
        message: Some(format!(
            "{why}, but not everything it started could be stopped (Windows may be waiting on its I/O), so Aura is as the installer left it; restart the computer if Aura does not open"
        )),
        installed_version: None,
        complete: false,
    };
    let _ = update_lock::write_result(&args.data_dir, &result);
    while !tree.kill_tree(limits.leftovers) {}
    guard.release();
    let _ = folder_lock.unlock();
    3
}

/// "30 minutes", "1 minute", "5 seconds".
fn span(d: Duration) -> String {
    let (n, unit) = if d.as_secs() >= 60 {
        (d.as_secs().div_ceil(60), "minute")
    } else {
        (d.as_secs().max(1), "second")
    };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

fn describe_failure(code: Option<i32>) -> String {
    match code {
        // NSIS: cancelled or aborted.
        Some(1) | Some(2) => "the installer was cancelled or stopped before it finished".into(),
        Some(c) => format!("the installer stopped with exit code {c}"),
        None => "the installer was stopped".into(),
    }
}

fn relaunch(app: &Path) -> std::io::Result<()> {
    let mut cmd = Command::new(app);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map(drop)
}

/// What is installed, whatever the installer reported: a failed NSIS run is
/// not a rollback, and may leave some files of each version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallCheck {
    /// The version every part reports, when they agree.
    pub version: Option<String>,
    /// What is missing or out of step, in words.
    pub problems: Vec<String>,
}

impl InstallCheck {
    pub fn complete(&self) -> bool {
        self.version.is_some() && self.problems.is_empty()
    }
}

/// The app, `aurad` and `aura` in `install_dir` must report one version, and
/// the app's resources (the bundled mods) must be there.
pub fn check_install(install_dir: &Path, app: &Path, limit: Duration) -> InstallCheck {
    let [aurad, aura] = sidecars(install_dir);
    let parts = [
        ("the app", app.to_path_buf(), VERSION_FLAG),
        ("aurad", aurad, "--version"),
        ("aura", aura, "--version"),
    ];
    let mut problems = Vec::new();
    let mut versions = Vec::new();
    for (name, path, flag) in parts {
        match probe_version(&path, flag, limit) {
            Some(v) => versions.push((name, v)),
            None if !path.exists() => problems.push(format!("{name} is missing")),
            None => problems.push(format!("{name} does not report a version")),
        }
    }
    if !install_dir.join("mods").is_dir() {
        problems.push("the bundled mods are missing".into());
    }
    let first = versions.first().map(|(_, v)| v.clone());
    if versions.iter().any(|(_, v)| Some(v) != first.as_ref()) {
        problems.push(format!(
            "its parts are of different versions ({})",
            versions
                .iter()
                .map(|(n, v)| format!("{n} {v}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let agreed = (versions.len() == 3 && !problems.iter().any(|p| p.contains("different")))
        .then_some(first)
        .flatten();
    InstallCheck {
        version: agreed,
        problems,
    }
}

/// What `program flag` prints as its version: the last word of its output.
fn probe_version(program: &Path, flag: &str, limit: Duration) -> Option<String> {
    if !program.exists() {
        return None;
    }
    let mut cmd = Command::new(program);
    cmd.arg(flag)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let deadline = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    out.split_whitespace().last().map(str::to_string)
}

/// The app's end of a started helper that holds the update lock.
pub struct Handover {
    child: Child,
    stdin: ChildStdin,
}

/// Start the helper and wait (at most `within`) until it holds the update lock.
pub fn start(mut cmd: Command, within: Duration) -> std::io::Result<Handover> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Anything else it prints first (none in a release build) is skipped.
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line == "locked" || line.starts_with("error ") {
                let _ = tx.send(line);
                return;
            }
        }
        let _ = tx.send("error the helper exited".into());
    });
    match rx.recv_timeout(within) {
        Ok(line) if line == "locked" => Ok(Handover { child, stdin }),
        Ok(line) => {
            let _ = child.wait();
            Err(std::io::Error::other(
                line.trim_start_matches("error ").to_string(),
            ))
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(std::io::Error::other("the update helper did not start"))
        }
    }
}

impl Handover {
    /// Let the helper install once this process has exited. Its end of the
    /// pipe stays open until then unless `close_now` (tests).
    pub fn go(mut self, close_now: bool) -> Child {
        let _ = writeln!(self.stdin, "go").and_then(|_| self.stdin.flush());
        if close_now {
            drop(self.stdin);
        } else {
            // Closed by the OS when the app exits: that is the helper's signal.
            std::mem::forget(self.stdin);
        }
        self.child
    }

    /// Call the install off; the helper releases the lock and exits.
    pub fn abort(mut self) {
        let _ = writeln!(self.stdin, "abort");
        drop(self.stdin);
        let _ = self.child.wait();
    }
}

/// Write the installer and a copy of the app's executable (the helper) into
/// a new folder under `temp`, marked as a helper's folder; the helper's
/// arguments and path.
pub fn prepare(
    temp: &Path,
    data_dir: &Path,
    version: &str,
    kind: InstallerKind,
    installer: &[u8],
    app_exe: &Path,
) -> std::io::Result<(HelperArgs, PathBuf)> {
    let dir = temp.join(format!("aura-update-{version}-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let owner =
        serde_json::json!({ "owner": OWNER, "version": version, "pid": std::process::id() });
    update_lock::write_atomic(&dir.join(FOLDER_OWNER), owner.to_string().as_bytes())?;
    std::fs::write(dir.join(FOLDER_LOCK), b"")?;
    let installer_path = dir.join(match kind {
        InstallerKind::Nsis => "Aura-setup.exe",
        InstallerKind::Msi => "Aura.msi",
    });
    std::fs::write(&installer_path, installer)?;
    let helper = dir.join(if cfg!(windows) {
        "aura-update-helper.exe"
    } else {
        "aura-update-helper"
    });
    std::fs::copy(app_exe, &helper)?;
    Ok((
        HelperArgs {
            data_dir: data_dir.to_path_buf(),
            version: version.to_string(),
            installer: installer_path,
            kind,
            relaunch: app_exe.to_path_buf(),
        },
        helper,
    ))
}

/// Whether `dir` is a helper's folder no helper uses any more: it is a real
/// folder (not a link), carries the helper's marker, and its lifetime lock is
/// free. A folder in use is never looked into.
fn inactive_helper_folder(dir: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return false;
    };
    if !meta.is_dir() {
        return false;
    }
    let ours = std::fs::read(dir.join(FOLDER_OWNER))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v.get("owner").and_then(|o| o.as_str()) == Some(OWNER));
    if !ours {
        return false;
    }
    let Ok(lock) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join(FOLDER_LOCK))
    else {
        return false;
    };
    match lock.try_lock() {
        Ok(()) => {
            let _ = lock.unlock();
            true
        }
        Err(_) => false,
    }
}

/// Remove what earlier updates left in `temp` (the helper cannot delete
/// itself): only folders positively identified as an inactive helper's.
pub fn clean_up(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("aura-update-")
            && inactive_helper_folder(&path)
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Run as the helper when the test binary is started by `helper_command`.
    #[test]
    fn helper_process() {
        let Ok(raw) = std::env::var("AURA_TEST_UPDATE_HELPER") else {
            return;
        };
        let args = HelperArgs::parse(raw.split('\u{1f}').map(OsString::from)).expect("helper args");
        let ms = |name: &str, default: Duration| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse().ok())
                .map(Duration::from_millis)
                .unwrap_or(default)
        };
        let limits = Limits {
            install: ms("AURA_TEST_INSTALL_LIMIT_MS", LIMITS.install),
            leftovers: Duration::from_secs(5),
            probe: Duration::from_secs(5),
        };
        // libtest has written "test … ... " without a newline: start a line of our own.
        println!();
        let stdin = std::io::stdin();
        let code = run(&args, stdin.lock(), std::io::stdout(), limits);
        std::process::exit(code);
    }

    fn helper_command(args: &HelperArgs) -> Command {
        let raw = args
            .to_args()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("\u{1f}");
        let mut c = Command::new(std::env::current_exe().unwrap());
        c.args([
            "update_helper::tests::helper_process",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("AURA_TEST_UPDATE_HELPER", raw);
        c
    }

    fn script(path: &Path, body: &str) {
        aura_core::test_support::write_script(path, &format!("#!/bin/sh\n{body}\n"));
    }

    /// Put the app (answering `--aura-version`, noting a start otherwise),
    /// `aurad` and `aura` of `version` into the install folder, with its mods.
    fn install(dir: &Path, version: &str) {
        script(
            &dir.join("app"),
            &format!(
                "if [ \"$1\" = {VERSION_FLAG} ]; then echo {version}; exit 0; fi\ntouch {}/app-started",
                dir.display()
            ),
        );
        script(&dir.join("aurad"), &format!("echo aurad {version}"));
        script(&dir.join("aura"), &format!("echo aura {version}"));
        std::fs::create_dir_all(dir.join("mods")).unwrap();
    }

    /// A data dir, a helper folder with an installer (`body`, which notes its
    /// arguments first; `$DIR` is the install folder) and Aura 1.0.0 installed.
    fn setup(name: &str, body: &str) -> (PathBuf, HelperArgs) {
        let dir = std::env::temp_dir().join(format!("aura-helper-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join("helper");
        std::fs::create_dir_all(&folder).unwrap();
        install(&dir, "1.0.0");
        script(
            &folder.join("installer"),
            &format!(
                "DIR={}\necho \"$@\" > $DIR/installer-ran\n{body}",
                dir.display()
            ),
        );
        let args = HelperArgs {
            data_dir: dir.join("data"),
            version: "9.9.9".into(),
            installer: folder.join("installer"),
            kind: InstallerKind::Nsis,
            relaunch: dir.join("app"),
        };
        (dir, args)
    }

    /// An installer that installs 9.9.9 and exits with `code`.
    fn installs(code: i32) -> String {
        format!(
            "for f in aurad aura; do printf '#!/bin/sh\\necho %s 9.9.9\\n' $f > $DIR/$f; done\n\
             printf '#!/bin/sh\\nif [ \"$1\" = {VERSION_FLAG} ]; then echo 9.9.9; exit 0; fi\\ntouch %s/app-started\\n' $DIR > $DIR/app\n\
             exit {code}"
        )
    }

    fn wait_for(path: &Path) -> bool {
        (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            path.exists()
        })
    }

    fn pid_in(path: &Path) -> u32 {
        assert!(wait_for(path), "{}", path.display());
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[test]
    fn args_round_trip() {
        let (_, args) = setup("args", "exit 0");
        let mut argv = args.to_args().into_iter();
        assert_eq!(HelperArgs::parse(&mut argv), Some(args));
        assert_eq!(
            HelperArgs::parse(vec![OsString::from("--other")].into_iter()),
            None
        );
    }

    #[test]
    fn hands_the_lock_over_and_installs_after_the_app_is_gone() {
        let (dir, args) = setup("ok", &installs(0));
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        // The helper, another process, holds the lock: aurad and aura refuse to run.
        let held = update_lock::install_in_progress(&args.data_dir).expect("locked by the helper");
        assert_eq!(held.version, "9.9.9");
        assert_ne!(held.pid, std::process::id());
        assert!(
            !dir.join("installer-ran").exists(),
            "nothing runs before go"
        );
        let mut child = handover.go(true);
        assert!(child.wait().unwrap().success());
        assert_eq!(
            std::fs::read_to_string(dir.join("installer-ran"))
                .unwrap()
                .trim(),
            "/P /UPDATE"
        );
        assert!(wait_for(&dir.join("app-started")), "Aura started again");
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(result.ok && result.complete, "{result:?}");
        assert_eq!(result.installed_version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn a_cancelled_install_says_which_version_is_there() {
        // Cancelled before it changed anything: Aura is whole, still 1.0.0.
        let (dir, args) = setup("cancelled", "exit 1");
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        let mut child = handover.go(true);
        assert_eq!(child.wait().unwrap().code(), Some(1));
        // Started again, so its ensure_daemon brings the daemon back.
        assert!(wait_for(&dir.join("app-started")));
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(!result.ok && result.complete, "{result:?}");
        assert_eq!(result.installed_version.as_deref(), Some("1.0.0"));
        assert!(result.message.unwrap().contains("cancelled"));
    }

    #[test]
    fn a_half_done_install_is_reported_as_incomplete() {
        // NSIS stopped half way: the new aurad, the old app, aura gone.
        let (dir, args) = setup(
            "half",
            "printf '#!/bin/sh\\necho aurad 9.9.9\\n' > $DIR/aurad\nrm $DIR/aura\nexit 2",
        );
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        handover.go(true).wait().unwrap();
        assert!(
            wait_for(&dir.join("app-started")),
            "still started, as far as it can be"
        );
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(!result.ok && !result.complete, "{result:?}");
        assert_eq!(result.installed_version, None);
        let message = result.message.unwrap();
        assert!(message.contains("aura is missing"), "{message}");
    }

    #[test]
    fn parts_of_different_versions_are_incomplete_even_when_the_installer_succeeded() {
        let (_dir, args) = setup(
            "mixed",
            "printf '#!/bin/sh\\necho aurad 9.9.9\\n' > $DIR/aurad\nexit 0",
        );
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        handover.go(true).wait().unwrap();
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(result.ok && !result.complete, "{result:?}");
        assert!(result.message.unwrap().contains("different versions"));
    }

    #[test]
    fn a_hanging_installer_is_stopped_with_everything_it_started() {
        let (dir, args) = setup("hang", "sleep 60 & echo $! > $DIR/grandchild\nwait");
        let mut cmd = helper_command(&args);
        cmd.env("AURA_TEST_INSTALL_LIMIT_MS", "700");
        let handover = start(cmd, Duration::from_secs(20)).unwrap();
        let mut helper = handover.go(true);
        let grandchild = pid_in(&dir.join("grandchild"));
        // The lock is held while the installer runs.
        assert!(update_lock::install_in_progress(&args.data_dir).is_some());
        assert!(!helper.wait().unwrap().success());
        // Released only once the whole tree has stopped.
        assert_eq!(
            aura_contain::identity(grandchild),
            None,
            "the installer's child was stopped"
        );
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(result
            .message
            .unwrap()
            .contains("did not finish within 1 second and was stopped"));
    }

    #[test]
    fn the_installer_stops_when_the_helper_dies() {
        let (dir, args) = setup("crash", "sleep 60 & echo $! > $DIR/grandchild\nwait");
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        let mut helper = handover.go(true);
        let grandchild = pid_in(&dir.join("grandchild"));
        assert!(aura_contain::identity(grandchild).is_some());
        // The helper crashes mid-install.
        helper.kill().unwrap();
        helper.wait().unwrap();
        let stopped = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            aura_contain::identity(grandchild).is_none()
        });
        assert!(stopped, "the installer did not outlive the helper");
        // Nothing left running: the next start may go ahead.
        let free = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            update_lock::install_in_progress(&args.data_dir).is_none()
        });
        assert!(free);
    }

    #[test]
    fn an_aborted_handover_installs_nothing() {
        let (dir, args) = setup("abort", "exit 0");
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        handover.abort();
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        assert!(!dir.join("installer-ran").exists());
        assert!(update_lock::take_result(&args.data_dir).is_none());
    }

    #[test]
    fn a_second_helper_cannot_take_a_held_lock() {
        let (_, args) = setup("busy", "exit 0");
        let guard = update_lock::begin_install(&args.data_dir, "1.0.0").unwrap();
        let err = start(helper_command(&args), Duration::from_secs(20))
            .err()
            .unwrap();
        assert!(err.to_string().contains("another Aura update"), "{err}");
        guard.release();
    }

    #[test]
    fn says_how_long_it_waited() {
        assert_eq!(span(LIMITS.install), "30 minutes");
        assert_eq!(span(Duration::from_secs(60)), "1 minute");
        assert_eq!(span(Duration::from_millis(700)), "1 second");
        assert_eq!(span(Duration::from_secs(5)), "5 seconds");
    }

    #[test]
    fn knows_what_installed() {
        assert!(installed(InstallerKind::Nsis, Some(0)));
        assert!(!installed(InstallerKind::Nsis, Some(3010)));
        assert!(installed(InstallerKind::Msi, Some(3010)));
        assert!(!installed(InstallerKind::Msi, Some(1602)));
        assert!(!installed(InstallerKind::Nsis, None));
        let (_, mut args) = setup("msi", "exit 0");
        args.kind = InstallerKind::Msi;
        let cmd = installer_command(&args);
        assert_eq!(cmd.get_program(), "msiexec");
        assert_eq!(cmd.get_args().last().unwrap(), "/promptrestart");
    }

    /// A tree that refuses to stop until `kill_tree` has been asked `stubborn` times.
    struct Stuck {
        stubborn: usize,
        kills: usize,
        /// Called on each kill attempt, to look at the world meanwhile.
        on_kill: Box<dyn FnMut()>,
    }

    impl Tree for Stuck {
        fn wait_timeout(
            &mut self,
            _limit: Duration,
        ) -> std::io::Result<Option<std::process::ExitStatus>> {
            Ok(None)
        }
        fn wait_tree(&mut self, _limit: Duration) -> bool {
            false
        }
        fn kill_tree(&mut self, _limit: Duration) -> bool {
            self.kills += 1;
            (self.on_kill)();
            self.kills > self.stubborn
        }
    }

    const QUICK: Limits = Limits {
        install: Duration::from_millis(10),
        leftovers: Duration::from_millis(10),
        probe: Duration::from_secs(5),
    };

    #[test]
    fn says_when_the_tree_is_not_confirmed_stopped() {
        let mut tree = Stuck {
            stubborn: 1,
            kills: 0,
            on_kill: Box::new(|| {}),
        };
        let ran = supervise(&mut tree, InstallerKind::Nsis, QUICK);
        assert!(!ran.stopped);
        assert!(ran.outcome.unwrap_err().contains("did not finish"));
    }

    #[test]
    fn an_unstopped_tree_keeps_the_lock_and_starts_nothing() {
        let (dir, args) = setup("stuck", "exit 0");
        let folder = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(args.folder().join("held"))
            .unwrap();
        let guard = update_lock::begin_install(&args.data_dir, "9.9.9").unwrap();
        let data_dir = args.data_dir.clone();
        let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let log = seen.clone();
        let mut tree = Stuck {
            stubborn: 3,
            kills: 0,
            on_kill: Box::new(move || {
                // While the tree is not stopped: still locked, and the failure recorded.
                let locked = update_lock::install_in_progress(&data_dir).is_some();
                let reported = std::fs::read(update_lock::result_path(&data_dir)).is_ok();
                log.borrow_mut().push((locked, reported));
            }),
        };
        let code = hold_until_stopped(
            &mut tree,
            &args,
            guard,
            folder,
            Err("the installer did not finish".into()),
            QUICK,
        );
        assert_eq!(code, 3);
        assert_eq!(tree.kills, 4);
        assert!(
            seen.borrow()
                .iter()
                .all(|&(locked, reported)| locked && reported),
            "{:?}",
            seen.borrow()
        );
        // Released once it stopped; Aura was not started, the files not checked.
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        assert!(!dir.join("app-started").exists());
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(!result.ok && !result.complete && result.installed_version.is_none());
        assert!(result.message.unwrap().contains("could be stopped"));
    }

    #[test]
    fn an_installer_that_wants_administrator_rights_is_refused_plainly() {
        let e = std::io::Error::from_raw_os_error(ERROR_ELEVATION_REQUIRED);
        assert!(start_failure(&e).contains("administrator rights"));
    }

    #[test]
    fn checks_what_is_installed() {
        let dir = std::env::temp_dir().join(format!("aura-helper-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        install(&dir, "2.0.0");
        let app = dir.join("app");
        let check = check_install(&dir, &app, Duration::from_secs(5));
        assert_eq!(check.version.as_deref(), Some("2.0.0"));
        assert!(check.complete(), "{check:?}");
        std::fs::remove_dir_all(dir.join("mods")).unwrap();
        let check = check_install(&dir, &app, Duration::from_secs(5));
        assert!(!check.complete());
        assert!(check.problems.iter().any(|p| p.contains("mods")));
    }

    #[test]
    fn prepares_a_marked_folder_and_cleans_up_only_inactive_ones() {
        let temp = std::env::temp_dir().join(format!("aura-helper-prep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let exe = std::env::current_exe().unwrap();
        let (args, helper) = prepare(
            &temp,
            Path::new("/data"),
            "9.9.9",
            InstallerKind::Nsis,
            b"MZ",
            &exe,
        )
        .unwrap();
        assert!(helper.exists() && args.installer.exists());
        assert_eq!(args.relaunch, exe);
        // Another helper's folder, in use: its lock is held.
        let (busy, _) = prepare(
            &temp.join("other"),
            Path::new("/data"),
            "9.9.8",
            InstallerKind::Nsis,
            b"MZ",
            &exe,
        )
        .unwrap();
        let busy_dir = temp.join("aura-update-busy");
        std::fs::rename(busy.installer.parent().unwrap(), &busy_dir).unwrap();
        let held = lock_folder(&busy_dir).unwrap();
        // Not a helper's: no marker.
        let stranger = temp.join("aura-update-someone-elses");
        std::fs::create_dir_all(&stranger).unwrap();
        std::fs::write(stranger.join("keep"), b"x").unwrap();
        // A link named like one.
        let target = temp.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, temp.join("aura-update-link")).unwrap();

        clean_up(&temp);
        assert!(
            !args.installer.parent().unwrap().exists(),
            "the inactive one went"
        );
        assert!(
            busy_dir.join("Aura-setup.exe").exists(),
            "the active one stayed whole"
        );
        assert!(stranger.join("keep").exists(), "an unmarked folder stayed");
        assert!(target.exists() && temp.join("aura-update-link").exists());
        drop(held);
    }
}
