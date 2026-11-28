//! Aura core: unified domain model, provider trait and the session manager.
//!
//! Everything the UI renders is expressed in the types of [`types`] and streamed
//! as [`event::Event`]s. Providers (Claude Code, Codex, ...) translate their
//! native protocols into these types; the [`manager::Manager`] owns sessions,
//! persists events through a [`store::Store`] and fans them out to clients.

pub mod autonomy;
pub mod css;
pub mod event;
pub mod features;
pub mod load_balancer;
pub mod manager;
pub mod meetings;
pub mod pricing;
pub mod process;
pub mod prompts;
pub mod provider;
pub mod schedule;
pub mod schedules;
pub mod specialists;
pub mod store;
pub mod suggestions;
pub mod templates;
pub mod test_support;
pub mod themes;
pub mod types;
pub mod usage;
pub mod which;

pub use autonomy::{Autonomy, AutonomyLevel, Checkpoint};
pub use event::*;
pub use features::*;
pub use load_balancer::{LoadBalancer, LoadBalancerUpdate};
pub use manager::*;
pub use meetings::{MeetingMode, MeetingSettings};
pub use prompts::SystemPrompts;
pub use provider::*;
pub use schedule::{
    MissedRuns, RunAs, RunResult, RunTrigger, Schedule, ScheduleSource, ScheduledRun,
    ScheduledTask, TimeOfDay, Weekday,
};
pub use schedules::{ClearHistory, Editor, HistoryCounts, ScheduleService, ScheduledTaskInput};
pub use specialists::{Specialist, SpecialistInput, SpecialistScope};
pub use store::*;
pub use suggestions::{SuggestionEvidence, SuggestionSettings};
pub use templates::{SessionTemplate, TemplateInput, TemplateKind};
pub use types::*;
pub use usage::{UsageGroup, UsageGroupBy, UsageQuery, UsageRecord, UsageSummary, UsageTotals};

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}
