use crate::driver::ClaudeDriver;
use anyhow::{bail, Result};
use async_trait::async_trait;
use aura_core::*;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;

pub struct ClaudeProvider {
    probe: aura_core::which::BinaryProbe,
    commands: Arc<Mutex<Vec<SlashCommand>>>,
}

impl Default for ClaudeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeProvider {
    /// Detects the `claude` binary and its version. Cheap enough for daemon startup;
    /// re-detected later by `Provider::refresh` when the cached probe goes stale.
    pub fn new() -> Self {
        let extra: Vec<PathBuf> = dirs::home_dir().map(|h| vec![h.join(".claude/local/claude")]).unwrap_or_default();
        Self::from_probe(aura_core::which::BinaryProbe::search("claude", "AURA_CLAUDE_BIN", extra, parse_version))
    }

    pub fn with_binary(binary: impl Into<String>) -> Self {
        Self::from_probe(aura_core::which::BinaryProbe::pinned(binary, parse_version))
    }

    fn from_probe(probe: aura_core::which::BinaryProbe) -> Self {
        probe.probe_blocking();
        Self { probe, commands: Arc::new(Mutex::new(vec![])) }
    }

    pub fn binary(&self) -> Option<String> {
        self.probe.binary()
    }

    pub fn capabilities_static() -> CapabilitySet {
        CapabilitySet {
            structured: true,
            models: true,
            effort: true,
            permission_modes: ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            sandbox_modes: vec![],
            fork: true,
            steer: false,
            interrupt: true,
            review: false,
            compact: true,
            mcp_status: false,
            skills_list: false,
            slash_commands: true,
            images: true,
            diff_stream: false,
            plan_stream: false,
            native_sessions: true,
            rename: false,
            terminal_mode: true,
        }
    }
}

/// "2.1.274 (Claude Code)" -> "2.1.274"
fn parse_version(stdout: &str) -> Option<String> {
    let first = stdout.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    Some(first.split_whitespace().next().unwrap_or(first).to_string())
}

#[async_trait]
impl Provider for ClaudeProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Claude
    }

    fn info(&self) -> ProviderInfo {
        let d = self.probe.cached();
        ProviderInfo {
            kind: ProviderKind::Claude,
            display_name: "Claude Code".into(),
            available: d.binary.is_some(),
            version: d.version,
            binary: d.binary,
            capabilities: Self::capabilities_static(),
            agents: vec![],
        }
    }

    async fn refresh(&self) {
        self.probe.refresh().await;
    }

    async fn list_native(&self) -> Result<Vec<NativeSession>> {
        let Some(dir) = crate::native::projects_dir() else { return Ok(vec![]) };
        Ok(tokio::task::spawn_blocking(move || crate::native::scan(&dir, 200)).await?)
    }

    async fn start(&self, session: &Session, fork: bool, sink: EventSink) -> Result<Box<dyn Driver>> {
        let Some(bin) = self.probe.binary() else { bail!("claude binary not found; install Claude Code or set AURA_CLAUDE_BIN") };
        let driver = ClaudeDriver::spawn(&bin, session, fork, sink, self.commands.clone()).await?;
        Ok(Box::new(driver))
    }

    fn terminal_command(&self, session: &Session) -> Vec<String> {
        let mut argv = vec![self.probe.binary().unwrap_or_else(|| "claude".into())];
        if let Some(id) = &session.native_id {
            argv.extend(["--resume".into(), id.clone()]);
        }
        if let Some(i) = &session.instructions {
            argv.extend(["--append-system-prompt".into(), i.clone()]);
        }
        argv
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"].iter().map(|s| s.to_string()).collect();
        let mk = |id: &str, name: &str, desc: &str, default: bool| ModelInfo {
            id: id.into(),
            display_name: name.into(),
            description: Some(desc.into()),
            efforts: efforts.clone(),
            default_effort: Some("high".into()),
            is_default: default,
        };
        Ok(vec![
            mk("default", "Default", "Your account's default model", true),
            mk("fable", "Fable", "Most capable Claude model", false),
            mk("opus", "Opus", "Highly capable, slower", false),
            mk("sonnet", "Sonnet", "Balanced speed and capability", false),
            mk("haiku", "Haiku", "Fastest and cheapest", false),
            mk("best", "Best", "Best available model for the account", false),
            mk("opusplan", "Opus plan", "Opus for planning, Sonnet for execution", false),
        ])
    }

    async fn list_commands(&self, _cwd: &str) -> Result<Vec<SlashCommand>> {
        let live = self.commands.lock().clone();
        if !live.is_empty() {
            return Ok(live);
        }
        // Before any session has reported its catalogue, offer the built-ins.
        Ok(["compact", "clear", "model", "effort", "config", "context", "cost", "init", "mcp", "memory", "review", "status", "usage"]
            .iter()
            .map(|n| SlashCommand { name: n.to_string(), description: None, source: Some("builtin".into()) })
            .collect())
    }
}
