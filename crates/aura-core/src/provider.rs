use crate::event::Event;
use crate::types::*;
use anyhow::Result;
use async_trait::async_trait;

/// Where drivers publish normalized events. The manager consumes them.
pub type EventSink = tokio::sync::mpsc::UnboundedSender<Event>;

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
