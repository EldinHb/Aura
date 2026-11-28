//! Usage history (see [`crate::usage`]): kept as turns end, summed for
//! `usage.summary` / `usage.session`, written up for `usage.report` and, once
//! a day if the user wants it, posted as a [`Event::UsageReport`].

use super::*;
use crate::usage::{
    self, DailyUsageSettings, Labels, SessionUsage, SessionUsageQuery, UsageQuery, UsageRecord,
    UsageReport, UsageReportQuery, UsageSummary,
};
use chrono::{DateTime, Duration, Local, Utc};

/// Setting: [`DailyUsageSettings`] as JSON.
pub const DAILY_USAGE_KEY: &str = "usage.daily";
/// Setting: the local date (`YYYY-MM-DD`) the last daily summary was written.
const DAILY_USAGE_LAST_KEY: &str = "usage.daily.last";
/// Where written summaries are kept, and how many.
const REPORTS: &str = "usage_reports";
pub const KEEP_REPORTS: usize = 30;
/// How often the daemon looks whether the daily summary is due.
const DAILY_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// How far up the orchestrator chain a feature owner is looked for.
const MAX_DEPTH: usize = 16;

impl Manager {
    /// The feature owner `s` is or works for, at any depth.
    fn feature_of(&self, s: &Session) -> Option<SessionId> {
        let sessions = self.inner.sessions.lock();
        let mut cur = s.clone();
        for _ in 0..MAX_DEPTH {
            if cur.feature_owner {
                return Some(cur.id);
            }
            cur = sessions.get(cur.orchestrator_id.as_ref()?)?.clone();
        }
        None
    }

    /// Keep what a completed turn spent. Turns that reported nothing are skipped.
    pub(super) fn record_turn_usage(&self, sid: &str, turn: &Turn) {
        let Some(u) = &turn.usage else { return };
        let spent = u.input_tokens + u.output_tokens + u.cached_input_tokens > 0
            || u.total_cost_usd.is_some_and(|c| c > 0.0);
        if !spent {
            return;
        }
        let Ok(s) = self.get_session(sid) else { return };
        let project = if s.folderless {
            None
        } else {
            Some(
                s.worktree
                    .as_ref()
                    .map(|w| w.repo_root.clone())
                    .unwrap_or_else(|| s.cwd.clone()),
            )
        };
        let record = UsageRecord {
            session_id: s.id.clone(),
            turn_id: turn.id.clone(),
            at: turn.ended_at.unwrap_or_else(crate::now),
            provider: s.provider,
            agent: s.agent.clone(),
            model: s.model.clone(),
            project,
            feature_id: self.feature_of(&s),
            orchestrator_id: s.orchestrator_id.clone(),
            session_title: s.title.clone(),
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_input_tokens: u.cached_input_tokens,
            cache_write_tokens: u.cache_write_tokens,
            context_used: u.context_used,
            context_window: u.context_window,
            cost_usd: u.total_cost_usd,
        };
        if let Err(e) = self.inner.store.add_usage_record(&record) {
            tracing::warn!("keeping usage of turn {} failed: {e}", turn.id);
        }
    }

    fn usage_labels(&self) -> Labels {
        let mut labels = Labels::default();
        for s in self.list_sessions() {
            if s.feature_owner {
                labels.features.insert(s.id.clone(), s.title.clone());
            }
            labels.sessions.insert(s.id, s.title);
        }
        labels
    }

    /// `usage.summary`: turns in a range, summed and grouped.
    pub fn usage_summary(&self, q: &UsageQuery) -> Result<UsageSummary> {
        usage::validate(q)?;
        let records = self.inner.store.usage_records(q.from, q.to, None)?;
        Ok(usage::summarize(&records, q, &self.usage_labels()))
    }

    /// `usage.session`: one session's turns, and its workers'.
    pub fn usage_session(&self, q: &SessionUsageQuery) -> Result<SessionUsage> {
        let session = self.get_session(&q.id).ok();
        let mut parents: Vec<(String, Option<String>)> = vec![];
        let mut ids = vec![q.id.clone()];
        if q.include_workers {
            // Who started whom: the live sessions, and the records of deleted ones.
            for s in self.list_sessions() {
                parents.push((s.id, s.orchestrator_id));
            }
            for r in self.inner.store.usage_records(None, None, None)? {
                if !parents.iter().any(|(id, _)| *id == r.session_id) {
                    parents.push((r.session_id, r.orchestrator_id));
                }
            }
            ids.extend(usage::descendants(&q.id, &parents));
        }
        let records = self.inner.store.usage_records(None, None, Some(&ids))?;
        let title = match session {
            Some(s) => s.title,
            None => match records.iter().find(|r| r.session_id == q.id) {
                Some(r) => r.session_title.clone(),
                None => bail!("unknown session {}", q.id),
            },
        };
        Ok(usage::session_usage(
            &q.id,
            title,
            &records,
            &parents,
            &self.usage_labels(),
        ))
    }

