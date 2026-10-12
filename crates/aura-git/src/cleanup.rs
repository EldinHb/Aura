//! Finding and deleting local branches that have served their purpose: their
//! pull request was merged and the remote branch deleted, or they are fully
//! merged into the default branch.

use crate::{git, git_allow};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use ts_rs::TS;

/// A fetch that waits on credentials or a dead network must not hang the dialog.
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CleanupReport {
    /// Main working tree of the repository.
    pub root: String,
    /// What `merged` is measured against, e.g. `origin/main`. None when no default branch was found.
    pub base: Option<String>,
    pub branches: Vec<StaleBranch>,
    /// Worktrees whose directory no longer exists.
    pub prunable_worktrees: Vec<String>,
    /// Why `git fetch --prune` failed; the report then reflects the last successful fetch.
    pub fetch_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StaleBranch {
    pub name: String,
    /// `gone` when its remote branch was deleted, as after merging a PR; `merged`
    /// when every commit is already in the base.
    pub reason: String,
    /// Commits not in the base. Squash and rebase merges rewrite commits, so a
    /// merged `gone` branch still counts its originals here.
    pub unmerged: u32,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CleanupResult {
    pub deleted: Vec<String>,
    /// Branches that were not deleted, with the reason.
    pub failed: Vec<(String, String)>,
    pub pruned_worktrees: u32,
}

/// Stale branches of the repository at `cwd`. With `fetch`, remote branches are
/// pruned first so that branches of just-merged pull requests show up as gone.
pub fn candidates(cwd: &str, fetch: bool) -> Result<CleanupReport> {
    let root = crate::ops::main_repo_root(cwd)?.context("Not a git repository")?;
    let fetch_error = if fetch { fetch_prune(&root).err().map(|e| format!("{e:#}")) } else { None };
    let base = default_base(&root);
    let protected = protected_branches(&root, base.as_deref())?;
    let merged: Vec<String> = match &base {
        Some(b) => lines(&git(&root, &["for-each-ref", "--merged", b, "--format=%(refname:short)", "refs/heads/"])?),
        None => vec![],
    };
    let mut branches = vec![];
    let refs = git(&root, &["for-each-ref", "--format=%(refname:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(subject)", "refs/heads/"])?;
    for line in refs.lines() {
        let mut f = line.split('\0');
        let (Some(name), Some(track), Some(date), Some(subject)) = (f.next(), f.next(), f.next(), f.next()) else { continue };
        if protected.iter().any(|p| p == name) {
            continue;
        }
        let reason = if track == "[gone]" {
            "gone"
        } else if merged.iter().any(|m| m == name) {
            "merged"
        } else {
            continue;
        };
        let unmerged = match &base {
            Some(b) => git(&root, &["rev-list", "--count", &format!("{b}..{name}"), "--"])?.trim().parse().unwrap_or(0),
            None => 0,
        };
        branches.push(StaleBranch { name: name.into(), reason: reason.into(), unmerged, subject: subject.into(), date: date.into() });
    }
    let prunable_worktrees = prunable(&git(&root, &["worktree", "list", "--porcelain"])?);
    Ok(CleanupReport { root, base, branches, prunable_worktrees, fetch_error })
}

/// Delete `branches` and prune missing worktrees. Each branch is checked again
/// against a fresh report, so nothing that stopped being stale, such as a branch
/// checked out in the meantime, is touched.
pub fn clean(cwd: &str, branches: &[String], prune_worktrees: bool) -> Result<CleanupResult> {
    let report = candidates(cwd, false)?;
    let mut result = CleanupResult::default();
    for name in branches {
        if !report.branches.iter().any(|b| &b.name == name) {
            result.failed.push((name.clone(), "No longer stale".into()));
            continue;
        }
        // Squash-merged branches are not merged as far as git can tell, so -d would refuse them.
        match git(&report.root, &["branch", "-D", name]) {
            Ok(_) => result.deleted.push(name.clone()),
            Err(e) => result.failed.push((name.clone(), format!("{e:#}"))),
        }
    }
    if prune_worktrees && !report.prunable_worktrees.is_empty() {
        git(&report.root, &["worktree", "prune"])?;
        result.pruned_worktrees = report.prunable_worktrees.len() as u32;
    }
    Ok(result)
}

/// The default branch to measure merges against: the remote's HEAD, else a
/// `main` or `master` that exists.
fn default_base(root: &str) -> Option<String> {
    if let Ok(head) = git(root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        return Some(head.trim().to_string());
    }
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find(|r| git(root, &["rev-parse", "--verify", "--quiet", r]).is_ok())
        .map(String::from)
}

/// Branches never offered for deletion: the default branch and every branch
/// checked out in a worktree, the current one included.
fn protected_branches(root: &str, base: Option<&str>) -> Result<Vec<String>> {
    let mut out: Vec<String> = crate::ops::worktrees(root)?.into_iter().filter_map(|w| w.branch).collect();
    if let Some(b) = base {
        out.push(b.split_once('/').map_or(b, |(_, name)| name).to_string());
        out.push(b.to_string());
    }
    Ok(out)
}

fn fetch_prune(root: &str) -> Result<()> {
    if git_allow(root, &["remote"], &[])?.trim().is_empty() {
        return Ok(());
    }
    let mut child = Command::new("git")
        .args(["-C", root, "fetch", "--all", "--prune", "--quiet"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to run git fetch")?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut err);
            }
            bail!("git fetch failed: {}", err.trim());
        }
        if started.elapsed() > FETCH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("git fetch timed out after {FETCH_TIMEOUT:?}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Paths of worktrees `git worktree list --porcelain` marks prunable.
fn prunable(porcelain: &str) -> Vec<String> {
    let mut out = vec![];
    let mut path = None;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p.to_string());
        } else if line.starts_with("prunable") {
            out.extend(path.take());
        }
    }
    out
}

fn lines(out: &str) -> Vec<String> {
    out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(cwd: &std::path::Path, args: &[&str]) {
        git(&cwd.to_string_lossy(), args).unwrap();
    }

    /// A clone of a bare remote with branches in every state the cleanup cares about.
    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        let local = dir.path().join("local");
        run(dir.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        run(dir.path(), &["clone", "-q", remote.to_str().unwrap(), local.to_str().unwrap()]);
        for (k, v) in [("user.email", "t@example.com"), ("user.name", "Test")] {
            run(&local, &["config", k, v]);
        }
        run(&local, &["commit", "-q", "--allow-empty", "-m", "init"]);
        run(&local, &["push", "-q", "-u", "origin", "main"]);
        run(&local, &["remote", "set-head", "origin", "main"]);
        // Pushed, then its remote branch deleted, as when a PR is merged.
        for (branch, msg) in [("squashed", "work"), ("unpushed", "keep me"), ("merged", "done")] {
            run(&local, &["checkout", "-q", "-b", branch, "main"]);
            run(&local, &["commit", "-q", "--allow-empty", "-m", msg]);
        }
        run(&local, &["push", "-q", "-u", "origin", "squashed"]);
        run(&local, &["push", "-q", "origin", "--delete", "squashed"]);
        run(&local, &["checkout", "-q", "main"]);
        run(&local, &["merge", "-q", "--ff-only", "merged"]);
        run(&local, &["push", "-q", "origin", "main"]);
        (dir, local)
    }

    #[test]
    fn lists_gone_and_merged_branches_but_not_live_work() {
        let (_dir, local) = setup();
        let report = candidates(local.to_str().unwrap(), true).unwrap();
        assert_eq!(report.fetch_error, None);
        assert_eq!(report.base.as_deref(), Some("origin/main"));
        let found: Vec<(&str, &str, u32)> = report.branches.iter().map(|b| (b.name.as_str(), b.reason.as_str(), b.unmerged)).collect();
        assert_eq!(found, [("merged", "merged", 0), ("squashed", "gone", 1)], "unpushed work and main are left alone");
    }

    #[test]
    fn deletes_only_branches_that_are_still_stale() {
        let (_dir, local) = setup();
        let cwd = local.to_str().unwrap();
        candidates(cwd, true).unwrap();
        run(&local, &["checkout", "-q", "merged"]);
        let result = clean(cwd, &["squashed".into(), "merged".into(), "unpushed".into()], true).unwrap();
        assert_eq!(result.deleted, ["squashed"]);
        let failed: Vec<&str> = result.failed.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(failed, ["merged", "unpushed"], "the checked-out branch and live work survive");
        assert!(crate::ops::branches(cwd).unwrap().contains(&"unpushed".to_string()));
    }

    #[test]
    fn prunes_worktrees_whose_directory_is_gone() {
        let (dir, local) = setup();
        let cwd = local.to_str().unwrap();
        let wt = dir.path().join("wt");
        run(&local, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
        std::fs::remove_dir_all(&wt).unwrap();
        assert_eq!(candidates(cwd, false).unwrap().prunable_worktrees.len(), 1);
        assert_eq!(clean(cwd, &[], true).unwrap().pruned_worktrees, 1);
        assert!(candidates(cwd, false).unwrap().prunable_worktrees.is_empty());
    }
}
