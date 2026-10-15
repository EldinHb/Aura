//! Small filesystem helpers exposed over RPC: directory listing for the cwd
//! picker and fuzzy file search for `@` mentions.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_git_repo: bool,
}

pub fn list_dir(path: &str, show_hidden: bool) -> Result<Vec<DirEntry>> {
    let p = if path.is_empty() || path == "~" {
        dirs::home_dir().unwrap_or_else(|| Path::new("/").to_path_buf())
    } else if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| Path::new("/").to_path_buf())
            .join(rest)
    } else {
        Path::new(path).to_path_buf()
    };
    let mut out = vec![];
    for entry in std::fs::read_dir(&p)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let full = entry.path();
        let is_dir = meta.is_dir();
        out.push(DirEntry {
            name,
            path: full.to_string_lossy().to_string(),
            is_dir,
            is_git_repo: is_dir && full.join(".git").exists(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Fuzzy file search honouring .gitignore. Scores subsequence matches, prefers
/// matches in the file name and shorter paths.
pub fn search_files(cwd: &str, query: &str, limit: usize) -> Result<Vec<String>> {
    let q: Vec<char> = query
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let mut scored: Vec<(i64, String)> = vec![];
    let walker = ignore::WalkBuilder::new(cwd)
        .hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .max_depth(Some(12))
        .build();
    let root = Path::new(cwd);
    for entry in walker.flatten().take(50_000) {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if let Some(score) = fuzzy_score(&rel, &q) {
            scored.push((score, rel));
        }
    }
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.len().cmp(&b.1.len()))
            .then(a.1.cmp(&b.1))
    });
    Ok(scored.into_iter().take(limit).map(|(_, p)| p).collect())
}

fn fuzzy_score(path: &str, q: &[char]) -> Option<i64> {
    if q.is_empty() {
        return Some(-(path.len() as i64));
    }
    let lower: Vec<char> = path.to_lowercase().chars().collect();
    let name_start = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let mut score: i64 = 0;
    let mut qi = 0;
    let mut last: Option<usize> = None;
    for (i, c) in lower.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            score += 10;
            if i >= name_start {
                score += 15;
            }
            if let Some(l) = last {
                if l + 1 == i {
                    score += 20;
                }
            }
            if i == 0 || matches!(lower[i - 1], '/' | '_' | '-' | '.') {
                score += 12;
            }
            last = Some(i);
            qi += 1;
        }
    }
    if qi < q.len() {
        return None;
    }
    Some(score - path.len() as i64 / 4)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fuzzy_prefers_filename_and_contiguous() {
        let q: Vec<char> = "mgr".chars().collect();
        let a = fuzzy_score("src/manager.rs", &q).unwrap();
        let b = fuzzy_score("m/g/r/other.txt", &q).unwrap();
        assert!(a > b);
        assert!(fuzzy_score("nothing.txt", &q).is_none());
    }
}
