//! The installer helper, for Windows. The updater plugin would start the
//! installer and exit, and then nobody waits for it: a cancelled or failed
//! install would leave the daemon stopped and Aura closed, and nothing holds
//! the update lock while the installer copies `aurad.exe` and `aura.exe`.
//!
//! Instead the app copies its own executable to a temporary folder (so the
//! helper locks nothing the installer replaces) and starts it with
//! [`FLAG`]. The handover, over the helper's stdin and stdout:
//!
//! 1. the helper takes the update lock ([`aura_rpc::update_lock`]) and says
//!    `locked`;
//! 2. the app stops the daemon, then says `go` (or `abort`, and the helper
//!    releases the lock and exits) and exits;
//! 3. its stdin closing tells the helper the app is gone; it runs the
//!    installer and waits for it, records how it went for the next app start,
//!    releases the lock, and starts Aura again, updated or not. The app's
//!    `ensure_daemon` then starts the daemon.
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
    /// The app to start once the installer is done.
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
}

/// Run as the helper when started with [`FLAG`]: the exit code, else None.
pub fn run_if_requested() -> Option<i32> {
    let args = HelperArgs::parse(std::env::args_os().skip(1))?;
    let stdin = std::io::stdin();
    Some(run(&args, stdin.lock(), std::io::stdout()))
}

/// The helper's side of the handover; the exit code.
pub fn run(args: &HelperArgs, mut input: impl BufRead, mut output: impl Write) -> i32 {
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

    let outcome = run_installer(args);
    let result = InstallResult {
        version: args.version.clone(),
        ok: outcome.is_ok(),
        message: outcome.as_ref().err().cloned(),
    };
    let _ = update_lock::write_result(&args.data_dir, &result);
    guard.release();
    if let Err(e) = relaunch(&args.relaunch) {
        let _ = update_lock::write_result(
            &args.data_dir,
            &InstallResult {
                message: Some(
                    format!(
                        "{} Aura could not be started again: {e}",
                        result.message.unwrap_or_default()
                    )
                    .trim()
                    .to_string(),
                ),
                ..result
            },
        );
    }
    i32::from(outcome.is_err())
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

const ERROR_ELEVATION_REQUIRED: i32 = 740;

fn run_installer(args: &HelperArgs) -> Result<(), String> {
    let status = match installer_command(args).status() {
        Ok(s) => s,
        // A per-machine installer asks for administrator rights, which a
        // plain CreateProcess cannot give: ask through the UAC prompt.
        Err(e) if e.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED) => {
            return run_elevated(args);
        }
        Err(e) => return Err(format!("the installer could not be started: {e}")),
    };
    if installed(args.kind, status.code()) {
        Ok(())
    } else {
        Err(describe_failure(status.code()))
    }
}

fn describe_failure(code: Option<i32>) -> String {
    match code {
        // NSIS: cancelled or aborted.
        Some(1) | Some(2) => "the installer was cancelled or stopped before it finished".into(),
        Some(c) => format!("the installer stopped with exit code {c}"),
        None => "the installer was stopped".into(),
    }
}

