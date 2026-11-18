//! Scheduled tasks: a prompt Aura starts a new session with each time the
//! task's schedule comes round. This module holds the types and the pure
//! schedule arithmetic; [`crate::schedules`] runs them.
//!
//! Times of day are wall-clock times in the user's time zone. A time the clock
//! skips when daylight saving time starts runs when the clock jumps (02:30 runs
//! at 03:00); a time the clock passes twice when it ends runs the first time.
//! Intervals in minutes and hours are elapsed time, so "every 2 hours" stays
//! two hours apart across a clock change. "Every N" days, weeks and months
//! count from the first run after the schedule was set.

use anyhow::{bail, Result};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A wall-clock time, `HH:MM` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, TS)]
#[ts(export, type = "string")]
pub struct TimeOfDay {
    pub hour: u32,
    pub minute: u32,
}

impl TimeOfDay {
    pub fn new(hour: u32, minute: u32) -> Result<Self> {
        if hour > 23 || minute > 59 {
            bail!("`{hour:02}:{minute:02}` is not a time of day: use HH:MM, 00:00 to 23:59");
        }
        Ok(Self { hour, minute })
    }

    fn naive(self) -> NaiveTime {
        NaiveTime::from_hms_opt(self.hour, self.minute, 0).unwrap_or(NaiveTime::MIN)
    }
}

impl std::fmt::Display for TimeOfDay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:02}:{:02}", self.hour, self.minute)
    }
}

impl std::str::FromStr for TimeOfDay {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        let bad = || anyhow::anyhow!("`{s}` is not a time of day: use HH:MM, 00:00 to 23:59");
        let (h, m) = s.trim().split_once(':').ok_or_else(bad)?;
        let (h, m) = (h.trim(), m.trim());
        if h.is_empty() || h.len() > 2 || m.len() != 2 {
            return Err(bad());
        }
        Self::new(h.parse().map_err(|_| bad())?, m.parse().map_err(|_| bad())?)
    }
}

impl Serialize for TimeOfDay {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for TimeOfDay {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(|e: anyhow::Error| serde::de::Error::custom(e.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ];

    fn of(d: NaiveDate) -> Self {
        Self::ALL[d.weekday().num_days_from_monday() as usize]
    }

    pub fn name(self) -> &'static str {
        match self {
            Weekday::Mon => "Monday",
            Weekday::Tue => "Tuesday",
            Weekday::Wed => "Wednesday",
            Weekday::Thu => "Thursday",
            Weekday::Fri => "Friday",
            Weekday::Sat => "Saturday",
            Weekday::Sun => "Sunday",
        }
    }
}

fn one() -> u32 {
    1
}

/// When a task runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "unit", rename_all = "snake_case")]
#[ts(export)]
pub enum Schedule {
    /// Every `every` minutes of elapsed time.
    Minutes {
        #[serde(default = "one")]
        every: u32,
    },
    /// Every `every` hours of elapsed time.
    Hours {
        #[serde(default = "one")]
        every: u32,
    },
    /// Every `every` days at `at`.
    Days {
        #[serde(default = "one")]
        every: u32,
        at: TimeOfDay,
    },
    /// Every `every` weeks, on each of `weekdays`, at `at`.
    Weeks {
        #[serde(default = "one")]
        every: u32,
        weekdays: Vec<Weekday>,
        at: TimeOfDay,
    },
    /// Every `every` months on day `day` (1–31) at `at`. In a month that has
    /// no such day it runs on the month's last day.
    Months {
        #[serde(default = "one")]
        every: u32,
        day: u32,
        at: TimeOfDay,
    },
}

impl Schedule {
    /// Why the schedule cannot be used, if it cannot.
    pub fn validate(&self) -> Result<()> {
        let (every, unit, max) = match self {
            Schedule::Minutes { every } => (*every, "minutes", 7 * 24 * 60),
            Schedule::Hours { every } => (*every, "hours", 365 * 24),
            Schedule::Days { every, .. } => (*every, "days", 365),
            Schedule::Weeks { every, .. } => (*every, "weeks", 52),
            Schedule::Months { every, .. } => (*every, "months", 12),
        };
        if every == 0 || every > max {
            bail!("every {every} {unit} is out of range: use 1 to {max}");
        }
        match self {
            Schedule::Weeks { weekdays, .. } if weekdays.is_empty() => {
                bail!("a weekly schedule needs at least one weekday")
            }
            Schedule::Months { day, .. } if !(1..=31).contains(day) => {
                bail!("day {day} of the month is out of range: use 1 to 31 (a day a month does not have runs on its last day)")
            }
            _ => Ok(()),
        }
    }

