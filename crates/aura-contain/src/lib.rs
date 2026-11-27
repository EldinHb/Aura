//! Run a process tree that cannot outlive the process supervising it: what
//! the Windows update helper runs the installer in.
//!
//! - **Windows:** the process starts suspended, joins a Job Object with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then runs. Every process it starts
//!   joins the job too. The supervisor holds the only handle to the job, so
//!   when it exits, however it exits, Windows kills the whole tree.
//! - **Unix:** the process leads a new process group, and a small watcher
//!   (`sh`) waits on a pipe only the supervisor holds; when the supervisor
//!   dies the pipe closes and the watcher kills the group. (Production only
//!   runs the helper on Windows; this gives the same behaviour for tests.)
//!
//! Killing a process tree can block: a process with I/O pending in a driver
//! ends only once that I/O does. So [`Contained::kill_tree`] says whether the
//! tree did stop within its bound, and a caller that must not go on while it
//! runs (the update helper) keeps waiting and keeps its guards meanwhile.
//!
//! An elevated process (one that needs the UAC prompt) is not supported: it
//! could not join the job of an unelevated supervisor, nor be stopped by it.

use std::io;
use std::path::Path;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

/// How often waits poll.
const POLL: Duration = Duration::from_millis(50);

/// A process tree bound to this process (see the crate docs).
pub struct Contained {
    child: Child,
    #[cfg(windows)]
    job: windows::Job,
    #[cfg(unix)]
    watcher: Option<Child>,
}

/// Start `cmd` contained.
pub fn spawn(cmd: Command) -> io::Result<Contained> {
    imp::spawn(cmd)
}

impl Contained {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    /// Wait for the main process, at most `limit`: its status, or None if it still runs.
    pub fn wait_timeout(&mut self, limit: Duration) -> io::Result<Option<ExitStatus>> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(POLL.min(limit));
        }
    }

    /// Wait until no process of the tree is left, at most `limit`. True when none is.
    pub fn wait_tree(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            let _ = self.child.try_wait();
            if !imp::tree_alive(self) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL);
        }
    }

    /// Kill every process of the tree, and return once they are all gone
    /// (or after `limit`, false then).
    pub fn kill_tree(&mut self, limit: Duration) -> bool {
        imp::kill_tree(self);
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.wait_tree(limit)
    }
}

impl Drop for Contained {
    fn drop(&mut self) {
        // Windows: closing the job (its field drops) kills what is left.
        #[cfg(unix)]
        {
            // The watcher kills the group when its pipe closes: let a finished
            // tree's group go without it (the pid could be reused).
            if let Some(mut w) = self.watcher.take() {
                let _ = w.kill();
                let _ = w.wait();
            }
            if imp::tree_alive(self) {
                imp::kill_tree(self);
            }
        }
    }
}

/// What tells process `pid` apart from every other process that had or will
/// have its pid, while it runs: None once it has exited.
pub fn identity(pid: u32) -> Option<String> {
    imp::identity(pid)
}

/// The ids of the processes running the executable at `image`.
pub fn processes_running(image: &Path) -> Vec<u32> {
    imp::processes_running(image)
}

