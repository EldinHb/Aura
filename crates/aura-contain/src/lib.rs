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
//! An elevated process (a per-machine installer started through the UAC
//! prompt) cannot join the job of an unelevated supervisor, and cannot be
//! killed by it: [`spawn_elevated`] gives a handle to wait on, and
//! [`identity`] lets another process tell that it still runs.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

pub mod quote;

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

/// A process started through the UAC prompt (Windows), outside any job.
pub struct Elevated {
    #[cfg(windows)]
    process: windows::Handle,
    pid: u32,
}

/// Start `program` with `args` as administrator, asking through the UAC
/// prompt. Unsupported elsewhere.
pub fn spawn_elevated(program: &Path, args: &[OsString]) -> io::Result<Elevated> {
    imp::spawn_elevated(program, args)
}

impl Elevated {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Wait at most `limit`: its exit code, or None if it still runs.
    pub fn wait_timeout(&self, limit: Duration) -> io::Result<Option<i32>> {
        imp::elevated_wait(self, limit)
    }

    /// Try to stop it; an unelevated process usually may not.
    pub fn terminate(&self) -> bool {
        imp::elevated_terminate(self)
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    pub fn spawn(mut cmd: Command) -> io::Result<Contained> {
        cmd.process_group(0);
        let child = cmd.spawn()?;
        let group = child.id().to_string();
        // The dead man's switch: `read` returns when this process's end of the
        // pipe closes, which it does when this process dies.
        let watcher = Command::new("/bin/sh")
            .args([
                "-c",
                "read -r _; kill -KILL -- \"-$1\" 2>/dev/null",
                "aura-contain",
                &group,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
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

    pub fn spawn_elevated(_program: &Path, _args: &[OsString]) -> io::Result<Elevated> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "elevation is a Windows prompt",
        ))
    }

    pub fn elevated_wait(_e: &Elevated, _limit: Duration) -> io::Result<Option<i32>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "elevation is a Windows prompt",
        ))
    }

    pub fn elevated_terminate(_e: &Elevated) -> bool {
        false
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
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
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
        ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const WAIT_OBJECT_0: u32 = 0;
    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
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

    pub fn spawn_elevated(program: &Path, args: &[OsString]) -> io::Result<Elevated> {
        let verb = wide(std::ffi::OsStr::new("runas"));
        let file = wide(program.as_os_str());
        let params = wide(&quote::join(args));
        // SAFETY: the struct is plain data; the strings outlive the call.
        unsafe {
            let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
            info.lpVerb = verb.as_ptr();
            info.lpFile = file.as_ptr();
            info.lpParameters = params.as_ptr();
            info.nShow = SW_SHOWNORMAL;
            if ShellExecuteExW(&mut info) == 0 {
                return Err(last_error());
            }
            if info.hProcess.is_null() {
                return Err(io::Error::other(
                    "the elevated installer gave no process to wait on",
                ));
            }
            let process = Handle(info.hProcess);
            let pid = windows_sys::Win32::System::Threading::GetProcessId(process.0);
            Ok(Elevated { process, pid })
        }
    }

    pub fn elevated_wait(e: &Elevated, limit: Duration) -> io::Result<Option<i32>> {
        let ms = limit.as_millis().min(u32::MAX as u128 - 1) as u32;
        // SAFETY: a process handle we own.
        let r = unsafe { WaitForSingleObject(e.process.0, ms) };
        if r != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0u32;
        // SAFETY: as above, with an out pointer to a u32.
        if unsafe { GetExitCodeProcess(e.process.0, &mut code) } == 0 {
            return Err(last_error());
        }
        Ok(Some(code as i32))
    }

    pub fn elevated_terminate(e: &Elevated) -> bool {
        // SAFETY: a process handle we own; failing is allowed (access denied).
        unsafe { TerminateProcess(e.process.0, 1) != 0 }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

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

    #[test]
    fn elevation_is_windows_only() {
        assert_eq!(
            spawn_elevated(Path::new("/bin/true"), &[])
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::Unsupported
        );
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
