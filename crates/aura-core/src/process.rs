//! Process groups for bounded background jobs. Dropping a job also stops its descendants.
use anyhow::Result;
use tokio::process::{Child, Command};

pub struct ProcessGroup {
    id: u32,
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: spawn_job creates a new group whose ID is this child's PID. A
        // negative PID addresses only that job's group, never Aura's own group.
        unsafe {
            libc::kill(-(self.id as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.id.to_string(), "/T", "/F"])
                .spawn();
        }
    }
}
pub fn spawn_job(command: &mut Command) -> Result<(Child, ProcessGroup)> {
    #[cfg(unix)]
    command.process_group(0);
    command.kill_on_drop(true);
    let child = command.spawn()?;
    let group = ProcessGroup {
        id: child.id().expect("new child has a process ID"),
    };
    Ok((child, group))
}

/// Ask process `pid` to stop (SIGTERM), or make it (SIGKILL when `force`).
/// False where that is not possible (Windows) or the process is gone.
pub fn terminate(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: a plain kill(2) on a positive pid.
        pid > 1 && unsafe { libc::kill(pid as libc::pid_t, sig) } == 0
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, force);
        false
    }
}

/// The executable name of process `pid`, if it runs.
pub fn process_name(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "comm=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !name.is_empty()).then_some(name)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// When process `pid` started, to the second, if it runs. From its elapsed
/// time, which `ps` gives the same way in every locale.
pub fn process_started(pid: u32) -> Option<chrono::DateTime<chrono::Utc>> {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "etime=", "-p", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let elapsed = parse_elapsed(String::from_utf8_lossy(&out.stdout).trim())?;
        Some(chrono::Utc::now() - chrono::Duration::seconds(elapsed as i64))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// Seconds in `ps`'s elapsed time: `[[dd-]hh:]mm:ss`.
pub fn parse_elapsed(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<u64> = rest
        .split(':')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<_>>()?;
    let (h, m, sec) = match parts[..] {
        [m, s] => (0, m, s),
        [h, m, s] => (h, m, s),
        _ => return None,
    };
    Some(((days * 24 + h) * 60 + m) * 60 + sec)
}

/// How many files Aura asks to keep open at most. Every live session holds
/// about three pipes to its agent, and apps started from the macOS GUI get a
/// soft limit of 256, which some 75 sessions use up; then spawning `gh` or
/// `git` fails with "too many open files".
pub const OPEN_FILES_WANTED: u64 = 65_536;

/// Raise the soft limit on open files towards the hard limit, at most to
/// [`OPEN_FILES_WANTED`] (and on macOS to `kern.maxfilesperproc`, as
/// RLIM_INFINITY is refused there). Children inherit the new limit. Returns
/// the old and new soft limits, which are the same when nothing changed;
/// None where there is no such limit (Windows) or it cannot be read.
// rlim_t is u64 on macOS and Linux, but not on every Unix.
#[allow(clippy::useless_conversion)]
pub fn raise_open_file_limit() -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: getrlimit writes into the struct we own.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
            tracing::warn!(
                "read the open-file limit: {}",
                std::io::Error::last_os_error()
            );
            return None;
        }
        let old = u64::from(lim.rlim_cur);
        let want = open_files_target(u64::from(lim.rlim_max), max_files_per_process());
        if want <= old {
            tracing::info!("open-file limit {old}, kept");
            return Some((old, old));
        }
        lim.rlim_cur = want.try_into().unwrap_or(lim.rlim_max);
        // SAFETY: setrlimit reads the struct we own; the soft limit stays at or below the hard one.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
            tracing::warn!(
                "raise the open-file limit from {old} to {want}: {}",
                std::io::Error::last_os_error()
            );
            return Some((old, old));
        }
        tracing::info!("open-file limit raised from {old} to {want}");
        Some((old, want))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// The soft limit to ask for: what Aura wants, within the hard limit and the
/// system's limit per process.
pub fn open_files_target(hard: u64, per_process: Option<u64>) -> u64 {
    OPEN_FILES_WANTED
        .min(hard)
        .min(per_process.unwrap_or(u64::MAX))
}

