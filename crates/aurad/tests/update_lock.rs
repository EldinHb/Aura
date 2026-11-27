//! aurad does not start while an app update is being installed.

#[test]
fn refuses_to_start_during_an_update() {
    let dir = std::env::temp_dir().join(format!("aurad-update-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let guard = aura_rpc::update_lock::begin_install(&dir, "9.9.9").unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_aurad"))
        .args([
            "--foreground",
            "--ephemeral",
            "--no-mods",
            "--providers",
            "terminal",
            "--data-dir",
        ])
        .arg(&dir)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(String::from_utf8_lossy(&out.stderr).contains("installing version 9.9.9"));
    assert!(
        aura_rpc::read_daemon_info(&dir).is_none(),
        "no daemon started"
    );
    guard.release();
    let _ = std::fs::remove_dir_all(&dir);
}
