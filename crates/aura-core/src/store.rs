use crate::event::Event;
use crate::schedule::{ScheduledRun, ScheduledTask};
use crate::types::*;
use crate::usage::UsageRecord;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SearchHit {
    pub session_id: SessionId,
    pub item_id: Option<String>,
    pub snippet: String,
    pub ts: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StoredEvent {
    pub seq: u64,
    pub ts: chrono::DateTime<chrono::Utc>,
    pub event: Event,
}

const SCHEDULED_TASKS: &str = "scheduled_tasks";
const USAGE_RECORDS: &str = "usage_records";
const SCHEDULED_RUNS: &str = "scheduled_runs";

/// Persistence boundary. Implemented by `aura-store` with SQLite; an in-memory
/// implementation lives here for tests.
pub trait Store: Send + Sync {
    /// Namespaced persistent feature documents. Default implementation supports in-memory stores.
    fn feature_records(&self, namespace: &str) -> Result<Vec<(String, String)>> {
        Ok(serde_json::from_str(
            &self
                .get_setting(&format!("feature:{namespace}"))?
                .unwrap_or_else(|| "[]".into()),
        )?)
    }
    fn save_feature_record(&self, namespace: &str, id: &str, value: &str) -> Result<()> {
        let mut records = self.feature_records(namespace)?;
        records.retain(|(key, _)| key != id);
        records.push((id.into(), value.into()));
        self.set_setting(
            &format!("feature:{namespace}"),
            &serde_json::to_string(&records)?,
        )
    }
    fn delete_feature_record(&self, namespace: &str, id: &str) -> Result<()> {
        let mut records = self.feature_records(namespace)?;
        records.retain(|(key, _)| key != id);
        self.set_setting(
            &format!("feature:{namespace}"),
            &serde_json::to_string(&records)?,
        )
    }
    /// Every scheduled task (see [`crate::schedule`]).
    fn scheduled_tasks(&self) -> Result<Vec<ScheduledTask>> {
        self.feature_records(SCHEDULED_TASKS)?
            .into_iter()
            .map(|(_, json)| Ok(serde_json::from_str(&json)?))
            .collect()
    }
    fn save_scheduled_task(&self, task: &ScheduledTask) -> Result<()> {
        self.save_feature_record(SCHEDULED_TASKS, &task.id, &serde_json::to_string(task)?)
    }
    /// Delete a task and its history.
    fn delete_scheduled_task(&self, id: &str) -> Result<()> {
        let runs = format!("{SCHEDULED_RUNS}:{id}");
        for (key, _) in self.feature_records(&runs)? {
            self.delete_feature_record(&runs, &key)?;
        }
        self.delete_feature_record(SCHEDULED_TASKS, id)
    }
    /// A task's history, latest first, at most `limit` entries.
    fn scheduled_runs(&self, task_id: &str, limit: usize) -> Result<Vec<ScheduledRun>> {
        let mut runs: Vec<ScheduledRun> = self
            .feature_records(&format!("{SCHEDULED_RUNS}:{task_id}"))?
            .into_iter()
            .map(|(_, json)| serde_json::from_str(&json))
            .collect::<Result<_, _>>()?;
        runs.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
        runs.truncate(limit);
        Ok(runs)
    }
    /// Add an entry to a task's history and keep only its latest `keep`.
    fn add_scheduled_run(&self, run: &ScheduledRun, keep: usize) -> Result<()> {
        let ns = format!("{SCHEDULED_RUNS}:{}", run.task_id);
        self.save_feature_record(&ns, &run.id, &serde_json::to_string(run)?)?;
        let all = self.scheduled_runs(&run.task_id, usize::MAX)?;
        for old in all.iter().skip(keep) {
            self.delete_feature_record(&ns, &old.id)?;
        }
        Ok(())
    }
    /// Delete these entries of a task's history.
    fn delete_scheduled_runs(&self, task_id: &str, ids: &[String]) -> Result<()> {
        let ns = format!("{SCHEDULED_RUNS}:{task_id}");
        for id in ids {
            self.delete_feature_record(&ns, id)?;
        }
        Ok(())
    }
    /// Keep what a turn spent (see [`crate::usage`]); a record for the same
    /// session and turn replaces the earlier one. Kept when the session is deleted.
    fn add_usage_record(&self, record: &UsageRecord) -> Result<()> {
        self.save_feature_record(
            USAGE_RECORDS,
            &format!("{}:{}", record.session_id, record.turn_id),
            &serde_json::to_string(record)?,
        )
    }
    /// The records of turns that ended in `[from, to)`, oldest first. With
    /// `sessions`, only those sessions'.
    fn usage_records(
        &self,
        from: Option<DateTime<Utc>>,
        to: Option<DateTime<Utc>>,
        sessions: Option<&[String]>,
    ) -> Result<Vec<UsageRecord>> {
        let mut out: Vec<UsageRecord> = self
            .feature_records(USAGE_RECORDS)?
            .into_iter()
            .filter_map(|(_, json)| serde_json::from_str::<UsageRecord>(&json).ok())
            .filter(|r| from.is_none_or(|f| r.at >= f) && to.is_none_or(|t| r.at < t))
            .filter(|r| sessions.is_none_or(|s| s.contains(&r.session_id)))
            .collect();
        out.sort_by(|a, b| a.at.cmp(&b.at).then(a.turn_id.cmp(&b.turn_id)));
        Ok(out)
    }
    fn upsert_session(&self, session: &Session) -> Result<()>;
    fn delete_session(&self, id: &str) -> Result<()>;
    fn list_sessions(&self) -> Result<Vec<Session>>;
    fn append_event(&self, session_id: &str, event: &Event) -> Result<u64>;
    fn events(&self, session_id: &str, after_seq: u64, limit: usize) -> Result<Vec<StoredEvent>>;
    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>>;
    fn get_setting(&self, key: &str) -> Result<Option<String>>;
    fn set_setting(&self, key: &str, value: &str) -> Result<()>;
    fn save_scrollback(&self, session_id: &str, data: &[u8]) -> Result<()>;
    fn load_scrollback(&self, session_id: &str) -> Result<Option<Vec<u8>>>;
}

/// In-memory store for tests and ephemeral runs.
#[derive(Default)]
pub struct MemoryStore {
    inner: parking_lot::Mutex<MemInner>,
}

#[derive(Default)]
struct MemInner {
    sessions: std::collections::BTreeMap<String, Session>,
    events: std::collections::HashMap<String, Vec<StoredEvent>>,
    settings: std::collections::HashMap<String, String>,
    features: std::collections::HashMap<String, std::collections::BTreeMap<String, String>>,
    scrollback: std::collections::HashMap<String, Vec<u8>>,
}

impl Store for MemoryStore {
    fn feature_records(&self, namespace: &str) -> Result<Vec<(String, String)>> {
        Ok(self
            .inner
            .lock()
            .features
            .get(namespace)
            .map(|records| {
                records
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default())
    }
    fn save_feature_record(&self, namespace: &str, id: &str, value: &str) -> Result<()> {
        self.inner
            .lock()
            .features
            .entry(namespace.into())
            .or_default()
            .insert(id.into(), value.into());
        Ok(())
    }
    fn delete_feature_record(&self, namespace: &str, id: &str) -> Result<()> {
        if let Some(records) = self.inner.lock().features.get_mut(namespace) {
            records.remove(id);
        }
        Ok(())
    }
    fn upsert_session(&self, session: &Session) -> Result<()> {
        self.inner
            .lock()
            .sessions
            .insert(session.id.clone(), session.clone());
        Ok(())
    }
    fn delete_session(&self, id: &str) -> Result<()> {
        let mut g = self.inner.lock();
        g.sessions.remove(id);
        g.events.remove(id);
        g.scrollback.remove(id);
        Ok(())
    }
    fn list_sessions(&self) -> Result<Vec<Session>> {
        Ok(self.inner.lock().sessions.values().cloned().collect())
    }
    fn append_event(&self, session_id: &str, event: &Event) -> Result<u64> {
        let mut g = self.inner.lock();
        let v = g.events.entry(session_id.to_string()).or_default();
        let seq = v.len() as u64 + 1;
        v.push(StoredEvent {
            seq,
            ts: crate::now(),
            event: event.clone(),
        });
        Ok(seq)
    }
    fn events(&self, session_id: &str, after_seq: u64, limit: usize) -> Result<Vec<StoredEvent>> {
        Ok(self
            .inner
            .lock()
            .events
            .get(session_id)
            .map(|v| {
                v.iter()
                    .filter(|e| e.seq > after_seq)
                    .take(limit)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default())
    }
    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let q = query.to_lowercase();
        let g = self.inner.lock();
        let mut hits = vec![];
        for (sid, evs) in &g.events {
            for e in evs {
                if let Event::ItemCompleted { item, .. } = &e.event {
                    if item.text.to_lowercase().contains(&q) {
                        hits.push(SearchHit {
                            session_id: sid.clone(),
                            item_id: Some(item.id.clone()),
                            snippet: item.text.chars().take(200).collect(),
                            ts: e.ts,
                        });
                        if hits.len() >= limit {
                            return Ok(hits);
                        }
                    }
                }
            }
        }
        Ok(hits)
    }
    fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self.inner.lock().settings.get(key).cloned())
    }
    fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.inner
            .lock()
            .settings
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn save_scrollback(&self, session_id: &str, data: &[u8]) -> Result<()> {
        self.inner
            .lock()
            .scrollback
            .insert(session_id.to_string(), data.to_vec());
        Ok(())
    }
    fn load_scrollback(&self, session_id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.inner.lock().scrollback.get(session_id).cloned())
    }
}
