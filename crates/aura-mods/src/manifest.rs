//! `mod.json`. Mirrors packages/mod-sdk/src/manifest.ts; keep the two in step.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The mod API major version this host implements.
pub const API_VERSION: u32 = 1;

/// Largest `mod.json`.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
/// Largest `daemon.js` or `ui.js`: far beyond any hand-written mod, small
/// enough that reading and parsing it stays quick.
pub const MAX_SCRIPT_BYTES: usize = 4 * 1024 * 1024;
/// Largest `ui.css`.
pub const MAX_STYLES_BYTES: usize = 1024 * 1024;

/// Read a file of a mod, at most `cap` bytes (one open, never more read).
pub fn read_mod_file(path: &Path, cap: usize) -> Result<String> {
    aura_core::themes::read_capped(path, cap).map_err(|e| anyhow::anyhow!(e))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionAccess {
    #[default]
    None,
    Read,
    Write,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Permissions {
    pub process: Vec<String>,
    pub net: Vec<String>,
    pub sessions: SessionAccess,
    pub git: bool,
    pub agents: bool,
    pub orchestrator_tools: bool,
    pub mods: Vec<String>,
}

impl Permissions {
    /// Whether these permissions grant nothing `approved` did not.
    pub fn within(&self, approved: &Permissions) -> bool {
        let rank = |s: &SessionAccess| match s {
            SessionAccess::None => 0,
            SessionAccess::Read => 1,
            SessionAccess::Write => 2,
        };
        self.process.iter().all(|p| approved.process.contains(p))
            && self.net.iter().all(|p| approved.net.contains(p))
            && self.mods.iter().all(|p| approved.mods.contains(p))
            && rank(&self.sessions) <= rank(&approved.sessions)
            && (!self.git || approved.git)
            && (!self.agents || approved.agents)
            && (!self.orchestrator_tools || approved.orchestrator_tools)
    }

    /// Whether `host` matches an entry of `net` ("*.example.com" matches subdomains).
    pub fn allows_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.net.iter().any(|pattern| {
            let pattern = pattern.to_ascii_lowercase();
            if pattern == "*" {
                true
            } else if let Some(suffix) = pattern.strip_prefix("*.") {
                host.ends_with(&format!(".{suffix}"))
            } else {
                host == pattern
            }
        })
    }

    pub fn reads_sessions(&self) -> bool {
        self.sessions != SessionAccess::None
    }

    pub fn writes_sessions(&self) -> bool {
        self.sessions == SessionAccess::Write
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub styles: Option<String>,
    #[serde(default)]
    pub depends_on: BTreeMap<String, String>,
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
    pub settings: Vec<Setting>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

/// A file the manifest names, which must stay inside the mod's folder.
pub fn entry_path(dir: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        bail!("{rel} must be a path inside the mod's folder");
    }
    Ok(dir.join(rel_path))
}

impl Manifest {
    pub fn load(dir: &Path) -> Result<Manifest> {
        let path = dir.join("mod.json");
        let text = read_mod_file(&path, MAX_MANIFEST_BYTES)?;
        let m: Manifest =
            serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
        m.validate(dir)?;
        Ok(m)
    }

    pub fn validate(&self, dir: &Path) -> Result<()> {
        if !valid_id(&self.id) {
            bail!(
                "mod id {:?} must be lowercase letters, digits and dashes",
                self.id
            );
        }
        if self.api_version != API_VERSION {
            bail!(
                "{} needs mod API {} but this Aura offers {API_VERSION}",
                self.id,
                self.api_version
            );
        }
        semver::Version::parse(&self.version)
            .with_context(|| format!("{}: version {:?} is not semver", self.id, self.version))?;
        for (dep, req) in &self.depends_on {
            if !valid_id(dep) {
                bail!("{}: dependency {dep:?} is not a mod id", self.id);
            }
            semver::VersionReq::parse(req).with_context(|| {
                format!(
                    "{}: dependency {dep} {req:?} is not a semver range",
                    self.id
                )
            })?;
        }
        for (what, entry, cap) in [
            ("daemon", &self.daemon, MAX_SCRIPT_BYTES),
            ("ui", &self.ui, MAX_SCRIPT_BYTES),
            ("styles", &self.styles, MAX_STYLES_BYTES),
        ] {
            if let Some(rel) = entry {
                let p = entry_path(dir, rel)?;
                if !p.is_file() {
                    bail!("{}: {what} file {} is missing", self.id, p.display());
                }
                let len = p.metadata().map(|m| m.len() as usize).unwrap_or(0);
                if len > cap {
                    bail!(
                        "{}: {rel} is {} KB; the limit is {} KB",
                        self.id,
                        len / 1024,
                        cap / 1024
                    );
                }
            }
        }
        if self.daemon.is_none() && self.ui.is_none() {
            bail!("{}: a mod needs a daemon or a ui entry", self.id);
        }
        Ok(())
    }

    /// The setting values with defaults filled in.
    pub fn settings_with(
        &self,
        stored: &serde_json::Map<String, serde_json::Value>,
    ) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for s in &self.settings {
            let v = stored
                .get(&s.key)
                .cloned()
                .or_else(|| s.default.clone())
                .unwrap_or(serde_json::Value::Null);
            out.insert(s.key.clone(), v);
        }
        // Values set by the mod itself for keys it did not declare are kept too.
        for (k, v) in stored {
            out.entry(k.clone()).or_insert_with(|| v.clone());
        }
        serde_json::Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(valid_id("github"));
        assert!(valid_id("pull-requests"));
        assert!(!valid_id("Pull"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(""));
        assert!(!valid_id("-x"));
    }

    #[test]
    fn hosts() {
        let p = Permissions {
            net: vec!["api.github.com".into(), "*.githubusercontent.com".into()],
            ..Default::default()
        };
        assert!(p.allows_host("api.github.com"));
        assert!(p.allows_host("API.github.com"));
        assert!(p.allows_host("raw.githubusercontent.com"));
        assert!(!p.allows_host("githubusercontent.com"));
        assert!(!p.allows_host("evil.com"));
        assert!(!p.allows_host("api.github.com.evil.com"));
    }

    #[test]
    fn growing_permissions_need_approval_again() {
        let approved = Permissions {
            process: vec!["gh".into()],
            sessions: SessionAccess::Read,
            ..Default::default()
        };
        let same = approved.clone();
        assert!(same.within(&approved));
        let more = Permissions {
            sessions: SessionAccess::Write,
            ..approved.clone()
        };
        assert!(!more.within(&approved));
        let other = Permissions {
            process: vec!["git".into()],
            ..approved.clone()
        };
        assert!(!other.within(&approved));
    }

    #[test]
    fn entries_stay_inside_the_mod() {
        let d = Path::new("/mods/x");
        assert!(entry_path(d, "dist/ui.js").is_ok());
        assert!(entry_path(d, "../y/ui.js").is_err());
        assert!(entry_path(d, "/etc/passwd").is_err());
    }
}
