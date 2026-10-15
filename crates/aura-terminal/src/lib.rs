//! The plain terminal provider: any command in a PTY, no structured mode.

use aura_core::*;

pub struct TerminalProvider;

#[async_trait::async_trait]
impl Provider for TerminalProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Terminal
    }
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Terminal,
            display_name: "Terminal".into(),
            available: true,
            version: None,
            binary: aura_pty::default_shell().first().cloned(),
            capabilities: CapabilitySet {
                terminal_mode: true,
                interrupt: true,
                rename: true,
                ..Default::default()
            },
            agents: vec![],
        }
    }
    async fn list_native(&self) -> anyhow::Result<Vec<NativeSession>> {
        Ok(vec![])
    }
    async fn start(
        &self,
        _s: &Session,
        _fork: bool,
        _sink: EventSink,
    ) -> anyhow::Result<Box<dyn Driver>> {
        anyhow::bail!("terminal sessions have no structured mode")
    }
    fn terminal_command(&self, session: &Session) -> Vec<String> {
        session
            .command
            .clone()
            .unwrap_or_else(aura_pty::default_shell)
    }
}