    /// `usage.report`: a written summary of a period, against the one before.
    pub fn usage_report(&self, q: &UsageReportQuery) -> Result<UsageReport> {
        if q.to <= q.from {
            bail!("`to` ({}) must be after `from` ({})", q.to, q.from);
        }
        if q.tz_offset_minutes.abs() > 18 * 60 {
            bail!(
                "tzOffsetMinutes must be between -1080 and 1080, not {}",
                q.tz_offset_minutes
            );
        }
        let store = &self.inner.store;
        let records = store.usage_records(Some(q.from), Some(q.to), None)?;
        let before = q.from - (q.to - q.from);
        let previous = store.usage_records(Some(before), Some(q.from), None)?;
        Ok(usage::report(
            q,
            &records,
            &previous,
            &self.usage_labels(),
            crate::now(),
        ))
    }

    /// The summaries Aura wrote on its own, the latest first.
    pub fn usage_reports(&self) -> Result<Vec<UsageReport>> {
        let mut all: Vec<UsageReport> = self
            .inner
            .store
            .feature_records(REPORTS)?
            .into_iter()
            .filter_map(|(_, json)| serde_json::from_str(&json).ok())
            .collect();
        all.sort_by_key(|r| std::cmp::Reverse(r.generated_at));
        Ok(all)
    }

    pub fn daily_usage(&self) -> DailyUsageSettings {
        self.inner
            .store
            .get_setting(DAILY_USAGE_KEY)
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }

    /// Change the daily summary. A time already past today starts tomorrow,
    /// so turning it on does not post one at once.
    pub fn set_daily_usage(&self, settings: DailyUsageSettings) -> Result<DailyUsageSettings> {
        let at = settings.parse_time()?;
        let settings = DailyUsageSettings {
            time: at.format("%H:%M").to_string(),
            ..settings
        };
        let store = &self.inner.store;
        store.set_setting(DAILY_USAGE_KEY, &serde_json::to_string(&settings)?)?;
        let now = Local::now();
        if now.time() >= at {
            store.set_setting(DAILY_USAGE_LAST_KEY, &now.date_naive().to_string())?;
        }
        Ok(settings)
    }

    /// Write the daily summary if it is due at `now` (local time): enabled,
    /// past its time, and not written yet today. Returns it.
    pub fn daily_usage_due(&self, now: DateTime<Local>) -> Result<Option<UsageReport>> {
        let settings = self.daily_usage();
        if !settings.enabled {
            return Ok(None);
        }
        let at = settings.parse_time()?;
        let today = now.date_naive().to_string();
        let store = &self.inner.store;
        if now.time() < at || store.get_setting(DAILY_USAGE_LAST_KEY)?.as_deref() == Some(&today) {
            return Ok(None);
        }
        store.set_setting(DAILY_USAGE_LAST_KEY, &today)?;
        let to = now.with_timezone(&Utc);
        let report = self.usage_report(&UsageReportQuery {
            from: to - Duration::hours(24),
            to,
            title: Some("Last 24 hours".into()),
            tz_offset_minutes: now.offset().local_minus_utc() / 60,
        })?;
        store.save_feature_record(REPORTS, &report.id, &serde_json::to_string(&report)?)?;
        for old in self.usage_reports()?.iter().skip(KEEP_REPORTS) {
            store.delete_feature_record(REPORTS, &old.id)?;
        }
        self.broadcast(Event::UsageReport {
            report: report.clone(),
        });
        Ok(Some(report))
    }

    /// Look every [`DAILY_EVERY`] whether the daily summary is due, until the
    /// daemon stops. One missed while the daemon was down is written when it
    /// starts again the same day.
    pub fn launch_daily_usage(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                if me.is_shutting_down() {
                    break;
                }
                if let Err(e) = me.daily_usage_due(Local::now()) {
                    tracing::warn!("daily usage summary failed: {e}");
                }
                tokio::time::sleep(DAILY_EVERY).await;
            }
        });
    }
}
