//! Aura core: unified domain model, provider trait and the session manager.
//!
//! Everything the UI renders is expressed in the types of [`types`] and streamed
//! as [`event::Event`]s. Providers (Claude Code, Codex, ...) translate their
//! native protocols into these types; the [`manager::Manager`] owns sessions,
//! persists events through a [`store::Store`] and fans them out to clients.

pub mod autonomy;
pub mod event;
pub mod features;
pub mod load_balancer;
pub mod manager;
pub mod meetings;
pub mod process;
pub mod prompts;
pub mod provider;
pub mod review;
pub mod specialists;
pub mod store;
pub mod suggestions;
pub mod types;
pub mod which;

pub use autonomy::{Autonomy, AutonomyLevel, Checkpoint};
pub use event::*;
pub use features::*;
pub use load_balancer::{LoadBalancer, LoadBalancerUpdate};
pub use manager::*;
pub use meetings::{MeetingMode, MeetingSettings};
pub use prompts::SystemPrompts;
pub use provider::*;
pub use review::*;
pub use specialists::{Specialist, SpecialistInput, SpecialistScope};
pub use store::*;
pub use suggestions::{SuggestionEvidence, SuggestionSettings};
pub use types::*;

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}
