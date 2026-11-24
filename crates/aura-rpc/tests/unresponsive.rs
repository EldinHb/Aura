//! An aurad that holds its data directory but cannot answer (out of open
//! files, say) is stopped, and nothing else is.
#![cfg(unix)]

use aura_rpc::{lock_data_dir, stop_unresponsive_daemon, DaemonInfo, UnresponsiveStop};

fn info(pid: u32) -> DaemonInfo {
    DaemonInfo {
        port: 1,
        token: "t".into(),
        pid,
        version: "0".into(),
        started_at: chrono::Utc::now(),
        data_dir: String::new(),
        birth: aura_core::process::process_birth(pid),
    }
}

/// A process with the given name that sleeps, and the data directory's lock,
/// released when it exits, as aurad's is.
async fn holder(dir: &std::path::Path, name: &str) -> u32 {
    let bin = dir.join(name);
    std::fs::copy("/bin/sleep", &bin).unwrap();
    let mut child = tokio::process::Command::new(&bin)
        .arg("60")
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let lock = lock_data_dir(dir).unwrap().expect("lock");
    tokio::spawn(async move {
        let _ = child.wait().await;
        drop(lock);
    });
    pid
}

#[tokio::test]
async fn an_aurad_that_does_not_answer_is_stopped() {
    // In a process of its own: the other test here starts a process, whose
    // child holds a copy of the lock's descriptor until it execs.
    if !aura_core::test_support::in_own_process(concat!(
        module_path!(),
        "::an_aurad_that_does_not_answer_is_stopped"
    )) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pid = holder(dir.path(), "aurad").await;
    assert_eq!(
        stop_unresponsive_daemon(dir.path(), &info(pid)).await,
        UnresponsiveStop::Freed
    );
    assert!(
        lock_data_dir(dir.path()).unwrap().is_some(),
        "the directory is free"
    );
    assert!(
        aura_core::process::process_name(pid).is_none(),
        "it is gone"
    );
}

#[tokio::test]
async fn another_process_is_never_signalled() {
    let dir = tempfile::tempdir().unwrap();
    let pid = holder(dir.path(), "something-else").await;
    assert_eq!(
        stop_unresponsive_daemon(dir.path(), &info(pid)).await,
        UnresponsiveStop::Unidentified
    );
    assert!(
        aura_core::process::process_name(pid).is_some(),
        "left running"
    );
    aura_core::process::terminate(pid, true);
}

#[tokio::test]
async fn a_free_directory_needs_nothing_stopped() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        stop_unresponsive_daemon(dir.path(), &info(u32::MAX)).await,
        UnresponsiveStop::Freed
    );
}
