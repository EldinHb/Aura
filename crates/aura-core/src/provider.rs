use crate::event::Event;
use crate::types::*;
use anyhow::Result;
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

/// Where a driver publishes normalized events. The manager consumes them,
/// and knows which of a session's drivers each came from: the events of a
/// driver that was replaced cannot change the state of the one after it.
#[derive(Clone)]
pub struct EventSink(Arc<dyn Fn(Event) -> bool + Send + Sync>);

/// The manager takes no more events: it is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SinkClosed;

impl std::fmt::Display for SinkClosed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the event sink is closed")
    }
}

impl std::error::Error for SinkClosed {}

impl EventSink {
    /// A sink that hands each event to `f`, which says whether it took it.
    pub fn new(f: impl Fn(Event) -> bool + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    /// Publish `event`; an error when no one takes events any more.
    pub fn send(&self, event: Event) -> std::result::Result<(), SinkClosed> {
        if (self.0)(event) {
            Ok(())
        } else {
            Err(SinkClosed)
        }
    }
}

impl From<UnboundedSender<Event>> for EventSink {
    fn from(tx: UnboundedSender<Event>) -> Self {
        Self::new(move |ev| tx.send(ev).is_ok())
    }
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventSink")
    }
}

/// A running structured session (one child process / one app-server thread).
#[async_trait]
pub trait Driver: Send + Sync {
    async fn send(&self, input: Input) -> Result<()>;
    async fn interrupt(&self) -> Result<()>;
    async fn respond_approval(&self, approval_id: &str, decision: ApprovalDecision) -> Result<()>;
    async fn respond_input(&self, response: UserInputResponse) -> Result<()>;
    async fn set(&self, setting: Setting) -> Result<()>;
    /// Provider specific actions exposed through `session.action` (compact, review, ...).
    async fn action(&self, name: &str, params: serde_json::Value) -> Result<serde_json::Value> {
        let _ = params;
        anyhow::bail!("action `{name}` not supported by this provider")
    }
    /// Stop the underlying process. The session remains resumable via its native id.
    async fn stop(&self) -> Result<()>;
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn info(&self) -> ProviderInfo;
    /// Re-read the CLI's presence and version if the cached probe is stale.
    /// `info` is sync and must not block, so refreshing is a separate step the
    /// manager takes before reporting. Default: nothing to detect.
    async fn refresh(&self) {}
    fn capabilities(&self) -> CapabilitySet {
        self.info().capabilities
    }
    /// Existing sessions on disk / in the provider that Aura could adopt.
    async fn list_native(&self) -> Result<Vec<NativeSession>>;
    /// Start (or resume when `session.native_id` is set) a structured session.
    async fn start(
        &self,
        session: &Session,
        fork: bool,
        sink: EventSink,
    ) -> Result<Box<dyn Driver>>;
    /// argv that opens the same session in a terminal (interactive TUI).
    fn terminal_command(&self, session: &Session) -> Vec<String>;
    /// Models available to this provider.
    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Ok(vec![])
    }
    /// Slash commands / skills known to this provider for a cwd.
    async fn list_commands(&self, cwd: &str) -> Result<Vec<SlashCommand>> {
        let _ = cwd;
        Ok(vec![])
    }
}
