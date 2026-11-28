//! A restricted, read-only view of a folder's git changes, for callers that
//! must not let the repository run anything: remote devices.
//!
//! `git status` and `git diff` read working-tree files through the
//! repository's own configuration: `core.fsmonitor`, clean/process filters,
//! external diff drivers, textconv and hooks all run commands the repository
//! (that is, any agent working in it) chose. This module never asks git to
//! look at a working-tree file. Git is only used for metadata it reads from
//! the index and the object store — `rev-parse`, `ls-files --stage`,
//! `ls-files --others`, `ls-tree` and `cat-file --batch`, none of which runs
//! a filter, driver or hook — with the risky settings overridden anyway, no
//! system config, no optional locks, no lazy fetch and literal pathspecs.
//! The working-tree side is read here, byte for byte, without following
//! symlinks and only inside the folder; diffs are computed in-process.
//!
//! What that costs: no clean filters or end-of-line conversion are applied,
//! so a file git would consider unchanged after its filter (LFS, CRLF) shows
//! as changed; renames are not detected; submodules are left out.
//!
//! Everything is bounded: files, bytes per file and in total, blob size, git
//! output and time (a git process past the deadline is killed). What is cut
//! says so (`truncated`).

use crate::ops::{DiffOpts, DiffStat, FileStatus};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};
use ts_rs::TS;

/// How much one call may do.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Files with changes reported (status, stat) or diffed.
    pub max_files: usize,
    /// Diff text per file.
    pub max_file_output: usize,
    /// Diff text in total.
    pub max_total_output: usize,
    /// Files (and blobs) larger than this are not diffed, only named.
    pub max_blob: u64,
    /// Output of one git command (file lists).
    pub max_git_output: usize,
    /// For the whole call; a git process still running then is killed.
    pub deadline: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: 300,
            max_file_output: 512 * 1024,
            max_total_output: 4 * 1024 * 1024,
            max_blob: 8 * 1024 * 1024,
            max_git_output: 32 * 1024 * 1024,
            deadline: Duration::from_secs(15),
        }
    }
}

/// `session.git_status` for remote devices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SafeStatus {
    /// Paths relative to the folder asked about.
    pub files: Vec<FileStatus>,
    /// Not every file is listed: a limit was reached.
    pub truncated: bool,
}

/// `session.git_diff_stat` for remote devices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SafeDiffStat {
    /// Paths relative to the folder asked about.
    pub files: Vec<DiffStat>,
    pub truncated: bool,
}

/// `session.git_diff` for remote devices: unified diff text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SafeDiff {
    pub text: String,
    pub truncated: bool,
}

/// Why a path a caller gave is refused.
pub fn check_path(path: &str) -> Result<()> {
    let p = Path::new(path);
    if path.is_empty()
        || path.starts_with(':')
        || path.contains('\0')
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("`{path}` is not a plain path inside the folder");
    }
    Ok(())
}

const NOT_A_FILE: &str = "# aura: not shown: a symlink, or not a regular file";