/// Stop process `pid` at once. False when that was not possible (it is gone,
/// or another user's, or elevated).
pub fn terminate(pid: u32) -> bool {
    imp::terminate(pid)
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    /// The dead man's switch, run by `sh` with the group's id as `$1`: `read`
    /// returns when the supervisor's end of the pipe closes, which it does
    /// when the supervisor dies. `kill -KILL -<pgid>` is the one spelling
    /// every `sh` takes: dash (Debian's and Ubuntu's /bin/sh) refuses
    /// `kill -KILL -- -<pgid>` ("Illegal number"), and then nothing was killed.
    pub(crate) const WATCHER: &str = "read -r _; kill -KILL \"-$1\"";

    /// The watcher for `group`, run by `shell`.
    pub(crate) fn watcher(shell: &str, group: u32) -> Command {
        let mut w = Command::new(shell);
        w.args(["-c", WATCHER, "aura-contain", &group.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        w
    }

    pub fn spawn(mut cmd: Command) -> io::Result<Contained> {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let watcher = watcher("/bin/sh", child.id()).spawn();
        let watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                let mut c = Contained {
                    child,
                    watcher: None,
                };
                c.kill_tree(Duration::from_secs(5));
                return Err(e);
            }
        };
        Ok(Contained {
            child,
            watcher: Some(watcher),
        })
    }

    fn group(c: &Contained) -> libc::pid_t {
        -(c.child.id() as libc::pid_t)
    }

    pub fn tree_alive(c: &Contained) -> bool {
        // SAFETY: signal 0 only asks whether the group has a member.
        unsafe { libc::kill(group(c), 0) == 0 }
    }

    pub fn kill_tree(c: &Contained) {
        // SAFETY: the group is the contained process's own (it leads it).
        unsafe {
            libc::kill(group(c), libc::SIGKILL);
        }
    }

    pub fn identity(pid: u32) -> Option<String> {
        let out = Command::new("ps")
            .args(["-o", "stat=,lstart=", "-p", &pid.to_string()])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let (stat, started) = text.split_once(char::is_whitespace)?;
        // A zombie has exited.
        (out.status.success() && !stat.starts_with('Z')).then(|| format!("unix:{}", started.trim()))
    }

    pub fn processes_running(image: &Path) -> Vec<u32> {
        let Ok(out) = Command::new("ps").args(["-axo", "pid=,comm="]).output() else {
            return Vec::new();
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let (pid, comm) = l.trim().split_once(char::is_whitespace)?;
                (Path::new(comm.trim()) == image).then(|| pid.parse().ok())?
            })
            .collect()
    }

    pub fn terminate(pid: u32) -> bool {
        // SAFETY: a plain kill(2) on a positive pid.
        pid > 1 && unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) } == 0
    }
}

#[cfg(windows)]
mod windows {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    /// An owned handle, closed on drop.
    pub struct Handle(pub HANDLE);
    // SAFETY: a process or job handle may be used from any thread.
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: we own the handle and close it once.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// The job; closing its only handle kills what it holds.
    pub struct Job(pub Handle);
}

