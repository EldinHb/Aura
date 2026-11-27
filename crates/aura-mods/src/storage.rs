//! Mod storage on top of core's `feature_records` table.
//!
//! Every namespace a mod uses is prefixed with `mod:<id>:`, so mods cannot see
//! each other's data and a migration can move data by prefix:
//!
//! | API                          | namespace                  | record id  |
//! | ---------------------------- | -------------------------- | ---------- |
//! | `aura.storage.kv`            | `mod:<id>:kv`              | key        |
//! | `aura.storage.collection(n)` | `mod:<id>:c:<n>`           | doc id     |
//! | `aura.sessions.data(sid)`    | `mod:<id>:sessions`        | session id |
//! | settings                     | `mods:settings`            | mod id     |
//!
//! Namespaces are read once and then kept in memory; writes go to both.

use anyhow::Result;
use aura_core::Store;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

pub const SETTINGS_NS: &str = "mods:settings";
pub const STATE_KEY: &str = "mods.state.v1";

pub fn kv_ns(id: &str) -> String {
    format!("mod:{id}:kv")
}
pub fn collection_ns(id: &str, name: &str) -> String {
    format!("mod:{id}:c:{name}")
}
pub fn sessions_ns(id: &str) -> String {
    format!("mod:{id}:sessions")
}

pub struct Records {
    store: Arc<dyn Store>,
    cache: Mutex<HashMap<String, BTreeMap<String, Value>>>,
}

impl Records {
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self {
            store,
            cache: Mutex::default(),
        }
    }

    pub fn store(&self) -> &Arc<dyn Store> {
        &self.store
    }

    fn load(&self, ns: &str) -> Result<()> {
        if self.cache.lock().contains_key(ns) {
            return Ok(());
        }
        let mut docs = BTreeMap::new();
        for (id, json) in self.store.feature_records(ns)? {
            match serde_json::from_str(&json) {
                Ok(v) => {
                    docs.insert(id, v);
                }
                Err(e) => tracing::warn!("skipping unreadable record {ns}/{id}: {e}"),
            }
        }
        self.cache.lock().entry(ns.to_string()).or_insert(docs);
        Ok(())
    }

    pub fn get(&self, ns: &str, id: &str) -> Result<Option<Value>> {
        self.load(ns)?;
        Ok(self.cache.lock().get(ns).and_then(|d| d.get(id).cloned()))
    }

    pub fn all(&self, ns: &str) -> Result<Vec<(String, Value)>> {
        self.load(ns)?;
        Ok(self
            .cache
            .lock()
            .get(ns)
            .map(|d| d.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default())
    }

    pub fn put(&self, ns: &str, id: &str, value: &Value) -> Result<()> {
        self.load(ns)?;
        self.store.save_feature_record(ns, id, &value.to_string())?;
        self.cache
            .lock()
            .entry(ns.to_string())
            .or_default()
            .insert(id.to_string(), value.clone());
        Ok(())
    }

    pub fn delete(&self, ns: &str, id: &str) -> Result<()> {
        self.load(ns)?;
        self.store.delete_feature_record(ns, id)?;
        if let Some(d) = self.cache.lock().get_mut(ns) {
            d.remove(id);
        }
        Ok(())
    }

    pub fn clear(&self, ns: &str) -> Result<()> {
        for (id, _) in self.all(ns)? {
            self.delete(ns, &id)?;
        }
        Ok(())
    }

    /// One key of a document that is an object of keys (session data, settings).
    pub fn get_field(&self, ns: &str, id: &str, key: &str) -> Result<Option<Value>> {
        Ok(self
            .get(ns, id)?
            .and_then(|d| d.get(key).cloned())
            .filter(|v| !v.is_null()))
    }

    /// Set (or, with `None`, remove) one key of an object document. An emptied document is deleted.
    pub fn set_field(&self, ns: &str, id: &str, key: &str, value: Option<Value>) -> Result<()> {
        let mut doc = match self.get(ns, id)? {
            Some(Value::Object(m)) => m,
            _ => Map::new(),
        };
        match value {
            Some(v) => {
                doc.insert(key.to_string(), v);
            }
            None => {
                doc.remove(key);
            }
        }
        if doc.is_empty() {
            self.delete(ns, id)
        } else {
            self.put(ns, id, &Value::Object(doc))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caches_and_writes_through() {
        let store: Arc<dyn Store> = Arc::new(aura_core::MemoryStore::default());
        let r = Records::new(store.clone());
        r.put("mod:a:kv", "x", &json!(1)).unwrap();
        r.set_field("mod:a:sessions", "s1", "links", Some(json!(["u"])))
            .unwrap();
        // A fresh view of the same store sees what was written.
        let again = Records::new(store);
        assert_eq!(again.get("mod:a:kv", "x").unwrap(), Some(json!(1)));
        assert_eq!(
            again.get_field("mod:a:sessions", "s1", "links").unwrap(),
            Some(json!(["u"]))
        );
        again
            .set_field("mod:a:sessions", "s1", "links", None)
            .unwrap();
        assert!(
            again.all("mod:a:sessions").unwrap().is_empty(),
            "an emptied document is deleted"
        );
        again.clear("mod:a:kv").unwrap();
        assert_eq!(again.get("mod:a:kv", "x").unwrap(), None);
    }
}
