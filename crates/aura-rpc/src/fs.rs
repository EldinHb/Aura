//! Small filesystem helpers exposed over RPC: directory listing for the cwd
//! picker, fuzzy file search for `@` mentions and the images agents show in
//! their messages.

use anyhow::{bail, Result};
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

/// Images larger than this are not shown in messages.
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// The image at `path` (absolute, or under `~/`) with its media type, for an
/// agent's message that shows it. Reads image files only: the type comes from
/// the file's first bytes, and anything else is refused unread past them.
pub fn read_image(path: &str) -> Result<(Vec<u8>, &'static str)> {
    let p = match path.strip_prefix("~/") {
        Some(rest) => match dirs::home_dir() {
            Some(home) => home.join(rest),
            None => bail!("no home folder"),
        },
        None => Path::new(path).to_path_buf(),
    };
    if !p.is_absolute() {
        bail!("not an absolute path: {path}");
    }
    let meta = std::fs::metadata(&p)?;
    if !meta.is_file() {
        bail!("not a file: {path}");
    }
    if meta.len() > MAX_IMAGE_BYTES {
        bail!("image over {} MB: {path}", MAX_IMAGE_BYTES / 1024 / 1024);
    }
    let mut head = [0u8; 512];
    let n = {
        use std::io::Read;
        let mut f = std::fs::File::open(&p)?;
        let mut n = 0;
        while n < head.len() {
            match f.read(&mut head[n..])? {
                0 => break,
                k => n += k,
            }
        }
        n
    };
    let svg = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("svg"));
    let Some(media_type) = image_type(&head[..n], svg) else {
        bail!("not an image: {path}");
    };
    Ok((std::fs::read(&p)?, media_type))
}

/// The media type of an image starting with `head`; SVG only for `.svg` files.
fn image_type(head: &[u8], svg: bool) -> Option<&'static str> {
    match head {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ if svg => {
            let text = String::from_utf8_lossy(head);
            let text = text.trim_start_matches('\u{feff}').trim_start();
            (text.starts_with("<svg") || (text.starts_with("<?xml") && text.contains("<svg")))
                .then_some("image/svg+xml")
        }
        _ => None,
    }
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

    #[test]
    fn reads_images_only() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("shot.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let (bytes, media_type) = read_image(png.to_str().unwrap()).unwrap();
        assert_eq!(media_type, "image/png");
        assert!(bytes.starts_with(b"\x89PNG"));

        // Named like an image, but not one.
        let fake = dir.path().join("secret.png");
        std::fs::write(&fake, b"password=hunter2").unwrap();
        assert!(read_image(fake.to_str().unwrap()).is_err());
        let svg = dir.path().join("d.svg");
        std::fs::write(
            &svg,
            b"<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        assert_eq!(
            read_image(svg.to_str().unwrap()).unwrap().1,
            "image/svg+xml"
        );
        let xml = dir.path().join("d.xml");
        std::fs::write(&xml, b"<svg/>").unwrap();
        assert!(read_image(xml.to_str().unwrap()).is_err());

        assert!(
            read_image("shot.png").is_err(),
            "relative paths are refused"
        );
        assert!(
            read_image(dir.path().to_str().unwrap()).is_err(),
            "folders are refused"
        );
    }
}
