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
