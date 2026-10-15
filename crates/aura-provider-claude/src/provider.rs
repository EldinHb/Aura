use crate::driver::ClaudeDriver;
use anyhow::{bail, Result};
use async_trait::async_trait;
use aura_core::*;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a failed model fetch is served from the fallback before retrying.
const MODELS_RETRY: Duration = Duration::from_secs(60);

pub struct ClaudeProvider {
    probe: aura_core::which::BinaryProbe,
    commands: Arc<Mutex<Vec<SlashCommand>>>,
    /// Held across the fetch, so concurrent callers wait for one probe.
    models: tokio::sync::Mutex<Option<ModelCache>>,
}

/// Models as reported by one install of `claude`. A fetch that failed keeps the
/// fallback list and is retried after [`MODELS_RETRY`].
struct ModelCache {
    detected: aura_core::which::Detected,
    models: Vec<ModelInfo>,
    failed_at: Option<Instant>,
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
        let extra: Vec<PathBuf> = dirs::home_dir()
            .map(|h| vec![h.join(".claude/local/claude")])
            .unwrap_or_default();
        Self::from_probe(aura_core::which::BinaryProbe::search(
            "claude",
            "AURA_CLAUDE_BIN",
            extra,
            parse_version,
        ))
    }

    pub fn with_binary(binary: impl Into<String>) -> Self {
        Self::from_probe(aura_core::which::BinaryProbe::pinned(binary, parse_version))
    }

    fn from_probe(probe: aura_core::which::BinaryProbe) -> Self {
        probe.probe_blocking();
        Self {
            probe,
            commands: Arc::new(Mutex::new(vec![])),
            models: tokio::sync::Mutex::new(None),
        }
    }

    pub fn binary(&self) -> Option<String> {
        self.probe.binary()
    }

    pub fn capabilities_static() -> CapabilitySet {
        CapabilitySet {
            structured: true,
            models: true,
            effort: true,
            permission_modes: [
                "default",
                "acceptEdits",
                "plan",
                "dontAsk",
                "auto",
                "bypassPermissions",
            ]
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
        let Some(dir) = crate::native::projects_dir() else {
            return Ok(vec![]);
        };
        Ok(tokio::task::spawn_blocking(move || crate::native::scan(&dir, 200)).await?)
    }

    async fn start(
        &self,
        session: &Session,
        fork: bool,
        sink: EventSink,
    ) -> Result<Box<dyn Driver>> {
        let Some(bin) = self.probe.binary() else {
            bail!("claude binary not found; install Claude Code or set AURA_CLAUDE_BIN")
        };
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
        argv.extend(crate::driver::mcp_args(session));
        argv
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        // Re-detect first, so an upgraded CLI is asked again rather than served from cache.
        self.probe.refresh().await;
        let detected = self.probe.cached();
        let Some(bin) = detected.binary.clone() else {
            return Ok(fallback_models());
        };
        let mut cache = self.models.lock().await;
        if let Some(c) = cache.as_ref().filter(|c| c.detected == detected) {
            if c.failed_at.is_none_or(|at| at.elapsed() < MODELS_RETRY) {
                return Ok(c.models.clone());
            }
        }
        let (models, failed_at) = match crate::models::fetch(&bin).await {
            Ok(models) => (models, None),
            Err(e) => {
                tracing::warn!("claude: listing models failed, offering the built-in list: {e:#}");
                (fallback_models(), Some(Instant::now()))
            }
        };
        *cache = Some(ModelCache {
            detected,
            models: models.clone(),
            failed_at,
        });
        Ok(models)
    }

    async fn list_commands(&self, _cwd: &str) -> Result<Vec<SlashCommand>> {
        let live = self.commands.lock().clone();
        if !live.is_empty() {
            return Ok(live);
        }
        // Before any session has reported its catalogue, offer the built-ins.
        Ok([
            "compact", "clear", "model", "effort", "config", "context", "cost", "init", "mcp",
            "memory", "review", "status", "usage",
        ]
        .iter()
        .map(|n| SlashCommand {
            name: n.to_string(),
            description: None,
            source: Some("builtin".into()),
        })
        .collect())
    }
}

