//! Read/write git operations for the diff viewer and palette commands.

use crate::{canonical, git, git_allow};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileStatus {
    pub path: String,
    /// Index status letter from `git status --porcelain` (' ' when clean, '?' untracked).
    pub staged: char,
    /// Working tree status letter (' ' when clean, '?' untracked).
    pub unstaged: char,
    pub renamed_from: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DiffOpts {
    /// Restrict to one path.
    pub path: Option<String>,
    /// Diff the index instead of the working tree.
    pub staged: bool,
    /// Diff working tree against this ref (e.g. `main`) instead of HEAD.
    pub base: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DiffStat {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LogEntry {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BranchStatus {
    /// Checked-out branch; None on a detached HEAD.
    pub branch: Option<String>,
    /// Commit HEAD points at; None before the first commit.
    pub head: Option<String>,
    /// Tracked branch as git shows it, e.g. `origin/feature`.
    pub upstream: Option<String>,
    /// Name of the tracked branch on its remote, e.g. `feature`.
    pub upstream_branch: Option<String>,
    /// `owner/repo` of the GitHub remote the tracked branch lives on.
    pub upstream_repo: Option<String>,
    /// Commits not yet pushed to the tracked branch.
    pub ahead: u32,
    /// Commits on the tracked branch not yet pulled.
    pub behind: u32,
    /// Files with uncommitted changes, untracked ones included.
    pub changed: u32,
}

/// Canonical root of the main working tree, also when `cwd` is inside a linked
/// worktree. None when `cwd` is not inside a repository.
pub fn main_repo_root(cwd: &str) -> Result<Option<String>> {
    let Some(root) = repo_root(cwd)? else {
        return Ok(None);
    };
    let common = std::path::PathBuf::from(git(&root, &["rev-parse", "--git-common-dir"])?.trim());
    let common = if common.is_absolute() {
        common
    } else {
        Path::new(&root).join(common)
    };
    // A non-bare repository keeps its common dir at `<main worktree>/.git`.
    match (common.file_name(), common.parent()) {
        (Some(name), Some(main)) if name == ".git" => Ok(Some(canonical(main))),
        _ => Ok(Some(root)),
    }
}

/// Canonical repository root, or None when `cwd` is not inside a repository.
pub fn repo_root(cwd: &str) -> Result<Option<String>> {
    if !Path::new(cwd).is_dir() {
        return Ok(None);
    }
    match git(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(out) => Ok(Some(canonical(Path::new(out.trim())))),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("not a git repository") {
                Ok(None)
            } else {
                Err(e)
            }
        }
    }
}

fn has_head(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

pub fn status(cwd: &str) -> Result<Vec<FileStatus>> {
    let out = git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut entries = Vec::new();
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    while let Some(rec) = parts.next() {
        if rec.len() < 4 {
            continue;
        }
        let mut chars = rec.chars();
        let staged = chars.next().unwrap_or(' ');
        let unstaged = chars.next().unwrap_or(' ');
        let path = rec[3..].to_string();
        let renamed_from = if staged == 'R' || staged == 'C' || unstaged == 'R' || unstaged == 'C' {
            parts.next().map(str::to_string)
        } else {
            None
        };
        entries.push(FileStatus {
            path,
            staged,
            unstaged,
            renamed_from,
        });
    }
    Ok(entries)
}

fn untracked(cwd: &str, path: Option<&str>) -> Result<Vec<String>> {
    let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z"];
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    let out = git(cwd, &args)?;
    Ok(out
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

/// Unified diff. Untracked files are appended as additions so a session's new
/// files show up in the diff viewer too.
pub fn diff(cwd: &str, opts: &DiffOpts) -> Result<String> {
    let mut args: Vec<String> = vec!["diff".into(), "--no-color".into()];
    if opts.staged {
        args.push("--cached".into());
    } else if let Some(base) = &opts.base {
        args.push(base.clone());
    } else if has_head(cwd) {
        args.push("HEAD".into());
    }
    if let Some(p) = &opts.path {
        args.push("--".into());
        args.push(p.clone());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut out = git(cwd, &refs)?;
    if !opts.staged {
        for file in untracked(cwd, opts.path.as_deref())? {
            let piece = git_allow(
                cwd,
                &["diff", "--no-color", "--no-index", "--", "/dev/null", &file],
                &[1],
            )?;
            out.push_str(&piece);
        }
    }
    Ok(out)
}

pub fn diff_stat(cwd: &str, base: Option<&str>) -> Result<Vec<DiffStat>> {
    let mut args = vec!["diff", "--numstat"];
    let target;
    if let Some(b) = base {
        target = b.to_string();
        args.push(&target);
    } else if has_head(cwd) {
        args.push("HEAD");
    }
    let out = git(cwd, &args)?;
    let mut stats: Vec<DiffStat> = out
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let added = it.next()?.parse().unwrap_or(0);
            let deleted = it.next()?.parse().unwrap_or(0);
            let path = it.next()?.to_string();
            Some(DiffStat {
                path,
                added,
                deleted,
            })
        })
        .collect();
    for file in untracked(cwd, None)? {
        let lines = std::fs::read_to_string(Path::new(cwd).join(&file))
            .map(|s| s.lines().count())
            .unwrap_or(0);
        stats.push(DiffStat {
            path: file,
            added: lines as u32,
            deleted: 0,
        });
    }
    Ok(stats)
}

pub fn current_branch(cwd: &str) -> Result<String> {
    Ok(git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string())
}

/// Branch, tracking and working tree state of `cwd`. None when `cwd` is not
/// inside a repository.
pub fn branch_status(cwd: &str) -> Result<Option<BranchStatus>> {
    if repo_root(cwd)?.is_none() {
        return Ok(None);
    }
    let mut status = parse_branch_status(&git(
        cwd,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ],
    )?);
    if let (Some(branch), Some(_)) = (&status.branch, &status.upstream) {
        let config = |key: &str| -> Result<Option<String>> {
            let out = git_allow(
                cwd,
                &["config", "--get", &format!("branch.{branch}.{key}")],
                &[1],
            )?;
            Ok(Some(out.trim().to_string()).filter(|v| !v.is_empty()))
        };
        status.upstream_branch =
            config("merge")?.map(|r| r.strip_prefix("refs/heads/").unwrap_or(&r).to_string());
        if let Some(remote) = config("remote")? {
            let url = git_allow(cwd, &["remote", "get-url", &remote], &[2])?;
            status.upstream_repo = parse_github_remote(url.trim());
        }
    }
    Ok(Some(status))
}

/// Parse `git status --porcelain=v2 --branch` output.
fn parse_branch_status(out: &str) -> BranchStatus {
    let mut status = BranchStatus::default();
    for line in out.lines() {
        if let Some(oid) = line.strip_prefix("# branch.oid ") {
            status.head = (oid != "(initial)").then(|| oid.to_string());
        } else if let Some(head) = line.strip_prefix("# branch.head ") {
            status.branch = (head != "(detached)").then(|| head.to_string());
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut it = ab.split_whitespace();
            status.ahead = it
                .next()
                .and_then(|a| a.strip_prefix('+')?.parse().ok())
                .unwrap_or(0);
            status.behind = it
                .next()
                .and_then(|b| b.strip_prefix('-')?.parse().ok())
                .unwrap_or(0);
        } else if ["1 ", "2 ", "u ", "? "].iter().any(|p| line.starts_with(p)) {
            status.changed += 1;
        }
    }
    status
}

pub fn branches(cwd: &str) -> Result<Vec<String>> {
    let out = git(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Commit and return the new commit sha. With `all`, stages everything first.
pub fn commit(cwd: &str, message: &str, all: bool) -> Result<String> {
    if all {
        git(cwd, &["add", "-A"])?;
    }
    git(cwd, &["commit", "-q", "-m", message])?;
    Ok(git(cwd, &["rev-parse", "HEAD"])?.trim().to_string())
}

pub fn push(cwd: &str, set_upstream: bool) -> Result<String> {
    let out = if set_upstream {
        let branch = current_branch(cwd)?;
        git(cwd, &["push", "-u", "origin", &branch])?
    } else {
        git(cwd, &["push"])?
    };
    Ok(out)
}

pub fn log(cwd: &str, limit: usize) -> Result<Vec<LogEntry>> {
    if !has_head(cwd) {
        return Ok(vec![]);
    }
    let n = format!("-n{limit}");
    let out = git(cwd, &["log", &n, "--format=%H%x1f%s%x1f%an%x1f%aI"])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\x1f');
            Some(LogEntry {
                sha: it.next()?.to_string(),
                subject: it.next()?.to_string(),
                author: it.next()?.to_string(),
                date: it.next()?.to_string(),
            })
        })
        .collect())
}

pub fn worktrees(cwd: &str) -> Result<Vec<Worktree>> {
    let out = git(cwd, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree {
                path: p.to_string(),
                branch: None,
                head: None,
            });
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(w) = cur.as_mut() {
                w.head = Some(h.to_string());
            }
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(w) = cur.as_mut() {
                w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            }
        }
    }
    if let Some(w) = cur {
        list.push(w);
    }
    Ok(list)
}

/// `owner/repo` of the GitHub repository whose issues and PRs `cwd` works
/// against, choosing remotes in the order `gh` does: `upstream`, `github`, then
/// `origin`. None when `cwd` is not a repository or has no GitHub remote.
pub fn github_repo(cwd: &str) -> Result<Option<String>> {
    if repo_root(cwd)?.is_none() {
        return Ok(None);
    }
    let remotes = git(cwd, &["remote"])?;
    let names: Vec<&str> = remotes
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    for name in ["upstream", "github", "origin"] {
        if !names.contains(&name) {
            continue;
        }
        if let Some(repo) = parse_github_remote(git(cwd, &["remote", "get-url", name])?.trim()) {
            return Ok(Some(repo));
        }
    }
    Ok(None)
}

/// `owner/repo` from a github.com remote URL in HTTPS, SSH or scp-like form.
fn parse_github_remote(url: &str) -> Option<String> {
    let path = [
        "https://github.com/",
        "http://github.com/",
        "ssh://git@github.com/",
        "git://github.com/",
        "git@github.com:",
    ]
    .iter()
    .find_map(|prefix| url.strip_prefix(prefix))
    .or_else(|| {
        // https://user@github.com/owner/repo
        let rest = url.strip_prefix("https://")?;
        let (user, rest) = rest.split_once('@')?;
        (!user.contains('/'))
            .then_some(rest)?
            .strip_prefix("github.com/")
    })?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let valid = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (valid(owner) && valid(repo)).then(|| format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::{parse_branch_status, parse_github_remote, BranchStatus};

    #[test]
    fn parses_branch_status() {
        let out = "# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.rs\n2 R. N... 100644 100644 100644 a b R100 new.rs\told.rs\n? notes.md\n";
        assert_eq!(
            parse_branch_status(out),
            BranchStatus {
                branch: Some("feature/x".into()),
                head: Some("1234567890abcdef1234567890abcdef12345678".into()),
                upstream: Some("origin/feature/x".into()),
                ahead: 2,
                behind: 1,
                changed: 3,
                ..Default::default()
            }
        );
    }

    #[test]
    fn parses_detached_and_unborn_heads() {
        let status = parse_branch_status("# branch.oid (initial)\n# branch.head (detached)\n");
        assert_eq!(
            (status.branch, status.head, status.upstream),
            (None, None, None)
        );
    }

    #[test]
    fn parses_github_remote_forms() {
        for url in [
            "https://github.com/owner/repo.git",
            "https://github.com/owner/repo",
            "https://github.com/owner/repo/",
            "https://token@github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
        ] {
            assert_eq!(
                parse_github_remote(url).as_deref(),
                Some("owner/repo"),
                "{url}"
            );
        }
        assert_eq!(
            parse_github_remote("git@github.com:my.org/my-repo_2.git").as_deref(),
            Some("my.org/my-repo_2")
        );
    }

    #[test]
    fn rejects_other_hosts_and_paths() {
        for url in [
            "https://gitlab.com/owner/repo.git",
            "git@example.com:owner/repo.git",
            "https://github.com/owner",
            "https://github.com/owner/repo/extra",
            "/local/path/repo",
        ] {
            assert_eq!(parse_github_remote(url), None, "{url}");
        }
    }
}
