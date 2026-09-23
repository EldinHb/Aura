use aura_core::ReviewComment;
use std::collections::{BTreeMap, BTreeSet};
/// Diff positions keyed by canonical path and side; no guesses across ambiguous filenames.
pub fn positions(diff: &str) -> BTreeMap<String, (BTreeSet<u32>, BTreeSet<u32>)> {
    let re = regex::Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap();
    let mut files = BTreeMap::new();
    let mut path = String::new();
    let (mut old, mut new) = (0, 0);
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            in_hunk = false;
        }
        if let Some(p) = line.strip_prefix("+++ ") {
            if p != "/dev/null" {
                path = decode_path(p.strip_prefix("b/").unwrap_or(p));
            }
            files
                .entry(path.clone())
                .or_insert_with(|| (BTreeSet::new(), BTreeSet::new()));
        } else if let Some(p) = line.strip_prefix("--- ") {
            path = decode_path(p.strip_prefix("a/").unwrap_or(p));
        } else if let Some(c) = re.captures(line) {
            old = c[1].parse().unwrap_or(0);
            new = c[2].parse().unwrap_or(0);
            in_hunk = true;
        } else if in_hunk {
            let pair = files
                .entry(path.clone())
                .or_insert_with(|| (BTreeSet::new(), BTreeSet::new()));
            match line.as_bytes().first() {
                Some(b'+') => {
                    pair.1.insert(new);
                    new += 1;
                }
                Some(b'-') => {
                    pair.0.insert(old);
                    old += 1;
                }
                Some(b' ') => {
                    pair.0.insert(old);
                    pair.1.insert(new);
                    old += 1;
                    new += 1;
                }
                Some(b'\\') => {}
                _ => in_hunk = false,
            }
        }
    }
    files
}
fn decode_path(s: &str) -> String {
    if s.starts_with('"') {
        serde_json::from_str::<String>(s)
            .unwrap_or_else(|_| s.into())
            .trim_start_matches("a/")
            .trim_start_matches("b/")
            .to_string()
    } else {
        s.into()
    }
}
pub fn validate(comments: &mut [ReviewComment], diff: &str, relocate: bool) {
    let files = positions(diff);
    for c in comments {
        c.valid = false;
        let path = c.path.trim_start_matches("./");
        let matches: Vec<_> = files
            .keys()
            .filter(|p| p.as_str() == path || p.ends_with(&format!("/{path}")))
            .collect();
        let path = if files.contains_key(path) {
            Some(path.to_string())
        } else if matches.len() == 1 {
            Some(matches[0].clone())
        } else {
            None
        };
        let Some(path) = path else {
            c.position_note =
                Some("No unambiguous file in this diff; included in the review body.".into());
            continue;
        };
        c.path = path.clone();
        let pair = &files[&path];
        let allowed = if c.side == "LEFT" { &pair.0 } else { &pair.1 };
        if !allowed.contains(&c.line) && relocate {
            if let Some(line) = allowed
                .iter()
                .min_by_key(|n| n.abs_diff(c.line))
                .filter(|n| n.abs_diff(c.line) <= 3)
            {
                c.position_note = Some(format!(
                    "Moved from line {} to {line}; verify this location.",
                    c.line
                ));
                c.line = *line;
                c.start_line = None;
            }
        }
        c.valid = allowed.contains(&c.line) && matches!(c.side.as_str(), "LEFT" | "RIGHT");
        if c.start_line
            .is_some_and(|start| start >= c.line || !(start..=c.line).all(|n| allowed.contains(&n)))
        {
            c.valid = false;
        }
        if !c.valid {
            c.position_note =
                Some("Outside the reviewed diff; included in the review body.".into());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    const DIFF: &str = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n same\n-old\n+new\n";
    #[test]
    fn maps_both_sides() {
        let p = positions(DIFF);
        assert!(p["x"].0.contains(&4));
        assert!(p["x"].1.contains(&4));
        assert!(!p["x"].1.contains(&5));
    }
    #[test]
    fn edited_invalid_positions_are_not_relocated() {
        let mut c = vec![ReviewComment {
            path: "x".into(),
            line: 5,
            side: "RIGHT".into(),
            ..Default::default()
        }];
        validate(&mut c, DIFF, false);
        assert!(!c[0].valid);
        validate(&mut c, DIFF, true);
        assert_eq!(c[0].line, 4);
        assert!(c[0].valid);
    }
}
