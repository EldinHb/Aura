//! Revision-pinned worktrees backed by a shared partial mirror. All paths are service-owned.
use anyhow::{bail, Context, Result};
use aura_core::PullRequest;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::process::Command;

fn mirror_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<parking_lot::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .entry(path.into())
        .or_default()
        .clone()
}
async fn output(mut command: Command) -> Result<String> {
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let (child, _group) = aura_core::process::spawn_job(&mut command)?;
    let out = child.wait_with_output().await?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(String::from_utf8(out.stdout)?.trim_end().into())
}
fn git_at(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotePath=false",
    ])
    .current_dir(path);
    cmd
}
pub async fn prepare(p: &PullRequest, cwd: &Path) -> Result<(String, String)> {
    let parts: Vec<_> = p.repo.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|x| {
            x.is_empty()
                || *x == "."
                || *x == ".."
                || !x
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        bail!("Invalid repository");
    }
    for sha in [&p.base_sha, &p.head_sha] {
        if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            bail!("Invalid commit SHA");
        }
    }
    let account = p
        .account
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let cache = cwd
        .parent()
        .and_then(Path::parent)
        .context("Missing service workspace root")?
        .join("mirrors")
        .join(account)
        .join(parts[0]);
    tokio::fs::create_dir_all(&cache).await?;
    let mirror = cache.join(format!("{}.git", parts[1]));
    let lock = mirror_lock(&mirror);
    let _guard = lock.lock().await;
    if !mirror.exists() {
        let stage = tempfile::tempdir_in(&cache)?;
        let staged = stage.path().join("mirror.git");
        let gh = aura_core::which::find_binary("gh", "AURA_GH_BIN", &[])
            .context("GitHub CLI unavailable")?;
        let mut cmd = Command::new(gh);
        cmd.args(["repo", "clone", &format!("https://github.com/{}", p.repo)])
            .arg(&staged)
            .args(["--", "--mirror", "--filter=blob:none"]);
        output(cmd).await?;
        tokio::fs::rename(staged, &mirror).await?;
    }
    let mut cmd = git_at(&mirror);
    cmd.args([
        "fetch",
        "origin",
        &format!("+refs/pull/{}/head:refs/aura/pr-{}", p.number, p.number),
        &p.base_sha,
        &p.head_sha,
    ]);
    output(cmd).await?;
    // TempDir removes checkout contents on cancellation/crash recovery. Prune the
    // corresponding registration before reuse, leaving live concurrent worktrees intact.
    let mut cmd = git_at(&mirror);
    cmd.args(["worktree", "prune", "--expire", "now"]);
    output(cmd).await?;
    let mut cmd = git_at(&mirror);
    cmd.args(["worktree", "add", "--detach"])
        .arg(cwd)
        .arg(&p.head_sha);
    output(cmd).await?;
    let mut cmd = git_at(cwd);
    cmd.args(["merge-base", &p.base_sha, &p.head_sha]);
    let base = output(cmd).await?;
    let mut cmd = git_at(cwd);
    cmd.args([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        &base,
        &p.head_sha,
        "--",
    ]);
    let diff = output(cmd).await?;
    Ok((diff, base))
}
