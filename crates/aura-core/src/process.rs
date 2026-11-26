//! Process groups for bounded background jobs. Dropping a job also stops its descendants.
use anyhow::Result;
use tokio::process::{Child, Command};

/// Windows `CREATE_NO_WINDOW`: run a console program without a console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep a child from opening a console window. `aurad` and the desktop app have
/// no console of their own, so on Windows every console program they start
/// (`git`, `gh`, `claude`, `--version` probes) would otherwise flash a terminal
/// window and steal focus. No-op elsewhere.
pub fn hide_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// [`hide_window`] for a tokio command.
pub fn hide_window_tokio(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

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
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &self.id.to_string(), "/T", "/F"]);
            let _ = hide_window(&mut cmd).spawn();
        }
    }
}
pub fn spawn_job(command: &mut Command) -> Result<(Child, ProcessGroup)> {
    #[cfg(unix)]
    command.process_group(0);
    command.kill_on_drop(true);
    hide_window_tokio(command);
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

/// What tells process `pid` apart from every other process that had or will
/// have its pid: the start the system recorded for it when it was created,
/// which no later change of the clock moves. macOS: `darwin:<sec>.<usec>`
/// from `proc_pidinfo`; Linux: `linux:<boot id>:<start in clock ticks since
/// boot>` from `/proc`. None when it does not run, cannot be read, or the
/// system has no such record here.
pub fn process_birth(pid: u32) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let pid = libc::c_int::try_from(pid).ok()?;
        // SAFETY: proc_bsdinfo is plain data, so all zeroes is a valid value.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is a proc_bsdinfo we own, of the size given.
        let n = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (n == size).then(|| {
            format!(
                "darwin:{}.{:06}",
                info.pbi_start_tvsec, info.pbi_start_tvusec
            )
        })
    }
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let ticks = linux_start_ticks(&stat)?;
        let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        Some(format!("linux:{}:{ticks}", boot.trim()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}

/// Whether process `pid` holds an flock(2) lock on the file at `path`
/// through one of its own descriptors, as aurad holds `daemon.lock` for as
/// long as it runs. Only the holder answers true: a process that merely has
/// the file open, or waits for the lock, does not. False when it cannot be
/// told (another system, a process of another user).
///
/// macOS: the process's descriptors (`proc_pidinfo`/`proc_pidfdinfo`) for the
/// file's device and inode, with `FHASLOCK` set on the open file (which
/// macOS keeps until the descriptor closes, also after an explicit unlock;
/// aurad holds its lock until it exits). Linux: an `FLOCK` line of
/// `/proc/locks` with the pid, device and inode.
pub fn holds_lock(pid: u32, path: &std::path::Path) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        #[cfg(target_os = "macos")]
        {
            darwin::holds_lock(pid, meta.dev(), meta.ino())
        }
        #[cfg(target_os = "linux")]
        {
            std::fs::read_to_string("/proc/locks")
                .is_ok_and(|locks| flock_holders(&locks, meta.dev(), meta.ino()).contains(&pid))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (pid, path);
        false
    }
}