    /// The schedule in words, e.g. "every 2 weeks on Monday and Friday at 09:00".
    pub fn describe(&self) -> String {
        let every = |n: u32, one: &str, many: &str| {
            if n == 1 {
                format!("every {one}")
            } else {
                format!("every {n} {many}")
            }
        };
        match self {
            Schedule::Minutes { every: n } => every(*n, "minute", "minutes"),
            Schedule::Hours { every: n } => every(*n, "hour", "hours"),
            Schedule::Days { every: n, at } => format!("{} at {at}", every(*n, "day", "days")),
            Schedule::Weeks {
                every: n,
                weekdays,
                at,
            } => {
                let mut days: Vec<Weekday> = weekdays.clone();
                days.sort();
                days.dedup();
                let names: Vec<&str> = days.iter().map(|d| d.name()).collect();
                let list = match names.split_last() {
                    Some((last, [])) => last.to_string(),
                    Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
                    None => String::new(),
                };
                format!("{} on {list} at {at}", every(*n, "week", "weeks"))
            }
            Schedule::Months { every: n, day, at } => {
                let suffix = match (day % 10, day % 100) {
                    (1, 11) | (2, 12) | (3, 13) => "th",
                    (1, _) => "st",
                    (2, _) => "nd",
                    (3, _) => "rd",
                    _ => "th",
                };
                let last = if *day > 28 {
                    " (the last day in shorter months)"
                } else {
                    ""
                };
                format!(
                    "{} on the {day}{suffix}{last} at {at}",
                    every(*n, "month", "months")
                )
            }
        }
    }

    /// The first run strictly after `after`, for a schedule set at `anchor`,
    /// with wall-clock times in `tz`.
    pub fn next_after<Tz: TimeZone>(
        &self,
        tz: &Tz,
        anchor: DateTime<Utc>,
        after: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        let anchor = truncate_to_minute(anchor);
        match self {
            Schedule::Minutes { every } => interval(anchor, after, i64::from(*every).max(1)),
            Schedule::Hours { every } => interval(anchor, after, i64::from(*every).max(1) * 60),
            Schedule::Days { every, at } => {
                let every = i64::from(*every).max(1);
                // Day 0 is the first day the time comes round after the anchor.
                let mut first = local_date(tz, anchor);
                if at_local(tz, first, *at)? <= anchor {
                    first = first.succ_opt()?;
                }
                let today = local_date(tz, after);
                let k = div_ceil((today - first).num_days(), every).max(0);
                let mut d = first + Duration::days(k * every);
                loop {
                    let t = at_local(tz, d, *at)?;
                    if t > after {
                        return Some(t);
                    }
                    d += Duration::days(every);
                }
            }
            Schedule::Weeks {
                every,
                weekdays,
                at,
            } => {
                if weekdays.is_empty() {
                    return None;
                }
                let every = i64::from(*every).max(1);
                let on = |d: NaiveDate| weekdays.contains(&Weekday::of(d));
                // Week 0 is the week of the first run after the anchor.
                let mut d = local_date(tz, anchor);
                let first = loop {
                    if on(d) && at_local(tz, d, *at)? > anchor {
                        break d;
                    }
                    d = d.succ_opt()?;
                };
                let week0 = monday(first);
                let mut d = local_date(tz, after).max(first);
                // Skip whole weeks that are not ours, then look day by day.
                let weeks = (monday(d) - week0).num_days() / 7;
                let skip = (every - weeks % every) % every;
                if skip > 0 {
                    d = monday(d) + Duration::weeks(skip);
                }
                for _ in 0..(every * 7 + 14) {
                    let ours = ((monday(d) - week0).num_days() / 7) % every == 0;
                    if ours && on(d) {
                        let t = at_local(tz, d, *at)?;
                        if t > after {
                            return Some(t);
                        }
                    }
                    d = d.succ_opt()?;
                }
                None
            }
            Schedule::Months { every, day, at } => {
                let every = i64::from(*every).max(1);
                let start = local_date(tz, anchor);
                let mut first = month_index(start);
                if at_local(tz, day_in_month(first, *day)?, *at)? <= anchor {
                    first += 1;
                }
                let now = month_index(local_date(tz, after));
                let k = div_ceil(now - first, every).max(0);
                let mut m = first + k * every;
                loop {
                    let t = at_local(tz, day_in_month(m, *day)?, *at)?;
                    if t > after {
                        return Some(t);
                    }
                    m += every;
                }
            }
        }
    }

