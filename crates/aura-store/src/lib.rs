//! SQLite persistence for Aura (sessions, event log, FTS search, settings, scrollback).

use anyhow::{Context, Result};
use aura_core::{Event, ItemKind, SearchHit, Session, Store, StoredEvent};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(pinned DESC, last_activity DESC);

    CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        item_id UNINDEXED,
        ts UNINDEXED,
        text
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scrollback (
        session_id TEXT PRIMARY KEY,
        data BLOB NOT NULL,
        updated_at TEXT NOT NULL
    );
    "#,
    // v2: independent records prevent inbox retirement from deleting review history.
    r#"CREATE TABLE IF NOT EXISTS feature_records (
        namespace TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(namespace, id)
    );"#,
];

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open sqlite {}", path.display()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Self { conn: Mutex::new(conn) };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate() {
            let target = i as i64 + 1;
            if version >= target {
                continue;
            }
            conn.execute_batch(sql).with_context(|| format!("migration v{target}"))?;
            conn.pragma_update(None, "user_version", target)?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self.conn.lock().pragma_query_value(None, "user_version", |r| r.get(0))?)
    }
}

fn event_kind(event: &Event) -> String {
    serde_json::to_value(event)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

/// Turn free text into a safe FTS5 MATCH expression: every whitespace token is
/// quoted so punctuation cannot be parsed as operators.
fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    s.parse::<DateTime<Utc>>().unwrap_or_else(|_| Utc::now())
}

