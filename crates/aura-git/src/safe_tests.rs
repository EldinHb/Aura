//! The restricted reader against a hostile repository: every setting that
//! makes plain `git status`/`git diff` run a command is set, and must not
//! run here.
//!
//! The hostile repository's commands are `sh` scripts that `touch` markers,
//! so the tests built on it run on Unix only.

use super::*;
use std::path::Path;

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[cfg(unix)]
struct Hostile {
    _tmp: tempfile::TempDir,
    repo: PathBuf,
    outside: PathBuf,
    markers: PathBuf,
}

#[cfg(unix)]
impl Hostile {
    fn markers(&self) -> Vec<String> {
        std::fs::read_dir(&self.markers)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }
}

#[cfg(unix)]
/// A repository whose config runs a command (touching a marker file) for
/// fsmonitor, clean/smudge/process filters, external diff, a diff driver's
/// command and textconv, and every hook. `sub/` is a session's folder.
fn hostile(format: &str) -> Hostile {
    let tmp = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(tmp.path()).unwrap();
    let repo = base.join("repo");
    let markers = base.join("markers");
    let outside = base.join("outside");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&markers).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "TOP SECRET\n").unwrap();
    git(&repo, &["init", "-q", &format!("--object-format={format}")]);
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    std::fs::write(repo.join("sub/a.txt"), "one\n").unwrap();
    std::fs::write(repo.join("sub/same.txt"), "same\n").unwrap();
    std::fs::write(repo.join("outside.txt"), "root file\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("a.txt", repo.join("sub/link")).unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "first"]);

    let m = markers.display();
    let set = |k: &str, v: &str| git(&repo, &["config", k, v]);
    set("core.fsmonitor", &format!("touch {m}/fsmonitor; false"));
    for (k, v) in [
        ("filter.evil.clean", "clean"),
        ("filter.evil.smudge", "smudge"),
        ("filter.evil.process", "process"),
        ("diff.evil.command", "diffcommand"),
        ("diff.evil.textconv", "textconv"),
        ("diff.external", "external"),
    ] {
        set(k, &format!("touch {m}/{v}; cat"));
    }
    set("filter.evil.required", "true");
    let hooks = base.join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    for hook in [
        "post-index-change",
        "pre-commit",
        "post-checkout",
        "reference-transaction",
        "fsmonitor-watchman",
    ] {
        let f = hooks.join(hook);
        std::fs::write(&f, format!("#!/bin/sh\ntouch {m}/hook-{hook}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    set("core.hooksPath", &hooks.to_string_lossy());
    std::fs::write(repo.join(".gitattributes"), "* filter=evil diff=evil\n").unwrap();
    std::fs::create_dir_all(repo.join(".git/info")).unwrap();
    std::fs::write(
        repo.join(".git/info/attributes"),
        "* filter=evil diff=evil\n",
    )
    .unwrap();

    // Changes in the session's folder, and one outside it.
    std::fs::write(repo.join("sub/a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("sub/new.txt"), "hello\n").unwrap();
    // Same bytes, new mtime: the stat data no longer matches, so it is hashed.
    std::fs::write(repo.join("sub/same.txt"), "same\n").unwrap();
    std::fs::write(repo.join("outside.txt"), "root file changed\n").unwrap();
    std::fs::write(repo.join("sibling.txt"), "untracked sibling\n").unwrap();
    #[cfg(unix)]
    {
        // Untracked symlinks out of the folder, to a file and to a folder.
        std::os::unix::fs::symlink(outside.join("secret.txt"), repo.join("sub/leak")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("sub/leakdir")).unwrap();
    }
    Hostile {
        _tmp: tmp,
        repo,
        outside,
        markers,
    }
}

fn names(files: &[FileStatus]) -> Vec<String> {
    files
        .iter()
        .map(|f| format!("{}{} {}", f.staged, f.unstaged, f.path))
        .collect()
}

#[cfg(unix)]
#[test]
fn nothing_the_repository_configures_runs() {
    for format in ["sha1", "sha256"] {
        let h = hostile(format);
        let sub = h.repo.join("sub");
        let limits = Limits::default();

        let st = status(&sub, &limits).unwrap();
        let listed = names(&st.files);
        assert!(
            listed.contains(&" M a.txt".to_string()),
            "{format}: {listed:?}"
        );
        assert!(
            listed.contains(&"?? new.txt".to_string()),
            "{format}: {listed:?}"
        );
        assert!(
            !listed.iter().any(|l| l.ends_with("same.txt")),
            "rewritten, same bytes: {listed:?}"
        );
        assert!(!st.truncated);

        let stat = diff_stat(&sub, None, &limits).unwrap();
        let a = stat.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.added, a.deleted), (1, 0));
        assert!(stat
            .files
            .iter()
            .any(|f| f.path == "new.txt" && f.added == 1));

        let d = diff(&sub, &DiffOpts::default(), &limits).unwrap();
        assert!(
            d.text.contains(
                "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+two\n"
            ),
            "{}",
            d.text
        );
        assert!(
            d.text.contains(
                "new file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n"
            ),
            "{}",
            d.text
        );
        let staged = diff(
            &sub,
            &DiffOpts {
                staged: true,
                ..Default::default()
            },
            &limits,
        )
        .unwrap();
        assert_eq!(staged.text, "");
        let based = diff(
            &sub,
            &DiffOpts {
                base: Some("main".into()),
                ..Default::default()
            },
            &limits,
        )
        .unwrap();
        assert!(based.text.contains("+two"));

        assert!(h.markers().is_empty(), "{format}: ran {:?}", h.markers());

        // The repository really is hostile: plain git runs its commands.
        let _ = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&h.repo)
            .output();
        let _ = std::process::Command::new("git")
            .args(["diff", "HEAD"])
            .current_dir(&h.repo)
            .output();
        assert!(!h.markers().is_empty(), "the hostile config is live");
    }
}

#[cfg(unix)]
#[test]
fn only_the_folder_is_read() {
    let h = hostile("sha1");
    let sub = h.repo.join("sub");
    let limits = Limits::default();
    let st = status(&sub, &limits).unwrap();
    let d = diff(&sub, &DiffOpts::default(), &limits).unwrap();
    let stat = diff_stat(&sub, None, &limits).unwrap();
    for text in [
        format!("{:?}", st.files),
        d.text.clone(),
        format!("{:?}", stat.files),
    ] {
        assert!(
            !text.contains("outside.txt") && !text.contains("sibling"),
            "{text}"
        );
        assert!(!text.contains("root file"), "{text}");
    }
    // Paths are relative to the folder.
    assert!(st.files.iter().all(|f| !f.path.starts_with("sub/")));
    for bad in [
        ":(top)outside.txt",
        ":/outside.txt",
        "../outside.txt",
        "/etc/passwd",
        "a/../../outside.txt",
        "",
    ] {
        assert!(check_path(bad).is_err(), "{bad}");
        assert!(
            diff(
                &sub,
                &DiffOpts {
                    path: Some(bad.into()),
                    ..Default::default()
                },
                &limits
            )
            .is_err(),
            "{bad}"
        );
    }
    // A path in the folder narrows to it.
    let one = diff(
        &sub,
        &DiffOpts {
            path: Some("a.txt".into()),
            ..Default::default()
        },
        &limits,
    )
    .unwrap();
    assert!(one.text.contains("+two") && !one.text.contains("hello"));
    // The whole repository, from its root, does see them.
    let all = status(&h.repo, &limits).unwrap();
    assert!(names(&all.files).contains(&" M outside.txt".to_string()));
    assert!(h.markers().is_empty());
}

#[cfg(unix)]
#[test]
fn symlinks_are_never_followed() {
    let h = hostile("sha1");
    let sub = h.repo.join("sub");
    let limits = Limits::default();
    let d = diff(&sub, &DiffOpts::default(), &limits).unwrap();
    let stat = diff_stat(&sub, None, &limits).unwrap();
    assert!(!d.text.contains("TOP SECRET"), "{}", d.text);
    assert!(
        !d.text.contains("leak"),
        "untracked symlinks are left out: {}",
        d.text
    );
    assert!(
        !stat.files.iter().any(|f| f.path.starts_with("leak")),
        "{:?}",
        stat.files
    );

    // A tracked symlink retargeted out of the folder shows the link, not
    // what it points at.
    std::fs::remove_file(sub.join("link")).unwrap();
    std::os::unix::fs::symlink(h.outside.join("secret.txt"), sub.join("link")).unwrap();
    let d = diff(&sub, &DiffOpts::default(), &limits).unwrap();
    assert!(d.text.contains("diff --git a/link b/link"), "{}", d.text);
    assert!(
        d.text
            .contains(&format!("+{}", h.outside.join("secret.txt").display())),
        "{}",
        d.text
    );
    assert!(!d.text.contains("TOP SECRET"), "{}", d.text);

    // A tracked file whose folder became a symlink out is not read.
    let plain = tempfile::tempdir().unwrap();
    let repo = std::fs::canonicalize(plain.path()).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::create_dir_all(repo.join("deep")).unwrap();
    std::fs::write(repo.join("deep/f.txt"), "tracked\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "1"]);
    std::fs::create_dir_all(h.outside.join("deep")).unwrap();
    std::fs::write(h.outside.join("deep/f.txt"), "TOP SECRET deep\n").unwrap();
    std::fs::remove_dir_all(repo.join("deep")).unwrap();
    std::os::unix::fs::symlink(h.outside.join("deep"), repo.join("deep")).unwrap();
    let st = status(&repo, &limits).unwrap();
    assert!(
        names(&st.files).contains(&" D deep/f.txt".to_string()),
        "{:?}",
        st.files
    );
    let d = diff(&repo, &DiffOpts::default(), &limits).unwrap();
    assert!(!d.text.contains("TOP SECRET"), "{}", d.text);
    let stat = diff_stat(&repo, None, &limits).unwrap();
    assert!(stat.files.iter().all(|f| f.added == 0), "{:?}", stat.files);
}

#[test]
fn the_index_stat_cache_is_trusted_only_when_it_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = std::fs::canonicalize(tmp.path()).unwrap();
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join("a.txt"), "aaaa\n").unwrap();
    std::fs::write(repo.join("b.txt"), "bbbb\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "1"]);
    // An index written well after the files: their stat data is trusted.
    std::thread::sleep(Duration::from_millis(1100));
    git(&repo, &["update-index", "--really-refresh"]);
    let limits = Limits::default();
    // `ls-files --debug` is read: every entry has its stat data, and it
    // matches the files, so nothing needs hashing.
    let r = Repo::open(&repo, &limits).unwrap().unwrap();
    let index = r.index().unwrap();
    assert_eq!(index.len(), 2);
    for (path, e) in &index {
        let meta = std::fs::symlink_metadata(repo.join(path)).unwrap();
        assert!(
            stat_matches(&meta, e.stat.unwrap(), r.index_mtime),
            "{path}"
        );
    }
    assert!(status(&repo, &limits).unwrap().files.is_empty());
    // Same size, other bytes, new mtime: hashed, and seen.
    std::fs::write(repo.join("b.txt"), "BBBB\n").unwrap();
    let st = status(&repo, &limits).unwrap();
    assert_eq!(names(&st.files), vec![" M b.txt".to_string()]);
}

#[cfg(unix)]
#[test]
fn limits_cut_and_say_so() {
    let h = hostile("sha1");
    let sub = h.repo.join("sub");
    for i in 0..10 {
        std::fs::write(sub.join(format!("many{i}.txt")), "x\n".repeat(1000)).unwrap();
    }
    let few = Limits {
        max_files: 3,
        ..Default::default()
    };
    let st = status(&sub, &few).unwrap();
    assert!(st.truncated && st.files.len() == 3);
    let stat = diff_stat(&sub, None, &few).unwrap();
    assert!(stat.truncated && stat.files.len() == 3);
    let d = diff(&sub, &DiffOpts::default(), &few).unwrap();
    assert!(
        d.truncated && d.text.matches("diff --git").count() == 3,
        "{}",
        d.text
    );
    assert!(d
        .text
        .ends_with("# aura: truncated: not every change is shown (limit reached)\n"));

    let small = Limits {
        max_file_output: 500,
        ..Default::default()
    };
    let d = diff(&sub, &DiffOpts::default(), &small).unwrap();
    assert!(d.truncated);
    assert!(d
        .text
        .contains("# aura: truncated: this file's diff is longer than the limit"));
    assert!(d.text.split("diff --git").all(|piece| piece.len() < 700));

    let total = Limits {
        max_total_output: 5000,
        ..Default::default()
    };
    let d = diff(&sub, &DiffOpts::default(), &total).unwrap();
    assert!(d.truncated && d.text.len() < 5200, "{}", d.text.len());

    let big = Limits {
        max_blob: 100,
        ..Default::default()
    };
    let d = diff(
        &sub,
        &DiffOpts {
            path: Some("many0.txt".into()),
            ..Default::default()
        },
        &big,
    )
    .unwrap();
    assert!(
        d.text
            .contains("# aura: not shown: 2000 bytes is too large"),
        "{}",
        d.text
    );
    assert!(h.markers().is_empty());
}

#[cfg(unix)]
#[test]
fn a_git_past_its_deadline_or_cap_is_stopped() {
    let h = hostile("sha1");
    let e = run_git(
        &h.repo,
        &["ls-files", "-z", "--stage"],
        None,
        Instant::now(),
        1 << 20,
    )
    .unwrap_err()
    .to_string();
    assert!(e.contains("took too long"), "{e}");
    let e = run_git(
        &h.repo,
        &["ls-files", "-z", "--stage"],
        None,
        Instant::now() + Duration::from_secs(10),
        10,
    )
    .unwrap_err()
    .to_string();
    assert!(e.contains("wrote more than"), "{e}");
}

#[test]
fn no_repository_is_no_changes() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("x.txt"), "x").unwrap();
    let limits = Limits::default();
    assert_eq!(status(tmp.path(), &limits).unwrap(), SafeStatus::default());
    assert_eq!(
        diff(tmp.path(), &DiffOpts::default(), &limits).unwrap(),
        SafeDiff::default()
    );
    assert_eq!(
        status(Path::new("/nonexistent/aura"), &limits).unwrap(),
        SafeStatus::default()
    );
}
