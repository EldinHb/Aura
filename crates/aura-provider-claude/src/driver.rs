//! One `claude -p` child process per structured session.

use crate::parser::{OutboundControl, Parser};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use aura_core::*;
use base64::Engine;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};

pub struct ClaudeDriver {
    #[allow(dead_code)]
    session_id: String,
    sink: EventSink,
    parser: Arc<Mutex<Parser>>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    /// Ask the wait task to kill the child.
    kill_tx: tokio::sync::mpsc::UnboundedSender<()>,
    /// Resolves with the exit code once the child is gone.
    exit_rx: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<Option<i32>>>>,
}

impl ClaudeDriver {
    pub async fn spawn(
        binary: &str,
        session: &Session,
        fork: bool,
        sink: EventSink,
        commands: Arc<Mutex<Vec<SlashCommand>>>,
    ) -> Result<Self> {
        let _ = &commands;
        let mut cmd = Command::new(binary);
        cmd.args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--replay-user-messages",
            "--forward-subagent-text",
            "--permission-prompt-tool",
            "stdio",
        ]);
        if let Some(id) = &session.native_id {
            cmd.args(["--resume", id]);
            if fork {
                cmd.arg("--fork-session");
            }
        }
        if let Some(m) = &session.model {
            cmd.args(["--model", m]);
        }
        if let Some(p) = &session.permission_mode {
            cmd.args(["--permission-mode", p]);
        }
        if let Some(e) = &session.effort {
            cmd.args(["--effort", e]);
        }
        cmd.current_dir(&session.cwd);
        cmd.env("AURA_SESSION_ID", &session.id);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().with_context(|| format!("spawn {binary}"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let parser = Arc::new(Mutex::new(Parser::new(&session.id)));
        let (kill_tx, mut kill_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<Option<i32>>();
        let driver = Self {
            session_id: session.id.clone(),
            sink: sink.clone(),
            parser: parser.clone(),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            kill_tx,
            exit_rx: tokio::sync::Mutex::new(Some(exit_rx)),
        };

        // stderr -> debug log, keep a tail for error reporting.
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "claude.stderr", "{line}");
                    let mut t = tail.lock();
                    t.push(line);
                    if t.len() > 20 {
                        t.remove(0);
                    }
                }
            });
        }

        // stdout -> parser -> sink
        {
            let parser = parser.clone();
            let sink = sink.clone();
            let commands = commands.clone();
            let sid = session.id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            let line = line.trim();
                            if line.is_empty() {
                                continue;
                            }
                            let v: Value = match serde_json::from_str(line) {
                                Ok(v) => v,
                                Err(e) => {
                                    tracing::debug!("claude: non-json stdout line ({e}): {line}");
                                    continue;
                                }
                            };
                            let events = {
                                let mut p = parser.lock();
                                let evs = p.handle_line(&v);
                                if !p.commands.is_empty() {
                                    *commands.lock() = p.commands.clone();
                                }
                                evs
                            };
                            for ev in events {
                                let _ = sink.send(ev);
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            tracing::debug!("claude: stdout read error for {sid}: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // Wait for exit in the background; report it.
        {
            let parser = parser.clone();
            let sink = sink.clone();
            let sid = session.id.clone();
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let code = tokio::select! {
                    status = child.wait() => status.ok().and_then(|s| s.code()),
                    _ = kill_rx.recv() => {
                        let _ = child.start_kill();
                        child.wait().await.ok().and_then(|s| s.code())
                    }
                };
                // Give the stdout task a moment to flush the last lines.
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let mut evs = parser.lock().drain_open_items();
                let message = if code.map(|c| c != 0).unwrap_or(true) {
                    let t = tail.lock().join("\n");
                    if t.trim().is_empty() {
                        Some(format!("claude exited with code {:?}", code))
                    } else {
                        Some(t)
                    }
                } else {
                    None
                };
                evs.push(Event::ProcessExited { session_id: sid.clone(), exit_code: code, message });
                for ev in evs {
                    let _ = sink.send(ev);
                }
                let _ = exit_tx.send(code);
            });
        }
        Ok(driver)
    }

    async fn write_json(&self, v: &Value) -> Result<()> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| anyhow!("claude process is not running"))?;
        let mut line = serde_json::to_string(v)?;
        line.push('\n');
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn control_request(&self, request: Value, kind: OutboundControl) -> Result<()> {
        let id = format!("aura-{}", uuid::Uuid::new_v4());
        self.parser.lock().note_outbound(&id, kind);
        self.write_json(&json!({"type": "control_request", "request_id": id, "request": request})).await
    }

    async fn send_text(&self, text: &str) -> Result<()> {
        self.send(Input { text: text.to_string(), ..Default::default() }).await
    }
}

