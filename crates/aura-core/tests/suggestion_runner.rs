//! The headless Claude Code run behind suggestion passes, against a fake
//! `claude` (`AURA_CLAUDE_BIN`). The environment is the process's own, so
//! the tests take turns.
#![cfg(unix)]

use aura_core::suggestions::{ClaudeCli, SuggestionModel, SuggestionSettings};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use std::time::Duration;

static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn fake_claude(dir: &Path, script: &str) {
    let bin = dir.join("claude");
    std::fs::write(&bin, format!("#!/usr/bin/python3\n{script}")).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("AURA_CLAUDE_BIN", &bin);
}

/// Wait, in real time and at most `limit`, until `check` holds.
async fn eventually(limit: Duration, check: impl Fn() -> bool) -> bool {
    let until = std::time::Instant::now() + limit;
    while std::time::Instant::now() < until {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    check()
}

/// Whether a process is gone: no longer there, or killed and not yet reaped.
fn gone(pid: &str) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    stat.trim().is_empty() || stat.trim().starts_with('Z')
}

#[tokio::test]
async fn a_claude_that_stops_reading_is_stopped_at_the_time_limit() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pid");
    // It says who it is (written whole, by a rename), then never reads.
    fake_claude(
        dir.path(),
        &format!(
            "import os, time\nopen({p:?} + '.tmp', 'w').write(str(os.getpid()))\nos.rename({p:?} + '.tmp', {p:?})\ntime.sleep(60)\n",
            p = pid_file.to_string_lossy()
        ),
    );
    // More than a pipe holds: writing it blocks while nobody reads.
    let prompt = "x".repeat(1_000_000);
    let task = tokio::spawn(async move {
        ClaudeCli
            .complete(
                &SuggestionSettings::default(),
                &prompt,
                &serde_json::json!({}),
            )
            .await
    });
    // Running, however long its start took under load.
    let started = eventually(Duration::from_secs(30), || pid_file.exists()).await;
    let pid = std::fs::read_to_string(&pid_file).unwrap_or_default();
    if !started {
        task.abort();
        let _ = task.await;
        std::env::remove_var("AURA_CLAUDE_BIN");
        panic!("the fake claude never started");
    }
    // Its three minutes pass.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(181)).await;
    tokio::time::resume();
    let result = tokio::time::timeout(Duration::from_secs(30), task).await;
    std::env::remove_var("AURA_CLAUDE_BIN");
    let err = result
        .expect("still writing the prompt after the time limit")
        .unwrap()
        .unwrap_err()
        .to_string();
    assert!(err.contains("three minutes"), "{err}");
    // And the child is gone.
    assert!(
        eventually(Duration::from_secs(10), || gone(pid.trim())).await,
        "the child {pid} still runs"
    );
}

#[tokio::test]
async fn a_claude_that_writes_without_end_is_cut_off() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let dir = tempfile::tempdir().unwrap();
    fake_claude(
        dir.path(),
        "import sys\nsys.stdin.read()\nfor _ in range(200):\n    sys.stdout.write('x' * 65536)\nsys.stdout.flush()\n",
    );
    let err = ClaudeCli
        .complete(
            &SuggestionSettings::default(),
            "data",
            &serde_json::json!({}),
        )
        .await
        .unwrap_err()
        .to_string();
    std::env::remove_var("AURA_CLAUDE_BIN");
    assert!(err.contains("more output than"), "{err}");
}

#[tokio::test]
async fn claude_runs_isolated_with_only_what_it_needs() {
    let _turn = ONE_AT_A_TIME.lock().await;
    let dir = tempfile::tempdir().unwrap();
    fake_claude(
        dir.path(),
        r#"import sys, os, json
sys.stdin.read()
print(json.dumps({'structured_output': {'args': sys.argv[1:], 'cwd': os.getcwd(), 'env': dict(os.environ)}}))
"#,
    );
    std::env::set_var("GITHUB_TOKEN", "review-only-sentinel");
    std::env::set_var("CLAUDE_CODE_REVIEW_SENTINEL", "review-only-sentinel");
    std::env::set_var("ANTHROPIC_API_KEY", "auth-sentinel");
    let model = "haiku; touch injected".to_string();
    let raw = ClaudeCli
        .complete(
            &SuggestionSettings {
                enabled: true,
                model: model.clone(),
            },
            "data",
            &serde_json::json!({}),
        )
        .await;
    for k in [
        "AURA_CLAUDE_BIN",
        "GITHUB_TOKEN",
        "CLAUDE_CODE_REVIEW_SENTINEL",
        "ANTHROPIC_API_KEY",
    ] {
        std::env::remove_var(k);
    }
    let v: serde_json::Value = serde_json::from_str(&raw.unwrap()).unwrap();
    let args: Vec<&str> = v["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    for flag in [
        "--safe-mode",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ] {
        assert!(args.contains(&flag), "{flag} missing from {args:?}");
    }
    let after = |flag: &str| args.iter().position(|a| *a == flag).map(|i| args[i + 1]);
    assert_eq!(after("--tools"), Some(""));
    assert_eq!(after("--setting-sources"), Some(""));
    assert_eq!(
        after("--model"),
        Some(model.as_str()),
        "the model stays one argument"
    );
    let env = v["env"].as_object().unwrap();
    assert!(!env.contains_key("GITHUB_TOKEN"), "GITHUB_TOKEN reached it");
    assert!(
        !env.contains_key("CLAUDE_CODE_REVIEW_SENTINEL"),
        "a CLAUDE_ setting reached it"
    );
    assert_eq!(
        env.get("ANTHROPIC_API_KEY").and_then(|v| v.as_str()),
        Some("auth-sentinel")
    );
    assert!(env.contains_key("PATH") && env.contains_key("HOME"));
    // A scratch directory of its own, gone afterwards.
    let cwd = v["cwd"].as_str().unwrap();
    let shared = std::fs::canonicalize(std::env::temp_dir()).unwrap();
    assert_ne!(
        std::fs::canonicalize(cwd).ok().as_deref(),
        Some(shared.as_path())
    );
    assert!(
        !Path::new(cwd).exists(),
        "the scratch directory is left behind"
    );
}
