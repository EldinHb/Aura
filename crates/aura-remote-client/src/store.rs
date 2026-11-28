//! What the desktop keeps about the computers it paired with: their addresses
//! and pinned fingerprints in a JSON file (no secrets), and each device token
//! in the OS keychain, never in a file.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A paired computer. `id` is its `serverId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: String,
    /// The user's own name for it; None shows `server_name`.
    #[serde(default)]
    pub label: Option<String>,
    /// The name the computer gave itself when paired.
    pub server_name: String,
    pub host: String,
    /// The other addresses from the pairing link, tried after `host`.
    #[serde(default)]
    pub alt: Vec<String>,
    pub port: u16,
    pub fingerprint: String,
    pub device_id: String,
    /// RFC 3339.
    pub paired_at: String,
}

impl RemoteEntry {
    pub fn name(&self) -> &str {
        self.label.as_deref().unwrap_or(&self.server_name)
    }

    /// `host`, then each `alt`, without repeats.
    pub fn addresses(&self) -> Vec<String> {
        let mut out = vec![self.host.clone()];
        for a in &self.alt {
            if !out.contains(a) {
                out.push(a.clone());
            }
        }
        out
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    remotes: Vec<RemoteEntry>,
}

/// The paired computers, in the order they were added, kept in `path`.
pub struct Registry {
    path: PathBuf,
    entries: Vec<RemoteEntry>,
}

impl Registry {
    /// Load `path`; a missing file is an empty list. A file that does not
    /// parse is kept aside (`.bad`) rather than overwritten unread.
    pub fn load(path: &Path) -> Result<Self> {
        let entries = match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<File>(&bytes) {
                Ok(f) => f.remotes,
                Err(e) => {
                    let bad = path.with_extension("json.bad");
                    tracing::warn!(
                        "{} does not parse ({e}); moved to {}",
                        path.display(),
                        bad.display()
                    );
                    let _ = std::fs::rename(path, &bad);
                    vec![]
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        Ok(Self {
            path: path.to_path_buf(),
            entries,
        })
    }

    pub fn entries(&self) -> &[RemoteEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&RemoteEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Add `entry`, or replace the one with its id (keeping the user's label).
    pub fn upsert(&mut self, mut entry: RemoteEntry) -> Result<RemoteEntry> {
        if let Some(old) = self.entries.iter_mut().find(|e| e.id == entry.id) {
            if entry.label.is_none() {
                entry.label = old.label.clone();
            }
            *old = entry.clone();
        } else {
            self.entries.push(entry.clone());
        }
        self.save()?;
        Ok(entry)
    }

    pub fn set_label(&mut self, id: &str, label: Option<String>) -> Result<RemoteEntry> {
        let e = self
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .with_context(|| format!("no remote computer {id}"))?;
        e.label = label;
        let e = e.clone();
        self.save()?;
        Ok(e)
    }

    /// Forget `id`; false when it was not there.
    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        if self.entries.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    /// Written to a temporary file and renamed over, 0600.
    fn save(&self) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let bytes = serde_json::to_vec_pretty(&File {
            remotes: self.entries.clone(),
        })?;
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut f = opts
                .open(&tmp)
                .with_context(|| format!("writing {}", tmp.display()))?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)
            .with_context(|| format!("writing {}", self.path.display()))?;
        Ok(())
    }
}

/// Where device tokens are kept, by remote id.
pub trait Secrets: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>>;
    fn set(&self, id: &str, token: &str) -> Result<()>;
    /// Removing one that is not there is fine.
    fn delete(&self, id: &str) -> Result<()>;
}

/// The OS keychain: one generic password per remote, service `service`,
/// account the remote's id.
pub struct KeyringSecrets {
    service: String,
}

impl KeyringSecrets {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, id).context("opening the keychain")
    }
}

impl Secrets for KeyringSecrets {
    fn get(&self, id: &str) -> Result<Option<String>> {
        match self.entry(id)?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("reading the device token from the keychain"),
        }
    }

    fn set(&self, id: &str, token: &str) -> Result<()> {
        self.entry(id)?
            .set_password(token)
            .context("saving the device token in the keychain")
    }

    fn delete(&self, id: &str) -> Result<()> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("removing the device token from the keychain"),
        }
    }
}

/// In memory, for tests.
#[derive(Default)]
pub struct MemorySecrets(parking_lot::Mutex<HashMap<String, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, id: &str) -> Result<Option<String>> {
        Ok(self.0.lock().get(id).cloned())
    }
    fn set(&self, id: &str, token: &str) -> Result<()> {
        self.0.lock().insert(id.to_string(), token.to_string());
        Ok(())
    }
    fn delete(&self, id: &str) -> Result<()> {
        self.0.lock().remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> RemoteEntry {
        RemoteEntry {
            id: id.into(),
            label: None,
            server_name: "Studio".into(),
            host: "10.0.0.2".into(),
            alt: vec!["100.64.0.2".into(), "10.0.0.2".into()],
            port: 7443,
            fingerprint: "ab".repeat(32),
            device_id: "dev".into(),
            paired_at: "2026-11-28T10:00:00Z".into(),
        }
    }

    #[test]
    fn entries_survive_a_reload_and_keep_their_label_on_re_pairing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remotes.json");
        let mut r = Registry::load(&path).unwrap();
        assert!(r.entries().is_empty());
        r.upsert(entry("a")).unwrap();
        r.set_label("a", Some("Home server".into())).unwrap();
        // Re-pairing replaces the entry and keeps the user's name for it.
        let mut again = entry("a");
        again.fingerprint = "cd".repeat(32);
        r.upsert(again).unwrap();
        let r = Registry::load(&path).unwrap();
        assert_eq!(r.entries().len(), 1);
        assert_eq!(r.get("a").unwrap().name(), "Home server");
        assert_eq!(r.get("a").unwrap().fingerprint, "cd".repeat(32));
        assert_eq!(
            r.get("a").unwrap().addresses(),
            vec!["10.0.0.2".to_string(), "100.64.0.2".to_string()]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No token in the file.
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("token"), "{text}");
    }

    #[test]
    fn remove_and_a_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remotes.json");
        let mut r = Registry::load(&path).unwrap();
        r.upsert(entry("a")).unwrap();
        assert!(r.remove("a").unwrap());
        assert!(!r.remove("a").unwrap());
        std::fs::write(&path, "{nope").unwrap();
        let r = Registry::load(&path).unwrap();
        assert!(r.entries().is_empty());
        assert!(path.with_extension("json.bad").exists());
    }
}