#[cfg(target_os = "macos")]
fn max_files_per_process() -> Option<u64> {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is NUL-terminated and the output buffer is an int of the size given.
    let ok = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            (&mut value as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    (ok && value > 0).then_some(value as u64)
}

#[cfg(not(target_os = "macos"))]
fn max_files_per_process() -> Option<u64> {
    None
}

/// The current soft limit on open files, where there is one.
// rlim_t is u64 on macOS and Linux, but not on every Unix.
#[allow(clippy::useless_conversion)]
pub fn open_file_limit() -> Option<u64> {
    #[cfg(unix)]
    {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: getrlimit writes into the struct we own.
        (unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } == 0)
            .then_some(u64::from(lim.rlim_cur))
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Whether `e`, or an error it was caused by, is the process (EMFILE) or the
/// system (ENFILE) running out of open files.
pub fn is_out_of_files(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::raw_os_error)
            .is_some_and(out_of_files_code)
    }) || e.chain().any(|c| {
        // Some libraries keep only the text (reqwest's connect errors among them).
        let s = c.to_string();
        s.contains("Too many open files") || s.contains("os error 24")
    })
}

fn out_of_files_code(code: i32) -> bool {
    #[cfg(unix)]
    {
        code == libc::EMFILE || code == libc::ENFILE
    }
    #[cfg(not(unix))]
    {
        let _ = code;
        false
    }
}

/// `e` with what it means when it is [`is_out_of_files`]: `what` (e.g. "start
/// the GitHub CLI") failed because Aura has as many files open as it may.
pub fn explain_out_of_files(e: anyhow::Error, what: &str) -> anyhow::Error {
    if !is_out_of_files(&e) {
        return e;
    }
    let limit = open_file_limit()
        .map(|l| format!(" of {l}"))
        .unwrap_or_default();
    anyhow::anyhow!(
        "Could not {what}: Aura reached its open-file limit{limit} (too many open files). Each running session keeps a few files open; stop sessions you no longer need, or restart Aura, which raises the limit when it starts. ({e:#})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_times_are_read_in_every_form_ps_gives() {
        assert_eq!(parse_elapsed("00:07"), Some(7));
        assert_eq!(parse_elapsed("12:34"), Some(12 * 60 + 34));
        assert_eq!(parse_elapsed("01:02:03"), Some(3723));
        assert_eq!(parse_elapsed("2-01:02:03"), Some(2 * 86_400 + 3723));
        assert_eq!(parse_elapsed(""), None);
        assert_eq!(parse_elapsed("7"), None);
        assert_eq!(parse_elapsed("a:b"), None);
    }

    #[cfg(unix)]
    #[test]
    fn this_process_started_before_now() {
        let started = process_started(std::process::id()).unwrap();
        assert!(started <= chrono::Utc::now());
        assert!(process_started(u32::MAX / 2).is_none(), "no such process");
    }

    #[test]
    fn the_target_stays_within_the_hard_and_the_per_process_limit() {
        assert_eq!(open_files_target(u64::MAX, None), OPEN_FILES_WANTED);
        assert_eq!(open_files_target(u64::MAX, Some(24_576)), 24_576);
        assert_eq!(open_files_target(4_096, Some(24_576)), 4_096);
    }

    #[cfg(unix)]
    #[test]
    fn the_soft_limit_is_raised_and_never_lowered() {
        let (old, new) = raise_open_file_limit().unwrap();
        assert!(new >= old);
        assert_eq!(open_file_limit(), Some(new));
        // Again: nothing left to raise.
        assert_eq!(raise_open_file_limit(), Some((new, new)));
    }

    #[cfg(unix)]
    #[test]
    fn running_out_of_files_is_told_apart_and_explained() {
        let emfile = anyhow::Error::new(std::io::Error::from_raw_os_error(libc::EMFILE))
            .context("Start GitHub CLI");
        assert!(is_out_of_files(&emfile));
        let text = explain_out_of_files(emfile, "start the GitHub CLI").to_string();
        assert!(text.contains("open-file limit"), "{text}");
        assert!(text.starts_with("Could not start the GitHub CLI"), "{text}");
        let other = anyhow::anyhow!("gh: not logged in");
        assert!(!is_out_of_files(&other));
        assert_eq!(
            explain_out_of_files(other, "x").to_string(),
            "gh: not logged in"
        );
        assert!(is_out_of_files(&anyhow::anyhow!(
            "error trying to connect: Too many open files (os error 24)"
        )));
    }
}