/// PowerShell's Start-Process -Verb RunAs shows the UAC prompt and waits.
fn run_elevated(args: &HelperArgs) -> Result<(), String> {
    let quote = |s: &std::ffi::OsStr| format!("'{}'", s.to_string_lossy().replace('\'', "''"));
    let cmd = installer_command(args);
    let program = quote(cmd.get_program());
    let list = cmd.get_args().map(quote).collect::<Vec<_>>().join(",");
    let script = format!(
        "$p = Start-Process -FilePath {program} -ArgumentList {list} -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| format!("the installer could not be started as administrator: {e}"))?;
    if installed(args.kind, status.code()) {
        Ok(())
    } else {
        Err(describe_failure(status.code()))
    }
}

fn relaunch(app: &Path) -> std::io::Result<()> {
    let mut cmd = Command::new(app);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map(drop)
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
/// a new folder under `temp`; the helper's arguments and path.
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

/// Remove what earlier updates left in `temp` (the helper cannot delete
/// itself). A folder still in use stays.
pub fn clean_up(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("aura-update-")
            && entry.path().is_dir()
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Run as the helper when the test binary is started by `helper_command`.
    #[test]
    fn helper_process() {
        let Ok(raw) = std::env::var("AURA_TEST_UPDATE_HELPER") else {
            return;
        };
        let args = HelperArgs::parse(raw.split('\u{1f}').map(OsString::from)).expect("helper args");
        // libtest has written "test … ... " without a newline: start a line of our own.
        println!();
        let stdin = std::io::stdin();
        let code = run(&args, stdin.lock(), std::io::stdout());
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
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A data dir, an installer exiting with `code` that notes its arguments,
    /// and an app that notes it was started.
    fn setup(name: &str, code: i32) -> (PathBuf, HelperArgs) {
        let dir = std::env::temp_dir().join(format!("aura-helper-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        script(
            &dir.join("installer"),
            &format!("echo \"$@\" > {}/installer-ran\nexit {code}", dir.display()),
        );
        script(
            &dir.join("app"),
            &format!("touch {}/app-started", dir.display()),
        );
        let args = HelperArgs {
            data_dir: dir.join("data"),
            version: "9.9.9".into(),
            installer: dir.join("installer"),
            kind: InstallerKind::Nsis,
            relaunch: dir.join("app"),
        };
        (dir, args)
    }

    fn wait_for(path: &Path) -> bool {
        (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            path.exists()
        })
    }

    #[test]
    fn args_round_trip() {
        let (_, args) = setup("args", 0);
        let mut argv = args.to_args().into_iter();
        assert_eq!(HelperArgs::parse(&mut argv), Some(args));
        assert_eq!(
            HelperArgs::parse(vec![OsString::from("--other")].into_iter()),
            None
        );
    }

    #[test]
    fn hands_the_lock_over_and_installs_after_the_app_is_gone() {
        let (dir, args) = setup("ok", 0);
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
        assert!(result.ok, "{result:?}");
    }

    #[test]
    fn a_failed_install_still_starts_aura_and_says_why() {
        let (dir, args) = setup("cancelled", 1);
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        let mut child = handover.go(true);
        assert_eq!(child.wait().unwrap().code(), Some(1));
        // Started again, so its ensure_daemon brings the daemon back.
        assert!(wait_for(&dir.join("app-started")));
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        let result = update_lock::take_result(&args.data_dir).unwrap();
        assert!(!result.ok);
        assert!(result.message.unwrap().contains("cancelled"));
    }

    #[test]
    fn an_aborted_handover_installs_nothing() {
        let (dir, args) = setup("abort", 0);
        let handover = start(helper_command(&args), Duration::from_secs(20)).unwrap();
        handover.abort();
        assert_eq!(update_lock::install_in_progress(&args.data_dir), None);
        assert!(!dir.join("installer-ran").exists());
        assert!(update_lock::take_result(&args.data_dir).is_none());
    }

    #[test]
    fn a_second_helper_cannot_take_a_held_lock() {
        let (_, args) = setup("busy", 0);
        let guard = update_lock::begin_install(&args.data_dir, "1.0.0").unwrap();
        let err = start(helper_command(&args), Duration::from_secs(20))
            .err()
            .unwrap();
        assert!(err.to_string().contains("another Aura update"), "{err}");
        guard.release();
    }

    #[test]
    fn knows_what_installed() {
        assert!(installed(InstallerKind::Nsis, Some(0)));
        assert!(!installed(InstallerKind::Nsis, Some(3010)));
        assert!(installed(InstallerKind::Msi, Some(3010)));
        assert!(!installed(InstallerKind::Msi, Some(1602)));
        assert!(!installed(InstallerKind::Nsis, None));
        let (_, mut args) = setup("msi", 0);
        args.kind = InstallerKind::Msi;
        let cmd = installer_command(&args);
        assert_eq!(cmd.get_program(), "msiexec");
        assert_eq!(cmd.get_args().last().unwrap(), "/promptrestart");
    }

    #[test]
    fn prepares_and_cleans_up_its_folder() {
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
        clean_up(&temp);
        assert!(!helper.parent().unwrap().exists());
    }
}
