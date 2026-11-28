//! SQLite persistence for Aura (sessions, event log, FTS search, settings, scrollback).

use anyhow::{Context, Result};
use aura_core::{
    Event, ItemKind, ScheduledRun, ScheduledTask, SearchHit, Session, Store, StoredEvent,
    UsageRecord,
};
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
    // v3: scheduled tasks and their run history.
    r#"
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        at TEXT NOT NULL,
        json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_runs_task ON scheduled_runs(task_id, at DESC);
    "#,
    // v4: tasks say what their session runs as (tasks from before ran plain
    // sessions), and sessions say which task started them. Sessions started
    // before that are found through the run history that links to them.
    r#"
    UPDATE scheduled_tasks SET json = json_set(json, '$.run_as', 'session')
    WHERE json_valid(json) AND json_extract(json, '$.run_as') IS NULL;
    UPDATE sessions
    SET json = json_set(sessions.json, '$.scheduled_task_id', started.task_id, '$.scheduled_task_name', started.name)
    FROM (
        SELECT json_extract(r.json, '$.session_id') AS session_id, r.task_id AS task_id,
               json_extract(t.json, '$.name') AS name
        FROM scheduled_runs r JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE json_valid(r.json) AND json_valid(t.json)
          AND json_extract(r.json, '$.result') = 'started'
          AND json_extract(r.json, '$.session_id') IS NOT NULL
        GROUP BY session_id
    ) AS started
    WHERE sessions.id = started.session_id AND json_valid(sessions.json)
      AND json_extract(sessions.json, '$.scheduled_task_id') IS NULL;
    "#,
    // v5: GitHub, pull requests and reviews moved out of core into the bundled
    // `github` and `pull-requests` mods. Their data is copied into the mods'
    // namespaces (see crates/aura-mods/src/storage.rs); the old rows stay, so
    // an older Aura still finds them.
    r#"
    INSERT OR IGNORE INTO feature_records (namespace, id, json)
    SELECT 'mod:pull-requests:c:' || namespace, id, json FROM feature_records
    WHERE namespace IN ('reviews', 'pr-watches', 'pr-follows', 'pr-follow-pending')
       OR namespace LIKE 'hidden:%' OR namespace LIKE 'details:%' OR namespace LIKE 'pull-changes:%';

    INSERT OR IGNORE INTO feature_records (namespace, id, json)
    SELECT 'mod:pull-requests:kv', key, CASE WHEN json_valid(value) THEN value ELSE json_quote(value) END
    FROM settings WHERE key = 'reviews.inbox' OR key LIKE 'pulls.snapshots.v1.%';

    -- A session's issue and PR links, detected links and PRs it worked on.
    INSERT OR IGNORE INTO feature_records (namespace, id, json)
    SELECT 'mod:github:sessions', s.id, '{}' FROM sessions s
    WHERE EXISTS (SELECT 1 FROM settings WHERE key IN ('session.links.v1.' || s.id, 'session.links.detected.v1.' || s.id) AND json_valid(value))
       OR (json_valid(s.json) AND json_array_length(s.json, '$.pulls') > 0);
    UPDATE feature_records SET json = json_set(feature_records.json, '$.links', json(st.value))
    FROM settings st
    WHERE feature_records.namespace = 'mod:github:sessions' AND st.key = 'session.links.v1.' || feature_records.id AND json_valid(st.value);
    UPDATE feature_records SET json = json_set(feature_records.json, '$.detected', json(st.value))
    FROM settings st
    WHERE feature_records.namespace = 'mod:github:sessions' AND st.key = 'session.links.detected.v1.' || feature_records.id AND json_valid(st.value);
    UPDATE feature_records SET json = json_set(feature_records.json, '$.pulls', json(json_extract(s.json, '$.pulls')))
    FROM sessions s
    WHERE feature_records.namespace = 'mod:github:sessions' AND s.id = feature_records.id
      AND json_valid(s.json) AND json_array_length(s.json, '$.pulls') > 0;
    "#,
    // v6: usage history, one row per agent turn that reported usage, kept
    // after its session is deleted (see aura_core::usage). Filled from the
    // turns already in the history; cache writes were not kept apart before.
    // Input is kept without cached input for every provider (Codex counts it
    // inside), and a turn belongs to the first feature owner up its
    // orchestrator chain (at most 16 levels, as for live turns).
    r#"
    CREATE TABLE IF NOT EXISTS usage_records (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        orchestrator_id TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS usage_records_at ON usage_records(at_ms);
    CREATE INDEX IF NOT EXISTS usage_records_orchestrator ON usage_records(orchestrator_id, session_id);

    WITH RECURSIVE
    chain(start_id, id, depth) AS (
        SELECT id, id, 0 FROM sessions WHERE json_valid(json)
        UNION ALL
        SELECT c.start_id, json_extract(s.json, '$.orchestrator_id'), c.depth + 1
        FROM chain c JOIN sessions s ON s.id = c.id
        WHERE c.depth < 16 AND json_valid(s.json)
          AND NOT COALESCE(json_extract(s.json, '$.feature_owner'), 0)
          AND json_extract(s.json, '$.orchestrator_id') IS NOT NULL
    ),
    owner(start_id, owner_id) AS (
        SELECT c.start_id, c.id FROM chain c JOIN sessions s ON s.id = c.id
        WHERE json_valid(s.json) AND json_extract(s.json, '$.feature_owner')
    ),
    t AS (
        SELECT e.session_id AS session_id,
               json_extract(e.json, '$.turn.id') AS turn_id,
               COALESCE(json_extract(e.json, '$.turn.ended_at'), e.ts) AS at,
               json_extract(e.json, '$.turn.usage') AS usage
        FROM events e
        WHERE e.kind = 'turn_completed' AND json_valid(e.json)
          AND json_type(e.json, '$.turn.usage') = 'object'
    )
    INSERT OR IGNORE INTO usage_records (session_id, turn_id, at_ms, orchestrator_id, json)
    SELECT t.session_id, t.turn_id,
           CAST(ROUND((julianday(t.at) - 2440587.5) * 86400000) AS INTEGER),
           json_extract(s.json, '$.orchestrator_id'),
           json_object(
             'session_id', t.session_id,
             'turn_id', t.turn_id,
             'at', t.at,
             'provider', COALESCE(json_extract(s.json, '$.provider'), 'claude'),
             'agent', json_extract(s.json, '$.agent'),
             'model', json_extract(s.json, '$.model'),
             'project', CASE WHEN s.json IS NULL OR json_extract(s.json, '$.folderless') THEN NULL
                        ELSE COALESCE(json_extract(s.json, '$.worktree.repo_root'), json_extract(s.json, '$.cwd')) END,
             'feature_id', (SELECT o.owner_id FROM owner o WHERE o.start_id = t.session_id),
             'orchestrator_id', json_extract(s.json, '$.orchestrator_id'),
             'session_title', COALESCE(json_extract(s.json, '$.title'), ''),
             'input_tokens', CASE WHEN json_extract(s.json, '$.provider') = 'codex'
                 THEN MAX(0, COALESCE(json_extract(t.usage, '$.input_tokens'), 0) - COALESCE(json_extract(t.usage, '$.cached_input_tokens'), 0))
                 ELSE COALESCE(json_extract(t.usage, '$.input_tokens'), 0) END,
             'output_tokens', COALESCE(json_extract(t.usage, '$.output_tokens'), 0),
             'cached_input_tokens', COALESCE(json_extract(t.usage, '$.cached_input_tokens'), 0),
             'cache_write_tokens', COALESCE(json_extract(t.usage, '$.cache_write_tokens'), 0),
             'context_used', json_extract(t.usage, '$.context_used'),
             'context_window', json_extract(t.usage, '$.context_window'),
             'cost_usd', json_extract(t.usage, '$.total_cost_usd')
           )
    FROM t
    LEFT JOIN sessions s ON s.id = t.session_id AND json_valid(s.json)
    WHERE t.turn_id IS NOT NULL AND julianday(t.at) IS NOT NULL
      AND (COALESCE(json_extract(t.usage, '$.input_tokens'), 0)
           + COALESCE(json_extract(t.usage, '$.output_tokens'), 0)
           + COALESCE(json_extract(t.usage, '$.cached_input_tokens'), 0) > 0
           OR COALESCE(json_extract(t.usage, '$.total_cost_usd'), 0) > 0);
    "#,
];

pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let conn =
            Connection::open(path).with_context(|| format!("open sqlite {}", path.display()))?;
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
        let store = Self {
            conn: Mutex::new(conn),
        };
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
            conn.execute_batch(sql)
                .with_context(|| format!("migration v{target}"))?;
            conn.pragma_update(None, "user_version", target)?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .lock()
            .pragma_query_value(None, "user_version", |r| r.get(0))?)
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
    fn scheduled_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json FROM scheduled_tasks ORDER BY created_at, id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            match serde_json::from_str::<ScheduledTask>(&row?) {
                Ok(t) => out.push(t),
                Err(e) => tracing::warn!("skipping unreadable scheduled task: {e}"),
            }
        }
        Ok(out)
    }
    fn save_scheduled_task(&self, task: &ScheduledTask) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO scheduled_tasks (id, created_at, json) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET json = excluded.json",
            params![
                task.id,
                task.created_at.to_rfc3339(),
                serde_json::to_string(task)?
            ],
        )?;
        Ok(())
    }
    fn delete_scheduled_task(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM scheduled_runs WHERE task_id = ?1", params![id])?;
        tx.execute("DELETE FROM scheduled_tasks WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }
    fn delete_scheduled_runs(&self, task_id: &str, ids: &[String]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute(
                "DELETE FROM scheduled_runs WHERE task_id = ?1 AND id = ?2",
                params![task_id, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    fn scheduled_runs(&self, task_id: &str, limit: usize) -> Result<Vec<ScheduledRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT json FROM scheduled_runs WHERE task_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![task_id, i64::try_from(limit).unwrap_or(i64::MAX)],
            |r| r.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for row in rows {
            match serde_json::from_str::<ScheduledRun>(&row?) {
                Ok(r) => out.push(r),
                Err(e) => tracing::warn!("skipping unreadable scheduled run: {e}"),
            }
        }
        Ok(out)
    }
    fn add_scheduled_run(&self, run: &ScheduledRun, keep: usize) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        // Fixed-width UTC times sort as text.
        let at = run.at.to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        tx.execute(
            "INSERT OR REPLACE INTO scheduled_runs (id, task_id, at, json) VALUES (?1, ?2, ?3, ?4)",
            params![run.id, run.task_id, at, serde_json::to_string(run)?],
        )?;
        tx.execute(
            "DELETE FROM scheduled_runs WHERE task_id = ?1 AND id NOT IN (
               SELECT id FROM scheduled_runs WHERE task_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2)",
            params![run.task_id, i64::try_from(keep).unwrap_or(i64::MAX)],
        )?;
        tx.commit()?;
        Ok(())
    }
    fn feature_records(&self, namespace: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id, json FROM feature_records WHERE namespace = ? ORDER BY id")?;
        let rows = stmt
            .query_map([namespace], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    fn save_feature_record(&self, namespace: &str, id: &str, value: &str) -> Result<()> {
        self.conn.lock().execute("INSERT INTO feature_records(namespace,id,json) VALUES (?1,?2,?3) ON CONFLICT(namespace,id) DO UPDATE SET json=excluded.json", params![namespace,id,value])?;
        Ok(())
    }
    fn delete_feature_record(&self, namespace: &str, id: &str) -> Result<()> {
        self.conn.lock().execute(
            "DELETE FROM feature_records WHERE namespace = ?1 AND id = ?2",
            params![namespace, id],
        )?;
        Ok(())
    }
    fn add_usage_record(&self, record: &UsageRecord) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO usage_records (session_id, turn_id, at_ms, orchestrator_id, json) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, turn_id) DO UPDATE SET at_ms = excluded.at_ms,
               orchestrator_id = excluded.orchestrator_id, json = excluded.json",
            params![
                record.session_id,
                record.turn_id,
                record.at.timestamp_millis(),
                record.orchestrator_id,
                serde_json::to_string(record)?
            ],
        )?;
        Ok(())
    }

    fn usage_records(
        &self,
        from: Option<DateTime<Utc>>,
        to: Option<DateTime<Utc>>,
        sessions: Option<&[String]>,
    ) -> Result<Vec<UsageRecord>> {
        let (from, to) = (
            from.map_or(i64::MIN, |f| f.timestamp_millis()),
            to.map_or(i64::MAX, |t| t.timestamp_millis()),
        );
        let conn = self.conn.lock();
        let read = |sql: &str, args: Vec<rusqlite::types::Value>| -> Result<Vec<UsageRecord>> {
            let mut stmt = conn.prepare_cached(sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (session, json) = row?;
                match serde_json::from_str::<UsageRecord>(&json) {
                    Ok(r) => out.push(r),
                    Err(e) => tracing::warn!("skipping unreadable usage record of {session}: {e}"),
                }
            }
            Ok(out)
        };
        let Some(ids) = sessions else {
            return read(
                "SELECT session_id, json FROM usage_records WHERE at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms, turn_id",
                vec![from.into(), to.into()],
            );
        };
        // By session, through the primary key, in chunks SQLite takes.
        let mut out = Vec::new();
        for chunk in ids.chunks(400) {
            let marks = vec!["?"; chunk.len()].join(",");
            let mut args: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
            args.extend(chunk.iter().map(|id| id.clone().into()));
            out.extend(read(
                &format!("SELECT session_id, json FROM usage_records WHERE at_ms >= ?1 AND at_ms < ?2 AND session_id IN ({marks})"),
                args,
            )?);
        }
        out.sort_by(|a, b| a.at.cmp(&b.at).then(a.turn_id.cmp(&b.turn_id)));
        Ok(out)
    }

    fn usage_parents(&self) -> Result<Vec<(String, Option<String>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT session_id, orchestrator_id FROM usage_records WHERE orchestrator_id IS NOT NULL",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
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
        tx.execute(
            "DELETE FROM messages_fts WHERE session_id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM scrollback WHERE session_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    fn list_sessions(&self) -> Result<Vec<Session>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT json FROM sessions ORDER BY pinned DESC, last_activity DESC")?;
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
            params![
                session_id,
                seq,
                ts.to_rfc3339(),
                event_kind(event),
                serde_json::to_string(event)?
            ],
        )?;
        if let Event::ItemCompleted { item, .. } = event {
            if matches!(item.kind, ItemKind::UserMessage | ItemKind::AgentMessage)
                && !item.text.trim().is_empty()
            {
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
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, ts, json) = row?;
            match serde_json::from_str::<Event>(&json) {
                Ok(event) => out.push(StoredEvent {
                    seq: seq as u64,
                    ts: parse_ts(&ts),
                    event,
                }),
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
                let hits = stmt
                    .query_map(params![q, limit as i64], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
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
                let hits = stmt
                    .query_map(params![like, limit as i64], map)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(hits)
            }
        }
    }

    fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .lock()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
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
            .query_row(
                "SELECT data FROM scrollback WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_core::{CreateSessionOpts, Item, ItemKind, ProviderKind, Turn, TurnStatus};

    fn session(cwd: &str) -> Session {
        Session::new(&CreateSessionOpts {
            provider: ProviderKind::Terminal,
            cwd: cwd.into(),
            ..Default::default()
        })
    }

    fn msg(session_id: &str, kind: ItemKind, text: &str) -> Event {
        Event::ItemCompleted {
            session_id: session_id.into(),
            item: Item::new(session_id, None, kind)
                .with_text(text)
                .completed(),
        }
    }

    #[test]
    fn fts5_is_available() {
        let s = SqliteStore::open_in_memory().unwrap();
        s.conn
            .lock()
            .execute_batch("CREATE VIRTUAL TABLE t USING fts5(x);")
            .unwrap();
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
        s.append_event(
            "s1",
            &msg(
                "s1",
                ItemKind::AgentMessage,
                "The quick brown fox fixed auth.py today.",
            ),
        )
        .unwrap();
        s.append_event(
            "s1",
            &msg(
                "s1",
                ItemKind::Reasoning,
                "brown reasoning should not index",
            ),
        )
        .unwrap();
        s.append_event(
            "s2",
            &msg(
                "s2",
                ItemKind::UserMessage,
                "Please run cargo test -- --nocapture",
            ),
        )
        .unwrap();
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
        assert_eq!(
            s.feature_records("groups").unwrap(),
            vec![("b".to_string(), "2".to_string())]
        );
        assert_eq!(s.feature_records("other").unwrap().len(), 1);
    }

    fn task(id: &str, at: DateTime<Utc>) -> ScheduledTask {
        ScheduledTask {
            id: id.into(),
            name: format!("task {id}"),
            prompt: "check the build".into(),
            agent: "claude".into(),
            model: Some("opus".into()),
            effort: Some("high".into()),
            permission_mode: None,
            sandbox_mode: None,
            cwd: "/tmp/repo".into(),
            run_as: aura_core::RunAs::Session,
            feature_goal: None,
            autonomy: None,
            worktree: true,
            branch_prefix: None,
            group: Some("nightly".into()),
            workspace: "ws".into(),
            enabled: true,
            schedule: aura_core::Schedule::Days {
                every: 1,
                at: "09:00".parse().unwrap(),
            },
            missed: aura_core::MissedRuns::RunOnce,
            allow_overlap: false,
            created_at: at,
            updated_at: at,
            anchor: at,
            last_slot: None,
            next_run: Some(at + chrono::Duration::hours(1)),
            last_run: None,
            created_by: None,
        }
    }

    fn run(task_id: &str, n: i64, start: DateTime<Utc>) -> ScheduledRun {
        ScheduledRun {
            id: format!("{task_id}-{n}"),
            task_id: task_id.into(),
            at: start + chrono::Duration::minutes(n),
            slot: None,
            trigger: aura_core::RunTrigger::Schedule,
            result: aura_core::RunResult::Started,
            session_id: Some(format!("s{n}")),
            session_title: None,
            message: None,
        }
    }

    #[test]
    fn scheduled_tasks_and_their_history_are_kept_and_pruned() {
        let s = SqliteStore::open_in_memory().unwrap();
        let t0 = "2026-11-18T08:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let mut a = task("a", t0);
        s.save_scheduled_task(&a).unwrap();
        s.save_scheduled_task(&task("b", t0 + chrono::Duration::seconds(1)))
            .unwrap();
        a.enabled = false;
        a.next_run = None;
        s.save_scheduled_task(&a).unwrap();
        let tasks = s.scheduled_tasks().unwrap();
        assert_eq!(
            tasks.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"],
            "in the order they were created"
        );
        assert_eq!(tasks[0], a, "saved again, not twice");

        // Runs come back latest first; only the latest `keep` stay.
        for n in 0..12 {
            s.add_scheduled_run(&run("a", n, t0), 10).unwrap();
        }
        s.add_scheduled_run(&run("b", 0, t0), 10).unwrap();
        let runs = s.scheduled_runs("a", 100).unwrap();
        assert_eq!(runs.len(), 10);
        assert_eq!(runs[0].id, "a-11");
        assert_eq!(runs[9].id, "a-2");
        assert_eq!(s.scheduled_runs("a", 3).unwrap().len(), 3);
        assert_eq!(s.scheduled_runs("b", 100).unwrap().len(), 1);

        // Deleting a task deletes its history, and nobody else's.
        s.delete_scheduled_task("a").unwrap();
        assert!(s.scheduled_runs("a", 100).unwrap().is_empty());
        assert_eq!(s.scheduled_runs("b", 100).unwrap().len(), 1);
        assert_eq!(s.scheduled_tasks().unwrap().len(), 1);
    }

    #[test]
    fn the_in_memory_store_keeps_scheduled_tasks_the_same_way() {
        let s = aura_core::MemoryStore::default();
        let t0 = "2026-11-18T08:00:00Z".parse::<DateTime<Utc>>().unwrap();
        s.save_scheduled_task(&task("a", t0)).unwrap();
        for n in 0..5 {
            s.add_scheduled_run(&run("a", n, t0), 3).unwrap();
        }
        let runs = s.scheduled_runs("a", 100).unwrap();
        assert_eq!(
            runs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["a-4", "a-3", "a-2"]
        );
        s.delete_scheduled_task("a").unwrap();
        assert!(s.scheduled_tasks().unwrap().is_empty());
        assert!(s.scheduled_runs("a", 100).unwrap().is_empty());
    }

    #[test]
    fn sessions_and_tasks_stored_before_workspaces_still_load() {
        let s = SqliteStore::open_in_memory().unwrap();
        let sess = session("/tmp/old");
        let mut json = serde_json::to_value(&sess).unwrap();
        json.as_object_mut().unwrap().remove("workspace");
        s.conn
            .lock()
            .execute(
                "INSERT INTO sessions (id, provider, archived, pinned, created_at, last_activity, json)
                 VALUES (?1, 'terminal', 0, 0, ?2, ?2, ?3)",
                params![sess.id, sess.created_at.to_rfc3339(), json.to_string()],
            )
            .unwrap();
        let loaded = s.list_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, sess.id);
        assert_eq!(loaded[0].workspace, "", "the daemon puts it in one");

        let old = task("old", Utc::now());
        let mut json = serde_json::to_value(&old).unwrap();
        json.as_object_mut().unwrap().remove("workspace");
        s.conn
            .lock()
            .execute(
                "INSERT INTO scheduled_tasks (id, created_at, json) VALUES (?1, ?2, ?3)",
                params![old.id, old.created_at.to_rfc3339(), json.to_string()],
            )
            .unwrap();
        let tasks = s.scheduled_tasks().unwrap();
        assert_eq!(
            (tasks[0].id.as_str(), tasks[0].workspace.as_str()),
            ("old", "")
        );
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
            s.append_event(&id, &msg(&id, ItemKind::AgentMessage, "persist me"))
                .unwrap();
            s.save_scheduled_task(&task("nightly", Utc::now())).unwrap();
            s.add_scheduled_run(&run("nightly", 1, Utc::now()), 100)
                .unwrap();
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(s.list_sessions().unwrap()[0].id, id);
        assert_eq!(s.get_setting("theme").unwrap(), Some("dark".into()));
        assert_eq!(s.events(&id, 0, 10).unwrap().len(), 1);
        assert_eq!(s.search("persist", 5).unwrap().len(), 1);
        assert_eq!(s.scheduled_tasks().unwrap()[0].id, "nightly");
        assert_eq!(s.scheduled_runs("nightly", 10).unwrap().len(), 1);
    }

    #[test]
    fn a_database_from_before_scheduled_tasks_gains_their_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aura.db");
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..2] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 2).unwrap();
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert!(s.scheduled_tasks().unwrap().is_empty());
        s.save_scheduled_task(&task("a", Utc::now())).unwrap();
        assert_eq!(s.scheduled_tasks().unwrap().len(), 1);
    }

    #[test]
    fn tasks_from_before_roles_run_sessions_and_their_sessions_learn_their_task() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aura.db");
        fn without(v: &impl serde::Serialize, keys: &[&str]) -> String {
            let mut v = serde_json::to_value(v).unwrap();
            for k in keys {
                v.as_object_mut().unwrap().remove(*k);
            }
            v.to_string()
        }
        let (started, busy, own) = (session("/tmp/a"), session("/tmp/b"), session("/tmp/c"));
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..3] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 3).unwrap();
            let old = ["scheduled_task_id", "scheduled_task_name"];
            for s in [&started, &busy, &own] {
                conn.execute(
                    "INSERT INTO sessions (id, provider, created_at, last_activity, json) VALUES (?1, 'terminal', ?2, ?2, ?3)",
                    params![s.id, s.created_at.to_rfc3339(), without(s, &old)],
                )
                .unwrap();
            }
            let t = task("nightly", Utc::now());
            conn.execute(
                "INSERT INTO scheduled_tasks (id, created_at, json) VALUES (?1, ?2, ?3)",
                params![
                    t.id,
                    t.created_at.to_rfc3339(),
                    without(&t, &["run_as", "feature_goal", "autonomy"])
                ],
            )
            .unwrap();
            // A run that started a session, and a skipped one that links to the
            // session that was still busy, which is not the task's.
            let mut first = run("nightly", 1, Utc::now());
            first.session_id = Some(started.id.clone());
            let mut skipped = run("nightly", 2, Utc::now());
            skipped.result = aura_core::RunResult::Skipped;
            skipped.session_id = Some(busy.id.clone());
            for r in [first, skipped] {
                conn.execute(
                    "INSERT INTO scheduled_runs (id, task_id, at, json) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        r.id,
                        r.task_id,
                        r.at.to_rfc3339(),
                        serde_json::to_string(&r).unwrap()
                    ],
                )
                .unwrap();
            }
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let task = &s.scheduled_tasks().unwrap()[0];
        assert_eq!(task.run_as, aura_core::RunAs::Session);
        assert_eq!(task.feature_goal, None);
        let sessions = s.list_sessions().unwrap();
        let by_id = |id: &str| sessions.iter().find(|s| s.id == id).unwrap().clone();
        assert_eq!(
            by_id(&started.id).scheduled_task_id.as_deref(),
            Some("nightly")
        );
        assert_eq!(
            by_id(&started.id).scheduled_task_name.as_deref(),
            Some("task nightly")
        );
        assert_eq!(by_id(&busy.id).scheduled_task_id, None);
        assert_eq!(by_id(&own.id).scheduled_task_id, None);
    }

    #[test]
    fn github_and_review_data_is_copied_to_the_mods() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aura.db");
        let (linked, worked, plain) = (session("/tmp/a"), session("/tmp/b"), session("/tmp/c"));
        {
            let conn = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..4] {
                conn.execute_batch(sql).unwrap();
            }
            conn.pragma_update(None, "user_version", 4).unwrap();
            for (s, pulls) in [
                (&linked, json!([])),
                (&worked, json!(["https://github.com/o/r/pull/7"])),
                (&plain, json!([])),
            ] {
                let mut v = serde_json::to_value(s).unwrap();
                v["pulls"] = pulls;
                conn.execute(
                    "INSERT INTO sessions (id, provider, created_at, last_activity, json) VALUES (?1, 'terminal', ?2, ?2, ?3)",
                    params![s.id, s.created_at.to_rfc3339(), v.to_string()],
                )
                .unwrap();
            }
            let record = |ns: &str, id: &str, json: &str| {
                conn.execute(
                    "INSERT INTO feature_records (namespace, id, json) VALUES (?1, ?2, ?3)",
                    params![ns, id, json],
                )
                .unwrap();
            };
            record("reviews", "r1", r#"{"id":"r1"}"#);
            record("hidden:github.com:me", "o/r#1", "true");
            record("pr-watches", "w1", r#"{"repo":"o/r"}"#);
            record("groups", "g1", r#"{"id":"g1"}"#);
            let setting = |k: &str, v: &str| {
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                    params![k, v],
                )
                .unwrap();
            };
            setting("reviews.inbox", r#"{"account":"github.com:me"}"#);
            setting("pulls.snapshots.v1.github.com:me", "[]");
            setting(
                &format!("session.links.v1.{}", linked.id),
                r#"{"prs":["o/r#2"]}"#,
            );
            setting("prompts", r#"{"global":""}"#);
        }
        let s = SqliteStore::open(&path).unwrap();
        let ns = |n: &str| s.feature_records(n).unwrap();
        assert_eq!(
            ns("mod:pull-requests:c:reviews"),
            vec![("r1".into(), r#"{"id":"r1"}"#.into())]
        );
        assert_eq!(ns("mod:pull-requests:c:hidden:github.com:me").len(), 1);
        assert_eq!(ns("mod:pull-requests:c:pr-watches").len(), 1);
        assert!(
            ns("mod:pull-requests:c:groups").is_empty(),
            "core data stays core's"
        );
        let kv: std::collections::HashMap<_, _> = ns("mod:pull-requests:kv").into_iter().collect();
        assert_eq!(kv["reviews.inbox"], r#"{"account":"github.com:me"}"#);
        assert_eq!(kv["pulls.snapshots.v1.github.com:me"], "[]");
        assert!(!kv.contains_key("prompts"));
        let sessions: std::collections::HashMap<String, serde_json::Value> =
            ns("mod:github:sessions")
                .into_iter()
                .map(|(k, v)| (k, serde_json::from_str(&v).unwrap()))
                .collect();
        assert_eq!(sessions[&linked.id], json!({"links": {"prs": ["o/r#2"]}}));
        assert_eq!(
            sessions[&worked.id],
            json!({"pulls": ["https://github.com/o/r/pull/7"]})
        );
        assert!(!sessions.contains_key(&plain.id));
        // The old rows stay for an older Aura.
        assert_eq!(ns("reviews").len(), 1);
    }

    fn turn_done(
        session_id: &str,
        id: &str,
        ended: &str,
        usage: Option<aura_core::Usage>,
    ) -> Event {
        Event::TurnCompleted {
            session_id: session_id.into(),
            turn: Turn {
                id: id.into(),
                session_id: session_id.into(),
                status: TurnStatus::Completed,
                started_at: ended.parse().unwrap(),
                ended_at: Some(ended.parse().unwrap()),
                usage,
                error: None,
            },
        }
    }

    #[test]
    fn usage_history_is_filled_from_the_turns_already_stored() {
        use aura_core::Usage;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aura.db");
        let mut owner = session("/src/app");
        owner.feature_owner = true;
        owner.orchestrator = true;
        owner.title = "Checkout".into();
        let mut worker = session("/src/app");
        worker.orchestrator_id = Some(owner.id.clone());
        worker.model = Some("gpt-5".into());
        worker.provider = ProviderKind::Codex;
        worker.worktree = Some(aura_core::WorktreeInfo {
            repo_root: "/src/app".into(),
            path: "/src/app/.aura-worktrees/x".into(),
            branch: "x".into(),
        });
        let usage = Usage {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 50,
            total_cost_usd: Some(0.25),
            context_window: Some(200_000),
            context_used: Some(1_000),
            ..Default::default()
        };
        {
            // A database as Aura 0.6.3 left it.
            let s = SqliteStore::open(&path).unwrap();
            s.upsert_session(&owner).unwrap();
            s.upsert_session(&worker).unwrap();
            s.append_event(
                &owner.id,
                &turn_done(
                    &owner.id,
                    "t1",
                    "2026-11-01T10:00:00.123456Z",
                    Some(usage.clone()),
                ),
            )
            .unwrap();
            s.append_event(
                &worker.id,
                &turn_done(
                    &worker.id,
                    "t2",
                    "2026-11-02T10:00:00Z",
                    Some(Usage {
                        total_cost_usd: None,
                        ..usage.clone()
                    }),
                ),
            )
            .unwrap();
            // Nothing spent, and no usage at all: no record.
            s.append_event(
                &worker.id,
                &turn_done(
                    &worker.id,
                    "t3",
                    "2026-11-02T11:00:00Z",
                    Some(Usage::default()),
                ),
            )
            .unwrap();
            s.append_event(
                &worker.id,
                &turn_done(&worker.id, "t4", "2026-11-02T12:00:00Z", None),
            )
            .unwrap();
            // Three levels under the feature owner, and one with no owner above it.
            let mut sub = session("/src/app");
            sub.orchestrator_id = Some(worker.id.clone());
            let mut subsub = session("/src/app");
            subsub.orchestrator_id = Some(sub.id.clone());
            let loose = session("/src/app");
            for x in [&sub, &subsub, &loose] {
                s.upsert_session(x).unwrap();
            }
            for (x, turn, at) in [
                (&subsub, "t5", "2026-11-03T10:00:00Z"),
                (&loose, "t6", "2026-11-03T11:00:00Z"),
            ] {
                s.append_event(&x.id, &turn_done(&x.id, turn, at, Some(usage.clone())))
                    .unwrap();
            }
            let conn = s.conn.lock();
            conn.execute_batch("DROP TABLE usage_records").unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }
        let s = SqliteStore::open(&path).unwrap();
        assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
        let all = s.usage_records(None, None, None).unwrap();
        assert_eq!(all.len(), 4, "{all:?}");
        let (a, b) = (&all[0], &all[1]);
        assert_eq!(
            all[2].feature_id.as_deref(),
            Some(owner.id.as_str()),
            "three levels down"
        );
        assert_eq!(all[3].feature_id, None);
        // Codex counts cached input inside its input: kept without it.
        assert_eq!((b.input_tokens, b.cached_input_tokens), (50, 50));
        assert_eq!((a.input_tokens, a.cached_input_tokens), (100, 50));
        assert!(s
            .usage_parents()
            .unwrap()
            .contains(&(worker.id.clone(), Some(owner.id.clone()))));
        assert_eq!(
            (a.turn_id.as_str(), a.cost_usd, a.feature_id.as_deref()),
            ("t1", Some(0.25), Some(owner.id.as_str()))
        );
        assert_eq!(
            a.at.timestamp_millis(),
            "2026-11-01T10:00:00.123Z"
                .parse::<DateTime<Utc>>()
                .unwrap()
                .timestamp_millis()
        );
        assert_eq!(a.session_title, "Checkout");
        assert_eq!(a.context_used, Some(1_000));
        assert_eq!(b.provider, ProviderKind::Codex);
        assert_eq!(b.model.as_deref(), Some("gpt-5"));
        assert_eq!(b.project.as_deref(), Some("/src/app"));
        assert_eq!(b.feature_id.as_deref(), Some(owner.id.as_str()));
        assert_eq!(b.orchestrator_id.as_deref(), Some(owner.id.as_str()));
        assert_eq!(b.cost_usd, None);
        // Ranges are [from, to), and a session's records outlive it.
        s.delete_session(&owner.id).unwrap();
        let from = "2026-11-02T00:00:00Z".parse().unwrap();
        let got = s.usage_records(Some(from), None, None).unwrap();
        assert_eq!(got.len(), 3);
        assert!(s
            .usage_records(None, Some(from), Some(&[worker.id.clone()]))
            .unwrap()
            .is_empty());
        assert_eq!(
            s.usage_records(None, None, Some(&[owner.id.clone()]))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_usage_record_for_the_same_turn_replaces_the_earlier_one() {
        let s = SqliteStore::open_in_memory().unwrap();
        let mut r = UsageRecord {
            session_id: "s".into(),
            turn_id: "t".into(),
            at: "2026-11-01T10:00:00Z".parse().unwrap(),
            provider: ProviderKind::Claude,
            agent: None,
            model: None,
            project: None,
            feature_id: None,
            orchestrator_id: None,
            session_title: String::new(),
            input_tokens: 1,
            output_tokens: 1,
            cached_input_tokens: 0,
            cache_write_tokens: 0,
            context_used: None,
            context_window: None,
            cost_usd: None,
        };
        s.add_usage_record(&r).unwrap();
        r.output_tokens = 9;
        s.add_usage_record(&r).unwrap();
        let all = s.usage_records(None, None, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].output_tokens, 9);
        // Many sessions at once go in chunks.
        let mut ids: Vec<String> = (0..900).map(|i| format!("other-{i}")).collect();
        ids.push("s".into());
        assert_eq!(s.usage_records(None, None, Some(&ids)).unwrap().len(), 1);
    }
}