/// The pids `/proc/locks` (Linux) says hold an flock lock on the file with
/// device `dev` and inode `ino`. Lines with `->` wait for a lock, and do not
/// count; devices are written `major:minor` in hex.
pub fn flock_holders(locks: &str, dev: u64, ino: u64) -> Vec<u32> {
    // glibc's gnu_dev_major/minor.
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
    let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
    locks
        .lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace().skip(1);
            let kind = f.next()?;
            if kind != "FLOCK" {
                return None;
            }
            let (_advisory, _access) = (f.next()?, f.next()?);
            let pid: u32 = f.next()?.parse().ok()?;
            let mut file = f.next()?.split(':');
            let maj = u64::from_str_radix(file.next()?, 16).ok()?;
            let min = u64::from_str_radix(file.next()?, 16).ok()?;
            let inode: u64 = file.next()?.parse().ok()?;
            (maj == major && min == minor && inode == ino).then_some(pid)
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod darwin {
    /// `struct proc_fileinfo` of <sys/proc_info.h>.
    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: libc::off_t,
        fi_type: i32,
        fi_guardflags: u32,
    }

    /// `struct vnode_fdinfowithpath` of <sys/proc_info.h>.
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    /// `PROC_PIDFDVNODEPATHINFO` of <sys/proc_info.h>.
    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;
    /// `FHASLOCK` of <sys/fcntl.h>: the open file holds an flock lock.
    const FHASLOCK: u32 = 0x4000;

    pub(super) fn holds_lock(pid: u32, dev: u64, ino: u64) -> bool {
        let Ok(pid) = libc::c_int::try_from(pid) else {
            return false;
        };
        // SAFETY: a null buffer asks for the size the list needs.
        let need =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if need <= 0 {
            return false;
        }
        let each = std::mem::size_of::<libc::proc_fdinfo>();
        // Room for a few opened meanwhile.
        let mut fds: Vec<libc::proc_fdinfo> = (0..need as usize / each + 16)
            .map(|_| libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0,
            })
            .collect();
        // SAFETY: the buffer is `fds`, of the size given.
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                (fds.len() * each) as libc::c_int,
            )
        };
        if got <= 0 {
            return false;
        }
        fds.truncate(got as usize / each);
        fds.iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
            .any(|fd| {
                // SAFETY: plain data, for which all zeroes is a valid value.
                let mut info: VnodeFdInfoWithPath = unsafe { std::mem::zeroed() };
                let size = std::mem::size_of::<VnodeFdInfoWithPath>() as libc::c_int;
                // SAFETY: the buffer is `info`, of the size given.
                let n = unsafe {
                    libc::proc_pidfdinfo(
                        pid,
                        fd.proc_fd,
                        PROC_PIDFDVNODEPATHINFO,
                        (&mut info as *mut VnodeFdInfoWithPath).cast(),
                        size,
                    )
                };
                let st = &info.pvip.vip_vi.vi_stat;
                n == size
                    && u64::from(st.vst_dev) == dev
                    && st.vst_ino == ino
                    && info.pfi.fi_openflags & FHASLOCK != 0
            })
    }
}

/// Field 22 of a Linux `/proc/<pid>/stat` line: when the process started, in
/// clock ticks since boot. The name in field 2 may hold spaces and
/// parentheses, so fields are counted from its last `)`.
pub fn linux_start_ticks(stat: &str) -> Option<u64> {
    let rest = &stat[stat.rfind(')')? + 1..];
    // `rest` starts at field 3.
    rest.split_whitespace().nth(22 - 3)?.parse().ok()
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
    fn flock_holders_are_read_from_proc_locks_and_waiters_left_out() {
        // dev 0x0801 (8:1), as stat gives it on Linux.
        let locks = "1: FLOCK  ADVISORY  WRITE 4242 08:01:5678 0 EOF\n\
                     1: -> FLOCK  ADVISORY  WRITE 4343 08:01:5678 0 EOF\n\
                     2: POSIX  ADVISORY  WRITE 4444 08:01:5678 0 EOF\n\
                     3: FLOCK  ADVISORY  WRITE 4545 08:01:9999 0 EOF\n\
                     4: FLOCK  ADVISORY  WRITE 4646 08:02:5678 0 EOF\n";
        assert_eq!(flock_holders(locks, 0x0801, 5678), [4242]);
        // A large device number: major and minor split across the bits.
        let dev = (0x103u64 << 8) | 0x2a | (0x1u64 << 20);
        let line = "1: FLOCK  ADVISORY  WRITE 7 103:12a:42 0 EOF";
        assert_eq!(flock_holders(line, dev, 42), [7]);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_holder_of_a_lock_is_told_from_a_process_that_only_has_the_file_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.lock");
        let held = std::fs::File::create(&path).unwrap();
        let me = std::process::id();
        assert!(!holds_lock(me, &path), "open, not locked");
        held.try_lock().unwrap();
        assert!(holds_lock(me, &path));
        assert!(!holds_lock(me, &dir.path().join("other")), "another file");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        assert!(!holds_lock(child.id(), &path), "another process");
        child.kill().unwrap();
        child.wait().unwrap();
        // Released the way aurad releases it: the descriptor closes.
        drop(held);
        assert!(!holds_lock(me, &path), "released");
    }

    #[test]
    fn the_start_is_read_from_a_linux_stat_line_whatever_the_name() {
        let stat =
            "4242 (a (b) c) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 10000 200";
        assert_eq!(linux_start_ticks(stat), Some(987_654));
        assert_eq!(linux_start_ticks("4242 (x) S 1"), None);
        assert_eq!(linux_start_ticks("no parenthesis"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_process_birth_is_its_own_and_stays_the_same() {
        let me = process_birth(std::process::id()).expect("this process");
        assert_eq!(
            process_birth(std::process::id()).as_deref(),
            Some(me.as_str())
        );
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let other = process_birth(child.id()).expect("the child");
        assert_ne!(other, me);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(process_birth(child.id()), None, "gone");
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
