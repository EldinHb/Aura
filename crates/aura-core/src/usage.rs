//! Usage history: what each agent turn spent, kept after its session is
//! deleted, and the summaries `usage.summary` makes of it.
//!
//! Every completed turn that reported usage becomes one [`UsageRecord`],
//! written when the turn ends (see `Manager::handle_event`). Records made
//! before this existed are taken from the stored history once, by the store's
//! migration. Costs are what the agent reported; without one, an estimate from
//! [`crate::pricing`]; without a price, none (tokens only).

use crate::pricing::{self, CachedTokens};
use crate::types::{ProviderKind, SessionId};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ts_rs::TS;

/// One completed turn's usage, with what it belonged to when it ran.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageRecord {
    pub session_id: SessionId,
    pub turn_id: String,
    pub at: DateTime<Utc>,
    pub provider: ProviderKind,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// The repository (a worktree's main one) or folder the session ran in.
    #[serde(default)]
    pub project: Option<String>,
    /// The feature owner's session id, when the session was one or worked for one.
    #[serde(default)]
    pub feature_id: Option<SessionId>,
    /// The orchestrator that started the session, for rolling workers up.
    #[serde(default)]
    pub orchestrator_id: Option<SessionId>,
    #[serde(default)]
    pub session_title: String,
    /// Uncached input, whatever the provider (see [`UsageRecord::new_input`]).
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Cache reads and writes (see [`crate::Usage::cached_input_tokens`]).
    pub cached_input_tokens: u64,
    /// The part of `cached_input_tokens` written to the cache.
    #[serde(default)]
    pub cache_write_tokens: u64,
    /// The context in use after the turn, and the model's window.
    #[serde(default)]
    pub context_used: Option<u64>,
    #[serde(default)]
    pub context_window: Option<u64>,
    /// The cost the agent reported for the turn.
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

impl UsageRecord {
    /// A turn's input tokens without its cached ones. Codex counts cached
    /// input inside its input tokens; Claude and ACP agents do not. Records
    /// keep the uncached count, so sums and cache hit rates add up the same
    /// for every provider.
    pub fn new_input(provider: ProviderKind, input: u64, cached: u64) -> u64 {
        match provider {
            ProviderKind::Codex => input.saturating_sub(cached),
            _ => input,
        }
    }

    /// The reported cost, else an estimate, and whether it is an estimate.
    pub fn cost(&self) -> Option<(f64, bool)> {
        if let Some(c) = self.cost_usd {
            return Some((c, false));
        }
        // `input_tokens` is uncached input for every provider (see [`UsageRecord::new_input`]).
        let counting = CachedTokens::Separate;
        pricing::estimate(
            self.model.as_deref()?,
            self.input_tokens,
            self.output_tokens,
            self.cached_input_tokens,
            self.cache_write_tokens,
            counting,
        )
        .map(|c| (c, true))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UsageGroupBy {
    #[default]
    Day,
    Session,
    Feature,
    Project,
    Agent,
    Model,
}

/// `usage.summary`'s parameters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct UsageQuery {
    /// Turns that ended at or after this. None: from the first.
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    /// Turns that ended before this. None: up to now.
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
    #[serde(default, alias = "group_by")]
    pub group_by: UsageGroupBy,
    /// Split each group by this as well (`parts`), e.g. days by model for
    /// stacked bars. Not by day.
    #[serde(default, alias = "split_by")]
    pub split_by: Option<UsageGroupBy>,
    /// The caller's offset from UTC in minutes (east positive, so +60 for
    /// CET), for which day a turn falls on. Default 0.
    #[serde(default, alias = "tz_offset_minutes")]
    pub tz_offset_minutes: i32,
    /// The caller's IANA time zone (`Europe/Amsterdam`). With it, each turn's
    /// day follows that zone's rules at the turn's time, so a range across a
    /// daylight-saving change is right; `tzOffsetMinutes` is then ignored.
    #[serde(default, alias = "time_zone")]
    #[ts(optional)]
    pub time_zone: Option<String>,
    /// At most this many groups, the largest first (days are never cut).
    /// Default 50, at most 500.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageTotals {
    pub turns: u32,
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    /// Cache reads and writes.
    #[ts(type = "number")]
    pub cached_input_tokens: u64,
    /// The part of `cached_input_tokens` written to the cache.
    #[ts(type = "number")]
    pub cache_write_tokens: u64,
    /// Reported plus estimated cost of the turns that have one.
    pub cost_usd: f64,
    /// The part of `cost_usd` that is an estimate from Aura's price table.
    pub estimated_cost_usd: f64,
    /// Turns with neither a reported cost nor a known price: their tokens
    /// count, their cost does not.
    pub unpriced_turns: u32,
}

impl UsageTotals {
    fn add(&mut self, r: &UsageRecord) {
        self.turns += 1;
        self.input_tokens += r.input_tokens;
        self.output_tokens += r.output_tokens;
        self.cached_input_tokens += r.cached_input_tokens;
        self.cache_write_tokens += r.cache_write_tokens;
        match r.cost() {
            Some((c, estimated)) => {
                self.cost_usd += c;
                if estimated {
                    self.estimated_cost_usd += c;
                }
            }
            None => self.unpriced_turns += 1,
        }
    }

