//! `aura.agents.runOnce`: one headless, read-only agent run.
//!
//! Generalizes the former pre-review runner (crates/aura-review/src/runner.rs):
//! the agent reads the files under `cwd` and answers on stdout, optionally
//! constrained to a JSON schema. It gets no GitHub credentials (the token
//! variables are removed and `GH_CONFIG_DIR` points at an empty directory),
//! no MCP servers, no web access and no write tools.

use crate::runtime::ModError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub prompt: String,
    pub cwd: String,
    #[serde(default)]
    pub json_schema: Option<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

pub type Progress = Arc<dyn Fn(String) + Send + Sync>;

/// The model that did most of the work in Claude's `modelUsage`.
pub fn claude_model(output: &Value) -> Option<String> {
    let usage = output.get("modelUsage")?.as_object()?;
    usage
        .iter()
        .max_by_key(|(_, u)| u.get("outputTokens").and_then(Value::as_u64).unwrap_or(0))
        .map(|(id, _)| id.clone())
}

pub async fn run_once(a: RunArgs, progress: Option<Progress>) -> Result<Value, ModError> {
    let provider = a.provider.as_str();
    let env_override = match provider {
        "codex" => "AURA_CODEX_BIN",
        "claude" => "AURA_CLAUDE_BIN",
        _ => return Err(ModError::invalid(format!("unsupported provider {provider}"))),
    };
    let bin = aura_core::which::find_binary(provider, env_override, &[])
        .ok_or_else(|| ModError::unavailable(format!("{provider} is not installed")))?;
    if !std::path::Path::new(&a.cwd).is_dir() {
        return Err(ModError::invalid(format!("{} is not a folder", a.cwd)));
    }
    let scratch = tempfile::tempdir().map_err(ModError::failed)?;
    let schema_path = scratch.path().join("schema.json");
    let output_path = scratch.path().join("result.json");
    let mut cmd = Command::new(bin);
    match provider {
        "codex" => {
            cmd.args([
                "exec",
                "-",
                "--ignore-user-config",
                "--ignore-rules",
                "--ephemeral",
                "--json",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
            ]);
            if let Some(schema) = &a.json_schema {
                tokio::fs::write(&schema_path, serde_json::to_vec(schema).map_err(ModError::failed)?)
                    .await
                    .map_err(ModError::failed)?;
                cmd.arg("--output-schema").arg(&schema_path);
            }
            cmd.arg("-o").arg(&output_path).args([
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "mcp_servers={}",
                "-c",
                "web_search=\"disabled\"",
            ]);
            if let Some(e) = &a.effort {
                cmd.args([
                    "-c",
                    &format!(
                        "model_reasoning_effort={}",
                        serde_json::to_string(e).map_err(ModError::failed)?
                    ),
                ]);
            }
        }
        _ => {
            cmd.args([
                "-p",
                "--safe-mode",
                "--restricted",
                "--disable-slash-commands",
                "--output-format",
                "json",
                "--permission-mode",
                "plan",
                "--tools",
                "Read,Grep,Glob",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--setting-sources",
                "",
            ]);
            if let Some(schema) = &a.json_schema {
                cmd.args(["--json-schema", &schema.to_string()]);
            }
            if let Some(e) = &a.effort {
                cmd.args(["--effort", e]);
            }
        }
    }
    if let Some(model) = &a.model {
        cmd.args(["--model", model]);
    }
    for name in [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
    ] {
        cmd.env_remove(name);
    }
    cmd.env("GH_CONFIG_DIR", scratch.path())
        .current_dir(&a.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (mut child, _group) = aura_core::process::spawn_job(&mut cmd)
        .map_err(|e| aura_core::process::explain_out_of_files(e, "start the agent"))
        .map_err(ModError::failed)?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let prompt = a.prompt;
    let capture = async {
        let read = |pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send>, progress: Option<Progress>| async move {
            let mut reader = BufReader::new(pipe).lines();
            let mut text = String::new();
            while let Some(line) = reader.next_line().await? {
                if let Some(p) = &progress {
                    p(line.chars().take(300).collect());
                }
                if text.len() < 8_000_000 {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            Ok::<String, std::io::Error>(text)
        };
        let input = async {
            stdin.write_all(prompt.as_bytes()).await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let (out, err, ()) = tokio::try_join!(
            read(Box::new(stdout), progress.clone()),
            read(Box::new(stderr), progress.clone()),
            input
        )?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, out, err))
    };
    let limit = Duration::from_millis(a.timeout_ms.unwrap_or(30 * 60 * 1000));
    let (status, out, err) = tokio::time::timeout(limit, capture)
        .await
        .map_err(|_| ModError::new("timeout", "the agent did not finish in time"))?
        .map_err(ModError::failed)?;
    if !status.success() {
        return Err(ModError::failed(format!(
            "Agent failed: {}",
            err.chars().take(2000).collect::<String>()
        )));
    }
    if provider == "codex" {
        let text = tokio::fs::read_to_string(&output_path)
            .await
            .map_err(|_| ModError::failed("Agent did not produce output"))?;
        let output = if a.json_schema.is_some() {
            Some(serde_json::from_str::<Value>(&text).map_err(|e| {
                ModError::failed(format!("Agent did not return valid JSON: {e}"))
            })?)
        } else {
            None
        };
        Ok(json!({"output": output, "text": text, "modelId": Value::Null}))
    } else {
        let v: Value = serde_json::from_str(&out)
            .map_err(|e| ModError::failed(format!("Claude returned no JSON: {e}")))?;
        if v["is_error"] == true {
            return Err(ModError::failed(format!("Claude reported an error: {}", v["result"])));
        }
        let output = if a.json_schema.is_some() {
            Some(
                v.get("structured_output")
                    .cloned()
                    .ok_or_else(|| ModError::failed("Claude did not return schema-constrained output"))?,
            )
        } else {
            None
        };
        Ok(json!({
            "output": output,
            "text": v.get("result").and_then(Value::as_str).unwrap_or(""),
            "modelId": claude_model(&v),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_model_is_the_one_that_wrote_most() {
        let v = json!({"modelUsage":{"claude-haiku-4-5":{"outputTokens":40},"claude-opus-5-5":{"outputTokens":900}}});
        assert_eq!(claude_model(&v).as_deref(), Some("claude-opus-5-5"));
        assert_eq!(claude_model(&json!({})), None);
    }
}