    /// The next `count` runs after `after`.
    pub fn upcoming<Tz: TimeZone>(
        &self,
        tz: &Tz,
        anchor: DateTime<Utc>,
        after: DateTime<Utc>,
        count: usize,
    ) -> Vec<DateTime<Utc>> {
        let mut out = Vec::with_capacity(count);
        let mut from = after;
        while out.len() < count {
            match self.next_after(tz, anchor, from) {
                Some(t) => {
                    out.push(t);
                    from = t;
                }
                None => break,
            }
        }
        out
    }
}

/// Runs that came due by `now`: the latest one, and how many earlier ones
/// went by unrun (the daemon was down or the machine asleep).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Due {
    /// The latest run time at or before `now`.
    pub slot: DateTime<Utc>,
    /// Run times before `slot` that were not run.
    pub skipped: u64,
}

/// Walking more runs than this to find the latest one stops and counts what it saw.
const MAX_WALK: u64 = 100_000;

/// What came due by `now` when the next run was `next`; None when it is still ahead.
pub fn due<Tz: TimeZone>(
    schedule: &Schedule,
    tz: &Tz,
    anchor: DateTime<Utc>,
    next: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<Due> {
    if next > now {
        return None;
    }
    let mut slot = next;
    let mut skipped = 0;
    while skipped < MAX_WALK {
        match schedule.next_after(tz, anchor, slot) {
            Some(t) if t <= now => {
                slot = t;
                skipped += 1;
            }
            _ => break,
        }
    }
    Some(Due { slot, skipped })
}

fn truncate_to_minute(t: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp(t.timestamp().div_euclid(60) * 60, 0).unwrap_or(t)
}

fn interval(anchor: DateTime<Utc>, after: DateTime<Utc>, minutes: i64) -> Option<DateTime<Utc>> {
    let step = Duration::minutes(minutes);
    if after < anchor {
        return Some(anchor + step);
    }
    let n = (after - anchor).num_seconds() / step.num_seconds();
    Some(anchor + step * (n as i32 + 1))
}

fn div_ceil(a: i64, b: i64) -> i64 {
    -((-a).div_euclid(b))
}

fn local_date<Tz: TimeZone>(tz: &Tz, t: DateTime<Utc>) -> NaiveDate {
    tz.from_utc_datetime(&t.naive_utc()).date_naive()
}

fn monday(d: NaiveDate) -> NaiveDate {
    d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

fn month_index(d: NaiveDate) -> i64 {
    i64::from(d.year()) * 12 + i64::from(d.month0())
}

/// Day `day` of month `index` (see [`month_index`]), or its last day when it is shorter.
fn day_in_month(index: i64, day: u32) -> Option<NaiveDate> {
    let year = i32::try_from(index.div_euclid(12)).ok()?;
    let month = (index.rem_euclid(12) + 1) as u32;
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)?
    };
    let last = (next - first).num_days() as u32;
    NaiveDate::from_ymd_opt(year, month, day.clamp(1, last))
}

/// `at` on local date `d`. A time the clock skips (daylight saving time
/// starts) is when the clock jumps; a time it passes twice is the first.
fn at_local<Tz: TimeZone>(tz: &Tz, d: NaiveDate, at: TimeOfDay) -> Option<DateTime<Utc>> {
    let mut naive = NaiveDateTime::new(d, at.naive());
    // Clock changes skip at most a few hours; look a day ahead to be safe.
    for _ in 0..=(24 * 60) {
        match tz.from_local_datetime(&naive) {
            LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => {
                return Some(t.with_timezone(&Utc))
            }
            LocalResult::None => naive += Duration::minutes(1),
        }
    }
    None
}

/// What happens to runs that went by while Aura was not running (or the
/// machine was asleep).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MissedRuns {
    /// Run once when Aura is back, however many went by.
    #[default]
    RunOnce,
    /// Run none of them; wait for the next time.
    Skip,
}

/// Who created a task when it was not the user.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScheduleSource {
    pub orchestrator: String,
    pub orchestrator_title: String,
}