/// The folder's changes, `git status` style.
pub fn status(dir: &Path, limits: &Limits) -> Result<SafeStatus> {
    let Some(repo) = Repo::open(dir, limits)? else {
        return Ok(SafeStatus::default());
    };
    let head = repo.tree("HEAD")?;
    let index = repo.index()?;
    let untracked = repo.untracked()?;
    let mut out = SafeStatus::default();
    let paths: BTreeSet<&String> = head.keys().chain(index.keys()).collect();
    for path in paths {
        if repo.too_late() {
            out.truncated = true;
            break;
        }
        let h = head.get(path);
        let i = index.get(path);
        let staged = match (h, i) {
            (_, Some(e)) if e.stage != 0 => 'U',
            (None, Some(_)) => 'A',
            (Some(_), None) => 'D',
            (Some(h), Some(i)) if h.oid != i.oid || h.mode != i.mode => 'M',
            _ => ' ',
        };
        let unstaged = match i {
            None => ' ',
            Some(e) if e.stage != 0 => 'U',
            Some(e) => match repo.worktree_blob(path, Some(e))? {
                Worktree::Missing | Worktree::Other => 'D',
                Worktree::Blob { oid, mode, .. } if oid != e.oid => {
                    if (mode == LINK) != (e.mode == LINK) {
                        'T'
                    } else {
                        'M'
                    }
                }
                Worktree::Blob { mode, .. } if mode != e.mode => 'M',
                Worktree::Blob { .. } => ' ',
            },
        };
        if staged != ' ' || unstaged != ' ' {
            out.files.push(FileStatus {
                path: path.clone(),
                staged,
                unstaged,
                renamed_from: None,
            });
        }
    }
    for path in untracked {
        out.files.push(FileStatus {
            path,
            staged: '?',
            unstaged: '?',
            renamed_from: None,
        });
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    if out.files.len() > limits.max_files {
        out.files.truncate(limits.max_files);
        out.truncated = true;
    }
    Ok(out)
}

/// Lines added and removed per changed file, against HEAD or `base`.
pub fn diff_stat(dir: &Path, base: Option<&str>, limits: &Limits) -> Result<SafeDiffStat> {
    let Some(repo) = Repo::open(dir, limits)? else {
        return Ok(SafeDiffStat::default());
    };
    let changes = repo.changes(base, false, None)?;
    let mut out = SafeDiffStat {
        truncated: changes.truncated,
        ..Default::default()
    };
    let blobs = repo.blobs(&changes.list)?;
    for c in &changes.list {
        if repo.too_late() {
            out.truncated = true;
            break;
        }
        let (old, new) = (repo.old_side(c, &blobs), repo.new_side(c, &blobs)?);
        let (added, deleted) = match (old, new) {
            (Side::Text(o), Side::Text(n)) => count_lines(&o, &n),
            (Side::Absent, Side::Text(n)) => count_lines("", &n),
            (Side::Text(o), Side::Absent) => count_lines(&o, ""),
            _ => (0, 0),
        };
        out.files.push(DiffStat {
            path: c.path.clone(),
            added,
            deleted,
        });
    }
    Ok(out)
}

/// Unified diff, untracked files included as new ones (not with `staged`).
pub fn diff(dir: &Path, opts: &DiffOpts, limits: &Limits) -> Result<SafeDiff> {
    if let Some(p) = &opts.path {
        check_path(p)?;
    }
    let Some(repo) = Repo::open(dir, limits)? else {
        return Ok(SafeDiff::default());
    };
    let changes = repo.changes(opts.base.as_deref(), opts.staged, opts.path.as_deref())?;
    let mut out = SafeDiff {
        truncated: changes.truncated,
        ..Default::default()
    };
    let blobs = repo.blobs(&changes.list)?;
    for c in &changes.list {
        if repo.too_late() {
            out.truncated = true;
            break;
        }
        let mut piece = file_diff(c, repo.old_side(c, &blobs), repo.new_side(c, &blobs)?);
        if piece.len() > limits.max_file_output {
            let cut = piece[..limits.max_file_output]
                .rfind('\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            piece.truncate(cut);
            piece.push_str("# aura: truncated: this file's diff is longer than the limit\n");
            out.truncated = true;
        }
        if out.text.len() + piece.len() > limits.max_total_output {
            out.truncated = true;
            break;
        }
        out.text.push_str(&piece);
    }
    if out.truncated {
        out.text
            .push_str("# aura: truncated: not every change is shown (limit reached)\n");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------

const LINK: u32 = 0o120000;
const GITLINK: u32 = 0o160000;

#[derive(Debug, Clone)]
struct Entry {
    mode: u32,
    oid: String,
    stage: u8,
    /// From `ls-files --debug`; None for tree entries.
    stat: Option<Stat>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Stat {
    mtime: (i64, u32),
    size: u64,
    ino: u64,
}

enum Worktree {
    Missing,
    /// A directory, device, fifo… or a path through a symlinked folder.
    Other,
    Blob {
        oid: String,
        mode: u32,
    },
}

#[derive(Debug, Clone)]
struct Change {
    path: String,
    /// The side it is compared against (HEAD, `base`).
    old: Option<Entry>,
    /// The index entry, for a staged diff; the working tree otherwise.
    new: New,
}

#[derive(Debug, Clone)]
enum New {
    Absent,
    Index(Entry),
    /// Working-tree file; `oid` and `mode` as hashed.
    Worktree {
        oid: String,
        mode: u32,
    },
    /// A symlink or special file that is not read.
    Skipped,
}

struct Changes {
    list: Vec<Change>,
    truncated: bool,
}

enum Side {
    Absent,
    Text(String),
    Binary,
    TooLarge(u64),
    Skipped,
}

struct Repo {
    /// The folder asked about, resolved.
    dir: PathBuf,
    /// Repository root, resolved.
    root: PathBuf,
    /// `dir` relative to `root`, `/`-separated; empty at the root.
    prefix: String,
    index_mtime: Option<SystemTime>,
    sha256: bool,
    filemode: bool,
    limits: Limits,
    deadline: Instant,
}

impl Repo {
    /// None when `dir` is in no repository, or its repository's working
    /// tree does not contain it (`core.worktree` elsewhere).
    fn open(dir: &Path, limits: &Limits) -> Result<Option<Repo>> {
        let deadline = Instant::now() + limits.deadline;
        let dir = match std::fs::canonicalize(dir) {
            Ok(d) if d.is_dir() => d,
            _ => return Ok(None),
        };
        let probe = run_git(
            &dir,
            &[
                "rev-parse",
                "--show-toplevel",
                "--show-object-format",
                "--git-path",
                "index",
            ],
            None,
            deadline,
            64 * 1024,
        );
        let Ok(out) = probe else {
            return Ok(None);
        };
        let out = String::from_utf8_lossy(&out);
        let mut lines = out.lines();
        let (Some(top), Some(format), Some(index)) = (lines.next(), lines.next(), lines.next())
        else {
            return Ok(None);
        };
        let Ok(root) = std::fs::canonicalize(top) else {
            return Ok(None);
        };
        let Ok(rel) = dir.strip_prefix(&root) else {
            return Ok(None);
        };
        let prefix = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let index_path = if Path::new(index).is_absolute() {
            PathBuf::from(index)
        } else {
            dir.join(index)
        };
        let index_mtime = std::fs::metadata(index_path)
            .and_then(|m| m.modified())
            .ok();
        let mut repo = Repo {
            dir,
            root,
            prefix,
            index_mtime,
            sha256: format.trim() == "sha256",
            filemode: true,
            limits: limits.clone(),
            deadline,
        };
        repo.filemode = repo
            .git(&["config", "--bool", "core.fileMode"], None)
            .map(|o| String::from_utf8_lossy(&o).trim() != "false")
            .unwrap_or(true);
        Ok(Some(repo))
    }

    fn too_late(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn git(&self, args: &[&str], input: Option<Vec<u8>>) -> Result<Vec<u8>> {
        run_git(
            &self.root,
            args,
            input,
            self.deadline,
            self.limits.max_git_output,
        )
    }

    /// Pathspec args restricting a command to the folder.
    fn scope(&self) -> Vec<&str> {
        if self.prefix.is_empty() {
            vec![]
        } else {
            vec!["--", &self.prefix]
        }
    }

    /// A repository path relative to the folder; None outside it.
    fn local(&self, path: &str) -> Option<String> {
        if self.prefix.is_empty() {
            return Some(path.to_string());
        }
        path.strip_prefix(&self.prefix)?
            .strip_prefix('/')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
    }

    /// Entries of `treeish` in the folder; empty when it does not resolve
    /// (no commit yet).
    fn tree(&self, treeish: &str) -> Result<BTreeMap<String, Entry>> {
        let mut args = vec![
            "ls-tree",
            "-r",
            "-z",
            "--full-tree",
            "--end-of-options",
            treeish,
        ];
        args.extend(self.scope());
        let out = match self.git(&args, None) {
            Ok(o) => o,
            Err(_) if treeish == "HEAD" => return Ok(BTreeMap::new()),
            Err(e) => return Err(e),
        };
        let mut map = BTreeMap::new();
        for rec in out.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let rec = String::from_utf8_lossy(rec);
            let Some((meta, path)) = rec.split_once('\t') else {
                continue;
            };
            let mut it = meta.split(' ');
            let (Some(mode), Some(_kind), Some(oid)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let Ok(mode) = u32::from_str_radix(mode, 8) else {
                continue;
            };
            if mode == GITLINK {
                continue;
            }
            if let Some(local) = self.local(path) {
                map.insert(
                    local,
                    Entry {
                        mode,
                        oid: oid.to_string(),
                        stage: 0,
                        stat: None,
                    },
                );
            }
        }
        Ok(map)
    }

    /// Index entries in the folder, with their stat data.
    fn index(&self) -> Result<BTreeMap<String, Entry>> {
        let mut args = vec!["ls-files", "-z", "--stage", "--debug"];
        args.extend(self.scope());
        let out = self.git(&args, None)?;
        let out = String::from_utf8_lossy(&out).into_owned();
        // `<mode> <oid> <stage>\t<path>\0` then five debug lines, each ending
        // in `\n`, before the next entry.
        let mut map = BTreeMap::new();
        let mut chunks = out.split('\0');
        let mut header = chunks.next().unwrap_or("").to_string();
        for chunk in chunks {
            let mut rest = chunk;
            let mut debug = Vec::new();
            for _ in 0..5 {
                match rest.split_once('\n') {
                    Some((line, more)) => {
                        debug.push(line);
                        rest = more;
                    }
                    None => break,
                }
            }
            self.add_index_entry(&mut map, &header, &debug);
            header = rest.to_string();
        }
        Ok(map)
    }

    fn add_index_entry(&self, map: &mut BTreeMap<String, Entry>, header: &str, debug: &[&str]) {
        let Some((meta, path)) = header.split_once('\t') else {
            return;
        };
        let mut it = meta.split(' ');
        let (Some(mode), Some(oid), Some(stage)) = (it.next(), it.next(), it.next()) else {
            return;
        };
        let (Ok(mode), Ok(stage)) = (u32::from_str_radix(mode, 8), stage.parse::<u8>()) else {
            return;
        };
        if mode == GITLINK {
            return;
        }
        let field = |name: &str| -> Option<&str> {
            debug.iter().find_map(|l| {
                let l = l.trim_start();
                l.split('\t')
                    .find_map(|part| part.strip_prefix(name))
                    .map(str::trim)
            })
        };
        let stat = (|| {
            let (s, ns) = field("mtime:")?.split_once(':')?;
            Some(Stat {
                mtime: (s.parse().ok()?, ns.parse().ok()?),
                size: field("size:")?.split_whitespace().next()?.parse().ok()?,
                ino: field("ino:")?.parse().ok()?,
            })
        })();
        if let Some(local) = self.local(path) {
            // A conflict has several stages: keep one, marked.
            let e = map.entry(local).or_insert(Entry {
                mode,
                oid: oid.to_string(),
                stage,
                stat,
            });
            if stage != 0 {
                e.stage = stage;
            }
        }
    }

    /// Untracked, not ignored files in the folder (nested repositories left out).
    fn untracked(&self) -> Result<Vec<String>> {
        let mut args = vec!["ls-files", "-z", "--others", "--exclude-standard"];
        args.extend(self.scope());
        let out = self.git(&args, None)?;
        Ok(out
            .split(|b| *b == 0)
            .filter(|r| !r.is_empty() && !r.ends_with(b"/"))
            .filter_map(|r| self.local(&String::from_utf8_lossy(r)))
            .collect())
    }

    /// The working-tree file at `path` (relative to the folder), hashed as a
    /// blob. `known`: its index entry, whose hash stands when the file's stat
    /// data still matches (as git itself decides).
    fn worktree_blob(&self, path: &str, known: Option<&Entry>) -> Result<Worktree> {
        let Some(file) = confined(&self.dir, path) else {
            return Ok(Worktree::Other);
        };
        let meta = match std::fs::symlink_metadata(&file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Worktree::Missing),
            Err(_) => return Ok(Worktree::Other),
        };
        if meta.file_type().is_symlink() {
            // The link itself, as git stores it; never what it points at.
            let target = std::fs::read_link(&file)?;
            let bytes = target.to_string_lossy().into_owned().into_bytes();
            return Ok(Worktree::Blob {
                oid: self.hash(&bytes),
                mode: LINK,
            });
        }
        if !meta.is_file() {
            return Ok(Worktree::Other);
        }
        let mode = self.file_mode(&meta, known);
        if let (Some(e), Some(stat)) = (known, known.and_then(|e| e.stat)) {
            if stat_matches(&meta, stat, self.index_mtime) {
                return Ok(Worktree::Blob {
                    oid: e.oid.clone(),
                    mode,
                });
            }
        }
        let (oid, _, _) = self.hash_file(&file, false)?;
        Ok(match oid {
            Some(oid) => Worktree::Blob { oid, mode },
            None => Worktree::Other,
        })
    }

    fn file_mode(&self, meta: &std::fs::Metadata, known: Option<&Entry>) -> u32 {
        #[cfg(unix)]
        if self.filemode {
            use std::os::unix::fs::PermissionsExt;
            return if meta.permissions().mode() & 0o111 != 0 {
                0o100755
            } else {
                0o100644
            };
        }
        let _ = meta;
        known
            .map(|e| e.mode)
            .filter(|m| *m != LINK)
            .unwrap_or(0o100644)
    }

    /// Read and hash a regular file without following a symlink put in its
    /// place meanwhile. With `keep`, also its bytes when not over `max_blob`.
    fn hash_file(&self, file: &Path, keep: bool) -> Result<(Option<String>, Option<Vec<u8>>, u64)> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let Ok(mut f) = options.open(file) else {
            return Ok((None, None, 0));
        };
        let meta = f.metadata()?;
        if !meta.is_file() {
            return Ok((None, None, 0));
        }
        let size = meta.len();
        let mut hasher = Hasher::new(self.sha256, size);
        let keep = keep && size <= self.limits.max_blob;
        let mut kept = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut read = 0u64;
        loop {
            if self.too_late() {
                bail!("reading the folder took too long");
            }
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            read += n as u64;
            hasher.update(&buf[..n]);
            if keep {
                kept.extend_from_slice(&buf[..n]);
            }
        }
        if read != size {
            // Changed while read: not something to show.
            return Ok((None, None, 0));
        }
        Ok((Some(hasher.finish()), keep.then_some(kept), size))
    }

    fn hash(&self, bytes: &[u8]) -> String {
        let mut h = Hasher::new(self.sha256, bytes.len() as u64);
        h.update(bytes);
        h.finish()
    }

    /// What changed against HEAD (or `base`): in the index with `staged`,
    /// in the working tree otherwise. Only `only` (a file or folder) when given.
    fn changes(&self, base: Option<&str>, staged: bool, only: Option<&str>) -> Result<Changes> {
        let target = self.tree(base.unwrap_or("HEAD"))?;
        let index = self.index()?;
        let wanted = |p: &str| match only {
            None => true,
            Some(o) => p == o || p.strip_prefix(o).is_some_and(|r| r.starts_with('/')),
        };
        let mut list = Vec::new();
        let mut truncated = false;
        let paths: BTreeSet<&String> = target.keys().chain(index.keys()).collect();
        for path in paths {
            if !wanted(path) {
                continue;
            }
            if self.too_late() {
                truncated = true;
                break;
            }
            let old = target.get(path).cloned();
            let new = if staged {
                match index.get(path) {
                    Some(e) => New::Index(e.clone()),
                    None => New::Absent,
                }
            } else {
                match self.worktree_blob(path, index.get(path))? {
                    Worktree::Missing => New::Absent,
                    Worktree::Other => New::Skipped,
                    Worktree::Blob { oid, mode, .. } => New::Worktree { oid, mode },
                }
            };
            let same = match (&old, &new) {
                (None, New::Absent) => true,
                (Some(o), New::Index(e)) => o.oid == e.oid && o.mode == e.mode,
                (Some(o), New::Worktree { oid, mode }) => o.oid == *oid && o.mode == *mode,
                _ => false,
            };
            if !same {
                list.push(Change {
                    path: path.clone(),
                    old,
                    new,
                });
            }
        }
        if !staged {
            for path in self.untracked()? {
                if !wanted(&path) || target.contains_key(&path) {
                    continue;
                }
                // Untracked symlinks and special files are left out entirely.
                let Some(file) = confined(&self.dir, &path) else {
                    continue;
                };
                match std::fs::symlink_metadata(&file) {
                    Ok(m) if m.is_file() => {}
                    _ => continue,
                }
                list.push(Change {
                    path,
                    old: None,
                    new: New::Worktree {
                        oid: String::new(),
                        mode: 0o100644,
                    },
                });
            }
        }
        list.sort_by(|a, b| a.path.cmp(&b.path));
        if list.len() > self.limits.max_files {
            list.truncate(self.limits.max_files);
            truncated = true;
        }
        Ok(Changes { list, truncated })
    }

    /// The blobs the changes need from the object store, not larger than
    /// `max_blob`: oid -> bytes (or size, when larger).
    fn blobs(&self, changes: &[Change]) -> Result<HashMap<String, Result<Vec<u8>, u64>>> {
        let mut oids: BTreeSet<String> = BTreeSet::new();
        for c in changes {
            if let Some(o) = &c.old {
                oids.insert(o.oid.clone());
            }
            if let New::Index(e) = &c.new {
                oids.insert(e.oid.clone());
            }
        }
        let mut found = HashMap::new();
        if oids.is_empty() {
            return Ok(found);
        }
        let list: String = oids.iter().map(|o| format!("{o}\n")).collect();
        let sizes = self.git(&["cat-file", "--batch-check"], Some(list.into_bytes()))?;
        let mut small = String::new();
        // What `cat-file --batch` may send back in all.
        let mut budget = self.limits.max_git_output as u64 / 2;
        for line in String::from_utf8_lossy(&sizes).lines() {
            let mut it = line.split(' ');
            let (Some(oid), Some(kind), Some(size)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            let size: u64 = size.parse().unwrap_or(u64::MAX);
            if kind != "blob" {
                continue;
            }
            if size > self.limits.max_blob || size > budget {
                found.insert(oid.to_string(), Err(size));
            } else {
                budget -= size;
                small.push_str(oid);
                small.push('\n');
            }
        }
        if small.is_empty() {
            return Ok(found);
        }
        let out = self.git(&["cat-file", "--batch"], Some(small.into_bytes()))?;
        // `<oid> blob <size>\n<bytes>\n`, one after the other.
        let mut at = 0;
        while at < out.len() {
            let Some(nl) = out[at..].iter().position(|b| *b == b'\n') else {
                break;
            };
            let header = String::from_utf8_lossy(&out[at..at + nl]).into_owned();
            at += nl + 1;
            let mut it = header.split(' ');
            let (Some(oid), Some(_), Some(size)) = (it.next(), it.next(), it.next()) else {
                break;
            };
            let Ok(size) = size.parse::<usize>() else {
                break;
            };
            if at + size > out.len() {
                break;
            }
            found.insert(oid.to_string(), Ok(out[at..at + size].to_vec()));
            at += size + 1;
        }
        Ok(found)
    }

    fn old_side(&self, c: &Change, blobs: &HashMap<String, Result<Vec<u8>, u64>>) -> Side {
        match &c.old {
            None => Side::Absent,
            Some(e) => blob_side(blobs.get(&e.oid)),
        }
    }

    fn new_side(&self, c: &Change, blobs: &HashMap<String, Result<Vec<u8>, u64>>) -> Result<Side> {
        Ok(match &c.new {
            New::Absent => Side::Absent,
            New::Skipped => Side::Skipped,
            New::Index(e) => blob_side(blobs.get(&e.oid)),
            New::Worktree { mode, .. } if *mode == LINK => {
                match confined(&self.dir, &c.path).and_then(|f| std::fs::read_link(f).ok()) {
                    Some(t) => Side::Text(t.to_string_lossy().into_owned()),
                    None => Side::Skipped,
                }
            }
            New::Worktree { .. } => {
                let Some(file) = confined(&self.dir, &c.path) else {
                    return Ok(Side::Skipped);
                };
                match self.hash_file(&file, true)? {
                    (Some(_), Some(bytes), _) => text_side(bytes),
                    (Some(_), None, size) => Side::TooLarge(size),
                    (None, _, _) => Side::Skipped,
                }
            }
        })
    }
}

fn blob_side(b: Option<&Result<Vec<u8>, u64>>) -> Side {
    match b {
        Some(Ok(bytes)) => text_side(bytes.clone()),
        Some(Err(size)) => Side::TooLarge(*size),
        None => Side::Skipped,
    }
}

fn text_side(bytes: Vec<u8>) -> Side {
    if bytes[..bytes.len().min(8000)].contains(&0) {
        Side::Binary
    } else {
        Side::Text(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn count_lines(old: &str, new: &str) -> (u32, u32) {
    use similar::ChangeTag;
    let d = similar::TextDiff::configure()
        .timeout(Duration::from_secs(2))
        .diff_lines(old, new);
    let (mut added, mut deleted) = (0, 0);
    for c in d.iter_all_changes() {
        match c.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => deleted += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, deleted)
}

/// One file's diff, as `git diff` writes it.
fn file_diff(c: &Change, old: Side, new: Side) -> String {
    let p = &c.path;
    let old_mode = c.old.as_ref().map(|e| e.mode);
    let new_mode = match &c.new {
        New::Index(e) => Some(e.mode),
        New::Worktree { mode, .. } => Some(*mode),
        _ => None,
    };
    let mut s = format!("diff --git a/{p} b/{p}\n");
    match (&old, &new) {
        (Side::Absent, _) => s.push_str(&format!(
            "new file mode {:o}\n",
            new_mode.unwrap_or(0o100644)
        )),
        (_, Side::Absent) => s.push_str(&format!(
            "deleted file mode {:o}\n",
            old_mode.unwrap_or(0o100644)
        )),
        _ => {
            if let (Some(o), Some(n)) = (old_mode, new_mode) {
                if o != n {
                    s.push_str(&format!("old mode {o:o}\nnew mode {n:o}\n"));
                }
            }
        }
    }
    let a = if matches!(old, Side::Absent) {
        "/dev/null".to_string()
    } else {
        format!("a/{p}")
    };
    let b = if matches!(new, Side::Absent) {
        "/dev/null".to_string()
    } else {
        format!("b/{p}")
    };
    let text = |side: &Side| match side {
        Side::Absent => Some(String::new()),
        Side::Text(t) => Some(t.clone()),
        _ => None,
    };
    match (text(&old), text(&new)) {
        (Some(o), Some(n)) => {
            if o == n {
                return s;
            }
            s.push_str(&format!("--- {a}\n+++ {b}\n"));
            let d = similar::TextDiff::configure()
                .timeout(Duration::from_secs(2))
                .diff_lines(&o, &n);
            for hunk in d.unified_diff().context_radius(3).iter_hunks() {
                s.push_str(&hunk.to_string());
            }
        }
        _ => {
            for side in [&old, &new] {
                match side {
                    Side::Skipped => {
                        s.push_str(NOT_A_FILE);
                        s.push('\n');
                        return s;
                    }
                    Side::TooLarge(size) => {
                        s.push_str(&format!("# aura: not shown: {size} bytes is too large\n"));
                        return s;
                    }
                    _ => {}
                }
            }
            s.push_str(&format!("Binary files {a} and {b} differ\n"));
        }
    }
    s
}

/// `dir/path`, when no folder on the way there is a symlink (or anything but
/// a folder). The last part is checked by whoever opens it.
fn confined(dir: &Path, path: &str) -> Option<PathBuf> {
    check_path(path).ok()?;
    let mut at = dir.to_path_buf();
    let parts: Vec<&str> = path.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        if i + 1 < parts.len() {
            let m = std::fs::symlink_metadata(&at).ok()?;
            if !m.is_dir() {
                return None;
            }
        }
    }
    Some(at)
}

/// Whether the index's stat data still describes the file, so its hash in
/// the index stands. A file changed in the same second as the index was
/// written ("racily clean") is hashed anyway.
fn stat_matches(meta: &std::fs::Metadata, stat: Stat, index_mtime: Option<SystemTime>) -> bool {
    if meta.len() != stat.size {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if stat.ino != 0 && meta.ino() != stat.ino {
            return false;
        }
        if (meta.mtime(), meta.mtime_nsec() as u32) != stat.mtime {
            return false;
        }
    }
    #[cfg(not(unix))]
    {
        let Ok(m) = meta.modified() else {
            return false;
        };
        let Ok(d) = m.duration_since(SystemTime::UNIX_EPOCH) else {
            return false;
        };
        if (d.as_secs() as i64, d.subsec_nanos()) != stat.mtime {
            return false;
        }
    }
    let file_mtime = SystemTime::UNIX_EPOCH
        + Duration::new(stat.mtime.0.max(0) as u64, stat.mtime.1.min(999_999_999));
    match index_mtime {
        Some(i) => file_mtime < i,
        None => false,
    }
}

enum Hasher {
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
}

impl Hasher {
    fn new(sha256: bool, size: u64) -> Self {
        use sha2::Digest;
        let header = format!("blob {size}\0");
        let mut h = if sha256 {
            Hasher::Sha256(sha2::Sha256::new())
        } else {
            Hasher::Sha1(sha1::Sha1::new())
        };
        h.update(header.as_bytes());
        h
    }
    fn update(&mut self, bytes: &[u8]) {
        use sha2::Digest;
        match self {
            Hasher::Sha1(h) => h.update(bytes),
            Hasher::Sha256(h) => h.update(bytes),
        }
    }
    fn finish(self) -> String {
        use sha2::Digest;
        let bytes = match self {
            Hasher::Sha1(h) => h.finalize().to_vec(),
            Hasher::Sha256(h) => h.finalize().to_vec(),
        };
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Settings that would run a command, or reach the network, overridden for
/// every git process here (the command line wins over the repository's
/// config). Defence in depth: the commands used do not consult them.
const SAFE_CONFIG: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=/nonexistent-aura-no-hooks",
    "-c",
    "diff.external=",
    "-c",
    "core.sshCommand=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "core.alternateRefsCommand=",
];

/// Variables of our own environment that would point git elsewhere or add
/// configuration.
const CLEARED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXTERNAL_DIFF",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "GIT_EXEC_PATH",
    "GIT_TRACE",
];

/// Run git in `cwd` under [`SAFE_CONFIG`]: killed at `deadline`, refused
/// when it writes more than `cap` bytes.
fn run_git(
    cwd: &Path,
    args: &[&str],
    input: Option<Vec<u8>>,
    deadline: Instant,
    cap: usize,
) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("--no-pager")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(cwd)
        .args(SAFE_CONFIG)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_PAGER", "cat")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for v in CLEARED_ENV {
        cmd.env_remove(v);
    }
    aura_core::process::hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .with_context(|| format!("run git {}", args.first().unwrap_or(&"")))?;
    let writer = input.and_then(|bytes| {
        let mut stdin = child.stdin.take()?;
        Some(std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        }))
    });
    let mut stdout = child.stdout.take().ok_or_else(|| anyhow!("git stdout"))?;
    let over = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let over_flag = over.clone();
    let reader = std::thread::spawn(move || -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => return out,
                Ok(n) => {
                    if out.len() + n > cap {
                        over_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                        return out;
                    }
                    out.extend_from_slice(&buf[..n]);
                }
            }
        }
    });
    let mut stderr = child.stderr.take().ok_or_else(|| anyhow!("git stderr"))?;
    let err_reader = std::thread::spawn(move || {
        let mut e = Vec::new();
        let _ = (&mut stderr).take(16 * 1024).read_to_end(&mut e);
        // Drain the rest so git never blocks on a full pipe.
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        e
    });
    let over = || over.load(std::sync::atomic::Ordering::SeqCst);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if over() {
            let _ = child.kill();
        } else if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("git {} took too long and was stopped", args[0]);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let out = reader.join().map_err(|_| anyhow!("git output reader"))?;
    let err = err_reader.join().unwrap_or_default();
    if let Some(w) = writer {
        let _ = w.join();
    }
    if over() {
        bail!("git {} wrote more than {cap} bytes", args[0]);
    }
    if !status.success() {
        bail!(
            "git {} failed: {}",
            args[0],
            String::from_utf8_lossy(&err).trim()
        );
    }
    Ok(out)
}

#[cfg(test)]
#[path = "safe_tests.rs"]
mod tests;