#[async_trait]
impl Driver for ClaudeDriver {
    async fn send(&self, input: Input) -> Result<()> {
        let mut content: Vec<Value> = vec![];
        for img in &input.images {
            let (data, media) = match (&img.data, &img.path) {
                (Some(d), _) => (d.clone(), img.media_type.clone().unwrap_or_else(|| "image/png".into())),
                (None, Some(p)) => {
                    let bytes = tokio::fs::read(p).await.with_context(|| format!("read image {p}"))?;
                    let media = img.media_type.clone().unwrap_or_else(|| guess_media_type(p));
                    (base64::engine::general_purpose::STANDARD.encode(bytes), media)
                }
                (None, None) => continue,
            };
            content.push(json!({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}));
        }
        if !input.text.is_empty() || content.is_empty() {
            content.push(json!({"type": "text", "text": input.text}));
        }
        let events = self.parser.lock().start_turn(&input.text);
        for ev in events {
            let _ = self.sink.send(ev);
        }
        self.write_json(&json!({"type": "user", "message": {"role": "user", "content": content}})).await
    }

    async fn interrupt(&self) -> Result<()> {
        self.control_request(json!({"subtype": "interrupt"}), OutboundControl::Interrupt).await
    }

    async fn respond_approval(&self, approval_id: &str, decision: ApprovalDecision) -> Result<()> {
        let payload = self
            .parser
            .lock()
            .approval_response(approval_id, &decision)
            .ok_or_else(|| anyhow!("unknown approval {approval_id}"))?;
        self.write_json(&payload).await
    }

    async fn respond_input(&self, response: UserInputResponse) -> Result<()> {
        let payload = self
            .parser
            .lock()
            .input_response(&response)
            .ok_or_else(|| anyhow!("unknown input request {}", response.request_id))?;
        self.write_json(&payload).await
    }

    async fn set(&self, setting: Setting) -> Result<()> {
        match setting {
            Setting::PermissionMode(mode) => {
                self.control_request(
                    json!({"subtype": "set_permission_mode", "mode": mode}),
                    OutboundControl::SetPermissionMode(mode.clone()),
                )
                .await
            }
            Setting::Model(m) => self.send_text(&format!("/model {m}")).await,
            Setting::Effort(e) => self.send_text(&format!("/effort {e}")).await,
            Setting::SandboxMode(_) => bail!("Claude Code has no sandbox mode setting"),
        }
    }

    async fn action(&self, name: &str, params: Value) -> Result<Value> {
        match name {
            "compact" => {
                let instr = params.get("instructions").and_then(Value::as_str).unwrap_or("");
                self.send_text(format!("/compact {instr}").trim_end()).await?;
                Ok(json!({"ok": true}))
            }
            "slash" => {
                let cmd = params.get("command").and_then(Value::as_str).ok_or_else(|| anyhow!("missing command"))?;
                self.send_text(cmd).await?;
                Ok(json!({"ok": true}))
            }
            other => bail!("action `{other}` not supported by Claude provider"),
        }
    }

    async fn stop(&self) -> Result<()> {
        // Closing stdin makes claude finish the current turn and exit.
        {
            let mut guard = self.stdin.lock().await;
            if let Some(mut stdin) = guard.take() {
                let _ = stdin.shutdown().await;
            }
        }
        let rx = self.exit_rx.lock().await.take();
        if let Some(rx) = rx {
            if tokio::time::timeout(std::time::Duration::from_secs(5), rx).await.is_err() {
                let _ = self.kill_tx.send(());
            }
        }
        Ok(())
    }
}

fn guess_media_type(path: &str) -> String {
    match std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
    .to_string()
}

impl Drop for ClaudeDriver {
    fn drop(&mut self) {
        // Ensure the child does not outlive the driver if `stop` was never called.
        let _ = self.kill_tx.send(());
    }
}