/// A prompt Aura starts a new session with on a schedule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    /// The first message of every session the task starts.
    pub prompt: String,
    /// `claude`, `codex` or an ACP agent's id.
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox_mode: Option<String>,
    /// The folder or repository the sessions work in.
    pub cwd: String,
    /// Each run works in a new git worktree of `cwd`, on a branch of its own.
    #[serde(default)]
    pub worktree: bool,
    /// The start of each run's branch name, which ends in the run's time.
    /// Defaults to `scheduled/<task name>`.
    #[serde(default)]
    pub branch_prefix: Option<String>,
    /// The sidebar group of the sessions it starts.
    #[serde(default)]
    pub group: Option<String>,
    pub enabled: bool,
    pub schedule: Schedule,
    #[serde(default)]
    pub missed: MissedRuns,
    /// Start a run while the previous one is still working. Off: that run is
    /// skipped and recorded as skipped.
    #[serde(default)]
    pub allow_overlap: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// When the schedule was last set; "every N" counts from here.
    pub anchor: DateTime<Utc>,
    /// The latest run time handled (run, skipped or let go); runs before it are done.
    #[serde(default)]
    pub last_slot: Option<DateTime<Utc>>,
    /// The next time it runs; None while it is disabled.
    #[serde(default)]
    pub next_run: Option<DateTime<Utc>>,
    /// The latest entry of its history.
    #[serde(default)]
    pub last_run: Option<ScheduledRun>,
    /// The orchestrator that created it; None when the user did.
    #[serde(default)]
    pub created_by: Option<ScheduleSource>,
}

impl ScheduledTask {
    /// The next run after the runs already handled, with times in `tz`.
    pub fn compute_next<Tz: TimeZone>(&self, tz: &Tz) -> Option<DateTime<Utc>> {
        if !self.enabled {
            return None;
        }
        let from = self.last_slot.map_or(self.anchor, |s| s.max(self.anchor));
        self.schedule.next_after(tz, self.anchor, from)
    }
}

/// Why a run happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunTrigger {
    /// Its time came.
    Schedule,
    /// Runs went by while Aura was not running; this is the one run that makes up for them.
    CatchUp,
    /// Someone chose Run now.
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunResult {
    /// A session started.
    Started,
    /// No session started, on purpose: the previous run was still working,
    /// or the run went by while Aura was not running.
    Skipped,
    /// Starting the session failed.
    Failed,
}