impl Store for SqliteStore {
    fn feature_records(&self, namespace: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id, json FROM feature_records WHERE namespace = ? ORDER BY id")?;
        let rows = stmt.query_map([namespace], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    fn save_feature_record(&self, namespace: &str, id: &str, value: &str) -> Result<()> {
        self.conn.lock().execute("INSERT INTO feature_records(namespace,id,json) VALUES (?1,?2,?3) ON CONFLICT(namespace,id) DO UPDATE SET json=excluded.json", params![namespace,id,value])?;
        Ok(())
    }
    fn delete_feature_record(&self, namespace: &str, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM feature_records WHERE namespace = ?1 AND id = ?2", params![namespace, id])?;
        Ok(())
    }
    fn upsert_session(&self, session: &Session) -> Result<()> {
        let json = serde_json::to_string(session)?;
        self.conn.lock().execute(
            "INSERT INTO sessions (id, provider, archived, pinned, created_at, last_activity, json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, archived=excluded.archived,
               pinned=excluded.pinned, created_at=excluded.created_at,
               last_activity=excluded.last_activity, json=excluded.json",
            params![
                session.id,
                session.provider.as_str(),
                session.archived as i64,
                session.pinned as i64,
                session.created_at.to_rfc3339(),
                session.last_activity.to_rfc3339(),
                json
            ],
        )?;
        Ok(())
    }

    fn delete_session(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM events WHERE session_id = ?1", params![id])?;
        tx.execute("DELETE FROM messages_fts WHERE session_id = ?1", params![id])?;
        tx.execute("DELETE FROM scrollback WHERE session_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    fn list_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json FROM sessions ORDER BY pinned DESC, last_activity DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let json = row?;
            match serde_json::from_str::<Session>(&json) {
                Ok(s) => out.push(s),
                Err(e) => tracing::warn!("skipping unreadable session row: {e}"),
            }
        }
        Ok(out)
    }

    fn append_event(&self, session_id: &str, event: &Event) -> Result<u64> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let ts = Utc::now();
        tx.execute(
            "INSERT INTO events (session_id, seq, ts, kind, json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, seq, ts.to_rfc3339(), event_kind(event), serde_json::to_string(event)?],
        )?;
        if let Event::ItemCompleted { item, .. } = event {
            if matches!(item.kind, ItemKind::UserMessage | ItemKind::AgentMessage) && !item.text.trim().is_empty() {
                tx.execute(
                    "INSERT INTO messages_fts (session_id, item_id, ts, text) VALUES (?1, ?2, ?3, ?4)",
                    params![session_id, item.id, ts.to_rfc3339(), item.text],
                )?;
            }
        }
        tx.commit()?;
        Ok(seq as u64)
    }

    fn events(&self, session_id: &str, after_seq: u64, limit: usize) -> Result<Vec<StoredEvent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, json FROM events WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after_seq as i64, limit as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, json) = row?;
            match serde_json::from_str::<Event>(&json) {
                Ok(event) => out.push(StoredEvent { seq: seq as u64, ts: parse_ts(&ts), event }),
                Err(e) => tracing::warn!("skipping unreadable event {session_id}/{seq}: {e}"),
            }
        }
        Ok(out)
    }

    fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let q = fts_query(query);
        if q.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock();
        let map = |r: &rusqlite::Row| {
            Ok(SearchHit {
                session_id: r.get::<_, String>(0)?,
                item_id: r.get::<_, Option<String>>(1)?,
                snippet: r.get::<_, String>(2)?,
                ts: parse_ts(&r.get::<_, String>(3)?),
            })
        };
        let fts = conn
            .prepare(
                "SELECT session_id, item_id, snippet(messages_fts, 3, '', '', '…', 24), ts
                 FROM messages_fts WHERE messages_fts MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .and_then(|mut stmt| {
                let hits = stmt.query_map(params![q, limit as i64], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(hits)
            });
        match fts {
            Ok(hits) => Ok(hits),
            Err(e) => {
                tracing::debug!("fts query failed ({e}); falling back to LIKE");
                let like = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
                let mut stmt = conn.prepare(
                    "SELECT session_id, item_id, substr(text, 1, 200), ts FROM messages_fts
                     WHERE text LIKE ?1 ESCAPE '\\' LIMIT ?2",
                )?;
                let hits = stmt.query_map(params![like, limit as i64], map)?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(hits)
            }
        }
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn save_scrollback(&self, session_id: &str, data: &[u8]) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO scrollback (session_id, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            params![session_id, data, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    fn load_scrollback(&self, session_id: &str) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .lock()
            .query_row("SELECT data FROM scrollback WHERE session_id = ?1", params![session_id], |r| r.get(0))
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_core::{CreateSessionOpts, Item, ItemKind, ProviderKind, Turn, TurnStatus};

    fn session(cwd: &str) -> Session {
        Session::new(&CreateSessionOpts { provider: ProviderKind::Terminal, cwd: cwd.into(), ..Default::default() })
    }

    fn msg(session_id: &str, kind: ItemKind, text: &str) -> Event {
        Event::ItemCompleted {
            session_id: session_id.into(),
            item: Item::new(session_id, None, kind).with_text(text).completed(),
        }
    }

    #[test]
    fn fts5_is_available() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.conn.lock().execute_batch("CREATE VIRTUAL TABLE t USING fts5(x);").unwrap();
    }

    #[test]
    fn session_roundtrip() {
        let s = SqliteStore::open_in_memory().unwrap();
        let mut a = session("/tmp/a");
        let mut b = session("/tmp/b");
        b.pinned = true;
        s.upsert_session(&a).unwrap();
        s.upsert_session(&b).unwrap();
        let list = s.list_sessions().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, b.id, "pinned first");
        a.title = "renamed".into();
        s.upsert_session(&a).unwrap();
        let list = s.list_sessions().unwrap();
        assert_eq!(list.iter().find(|x| x.id == a.id).unwrap().title, "renamed");
        s.delete_session(&a.id).unwrap();
        assert_eq!(s.list_sessions().unwrap().len(), 1);
    }

    #[test]
    fn event_seq_per_session() {
        let s = SqliteStore::open_in_memory().unwrap();
        let turn = |sid: &str| Event::TurnStarted {
            session_id: sid.into(),
            turn: Turn {
                id: "t".into(),
                session_id: sid.into(),
                status: TurnStatus::Running,
                started_at: Utc::now(),
                ended_at: None,
                usage: None,
                error: None,
            },
        };
        assert_eq!(s.append_event("a", &turn("a")).unwrap(), 1);
        assert_eq!(s.append_event("a", &turn("a")).unwrap(), 2);
        assert_eq!(s.append_event("b", &turn("b")).unwrap(), 1);
        assert_eq!(s.append_event("a", &turn("a")).unwrap(), 3);
        let evs = s.events("a", 1, 10).unwrap();
        assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![2, 3]);
        let evs = s.events("a", 0, 2).unwrap();
        assert_eq!(evs.len(), 2);
        assert!(matches!(evs[0].event, Event::TurnStarted { .. }));
        s.delete_session("a").unwrap();
        assert!(s.events("a", 0, 10).unwrap().is_empty());
    }

    #[test]
    fn fts_search() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.append_event("s1", &msg("s1", ItemKind::AgentMessage, "The quick brown fox fixed auth.py today.")).unwrap();
        s.append_event("s1", &msg("s1", ItemKind::Reasoning, "brown reasoning should not index")).unwrap();
        s.append_event("s2", &msg("s2", ItemKind::UserMessage, "Please run cargo test -- --nocapture")).unwrap();
        let hits = s.search("brown", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "s1");
        assert!(hits[0].item_id.is_some());
        assert!(hits[0].snippet.contains("brown"));
        let hits = s.search("cargo test -- --nocapture", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "s2");
        let hits = s.search("auth.py", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(s.search("zebra", 10).unwrap().is_empty());
        assert!(s.search("   ", 10).unwrap().is_empty());
    }

    #[test]
    fn settings_and_scrollback() {
        let s = SqliteStore::open_in_memory().unwrap();
        assert_eq!(s.get_setting("k").unwrap(), None);
        s.set_setting("k", "v1").unwrap();
        s.set_setting("k", "v2").unwrap();
        assert_eq!(s.get_setting("k").unwrap(), Some("v2".into()));
        assert_eq!(s.load_scrollback("x").unwrap(), None);
        s.save_scrollback("x", b"abc").unwrap();
        s.save_scrollback("x", b"abcdef").unwrap();
        assert_eq!(s.load_scrollback("x").unwrap(), Some(b"abcdef".to_vec()));
        s.delete_session("x").unwrap();
        assert_eq!(s.load_scrollback("x").unwrap(), None);
    }

    #[test]
    fn feature_records_can_be_deleted() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.save_feature_record("groups", "a", "1").unwrap();
        s.save_feature_record("groups", "b", "2").unwrap();
        s.save_feature_record("other", "a", "3").unwrap();
        s.delete_feature_record("groups", "a").unwrap();
        assert_eq!(s.feature_records("groups").unwrap(), vec![("b".to_string(), "2".to_string())]);
        assert_eq!(s.feature_records("other").unwrap().len(), 1);
    }

    #[test]
    fn file_backed_persists_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("aura.db");
        let id;
        {
            let s = SqliteStore::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
            let sess = session("/tmp/p");
            id = sess.id.clone();
            s.upsert_session(&sess).unwrap();
            s.set_setting("theme", "dark").unwrap();
            s.append_event(&id, &msg(&id, ItemKind::AgentMessage, "persist me")).unwrap();
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(s.list_sessions().unwrap()[0].id, id);
        assert_eq!(s.get_setting("theme").unwrap(), Some("dark".into()));
        assert_eq!(s.events(&id, 0, 10).unwrap().len(), 1);
        assert_eq!(s.search("persist", 5).unwrap().len(), 1);
    }
}
