//! Aura core: unified domain model, provider trait and the session manager.
//!
//! Everything the UI renders is expressed in the types of [`types`] and streamed
//! as [`event::Event`]s. Providers (Claude Code, Codex, ...) translate their
//! native protocols into these types; the [`manager::Manager`] owns sessions,
//! persists events through a [`store::Store`] and fans them out to clients.

pub mod event;
pub mod manager;
pub mod process;
pub mod provider;
pub mod review;
pub mod store;
pub mod types;
pub mod which;

pub use event::*;
pub use manager::*;
pub use provider::*;
pub use review::*;
pub use store::*;
pub use types::*;

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}
