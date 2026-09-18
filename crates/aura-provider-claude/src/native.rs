//! Discovery of existing Claude Code sessions on disk (`~/.claude/projects/*/*.jsonl`).

use aura_core::{NativeSession, ProviderKind};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub fn projects_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(p).join("projects"));
    }
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Scan the projects directory. Never fails: a missing directory yields an empty list.
pub fn scan(dir: &Path, cap: usize) -> Vec<NativeSession> {
    let mut out = vec![];
    let Ok(projects) = std::fs::read_dir(dir) else { return out };
    for project in projects.flatten() {
        let ppath = project.path();
        if !ppath.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&ppath) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if stem.starts_with("agent-") {
                continue;
            }
            if let Some(s) = read_session(&path, stem) {
                out.push(s);
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    out.truncate(cap);
    out
}

fn read_session(path: &Path, stem: &str) -> Option<NativeSession> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let updated_at = meta.modified().ok().map(chrono::DateTime::<chrono::Utc>::from);
    let reader = BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    for (i, line) in reader.lines().enumerate() {
        if i > 200 || (cwd.is_some() && title.is_some()) {
            break;
        }
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                cwd = Some(c.to_string());
            }
        }
        if title.is_none() && v.get("type").and_then(Value::as_str) == Some("user") {
            if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let text = match v.pointer("/message/content") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .next()
                    .map(String::from),
                _ => None,
            };
            if let Some(t) = text {
                let t = t.trim();
                if !t.is_empty() && !t.starts_with('<') {
                    title = Some(truncate(t, 80));
                }
            }
        }
    }
    Some(NativeSession {
        provider: ProviderKind::Claude,
        native_id: stem.to_string(),
        cwd,
        title: title.clone(),
        updated_at,
        preview: title,
    })
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.replace('\n', " ");
    if s.chars().count() <= n {
        s
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_missing_dir_is_empty() {
        assert!(scan(Path::new("/definitely/not/here"), 10).is_empty());
    }

    #[test]
    fn scan_reads_cwd_and_title() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-Users-me-proj");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(
            proj.join("11111111-2222-3333-4444-555555555555.jsonl"),
            concat!(
                r#"{"type":"summary","summary":"x"}"#, "\n",
                r#"{"type":"user","cwd":"/Users/me/proj","message":{"role":"user","content":[{"type":"text","text":"Fix the login bug please"}]}}"#, "\n",
            ),
        )
        .unwrap();
        std::fs::write(proj.join("agent-abc.jsonl"), "{}\n").unwrap();
        let v = scan(tmp.path(), 10);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].native_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(v[0].cwd.as_deref(), Some("/Users/me/proj"));
        assert_eq!(v[0].title.as_deref(), Some("Fix the login bug please"));
    }
}