    pub fn merge(&mut self, o: &UsageTotals) {
        self.turns += o.turns;
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.cached_input_tokens += o.cached_input_tokens;
        self.cache_write_tokens += o.cache_write_tokens;
        self.cost_usd += o.cost_usd;
        self.estimated_cost_usd += o.estimated_cost_usd;
        self.unpriced_turns += o.unpriced_turns;
    }

    pub fn tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cached_input_tokens
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageGroup {
    /// Day (`YYYY-MM-DD`, in the caller's offset), session id, feature
    /// owner's session id, project path, agent or model. Empty for turns
    /// without one (no feature, no model reported).
    pub key: String,
    /// What to show for the key: a session's or feature's title, a folder's
    /// name, "default model".
    pub label: String,
    pub totals: UsageTotals,
    /// With `splitBy`: this group split by it, largest first. Empty otherwise.
    #[serde(default)]
    pub parts: Vec<UsageGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageSummary {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub group_by: UsageGroupBy,
    pub totals: UsageTotals,
    /// Days in order, every day of a bounded range included (empty ones too);
    /// anything else largest cost first, then most tokens.
    pub groups: Vec<UsageGroup>,
    /// Groups left out by `limit`.
    pub more: u32,
}

/// Labels for keys that are ids: sessions' and features' titles now. A
/// deleted session keeps the title it had in its records.
#[derive(Debug, Default)]
pub struct Labels {
    pub sessions: HashMap<String, String>,
    pub features: HashMap<String, String>,
}

pub const DEFAULT_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 500;
/// The longest range whose empty days are filled in.
const MAX_FILLED_DAYS: i64 = 400;

pub fn validate(q: &UsageQuery) -> anyhow::Result<()> {
    if let (Some(from), Some(to)) = (q.from, q.to) {
        if to < from {
            anyhow::bail!("`to` ({to}) is before `from` ({from})");
        }
    }
    if q.split_by == Some(UsageGroupBy::Day) {
        anyhow::bail!("splitBy cannot be day: group by day and split by something else");
    }
    zone(q.time_zone.as_deref(), q.tz_offset_minutes)?;
    Ok(())
}

/// Where days begin: a named zone with its daylight-saving rules, the
/// daemon's own local zone, or a fixed offset.
#[derive(Debug, Clone, Copy)]
pub enum Zone {
    Named(Tz),
    Local,
    Fixed(FixedOffset),
}

impl Zone {
    pub fn date(&self, at: DateTime<Utc>) -> NaiveDate {
        match self {
            Zone::Named(tz) => at.with_timezone(tz).date_naive(),
            Zone::Local => at.with_timezone(&chrono::Local).date_naive(),
            Zone::Fixed(o) => at.with_timezone(o).date_naive(),
        }
    }
    pub fn format(&self, at: DateTime<Utc>, fmt: &str) -> String {
        match self {
            Zone::Named(tz) => at.with_timezone(tz).format(fmt).to_string(),
            Zone::Local => at.with_timezone(&chrono::Local).format(fmt).to_string(),
            Zone::Fixed(o) => at.with_timezone(o).format(fmt).to_string(),
        }
    }
}

/// The zone a query names, or its fixed offset; an error says what to fix.
pub fn zone(time_zone: Option<&str>, offset_minutes: i32) -> anyhow::Result<Zone> {
    if let Some(name) = time_zone.map(str::trim).filter(|n| !n.is_empty()) {
        return name.parse::<Tz>().map(Zone::Named).map_err(|_| {
            anyhow::anyhow!(
                "timeZone must be an IANA time zone like Europe/Amsterdam, not `{name}`"
            )
        });
    }
    if offset_minutes.abs() > 18 * 60 {
        anyhow::bail!("tzOffsetMinutes must be between -1080 and 1080, not {offset_minutes}");
    }
    Ok(Zone::Fixed(
        FixedOffset::east_opt(offset_minutes * 60).unwrap(),
    ))
}

fn day(at: DateTime<Utc>, tz: Zone) -> NaiveDate {
    tz.date(at)
}

fn base_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn key_label(r: &UsageRecord, by: UsageGroupBy, tz: Zone, labels: &Labels) -> (String, String) {
    match by {
        UsageGroupBy::Day => {
            let d = day(r.at, tz).to_string();
            (d.clone(), d)
        }
        UsageGroupBy::Session => (
            r.session_id.clone(),
            labels
                .sessions
                .get(&r.session_id)
                .cloned()
                .unwrap_or_else(|| r.session_title.clone()),
        ),
        UsageGroupBy::Feature => match &r.feature_id {
            Some(f) => (
                f.clone(),
                labels
                    .features
                    .get(f)
                    .or_else(|| labels.sessions.get(f))
                    .cloned()
                    .unwrap_or_else(|| "deleted feature".into()),
            ),
            None => (String::new(), "no feature".into()),
        },
        UsageGroupBy::Project => match &r.project {
            Some(p) => (p.clone(), base_name(p)),
            None => (String::new(), "no folder".into()),
        },
        UsageGroupBy::Agent => {
            let a = r
                .agent
                .clone()
                .unwrap_or_else(|| r.provider.as_str().to_string());
            (a.clone(), a)
        }
        UsageGroupBy::Model => match &r.model {
            Some(m) => (m.clone(), m.clone()),
            None => (String::new(), "default model".into()),
        },
    }
}

fn largest_first(groups: &mut [UsageGroup]) {
    groups.sort_by(|a, b| {
        b.totals
            .cost_usd
            .total_cmp(&a.totals.cost_usd)
            .then(b.totals.tokens().cmp(&a.totals.tokens()))
            .then(a.label.cmp(&b.label))
    });
}

/// `records` grouped by `by`, in no particular order.
pub fn group(
    records: &[&UsageRecord],
    by: UsageGroupBy,
    split_by: Option<UsageGroupBy>,
    tz: Zone,
    labels: &Labels,
) -> Vec<UsageGroup> {
    let mut groups: HashMap<String, (UsageGroup, Vec<&UsageRecord>)> = HashMap::new();
    for r in records {
        let (key, label) = key_label(r, by, tz, labels);
        let g = groups.entry(key.clone()).or_insert_with(|| {
            (
                UsageGroup {
                    key,
                    label,
                    totals: UsageTotals::default(),
                    parts: vec![],
                },
                vec![],
            )
        });
        g.0.totals.add(r);
        g.1.push(r);
    }
    groups
        .into_values()
        .map(|(mut g, rs)| {
            if let Some(split) = split_by {
                g.parts = group(&rs, split, None, tz, labels);
                largest_first(&mut g.parts);
            }
            g
        })
        .collect()
}

/// Sum `records` (already limited to the range) as `q` asks.
pub fn summarize(records: &[UsageRecord], q: &UsageQuery, labels: &Labels) -> UsageSummary {
    let tz = zone(q.time_zone.as_deref(), q.tz_offset_minutes)
        .unwrap_or(Zone::Fixed(FixedOffset::east_opt(0).unwrap()));
    let mut totals = UsageTotals::default();
    for r in records {
        totals.add(r);
    }
    let refs: Vec<&UsageRecord> = records.iter().collect();
    let mut groups = group(&refs, q.group_by, q.split_by, tz, labels);
    let mut more = 0;
    if q.group_by == UsageGroupBy::Day {
        if let (Some(from), Some(to)) = (q.from, q.to) {
            let (first, last) = (day(from, tz), day(to - Duration::milliseconds(1), tz));
            if (last - first).num_days() <= MAX_FILLED_DAYS {
                let have: std::collections::HashSet<String> =
                    groups.iter().map(|g| g.key.clone()).collect();
                let mut d = first;
                while d <= last {
                    let key = d.to_string();
                    if !have.contains(&key) {
                        groups.push(UsageGroup {
                            key: key.clone(),
                            label: key,
                            totals: UsageTotals::default(),
                            parts: vec![],
                        });
                    }
                    match d.succ_opt() {
                        Some(next) => d = next,
                        None => break,
                    }
                }
            }
        }
        groups.sort_by(|a, b| a.key.cmp(&b.key));
    } else {
        largest_first(&mut groups);
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
        if groups.len() > limit {
            more = (groups.len() - limit) as u32;
            groups.truncate(limit);
        }
    }
    UsageSummary {
        from: q.from,
        to: q.to,
        group_by: q.group_by,
        totals,
        groups,
        more,
    }
}

// ---------------------------------------------------------------------------
// One session

/// One turn of a session, for the line under its reply and the session's charts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TurnUsage {
    pub turn_id: String,
    pub at: DateTime<Utc>,
    pub model: Option<String>,
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    /// Cached input read from the cache (cache reads).
    #[ts(type = "number")]
    pub cache_read_tokens: u64,
    #[ts(type = "number")]
    pub cache_write_tokens: u64,
    /// The context in use after the turn, and the model's window.
    #[ts(type = "number | null")]
    pub context_used: Option<u64>,
    #[ts(type = "number | null")]
    pub context_window: Option<u64>,
    /// Reported, or estimated when `estimated`; None without a known price.
    pub cost_usd: Option<f64>,
    pub estimated: bool,
}

impl From<&UsageRecord> for TurnUsage {
    fn from(r: &UsageRecord) -> Self {
        let cost = r.cost();
        TurnUsage {
            turn_id: r.turn_id.clone(),
            at: r.at,
            model: r.model.clone(),
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cache_read_tokens: r.cached_input_tokens.saturating_sub(r.cache_write_tokens),
            cache_write_tokens: r.cache_write_tokens,
            context_used: r.context_used,
            context_window: r.context_window,
            cost_usd: cost.map(|c| c.0),
            estimated: cost.is_some_and(|c| c.1),
        }
    }
}

/// `usage.session`'s parameters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SessionUsageQuery {
    pub id: SessionId,
    /// Also the sessions it started, at any depth (an orchestrator's workers).
    #[serde(default, alias = "include_workers")]
    pub include_workers: bool,
}

/// What one session spent, turn by turn, and its workers with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionUsage {
    pub session_id: SessionId,
    pub title: String,
    /// The session's own turns.
    pub totals: UsageTotals,
    /// Its own and its workers' together (the same as `totals` without workers).
    pub all_totals: UsageTotals,
    /// The session's own turns, oldest first.
    pub turns: Vec<TurnUsage>,
    /// Own and workers' turns by model, largest first.
    pub models: Vec<UsageGroup>,
    /// Each worker with its own workers rolled into it, largest first.
    pub workers: Vec<UsageGroup>,
}

