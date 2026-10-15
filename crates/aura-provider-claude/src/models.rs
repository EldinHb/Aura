//! The model catalogue as the installed `claude` reports it.
//!
//! Claude Code answers the stream-json `initialize` control request with the
//! same list its own `/model` picker shows, so new models appear here as soon as
//! the CLI is upgraded instead of waiting for Aura to hardcode them.

use anyhow::{anyhow, bail, Context, Result};
use aura_core::ModelInfo;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// The handshake takes well under a second; this only guards against a hung CLI.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_ID: &str = "aura-models";

/// Start `binary` without a prompt, ask for its `initialize` response and read
/// the models out of it. No user message is sent, so no model turn runs.
pub async fn fetch(binary: &str) -> Result<Vec<ModelInfo>> {
    tokio::time::timeout(FETCH_TIMEOUT, fetch_inner(binary))
        .await
        .map_err(|_| anyhow!("claude did not answer initialize within {FETCH_TIMEOUT:?}"))?
}

async fn fetch_inner(binary: &str) -> Result<Vec<ModelInfo>> {
    let mut cmd = Command::new(binary);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]);
    // A neutral directory, so no project's settings or MCP servers are loaded.
    cmd.current_dir(std::env::temp_dir());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().with_context(|| format!("spawn {binary}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

    let request = json!({"type": "control_request", "request_id": REQUEST_ID, "request": {"subtype": "initialize"}});
    stdin.write_all(format!("{request}\n").as_bytes()).await?;
    stdin.flush().await?;

    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v["type"] != "control_response" || v["response"]["request_id"] != REQUEST_ID {
            continue;
        }
        let _ = child.start_kill();
        if v["response"]["subtype"] != "success" {
            bail!("initialize failed: {}", v["response"]["error"]);
        }
        return parse(&v["response"]["response"]);
    }
    bail!("claude exited before answering initialize")
}

/// Map the `models` array of an `initialize` response onto [`ModelInfo`].
pub fn parse(init: &Value) -> Result<Vec<ModelInfo>> {
    let list = init["models"]
        .as_array()
        .ok_or_else(|| anyhow!("initialize response has no models"))?;
    let models: Vec<ModelInfo> = list
        .iter()
        .filter_map(|m| {
            let id = m["value"].as_str().filter(|s| !s.is_empty())?.to_string();
            Some(ModelInfo {
                display_name: m["displayName"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
                description: m["description"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                efforts: m["supportedEffortLevels"]
                    .as_array()
                    .map(|es| {
                        es.iter()
                            .filter_map(|e| e.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default(),
                // Claude Code does not report a per-model default effort.
                default_effort: None,
                is_default: id == "default",
                id,
            })
        })
        .collect();
    if models.is_empty() {
        bail!("initialize response lists no models");
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_initialize_models() {
        let init = json!({"models": [
            {"value": "default", "displayName": "Default (recommended)", "description": "Opus 5.5 · Best for everyday, complex tasks",
             "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]},
            {"value": "claude-mythos-5-1", "displayName": "Mythos 5.1", "description": "",
             "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]},
            {"value": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5", "description": "Fastest for quick answers"},
            {"value": "", "displayName": "Nameless"}
        ]});
        let models = parse(&init).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["default", "claude-mythos-5-1", "claude-haiku-4-5-20251001"]
        );
        assert!(models[0].is_default && !models[1].is_default);
        assert_eq!(models[1].display_name, "Mythos 5.1");
        assert_eq!(models[1].description, None, "empty description dropped");
        assert_eq!(models[1].efforts.len(), 5);
        assert!(
            models[2].efforts.is_empty(),
            "a model without effort support offers none"
        );
    }

    #[test]
    fn rejects_a_response_without_models() {
        assert!(parse(&json!({"commands": []})).is_err());
        assert!(parse(&json!({"models": []})).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_models_from_a_cli() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("claude");
        let mut f = std::fs::File::create(&cli).unwrap();
        // Noise first, like the hook events the real CLI emits before answering.
        writeln!(
            f,
            "#!/bin/sh\nread line\necho '{{\"type\":\"system\",\"subtype\":\"hook_started\"}}'"
        )
        .unwrap();
        writeln!(
            f,
            "echo '{{\"type\":\"control_response\",\"response\":{{\"subtype\":\"success\",\"request_id\":\"{REQUEST_ID}\",\"response\":{{\"models\":[{{\"value\":\"claude-mythos-5-1\",\"displayName\":\"Mythos 5.1\"}}]}}}}}}'\nsleep 30"
        )
        .unwrap();
        drop(f);
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let models = fetch(cli.to_str().unwrap()).await.unwrap();
        assert_eq!(models[0].id, "claude-mythos-5-1");
    }
}