/// Offered when the CLI cannot be asked: aliases every Claude Code version accepts.
fn fallback_models() -> Vec<ModelInfo> {
    let efforts: Vec<String> = ["low", "medium", "high", "xhigh", "max"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mk = |id: &str, name: &str, desc: &str, default: bool| ModelInfo {
        id: id.into(),
        display_name: name.into(),
        description: Some(desc.into()),
        efforts: efforts.clone(),
        default_effort: Some("high".into()),
        is_default: default,
    };
    vec![
        mk("default", "Default", "Your account's default model", true),
        mk("fable", "Fable", "Most capable Claude model", false),
        mk("opus", "Opus", "Highly capable, slower", false),
        mk("sonnet", "Sonnet", "Balanced speed and capability", false),
        mk("haiku", "Haiku", "Fastest and cheapest", false),
        mk(
            "best",
            "Best",
            "Best available model for the account",
            false,
        ),
        mk(
            "opusplan",
            "Opus plan",
            "Opus for planning, Sonnet for execution",
            false,
        ),
    ]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in `claude` that reports `version` and answers initialize with
    /// `model`, or exits without answering when `model` is `None`.
    fn write_cli(path: &std::path::Path, version: &str, model: Option<&str>) {
        let answer = match model {
            Some(m) => format!(
                "read line\necho '{{\"type\":\"control_response\",\"response\":{{\"subtype\":\"success\",\"request_id\":\"aura-models\",\"response\":{{\"models\":[{{\"value\":\"{m}\"}}]}}}}}}'"
            ),
            None => "exit 1".into(),
        };
        let mut f = std::fs::File::create(path).unwrap();
        writeln!(f, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{version} (Claude Code)'; exit 0; fi\n{answer}").unwrap();
        drop(f);
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn ids(models: &[ModelInfo]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    #[tokio::test]
    async fn lists_the_models_the_cli_reports_and_refetches_after_an_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("claude");
        write_cli(&cli, "2.1.0", Some("claude-fable-5-1"));
        let p = ClaudeProvider::from_probe(
            aura_core::which::BinaryProbe::pinned(cli.to_str().unwrap(), parse_version)
                .with_ttl(Duration::from_millis(1)),
        );
        assert_eq!(ids(&p.list_models().await.unwrap()), ["claude-fable-5-1"]);

        // Same version: served from cache even though the CLI would now answer differently.
        write_cli(&cli, "2.1.0", Some("claude-other"));
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(ids(&p.list_models().await.unwrap()), ["claude-fable-5-1"]);

        write_cli(&cli, "2.1.1", Some("claude-mythos-5-1"));
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(
            ids(&p.list_models().await.unwrap()),
            ["claude-mythos-5-1"],
            "upgrade picked up"
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_builtin_list_when_the_cli_cannot_answer() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("claude");
        write_cli(&cli, "2.1.0", None);
        let p = ClaudeProvider::with_binary(cli.to_str().unwrap());
        assert_eq!(
            ids(&p.list_models().await.unwrap()),
            ids(&fallback_models())
        );
    }
}

/// Diagnostic against the installed CLI, so it is not part of the normal run:
/// `cargo test -p aura-provider-claude -- --ignored --nocapture lists_the_installed`
#[cfg(test)]
#[tokio::test]
#[ignore = "depends on the developer's own claude install"]
async fn lists_the_installed_clis_models() {
    let p = ClaudeProvider::new();
    let models = p.list_models().await.unwrap();
    for m in &models {
        println!("{:<32} {:<24} {:?}", m.id, m.display_name, m.efforts);
    }
    assert!(
        !models.iter().any(|m| m.id == "opusplan"),
        "got the fallback list, not the CLI's"
    );
}
