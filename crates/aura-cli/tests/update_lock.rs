//! `aura` does not run (nor start the daemon) while an app update is being installed.

#[test]
fn refuses_to_run_during_an_update() {
    let dir = std::env::temp_dir().join(format!("aura-cli-update-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let guard = aura_rpc::update_lock::begin_install(&dir, "9.9.9").unwrap();
    for args in [&["ls"][..], &["daemon", "start"][..]] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_aura"))
            .arg("--data-dir")
            .arg(&dir)
            .args(args)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?}: {out:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("installing version 9.9.9"),
            "{out:?}"
        );
    }
    assert!(
        aura_rpc::read_daemon_info(&dir).is_none(),
        "no daemon started"
    );
    guard.release();
    let _ = std::fs::remove_dir_all(&dir);
}