#[cfg(windows)]
mod imp {
    use super::windows::{Handle, Job};
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{FILETIME, HANDLE, STILL_ACTIVE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenThread, QueryFullProcessImageNameW,
        ResumeThread, TerminateProcess, CREATE_SUSPENDED, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
    };

    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }

    pub fn spawn(mut cmd: Command) -> io::Result<Contained> {
        // SAFETY: plain Win32 calls on handles we own; the struct is plain data.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(last_error());
            }
            let job = Job(Handle(job));
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0 .0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(last_error());
            }
            // Suspended until it is in the job, so nothing it starts escapes.
            cmd.creation_flags(CREATE_SUSPENDED);
            let mut child = cmd.spawn()?;
            if AssignProcessToJobObject(job.0 .0, child.as_raw_handle() as HANDLE) == 0 {
                let e = last_error();
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
            if let Err(e) = resume(child.id()) {
                TerminateJobObject(job.0 .0, 1);
                let _ = child.wait();
                return Err(e);
            }
            Ok(Contained { child, job })
        }
    }

    /// Resume the threads of a process started suspended (std keeps the
    /// thread handle to itself).
    fn resume(pid: u32) -> io::Result<()> {
        // SAFETY: a snapshot we close; THREADENTRY32 is plain data with its size set.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(last_error());
            }
            let snap = Handle(snap);
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut resumed = 0;
            let mut ok = Thread32First(snap.0, &mut entry) != 0;
            while ok {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        let thread = Handle(thread);
                        if ResumeThread(thread.0) != u32::MAX {
                            resumed += 1;
                        }
                    }
                }
                ok = Thread32Next(snap.0, &mut entry) != 0;
            }
            if resumed == 0 {
                return Err(io::Error::other("could not resume the installer"));
            }
            Ok(())
        }
    }

    pub fn tree_alive(c: &Contained) -> bool {
        // SAFETY: the struct is plain data of the size given.
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                c.job.0 .0,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            ok == 0 || info.ActiveProcesses > 0
        }
    }

    pub fn kill_tree(c: &Contained) {
        // SAFETY: the job handle is ours.
        unsafe {
            TerminateJobObject(c.job.0 .0, 1);
        }
    }

    fn open(pid: u32, access: u32) -> Option<Handle> {
        // SAFETY: OpenProcess returns null on failure, which we check.
        let h = unsafe { OpenProcess(access, 0, pid) };
        (!h.is_null()).then(|| Handle(h))
    }

    fn running(h: &Handle) -> bool {
        let mut code = 0u32;
        // SAFETY: a valid process handle and an out pointer to a u32.
        unsafe { GetExitCodeProcess(h.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }

    pub fn identity(pid: u32) -> Option<String> {
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        if !running(&h) {
            return None;
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: four out pointers to FILETIMEs we own.
        let ok = unsafe { GetProcessTimes(h.0, &mut created, &mut exited, &mut kernel, &mut user) };
        (ok != 0).then(|| {
            format!(
                "win:{}",
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
            )
        })
    }

    fn image_of(pid: u32) -> Option<std::path::PathBuf> {
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        // SAFETY: the buffer and its length in u16s.
        let ok = unsafe {
            QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| OsString::from_wide(&buf[..len as usize]).into())
    }

    pub fn processes_running(image: &Path) -> Vec<u32> {
        let want = image.to_string_lossy().to_lowercase();
        let mut pids = Vec::new();
        // SAFETY: a snapshot we close; PROCESSENTRY32W is plain data with its size set.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return pids;
            }
            let snap = Handle(snap);
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap.0, &mut entry) != 0;
            while ok {
                let pid = entry.th32ProcessID;
                if image_of(pid).is_some_and(|p| p.to_string_lossy().to_lowercase() == want) {
                    pids.push(pid);
                }
                ok = Process32NextW(snap.0, &mut entry) != 0;
            }
        }
        pids
    }

    pub fn terminate(pid: u32) -> bool {
        let Some(h) = open(pid, PROCESS_TERMINATE) else {
            return false;
        };
        // SAFETY: a handle opened with PROCESS_TERMINATE.
        unsafe { TerminateProcess(h.0, 1) != 0 }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    fn alive(pid: u32) -> bool {
        identity(pid).is_some()
    }

    fn pid_from(path: &Path) -> u32 {
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(path) {
                if let Ok(p) = s.trim().parse() {
                    return p;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("no pid in {}", path.display());
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aura-contain-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn waits_for_the_main_process_and_the_tree() {
        let mut c = spawn(sh("exit 3")).unwrap();
        let status = c.wait_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(status.code(), Some(3));
        assert!(c.wait_tree(Duration::from_secs(5)));
    }

    #[test]
    fn kills_the_whole_tree_on_timeout() {
        let d = temp("tree");
        let child_pid = d.join("grandchild");
        let mut c = spawn(sh(&format!(
            "sleep 60 & echo $! > {}; wait",
            child_pid.display()
        )))
        .unwrap();
        let grandchild = pid_from(&child_pid);
        assert!(c
            .wait_timeout(Duration::from_millis(200))
            .unwrap()
            .is_none());
        assert!(c.kill_tree(Duration::from_secs(5)), "every process gone");
        assert!(!alive(grandchild));
    }

    /// The supervisor (a re-run of this test binary) holds a contained tree.
    #[test]
    fn supervisor_process() {
        let Ok(out) = std::env::var("AURA_CONTAIN_SUPERVISOR") else {
            return;
        };
        let _c = spawn(sh(&format!("sleep 60 & echo $! > {out}; wait"))).unwrap();
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn the_tree_dies_with_its_supervisor() {
        let d = temp("deadman");
        let out = d.join("grandchild");
        let mut supervisor = Command::new(std::env::current_exe().unwrap())
            .args(["tests::supervisor_process", "--exact", "--nocapture"])
            .env("AURA_CONTAIN_SUPERVISOR", &out)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let grandchild = pid_from(&out);
        assert!(alive(grandchild));
        // The supervisor crashes.
        supervisor.kill().unwrap();
        supervisor.wait().unwrap();
        let gone = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            !alive(grandchild)
        });
        assert!(gone, "the installer's tree stopped with its supervisor");
    }

    /// The watcher works in every `sh` it may meet as /bin/sh: dash
    /// (Debian, Ubuntu), bash (macOS), busybox, and the others when installed.
    #[test]
    fn the_watcher_kills_the_group_in_every_shell() {
        let mut shells: Vec<String> = [
            "/bin/sh",
            "/bin/dash",
            "/bin/bash",
            "/bin/zsh",
            "/bin/ksh",
            "/bin/mksh",
        ]
        .into_iter()
        .filter(|s| Path::new(s).exists())
        .map(String::from)
        .collect();
        if Path::new("/bin/busybox").exists() {
            shells.push("/bin/busybox sh".into());
        }
        assert!(!shells.is_empty());
        for shell in shells {
            let mut group = Command::new("sleep");
            group.arg("60").process_group(0);
            let mut leader = group.spawn().unwrap();
            let (program, extra) = match shell.split_once(' ') {
                Some((p, a)) => (p.to_string(), Some(a.to_string())),
                None => (shell.clone(), None),
            };
            let mut w = imp::watcher(&program, leader.id());
            if let Some(a) = extra {
                // `busybox sh -c …`: the applet goes before the script.
                let args: Vec<_> = w.get_args().map(|a| a.to_owned()).collect();
                w = Command::new(&program);
                w.arg(a)
                    .args(args)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
            }
            let mut w = w.spawn().unwrap();
            // The supervisor's end of the pipe closes.
            drop(w.stdin.take());
            let status = w.wait().unwrap();
            let gone = (0..100).any(|_| {
                if leader.try_wait().unwrap().is_some() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
                false
            });
            if !gone {
                let _ = leader.kill();
                let _ = leader.wait();
            }
            assert!(gone, "{shell} did not kill the group (watcher {status})");
        }
    }

    #[test]
    fn a_finished_tree_is_left_alone_on_drop() {
        let mut c = spawn(sh("exit 0")).unwrap();
        c.wait_timeout(Duration::from_secs(5)).unwrap();
        drop(c);
    }

    #[test]
    fn tells_a_running_process_from_a_gone_one() {
        let me = identity(std::process::id()).expect("this process runs");
        assert_eq!(identity(std::process::id()), Some(me));
        let mut c = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = c.id();
        c.wait().unwrap();
        assert_eq!(identity(pid), None);
    }
}

/// Run on Windows only (CI's windows-latest job); not run on the other hosts.
#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    fn cmd(script: &str) -> Command {
        let mut c = Command::new("cmd");
        c.args(["/C", script]);
        c
    }

    #[test]
    fn runs_in_a_job_and_reports_the_exit_code() {
        let mut c = spawn(cmd("exit 3")).unwrap();
        let status = c.wait_timeout(Duration::from_secs(30)).unwrap().unwrap();
        assert_eq!(status.code(), Some(3));
        assert!(c.wait_tree(Duration::from_secs(30)));
    }

    #[test]
    fn kills_the_whole_job() {
        // cmd starts ping, which outlives cmd unless the job takes it.
        let mut c = spawn(cmd("ping -n 60 127.0.0.1 > nul")).unwrap();
        assert!(c
            .wait_timeout(Duration::from_millis(500))
            .unwrap()
            .is_none());
        let pid = c.id();
        assert!(c.kill_tree(Duration::from_secs(30)));
        assert_eq!(identity(pid), None);
    }

    #[test]
    fn closing_the_job_ends_it() {
        let c = spawn(cmd("ping -n 60 127.0.0.1 > nul")).unwrap();
        let pid = c.id();
        drop(c);
        let gone = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            identity(pid).is_none()
        });
        assert!(gone);
    }

    #[test]
    fn knows_this_process() {
        let me = std::process::id();
        assert!(identity(me).is_some());
        let exe = std::env::current_exe().unwrap();
        assert!(processes_running(&exe).contains(&me));
    }
}
