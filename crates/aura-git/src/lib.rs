//! Git integration by shelling out to the `git` binary: worktree lifecycle
//! (implements `aura_core::WorktreeBackend`) and read/write operations used by
//! the diff viewer and quick-commit commands.

use anyhow::{anyhow, bail, Context, Result};
use aura_core::{WorktreeBackend, WorktreeInfo, WorktreeOpts};
use std::path::{Path, PathBuf};
use std::process::Command;

pub mod ops;

const WORKTREES_DIR: &str = ".aura-worktrees";

/// Run `git -C <cwd> <args>`; Ok(stdout) on success, Err with stderr otherwise.
pub(crate) fn git(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;
    if !out.status.success() {
        bail!(
            "git {} failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Like [`git`] but tolerates a non-zero exit code listed in `ok_codes`.
pub(crate) fn git_allow(cwd: &str, args: &[&str], ok_codes: &[i32]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;
    let code = out.status.code().unwrap_or(-1);
    if !out.status.success() && !ok_codes.contains(&code) {
        bail!(
            "git {} failed ({}): {}",
            args.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn canonical(p: &Path) -> String {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().to_string()
}

fn branch_exists(root: &str, branch: &str) -> bool {
    git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

/// Make sure `.aura-worktrees/` is ignored via `<common git dir>/info/exclude`.
fn ensure_excluded(root: &str) -> Result<()> {
    let common = git(root, &["rev-parse", "--git-common-dir"])?.trim().to_string();
    let common_dir = {
        let p = PathBuf::from(&common);
        if p.is_absolute() {
            p
        } else {
            PathBuf::from(root).join(p)
        }
    };
    let info = common_dir.join("info");
    std::fs::create_dir_all(&info).with_context(|| format!("create {}", info.display()))?;
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let line = format!("{WORKTREES_DIR}/");
    if existing.lines().any(|l| l.trim() == line || l.trim() == WORKTREES_DIR) {
        return Ok(());
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&line);
    content.push('\n');
    std::fs::write(&exclude, content).with_context(|| format!("write {}", exclude.display()))?;
    Ok(())
}

pub struct Git;

impl WorktreeBackend for Git {
    fn create(&self, cwd: &str, opts: &WorktreeOpts) -> Result<WorktreeInfo> {
        let root = ops::repo_root(cwd)?.ok_or_else(|| anyhow!("{cwd} is not inside a git repository"))?;
        let path = match &opts.path {
            Some(p) => PathBuf::from(p),
            None => PathBuf::from(&root).join(WORKTREES_DIR).join(opts.branch.replace('/', "-")),
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let path_str = path.to_string_lossy().to_string();
        if branch_exists(&root, &opts.branch) {
            git(&root, &["worktree", "add", &path_str, &opts.branch])?;
        } else {
            let base = opts.base.as_deref().unwrap_or("HEAD");
            git(&root, &["worktree", "add", "-b", &opts.branch, &path_str, base])?;
        }
        ensure_excluded(&root)?;
        Ok(WorktreeInfo { repo_root: root, path: canonical(&path), branch: opts.branch.clone() })
    }

    fn remove(&self, info: &WorktreeInfo) -> Result<()> {
        match git(&info.repo_root, &["worktree", "remove", "--force", &info.path]) {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("is not a working tree") || msg.contains("No such file") {
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        git(&cwd, &["init", "-q", "-b", "main"]).unwrap();
        git(&cwd, &["config", "user.email", "t@example.com"]).unwrap();
        git(&cwd, &["config", "user.name", "Test"]).unwrap();
        git(&cwd, &["commit", "-q", "--allow-empty", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn create_new_branch_worktree_then_remove() {
        let dir = repo();
        let cwd = dir.path().to_string_lossy().to_string();
        let info = Git
            .create(&cwd, &WorktreeOpts { branch: "feat/x".into(), base: None, path: None })
            .unwrap();
        assert!(info.path.ends_with(".aura-worktrees/feat-x"), "{}", info.path);
        assert!(Path::new(&info.path).join(".git").exists());
        assert_eq!(ops::current_branch(&info.path).unwrap(), "feat/x");
        assert!(ops::worktrees(&cwd).unwrap().iter().any(|w| w.branch.as_deref() == Some("feat/x")));
        Git.remove(&info).unwrap();
        assert!(!Path::new(&info.path).exists());
        // removing again is a no-op
        Git.remove(&info).unwrap();
    }

    #[test]
    fn create_worktree_on_existing_branch() {
        let dir = repo();
        let cwd = dir.path().to_string_lossy().to_string();
        git(&cwd, &["branch", "existing"]).unwrap();
        let info = Git
            .create(&cwd, &WorktreeOpts { branch: "existing".into(), base: None, path: None })
            .unwrap();
        assert_eq!(ops::current_branch(&info.path).unwrap(), "existing");
        let branches = ops::branches(&cwd).unwrap();
        assert_eq!(branches.iter().filter(|b| *b == "existing").count(), 1);
    }

    #[test]
    fn exclude_updated_once() {
        let dir = repo();
        let cwd = dir.path().to_string_lossy().to_string();
        Git.create(&cwd, &WorktreeOpts { branch: "a".into(), base: None, path: None }).unwrap();
        Git.create(&cwd, &WorktreeOpts { branch: "b".into(), base: None, path: None }).unwrap();
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches(".aura-worktrees/").count(), 1, "{exclude}");
        // not a repo
        let other = tempfile::tempdir().unwrap();
        assert!(Git
            .create(&other.path().to_string_lossy(), &WorktreeOpts { branch: "z".into(), base: None, path: None })
            .is_err());
    }

    #[test]
    fn status_diff_commit_log() {
        let dir = repo();
        let cwd = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        git(&cwd, &["add", "a.txt"]).unwrap();
        git(&cwd, &["commit", "-q", "-m", "add a"]).unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();

        let st = ops::status(&cwd).unwrap();
        let a = st.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.staged, a.unstaged), (' ', 'M'));
        let n = st.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!((n.staged, n.unstaged), ('?', '?'));

        let d = ops::diff(&cwd, &ops::DiffOpts::default()).unwrap();
        assert!(d.contains("+two"), "{d}");
        assert!(d.contains("+fresh"), "{d}");
        assert!(d.contains("new.txt"), "{d}");

        let only = ops::diff(&cwd, &ops::DiffOpts { path: Some("a.txt".into()), ..Default::default() }).unwrap();
        assert!(only.contains("+two") && !only.contains("fresh"), "{only}");

        let stat = ops::diff_stat(&cwd, None).unwrap();
        let s = stat.iter().find(|s| s.path == "a.txt").unwrap();
        assert_eq!((s.added, s.deleted), (1, 0));

        let sha = ops::commit(&cwd, "second", true).unwrap();
        assert_eq!(sha.len(), 40);
        let log = ops::log(&cwd, 5).unwrap();
        assert_eq!(log[0].sha, sha);
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[0].author, "Test");
        assert!(ops::status(&cwd).unwrap().is_empty());

        let base_diff = ops::diff(&cwd, &ops::DiffOpts { base: Some("HEAD~1".into()), ..Default::default() }).unwrap();
        assert!(base_diff.contains("+fresh"));
        let staged = ops::diff(&cwd, &ops::DiffOpts { staged: true, ..Default::default() }).unwrap();
        assert!(staged.is_empty());
    }

    #[test]
    fn branches_and_root() {
        let dir = repo();
        let cwd = dir.path().to_string_lossy().to_string();
        git(&cwd, &["branch", "other"]).unwrap();
        let mut b = ops::branches(&cwd).unwrap();
        b.sort();
        assert_eq!(b, vec!["main".to_string(), "other".to_string()]);
        assert_eq!(ops::repo_root(&cwd).unwrap().unwrap(), canonical(dir.path()));
        let none = tempfile::tempdir().unwrap();
        assert_eq!(ops::repo_root(&none.path().to_string_lossy()).unwrap(), None);
        // diff with no HEAD (fresh repo) falls back
        let fresh = tempfile::tempdir().unwrap();
        let fcwd = fresh.path().to_string_lossy().to_string();
        git(&fcwd, &["init", "-q"]).unwrap();
        std::fs::write(fresh.path().join("x.txt"), "x\n").unwrap();
        let d = ops::diff(&fcwd, &ops::DiffOpts::default()).unwrap();
        assert!(d.contains("+x"), "{d}");
    }
}

pub mod review;