/// Every session under `root` (not `root` itself), from what the records and
/// the live sessions (id, orchestrator) say, at any depth.
pub fn descendants(root: &str, parents: &[(String, Option<String>)]) -> Vec<String> {
    let mut found: Vec<String> = vec![];
    let mut frontier = vec![root.to_string()];
    while let Some(p) = frontier.pop() {
        for (id, parent) in parents {
            if parent.as_deref() == Some(p.as_str()) && id != root && !found.contains(id) {
                found.push(id.clone());
                frontier.push(id.clone());
            }
        }
    }
    found
}

/// Build a session's usage from its records and its workers'.
pub fn session_usage(
    root: &str,
    title: String,
    records: &[UsageRecord],
    parents: &[(String, Option<String>)],
    labels: &Labels,
) -> SessionUsage {
    let utc = Zone::Fixed(FixedOffset::east_opt(0).unwrap());
    let own: Vec<&UsageRecord> = records.iter().filter(|r| r.session_id == root).collect();
    let mut totals = UsageTotals::default();
    for r in &own {
        totals.add(r);
    }
    let mut all_totals = UsageTotals::default();
    for r in records {
        all_totals.add(r);
    }
    let all: Vec<&UsageRecord> = records.iter().collect();
    let mut models = group(&all, UsageGroupBy::Model, None, utc, labels);
    largest_first(&mut models);
    // Each direct worker, with everything under it.
    let mut workers = vec![];
    for (id, parent) in parents {
        if parent.as_deref() != Some(root) {
            continue;
        }
        let mut under = descendants(id, parents);
        under.push(id.clone());
        let mut t = UsageTotals::default();
        let mut title = None;
        for r in records.iter().filter(|r| under.contains(&r.session_id)) {
            t.add(r);
            if r.session_id == *id {
                title.get_or_insert_with(|| r.session_title.clone());
            }
        }
        if t.turns == 0 {
            continue;
        }
        workers.push(UsageGroup {
            key: id.clone(),
            label: labels
                .sessions
                .get(id)
                .cloned()
                .or(title)
                .unwrap_or_else(|| "deleted worker".into()),
            totals: t,
            parts: vec![],
        });
    }
    largest_first(&mut workers);
    SessionUsage {
        session_id: root.to_string(),
        title,
        totals,
        all_totals,
        turns: own.iter().map(|r| TurnUsage::from(*r)).collect(),
        models,
        workers,
    }
}