/// One entry of a task's history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScheduledRun {
    pub id: String,
    pub task_id: String,
    /// When it happened.
    pub at: DateTime<Utc>,
    /// The run time it was for; None for Run now.
    #[serde(default)]
    pub slot: Option<DateTime<Utc>>,
    pub trigger: RunTrigger,
    pub result: RunResult,
    /// The session it started.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_title: Option<String>,
    /// Why it was skipped or failed, or what else happened.
    #[serde(default)]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::{America::New_York, Europe::Amsterdam, Tz};

    /// A wall-clock time in `tz`, in UTC.
    fn at(tz: &Tz, s: &str) -> DateTime<Utc> {
        let naive = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        tz.from_local_datetime(&naive)
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
    }

    fn local(tz: &Tz, t: DateTime<Utc>) -> String {
        t.with_timezone(tz).format("%Y-%m-%d %H:%M %a").to_string()
    }

    fn runs(tz: &Tz, s: &Schedule, anchor: &str, n: usize) -> Vec<String> {
        let a = at(tz, anchor);
        s.upcoming(tz, a, a, n)
            .into_iter()
            .map(|t| local(tz, t))
            .collect()
    }

    fn time(s: &str) -> TimeOfDay {
        s.parse().unwrap()
    }

    #[test]
    fn times_of_day_read_and_print_as_hh_mm() {
        assert_eq!(time("9:05"), TimeOfDay { hour: 9, minute: 5 });
        assert_eq!(time("23:59").to_string(), "23:59");
        for bad in ["24:00", "12:60", "12", "12:5", "ab:cd", ""] {
            assert!(bad.parse::<TimeOfDay>().is_err(), "{bad}");
        }
        let json = serde_json::to_string(&time("07:30")).unwrap();
        assert_eq!(json, "\"07:30\"");
        assert_eq!(
            serde_json::from_str::<TimeOfDay>(&json).unwrap(),
            time("07:30")
        );
    }

    #[test]
    fn schedules_read_as_the_ui_and_tools_write_them() {
        let s: Schedule = serde_json::from_value(serde_json::json!({
            "unit": "weeks", "every": 2, "weekdays": ["mon", "fri"], "at": "09:00"
        }))
        .unwrap();
        assert_eq!(
            s,
            Schedule::Weeks {
                every: 2,
                weekdays: vec![Weekday::Mon, Weekday::Fri],
                at: time("09:00")
            }
        );
        let m: Schedule = serde_json::from_value(
            serde_json::json!({ "unit": "months", "day": 31, "at": "08:00" }),
        )
        .unwrap();
        assert_eq!(
            m,
            Schedule::Months {
                every: 1,
                day: 31,
                at: time("08:00")
            }
        );
    }

    #[test]
    fn schedules_out_of_range_are_refused() {
        for bad in [
            Schedule::Minutes { every: 0 },
            Schedule::Hours { every: 9000 },
            Schedule::Days {
                every: 0,
                at: time("09:00"),
            },
            Schedule::Weeks {
                every: 1,
                weekdays: vec![],
                at: time("09:00"),
            },
            Schedule::Months {
                every: 1,
                day: 32,
                at: time("09:00"),
            },
            Schedule::Months {
                every: 13,
                day: 1,
                at: time("09:00"),
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        Schedule::Minutes { every: 1 }.validate().unwrap();
    }

    #[test]
    fn schedules_describe_themselves() {
        assert_eq!(Schedule::Minutes { every: 1 }.describe(), "every minute");
        assert_eq!(Schedule::Hours { every: 3 }.describe(), "every 3 hours");
        assert_eq!(
            Schedule::Days {
                every: 1,
                at: time("09:00")
            }
            .describe(),
            "every day at 09:00"
        );
        assert_eq!(
            Schedule::Weeks {
                every: 2,
                weekdays: vec![Weekday::Fri, Weekday::Mon, Weekday::Wed],
                at: time("17:30")
            }
            .describe(),
            "every 2 weeks on Monday, Wednesday and Friday at 17:30"
        );
        assert_eq!(
            Schedule::Months {
                every: 1,
                day: 31,
                at: time("08:00")
            }
            .describe(),
            "every month on the 31st (the last day in shorter months) at 08:00"
        );
        assert_eq!(
            Schedule::Months {
                every: 3,
                day: 12,
                at: time("08:00")
            }
            .describe(),
            "every 3 months on the 12th at 08:00"
        );
    }

    #[test]
    fn minutes_count_from_when_the_schedule_was_set() {
        let tz = &Amsterdam;
        let s = Schedule::Minutes { every: 15 };
        assert_eq!(
            runs(tz, &s, "2026-11-18 10:07", 3),
            [
                "2026-11-18 10:22 Wed",
                "2026-11-18 10:37 Wed",
                "2026-11-18 10:52 Wed"
            ]
        );
        // From any moment, the next one on the same grid.
        let a = at(tz, "2026-11-18 10:07");
        let next = s.next_after(tz, a, at(tz, "2026-11-18 13:00")).unwrap();
        assert_eq!(local(tz, next), "2026-11-18 13:07 Wed");
        // Exactly on a run time, the next is the one after.
        let next = s.next_after(tz, a, at(tz, "2026-11-18 13:07")).unwrap();
        assert_eq!(local(tz, next), "2026-11-18 13:22 Wed");
    }

    #[test]
    fn hours_are_elapsed_time_across_a_clock_change() {
        let tz = &Amsterdam;
        // Clocks go forward at 02:00 on 29 March 2026: 01:30 to 03:30 is one hour.
        let s = Schedule::Hours { every: 1 };
        assert_eq!(
            runs(tz, &s, "2026-03-29 00:30", 3),
            [
                "2026-03-29 01:30 Sun",
                "2026-03-29 03:30 Sun",
                "2026-03-29 04:30 Sun"
            ]
        );
        // Clocks go back at 03:00 on 25 October 2026: 02:30 comes twice, an hour apart.
        let a = at(tz, "2026-10-25 01:30");
        let got: Vec<i64> = s
            .upcoming(tz, a, a, 3)
            .windows(2)
            .map(|w| (w[1] - w[0]).num_minutes())
            .collect();
        assert_eq!(got, [60, 60]);
    }

    #[test]
    fn days_run_at_the_wall_clock_time_across_daylight_saving_time() {
        let tz = &Amsterdam;
        let s = Schedule::Days {
            every: 1,
            at: time("09:00"),
        };
        // Set after 09:00: the first run is the next morning, and every
        // morning keeps 09:00 local through the change on 29 March.
        assert_eq!(
            runs(tz, &s, "2026-03-27 10:00", 4),
            [
                "2026-03-28 09:00 Sat",
                "2026-03-29 09:00 Sun",
                "2026-03-30 09:00 Mon",
                "2026-03-31 09:00 Tue"
            ]
        );
        let a = at(tz, "2026-03-27 10:00");
        let gaps: Vec<i64> = s
            .upcoming(tz, a, a, 3)
            .windows(2)
            .map(|w| (w[1] - w[0]).num_hours())
            .collect();
        assert_eq!(
            gaps,
            [23, 24],
            "the night the clock goes forward is shorter"
        );
        // Set before 09:00: today.
        assert_eq!(
            runs(tz, &s, "2026-03-27 08:00", 1),
            ["2026-03-27 09:00 Fri"]
        );
    }

    #[test]
    fn a_time_the_clock_skips_runs_when_it_jumps_and_a_repeated_time_runs_once() {
        let tz = &Amsterdam;
        let s = Schedule::Days {
            every: 1,
            at: time("02:30"),
        };
        assert_eq!(
            runs(tz, &s, "2026-03-27 12:00", 3),
            [
                "2026-03-28 02:30 Sat",
                "2026-03-29 03:00 Sun",
                "2026-03-30 02:30 Mon"
            ]
        );
        // 02:30 happens twice on 25 October; it runs at the first one only.
        let a = at(tz, "2026-10-24 12:00");
        let got = s.upcoming(tz, a, a, 3);
        assert_eq!(
            got.iter().map(|t| local(tz, *t)).collect::<Vec<_>>(),
            [
                "2026-10-25 02:30 Sun",
                "2026-10-26 02:30 Mon",
                "2026-10-27 02:30 Tue"
            ]
        );
        assert_eq!(
            got[0].with_timezone(tz).format("%z").to_string(),
            "+0200",
            "the first 02:30, still on summer time"
        );
        // New York changes on other dates (8 March and 1 November 2026).
        let ny = &New_York;
        assert_eq!(
            runs(ny, &s, "2026-03-07 12:00", 2),
            ["2026-03-08 03:00 Sun", "2026-03-09 02:30 Mon"]
        );
    }

    #[test]
    fn every_few_days_counts_from_the_first_run() {
        let tz = &Amsterdam;
        let s = Schedule::Days {
            every: 3,
            at: time("07:00"),
        };
        assert_eq!(
            runs(tz, &s, "2026-11-18 08:00", 3),
            [
                "2026-11-19 07:00 Thu",
                "2026-11-22 07:00 Sun",
                "2026-11-25 07:00 Wed"
            ]
        );
        let a = at(tz, "2026-11-18 08:00");
        let next = s.next_after(tz, a, at(tz, "2026-11-23 12:00")).unwrap();
        assert_eq!(local(tz, next), "2026-11-25 07:00 Wed");
    }

    #[test]
    fn weeks_run_on_the_chosen_days_of_every_nth_week() {
        let tz = &Amsterdam;
        let s = Schedule::Weeks {
            every: 1,
            weekdays: vec![Weekday::Mon, Weekday::Thu],
            at: time("09:30"),
        };
        // Wednesday 18 November 2026.
        assert_eq!(
            runs(tz, &s, "2026-11-18 12:00", 4),
            [
                "2026-11-19 09:30 Thu",
                "2026-11-23 09:30 Mon",
                "2026-11-26 09:30 Thu",
                "2026-11-30 09:30 Mon"
            ]
        );
        // Every other week, counted from the week of the first run: set on a
        // Sunday for Mondays, the first is the next day, then two weeks on.
        let s = Schedule::Weeks {
            every: 2,
            weekdays: vec![Weekday::Mon],
            at: time("09:00"),
        };
        assert_eq!(
            runs(tz, &s, "2026-11-22 12:00", 3),
            [
                "2026-11-23 09:00 Mon",
                "2026-12-07 09:00 Mon",
                "2026-12-21 09:00 Mon"
            ]
        );
        let a = at(tz, "2026-11-22 12:00");
        let next = s.next_after(tz, a, at(tz, "2026-11-30 10:00")).unwrap();
        assert_eq!(local(tz, next), "2026-12-07 09:00 Mon");
        // Across the end of summer time the local time stays.
        let s = Schedule::Weeks {
            every: 1,
            weekdays: vec![Weekday::Sun],
            at: time("10:00"),
        };
        assert_eq!(
            runs(tz, &s, "2026-10-17 12:00", 3),
            [
                "2026-10-18 10:00 Sun",
                "2026-10-25 10:00 Sun",
                "2026-11-01 10:00 Sun"
            ]
        );
    }

    #[test]
    fn a_day_a_month_lacks_runs_on_its_last_day() {
        let tz = &Amsterdam;
        let s = Schedule::Months {
            every: 1,
            day: 31,
            at: time("08:00"),
        };
        assert_eq!(
            runs(tz, &s, "2026-01-15 12:00", 6),
            [
                "2026-01-31 08:00 Sat",
                "2026-02-28 08:00 Sat",
                "2026-03-31 08:00 Tue",
                "2026-04-30 08:00 Thu",
                "2026-05-31 08:00 Sun",
                "2026-06-30 08:00 Tue"
            ]
        );
        // The 29th in a leap year's February, and the 30th.
        let s = Schedule::Months {
            every: 1,
            day: 30,
            at: time("08:00"),
        };
        assert_eq!(
            runs(tz, &s, "2028-01-31 12:00", 2),
            ["2028-02-29 08:00 Tue", "2028-03-30 08:00 Thu"]
        );
        // Every three months, counted from the first run; past the time on
        // the day it was set, the first run is next month.
        let s = Schedule::Months {
            every: 3,
            day: 1,
            at: time("06:00"),
        };
        assert_eq!(
            runs(tz, &s, "2026-11-01 07:00", 3),
            [
                "2026-12-01 06:00 Tue",
                "2027-03-01 06:00 Mon",
                "2027-06-01 06:00 Tue"
            ]
        );
    }

    #[test]
    fn missed_runs_are_counted_and_only_the_latest_is_due() {
        let tz = &Amsterdam;
        let s = Schedule::Hours { every: 1 };
        let a = at(tz, "2026-11-18 08:00");
        let next = s.next_after(tz, a, a).unwrap();
        // Not yet.
        assert_eq!(due(&s, tz, a, next, at(tz, "2026-11-18 08:59")), None);
        // On time: one run, nothing missed.
        assert_eq!(
            due(&s, tz, a, next, at(tz, "2026-11-18 09:00")),
            Some(Due {
                slot: next,
                skipped: 0
            })
        );
        // Down from 08:30 to 13:10: 09:00 to 13:00 came due, five runs, one is due.
        let d = due(&s, tz, a, next, at(tz, "2026-11-18 13:10")).unwrap();
        assert_eq!(local(tz, d.slot), "2026-11-18 13:00 Wed");
        assert_eq!(d.skipped, 4);
        // A daily task down over two mornings.
        let s = Schedule::Days {
            every: 1,
            at: time("09:00"),
        };
        let a = at(tz, "2026-11-16 08:00");
        let next = s.next_after(tz, a, a).unwrap();
        let d = due(&s, tz, a, next, at(tz, "2026-11-18 12:00")).unwrap();
        assert_eq!(local(tz, d.slot), "2026-11-18 09:00 Wed");
        assert_eq!(d.skipped, 2);
    }

    #[test]
    fn a_task_continues_after_the_runs_it_handled() {
        let tz = &Amsterdam;
        let a = at(tz, "2026-11-16 08:00");
        let mut task = ScheduledTask {
            id: "t".into(),
            name: "n".into(),
            prompt: "p".into(),
            agent: "claude".into(),
            model: None,
            effort: None,
            permission_mode: None,
            sandbox_mode: None,
            cwd: "/tmp".into(),
            worktree: false,
            branch_prefix: None,
            group: None,
            enabled: true,
            schedule: Schedule::Days {
                every: 1,
                at: time("09:00"),
            },
            missed: MissedRuns::RunOnce,
            allow_overlap: false,
            created_at: a,
            updated_at: a,
            anchor: a,
            last_slot: None,
            next_run: None,
            last_run: None,
            created_by: None,
        };
        assert_eq!(
            local(tz, task.compute_next(tz).unwrap()),
            "2026-11-16 09:00 Mon"
        );
        task.last_slot = Some(at(tz, "2026-11-18 09:00"));
        assert_eq!(
            local(tz, task.compute_next(tz).unwrap()),
            "2026-11-19 09:00 Thu"
        );
        task.enabled = false;
        assert_eq!(task.compute_next(tz), None);
    }
}