// ---------------------------------------------------------------------------
// Summaries in words

/// `usage.report`'s parameters.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct UsageReportQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    /// What the period is called in the summary's title ("Today", "This week").
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, alias = "tz_offset_minutes")]
    pub tz_offset_minutes: i32,
    /// As in [`UsageQuery::time_zone`].
    #[serde(default, alias = "time_zone")]
    #[ts(optional)]
    pub time_zone: Option<String>,
}

/// A usage summary for a period, made from the records alone (no model
/// writes it): totals, the biggest sessions and features, what changed
/// against the period before.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageReport {
    pub id: String,
    pub title: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub generated_at: DateTime<Utc>,
    pub totals: UsageTotals,
    /// The period of the same length right before.
    pub previous: UsageTotals,
    /// The summary as Markdown, ready to copy.
    pub markdown: String,
}

pub fn format_tokens(n: u64) -> String {
    match n {
        n if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 10_000 => format!("{:.0}k", n as f64 / 1e3),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

pub fn format_cost(c: f64) -> String {
    if c >= 100.0 {
        format!("${c:.0}")
    } else if c >= 0.995 || c == 0.0 {
        format!("${c:.2}")
    } else {
        format!("${c:.3}")
    }
}

/// "+25%" / "−10%" / "new" against `before`.
fn change(now: f64, before: f64) -> Option<String> {
    if before <= 0.0 {
        return (now > 0.0).then(|| "new".to_string());
    }
    let pct = (now - before) / before * 100.0;
    if pct.abs() < 0.5 {
        return Some("unchanged".into());
    }
    Some(if pct > 0.0 {
        format!("+{pct:.0}%")
    } else {
        format!("\u{2212}{:.0}%", -pct)
    })
}

/// Cost when known, else tokens, for comparing groups.
fn weight(t: &UsageTotals) -> f64 {
    if t.cost_usd > 0.0 {
        t.cost_usd
    } else {
        t.tokens() as f64 / 1e6
    }
}

fn totals_line(t: &UsageTotals) -> String {
    let mut s = format!(
        "{} in, {} out, {} cached over {} turn{}",
        format_tokens(t.input_tokens),
        format_tokens(t.output_tokens),
        format_tokens(t.cached_input_tokens),
        t.turns,
        if t.turns == 1 { "" } else { "s" }
    );
    if t.unpriced_turns > 0 {
        s += &format!(
            " ({} without a known price, counted in tokens only)",
            t.unpriced_turns
        );
    }
    s
}

/// Write the summary of `records` (the period's) against `previous` (the
/// period of the same length before it).
pub fn report(
    q: &UsageReportQuery,
    tz: Zone,
    records: &[UsageRecord],
    previous: &[UsageRecord],
    labels: &Labels,
    now: DateTime<Utc>,
) -> UsageReport {
    let sum = |rs: &[UsageRecord]| {
        let mut t = UsageTotals::default();
        for r in rs {
            t.add(r);
        }
        t
    };
    let totals = sum(records);
    let before = sum(previous);
    let title = q.title.clone().unwrap_or_else(|| "Usage".into());
    let fmt = "%a %-d %b %H:%M";
    let mut md = format!(
        "## Usage summary: {title}\n\n_{} \u{2013} {}_\n\n",
        tz.format(q.from, fmt),
        tz.format(q.to, fmt)
    );
    if totals.turns == 0 {
        md += "No agent turns in this period.\n";
    } else {
        let est = if totals.estimated_cost_usd > 0.0 {
            format!(
                " ({} of it estimated from list prices)",
                format_cost(totals.estimated_cost_usd)
            )
        } else {
            String::new()
        };
        md += &format!("- **Cost:** {}{est}", format_cost(totals.cost_usd));
        if let Some(c) = change(totals.cost_usd, before.cost_usd) {
            md += &format!(
                ", {c} against the period before ({})",
                format_cost(before.cost_usd)
            );
        }
        md += "\n";
        md += &format!("- **Tokens:** {}", totals_line(&totals));
        if let Some(c) = change(totals.tokens() as f64, before.tokens() as f64) {
            md += &format!(", {c} in tokens");
        }
        md += "\n";
        let refs: Vec<&UsageRecord> = records.iter().collect();
        let prev_refs: Vec<&UsageRecord> = previous.iter().collect();
        let section = |md: &mut String, heading: &str, by: UsageGroupBy, n: usize| {
            let mut gs = group(&refs, by, None, tz, labels);
            largest_first(&mut gs);
            gs.retain(|g| !(by == UsageGroupBy::Feature && g.key.is_empty()));
            if gs.is_empty() {
                return;
            }
            *md += &format!("\n### {heading}\n\n");
            for g in gs.iter().take(n) {
                *md += &format!(
                    "- {}: {} \u{00b7} {} tokens \u{00b7} {} turn{}\n",
                    g.label,
                    format_cost(g.totals.cost_usd),
                    format_tokens(g.totals.tokens()),
                    g.totals.turns,
                    if g.totals.turns == 1 { "" } else { "s" }
                );
            }
        };
        section(&mut md, "Biggest sessions", UsageGroupBy::Session, 5);
        section(&mut md, "Features", UsageGroupBy::Feature, 3);
        section(&mut md, "Models", UsageGroupBy::Model, 5);
        // What moved most against the period before, by session and model.
        let mut notes: Vec<(f64, String)> = vec![];
        for (by, what) in [
            (UsageGroupBy::Model, "Model"),
            (UsageGroupBy::Session, "Session"),
        ] {
            let now_g = group(&refs, by, None, tz, labels);
            let prev_g = group(&prev_refs, by, None, tz, labels);
            for g in &now_g {
                let p = prev_g
                    .iter()
                    .find(|p| p.key == g.key)
                    .map(|p| weight(&p.totals))
                    .unwrap_or(0.0);
                let w = weight(&g.totals);
                if p == 0.0 && by == UsageGroupBy::Model && w > 0.0 {
                    notes.push((
                        w,
                        format!("{what} {} was used for the first time in a while.", g.label),
                    ));
                } else if p > 0.0 && w >= p * 2.0 && w - p >= weight(&totals) * 0.1 {
                    notes.push((
                        w - p,
                        format!(
                            "{what} {} spent {:.1}\u{00d7} as much as the period before.",
                            g.label,
                            w / p
                        ),
                    ));
                }
            }
        }
        if totals.turns > 0 && before.turns > 0 {
            let hit = |t: &UsageTotals| {
                let input = t.input_tokens + t.cached_input_tokens;
                (input > 0)
                    .then(|| (t.cached_input_tokens - t.cache_write_tokens) as f64 / input as f64)
            };
            if let (Some(a), Some(b)) = (hit(&totals), hit(&before)) {
                if (a - b).abs() >= 0.15 {
                    notes.push((
                        0.0,
                        format!(
                            "Cache reads were {:.0}% of input, against {:.0}% before.",
                            a * 100.0,
                            b * 100.0
                        ),
                    ));
                }
            }
        }
        notes.sort_by(|a, b| b.0.total_cmp(&a.0));
        if !notes.is_empty() {
            md += "\n### Notable\n\n";
            for (_, n) in notes.iter().take(5) {
                md += &format!("- {n}\n");
            }
        }
        if totals.estimated_cost_usd > 0.0 || totals.unpriced_turns > 0 {
            md += "\n_Costs an agent did not report are estimates from list prices; turns of models without a known price count in tokens only._\n";
        }
    }
    UsageReport {
        id: crate::new_id(),
        title,
        from: q.from,
        to: q.to,
        generated_at: now,
        totals,
        previous: before,
        markdown: md,
    }
}

/// The daily summary: whether Aura writes one, and at what time of day
/// (the computer's local time). It covers the 24 hours before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct DailyUsageSettings {
    pub enabled: bool,
    /// `HH:MM`, 24-hour.
    pub time: String,
}

impl Default for DailyUsageSettings {
    fn default() -> Self {
        DailyUsageSettings {
            enabled: false,
            time: "18:00".into(),
        }
    }
}

impl DailyUsageSettings {
    pub fn parse_time(&self) -> anyhow::Result<chrono::NaiveTime> {
        chrono::NaiveTime::parse_from_str(self.time.trim(), "%H:%M").map_err(|_| {
            anyhow::anyhow!(
                "time must be HH:MM (24-hour), like 18:00, not `{}`",
                self.time
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(session: &str, at: &str, model: Option<&str>, cost: Option<f64>) -> UsageRecord {
        UsageRecord {
            session_id: session.into(),
            turn_id: format!("{session}-{at}"),
            at: at.parse().unwrap(),
            provider: ProviderKind::Codex,
            agent: None,
            model: model.map(Into::into),
            project: Some("/src/app".into()),
            feature_id: None,
            orchestrator_id: None,
            session_title: format!("title {session}"),
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            cached_input_tokens: 0,
            cache_write_tokens: 0,
            context_used: None,
            context_window: None,
            cost_usd: cost,
        }
    }

    #[test]
    fn totals_add_reported_and_estimated_costs_and_count_unpriced_turns() {
        let records = vec![
            rec("a", "2026-11-01T10:00:00Z", Some("gpt-5"), None), // 1.25 + 1.0
            rec("a", "2026-11-01T11:00:00Z", None, Some(0.5)),
            rec("b", "2026-11-02T10:00:00Z", Some("mystery"), None),
        ];
        let s = summarize(&records, &UsageQuery::default(), &Labels::default());
        assert_eq!(s.totals.turns, 3);
        assert_eq!(s.totals.input_tokens, 3_000_000);
        assert!(
            (s.totals.cost_usd - 2.75).abs() < 1e-9,
            "{}",
            s.totals.cost_usd
        );
        assert!((s.totals.estimated_cost_usd - 2.25).abs() < 1e-9);
        assert_eq!(s.totals.unpriced_turns, 1);
    }

    #[test]
    fn codex_cached_input_counts_once() {
        // Codex: 100 input of which 80 cached, and 20 output.
        let mut r = rec("a", "2026-11-01T10:00:00Z", Some("gpt-5"), None);
        r.input_tokens = UsageRecord::new_input(ProviderKind::Codex, 100, 80);
        r.cached_input_tokens = 80;
        r.output_tokens = 20;
        let t = summarize(&[r.clone()], &UsageQuery::default(), &Labels::default()).totals;
        assert_eq!(t.tokens(), 120);
        let hit = (t.cached_input_tokens - t.cache_write_tokens) as f64
            / (t.input_tokens + t.cached_input_tokens) as f64;
        assert!((hit - 0.8).abs() < 1e-9);
        // Priced the same as before: 20 uncached + 80 cached at gpt-5's prices.
        let want = (20.0 * 1.25 + 80.0 * 0.125 + 20.0 * 10.0) / 1e6;
        assert!((r.cost().unwrap().0 - want).abs() < 1e-12);
        assert_eq!(UsageRecord::new_input(ProviderKind::Claude, 100, 80), 100);
    }

    #[test]
    fn a_named_zone_puts_each_turn_on_its_own_day_across_a_dst_change() {
        // Amsterdam left summer time on Sun 25 Oct 2026 (UTC+2 to UTC+1).
        let records = vec![
            rec("a", "2026-10-24T22:30:00Z", None, Some(1.0)), // 00:30 on the 25th (+2)
            rec("a", "2026-10-25T23:30:00Z", None, Some(1.0)), // 00:30 on the 26th (+1)
        ];
        let q = UsageQuery {
            from: Some("2026-10-23T22:00:00Z".parse().unwrap()),
            to: Some("2026-10-26T23:00:00Z".parse().unwrap()),
            time_zone: Some("Europe/Amsterdam".into()),
            tz_offset_minutes: 120, // ignored with a zone
            ..Default::default()
        };
        let s = summarize(&records, &q, &Labels::default());
        let days: Vec<_> = s
            .groups
            .iter()
            .map(|g| (g.key.as_str(), g.totals.turns))
            .collect();
        assert_eq!(
            days,
            [("2026-10-24", 0), ("2026-10-25", 1), ("2026-10-26", 1)]
        );
        assert!(validate(&UsageQuery {
            time_zone: Some("Mars/Base".into()),
            ..Default::default()
        })
        .unwrap_err()
        .to_string()
        .contains("IANA"));
    }

    #[test]
    fn days_follow_the_callers_offset_and_empty_days_are_filled() {
        let records = vec![rec("a", "2026-11-01T23:30:00Z", None, Some(1.0))];
        let q = UsageQuery {
            from: Some("2026-10-31T23:00:00Z".parse().unwrap()),
            to: Some("2026-11-03T23:00:00Z".parse().unwrap()),
            tz_offset_minutes: 60,
            ..Default::default()
        };
        let s = summarize(&records, &q, &Labels::default());
        let keys: Vec<_> = s.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, ["2026-11-01", "2026-11-02", "2026-11-03"]);
        // 23:30 UTC is 00:30 the next day at +01:00.
        assert_eq!(s.groups[1].totals.turns, 1);
        assert_eq!(s.groups[0].totals.turns, 0);
    }

    #[test]
    fn groups_are_largest_first_with_live_labels_and_a_limit() {
        let records = vec![
            rec("a", "2026-11-01T10:00:00Z", None, Some(1.0)),
            rec("b", "2026-11-01T10:00:00Z", None, Some(3.0)),
            rec("c", "2026-11-01T10:00:00Z", None, Some(2.0)),
        ];
        let mut labels = Labels::default();
        labels.sessions.insert("b".into(), "Renamed".into());
        let q = UsageQuery {
            group_by: UsageGroupBy::Session,
            limit: Some(2),
            ..Default::default()
        };
        let s = summarize(&records, &q, &labels);
        let got: Vec<_> = s
            .groups
            .iter()
            .map(|g| (g.key.as_str(), g.label.as_str()))
            .collect();
        assert_eq!(got, [("b", "Renamed"), ("c", "title c")]);
        assert_eq!(s.more, 1);
        // Totals cover every group, not only those shown.
        assert_eq!(s.totals.turns, 3);
    }

    #[test]
    fn turns_without_a_model_or_feature_get_a_group_of_their_own() {
        let records = vec![rec("a", "2026-11-01T10:00:00Z", None, Some(1.0))];
        for (by, label) in [
            (UsageGroupBy::Model, "default model"),
            (UsageGroupBy::Feature, "no feature"),
            (UsageGroupBy::Project, "app"),
            (UsageGroupBy::Agent, "codex"),
        ] {
            let q = UsageQuery {
                group_by: by,
                ..Default::default()
            };
            assert_eq!(
                summarize(&records, &q, &Labels::default()).groups[0].label,
                label
            );
        }
    }

    #[test]
    fn days_split_by_model_for_stacked_bars() {
        let records = vec![
            rec("a", "2026-11-01T10:00:00Z", Some("gpt-5"), Some(1.0)),
            rec("b", "2026-11-01T11:00:00Z", Some("o3"), Some(2.0)),
            rec("b", "2026-11-01T12:00:00Z", Some("o3"), Some(2.0)),
        ];
        let q = UsageQuery {
            split_by: Some(UsageGroupBy::Model),
            ..Default::default()
        };
        let s = summarize(&records, &q, &Labels::default());
        let parts: Vec<_> = s.groups[0]
            .parts
            .iter()
            .map(|p| (p.key.as_str(), p.totals.turns))
            .collect();
        assert_eq!(parts, [("o3", 2), ("gpt-5", 1)]);
    }

    #[test]
    fn bad_queries_say_what_to_fix() {
        let q = UsageQuery {
            from: Some("2026-11-02T00:00:00Z".parse().unwrap()),
            to: Some("2026-11-01T00:00:00Z".parse().unwrap()),
            ..Default::default()
        };
        assert!(validate(&q).unwrap_err().to_string().contains("before"));
        let q: Result<UsageQuery, _> =
            serde_json::from_value(serde_json::json!({"groupBy": "planet"}));
        assert!(q.is_err());
        let q: UsageQuery = serde_json::from_value(
            serde_json::json!({"groupBy": "model", "tzOffsetMinutes": -300}),
        )
        .unwrap();
        assert_eq!(
            (q.group_by, q.tz_offset_minutes),
            (UsageGroupBy::Model, -300)
        );
    }
}
