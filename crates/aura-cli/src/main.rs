//! aura — command line client for the Aura daemon.

use anyhow::{anyhow, bail, Context, Result};
use aura_core::*;
use aura_rpc::client::RpcClient;
use clap::{Parser, Subcommand};
use serde_json::json;
use std::io::Write;

mod mcp;

#[derive(Parser, Debug)]
#[command(
    name = "aura",
    version,
    about = "Aura: keyboard-first manager for AI coding CLI sessions"
)]
struct Cli {
    /// Data directory (default: ~/.aura or $AURA_DATA_DIR)
    #[arg(long, global = true)]
    data_dir: Option<std::path::PathBuf>,
    /// Output JSON instead of tables
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// List sessions
    Ls {
        #[arg(long)]
        all: bool,
    },
    /// Create a session
    New {
        /// claude | codex | acp | terminal
        #[arg(short, long, default_value = "terminal")]
        provider: String,
        /// ACP agent id (gemini, opencode, goose, ... or one from acp-agents.json). Implies --provider acp
        #[arg(long)]
        agent: Option<String>,
        /// Working directory. Defaults to the current one; an orchestrator without it belongs to no folder
        #[arg(short, long)]
        cwd: Option<String>,
        #[arg(short, long)]
        title: Option<String>,
        #[arg(short, long)]
        group: Option<String>,
        /// First message for AI providers
        #[arg(long)]
        prompt: Option<String>,
        /// System prompt for this session, added after the global and per-agent ones
        #[arg(long)]
        system_prompt: Option<String>,
        /// Create a git worktree on this branch
        #[arg(long)]
        branch: Option<String>,
        /// Make the session an orchestrator that starts and directs other sessions
        #[arg(long)]
        orchestrator: bool,
        /// Resume this native session id
        #[arg(long)]
        resume: Option<String>,
        /// Attach after creating (terminal sessions)
        #[arg(short, long)]
        attach: bool,
        /// Command for terminal sessions
        #[arg(last = true)]
        command: Vec<String>,
    },
    /// Attach to a terminal session (Ctrl+\ detaches)
    Attach { id: String },
    /// Send a message to a session
    Send { id: String, text: Vec<String> },
    /// Interrupt the running turn
    Interrupt { id: String },
    /// Stop the process behind a session (keeps it resumable)
    Kill { id: String },
    /// Delete a session and its history
    Rm {
        id: String,
        #[arg(long)]
        worktree: bool,
    },
    /// Switch a session between structured and terminal mode
    Mode { id: String, mode: String },
    /// Print pending approvals and questions
    Pending,
    /// Approve or decline a pending approval: aura approve <session> <approval> [accept|session|decline]
    Approve {
        id: String,
        approval_id: String,
        #[arg(default_value = "accept")]
        decision: String,
    },
    /// Stream events as JSON lines
    Events,
    /// Show a session's history as JSON lines
    History { id: String },
    /// Manage the daemon
    Daemon {
        #[command(subcommand)]
        cmd: DaemonCmd,
    },
    /// List providers
    Providers,
    /// Serve an orchestrator's tools over MCP on stdin/stdout (Aura starts this itself)
    Mcp {
        /// The orchestrator session the tools act for
        #[arg(long)]
        orchestrator: String,
    },
}

#[derive(Subcommand, Debug)]
enum DaemonCmd {
    Start,
    Stop,
    Status,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let data_dir = cli
        .data_dir
        .clone()
        .unwrap_or_else(aura_rpc::default_data_dir);
    if let Cmd::Daemon { cmd } = &cli.cmd {
        return daemon_cmd(&data_dir, cmd).await;
    }
    if let Cmd::Mcp { orchestrator } = cli.cmd {
        return mcp::run(data_dir, orchestrator).await;
    }
    let client = connect_or_start(&data_dir).await?;
    match cli.cmd {
        Cmd::Ls { all } => {
            let mut sessions: Vec<Session> = client.call_as("session.list", json!({})).await?;
            if !all {
                sessions.retain(|s| !s.archived);
            }
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&sessions)?);
            } else {
                println!(
                    "{:<10} {:<9} {:<17} {:<11} {:<30} CWD",
                    "ID", "PROVIDER", "STATUS", "MODE", "TITLE"
                );
                for s in sessions {
                    println!(
                        "{:<10} {:<9} {:<17} {:<11} {:<30} {}",
                        &s.id[..8],
                        s.agent.as_deref().unwrap_or(s.provider.as_str()),
                        format!(
                            "{:?}{}",
                            s.status,
                            if s.pending_count > 0 {
                                format!("({})", s.pending_count)
                            } else {
                                String::new()
                            }
                        ),
                        format!("{:?}", s.mode),
                        truncate(&s.title, 30),
                        s.cwd
                    );
                }
            }
        }
        Cmd::New {
            provider,
            agent,
            cwd,
            title,
            group,
            prompt,
            system_prompt,
            branch,
            orchestrator,
            resume,
            attach,
            command,
        } => {
            let mut provider = ProviderKind::parse(&provider)
                .ok_or_else(|| anyhow!("unknown provider {provider}"))?;
            if agent.is_some() {
                if !matches!(provider, ProviderKind::Acp | ProviderKind::Terminal) {
                    anyhow::bail!(
                        "--agent selects an ACP agent; it cannot be combined with --provider {}",
                        provider.as_str()
                    );
                }
                provider = ProviderKind::Acp;
            }
            // An orchestrator without --cwd belongs to no folder.
            let cwd = match cwd {
                Some(c) => c,
                None if orchestrator && branch.is_none() => String::new(),
                None => std::env::current_dir()?.to_string_lossy().to_string(),
            };
            let opts = CreateSessionOpts {
                provider,
                agent,
                cwd,
                title,
                group,
                command: if command.is_empty() {
                    None
                } else {
                    Some(command)
                },
                initial_prompt: prompt,
                system_prompt,
                resume_native_id: resume,
                worktree: branch.map(|b| WorktreeOpts {
                    branch: b,
                    base: None,
                    path: None,
                }),
                orchestrator,
                ..Default::default()
            };
            let s: Session = client
                .call_as("session.create", serde_json::to_value(opts)?)
                .await?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&s)?);
            } else {
                println!("{} {}", s.id, s.title);
            }
            if attach && s.mode == SessionMode::Terminal {
                attach_session(&client, &s.id).await?;
            }
        }
        Cmd::Attach { id } => {
            let id = resolve(&client, &id).await?;
            attach_session(&client, &id).await?;
        }
        Cmd::Send { id, text } => {
            let id = resolve(&client, &id).await?;
            client
                .call(
                    "session.send",
                    json!({ "id": id, "input": { "text": text.join(" ") } }),
                )
                .await?;
        }
        Cmd::Interrupt { id } => {
            let id = resolve(&client, &id).await?;
            client
                .call("session.interrupt", json!({ "id": id }))
                .await?;
        }
        Cmd::Kill { id } => {
            let id = resolve(&client, &id).await?;
            client.call("session.stop", json!({ "id": id })).await?;
        }
        Cmd::Rm { id, worktree } => {
            let id = resolve(&client, &id).await?;
            client
                .call(
                    "session.delete",
                    json!({ "id": id, "remove_worktree": worktree }),
                )
                .await?;
        }
        Cmd::Mode { id, mode } => {
            let id = resolve(&client, &id).await?;
            let s: Session = client
                .call_as("session.switch_mode", json!({ "id": id, "mode": mode }))
                .await?;
            println!("{} now in {:?} mode", &s.id[..8], s.mode);
        }
        Cmd::Pending => {
            let v = client.call("session.pending", json!({})).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Cmd::Approve {
            id,
            approval_id,
            decision,
        } => {
            let id = resolve(&client, &id).await?;
            let option = match decision.as_str() {
                "accept" | "y" => ApprovalOption::Accept,
                "session" | "Y" => ApprovalOption::AcceptForSession,
                "decline" | "n" => ApprovalOption::Decline,
                "cancel" => ApprovalOption::Cancel,
                other => bail!("unknown decision {other}"),
            };
            client
                .call(
                    "session.respond_approval",
                    json!({ "id": id, "approval_id": approval_id, "decision": ApprovalDecision { option, updated_input: None, message: None } }),
                )
                .await?;
        }
        Cmd::Events => {
            let mut rx = client.events();
            loop {
                match rx.recv().await {
                    Ok(ev) => println!("{}", serde_json::to_string(&ev)?),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
        Cmd::History { id } => {
            let id = resolve(&client, &id).await?;
            let v = client.call("session.history", json!({ "id": id })).await?;
            for e in v.as_array().cloned().unwrap_or_default() {
                println!("{}", serde_json::to_string(&e)?);
            }
        }
        Cmd::Providers => {
            let v = client.call("provider.list", json!({})).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        Cmd::Daemon { .. } | Cmd::Mcp { .. } => unreachable!(),
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let t: String = s.chars().take(n - 1).collect();
        format!("{t}…")
    }
}

async fn resolve(client: &RpcClient, prefix: &str) -> Result<String> {
    let sessions: Vec<Session> = client.call_as("session.list", json!({})).await?;
    let matches: Vec<&Session> = sessions
        .iter()
        .filter(|s| s.id.starts_with(prefix) || s.title == prefix)
        .collect();
    match matches.len() {
        1 => Ok(matches[0].id.clone()),
        0 => bail!("no session matches {prefix}"),
        _ => bail!("ambiguous prefix {prefix}"),
    }
}

async fn daemon_cmd(data_dir: &std::path::Path, cmd: &DaemonCmd) -> Result<()> {
    match cmd {
        DaemonCmd::Start => {
            if RpcClient::connect_from_dir(data_dir).await.is_ok() {
                println!("daemon already running");
                return Ok(());
            }
            spawn_daemon(data_dir)?;
            wait_for_daemon(data_dir).await?;
            let info = aura_rpc::read_daemon_info(data_dir).unwrap();
            println!("aurad started (pid {}, port {})", info.pid, info.port);
        }
        DaemonCmd::Stop => match RpcClient::connect_from_dir(data_dir).await {
            Ok(c) => {
                let _ = c.call("daemon.shutdown", json!({})).await;
                println!("stop requested");
            }
            Err(_) => println!("daemon not running"),
        },
        DaemonCmd::Status => match RpcClient::connect_from_dir(data_dir).await {
            Ok(c) => {
                if let Some(why) = c.mismatch() {
                    eprintln!("warning: {why}");
                }
                let v = c.call("daemon.info", json!({})).await?;
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
            Err(e) => println!("daemon not running: {e}"),
        },
    }
    Ok(())
}

/// Find `aurad` next to this binary (or on PATH) and start it detached.
pub fn spawn_daemon(data_dir: &std::path::Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let sibling = exe.with_file_name(if cfg!(windows) { "aurad.exe" } else { "aurad" });
    let bin = if sibling.exists() {
        sibling
    } else {
        std::path::PathBuf::from("aurad")
    };
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("--data-dir").arg(data_dir);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New session so the daemon survives the terminal / shell exiting.
        unsafe {
            cmd.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .with_context(|| format!("spawn {}", bin.display()))?;
    Ok(())
}

#[cfg(unix)]
fn libc_setsid() {
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        setsid();
    }
}

async fn wait_for_daemon(data_dir: &std::path::Path) -> Result<()> {
    for _ in 0..100 {
        if RpcClient::connect_from_dir(data_dir).await.is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    bail!("daemon did not come up within 10s")
}

/// Connect, starting the daemon when none runs. A daemon of another version is
/// used as it is, with a warning: replacing it would stop every session on it,
/// including the orchestrator `aura mcp` may be serving.
async fn connect_or_start(data_dir: &std::path::Path) -> Result<RpcClient> {
    let c = match RpcClient::connect_from_dir(data_dir).await {
        Ok(c) => c,
        Err(_) => {
            spawn_daemon(data_dir)?;
            wait_for_daemon(data_dir).await?;
            RpcClient::connect_from_dir(data_dir).await?
        }
    };
    if let Some(why) = c.mismatch() {
        eprintln!("warning: {why}");
    }
    Ok(c)
}

/// Raw-mode passthrough to a terminal session.
async fn attach_session(client: &RpcClient, id: &str) -> Result<()> {
    use crossterm::terminal;
    let s: Session = client.call_as("session.get", json!({ "id": id })).await?;
    if s.mode != SessionMode::Terminal {
        bail!(
            "session {} is in structured mode; use `aura mode {} terminal` first",
            &id[..8],
            &id[..8]
        );
    }
    let att = client.call("pty.attach", json!({ "id": id })).await?;
    let (cols, rows) = terminal::size().unwrap_or((120, 40));
    client
        .call(
            "pty.resize",
            json!({ "id": id, "cols": cols, "rows": rows }),
        )
        .await?;
    terminal::enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    if let Some(sb) = att["scrollback"].as_str() {
        use base64::Engine;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(sb) {
            let _ = stdout.write_all(&bytes);
            let _ = stdout.flush();
        }
    }
    let mut out_rx = client.pty_output();
    let mut ev_rx = client.events();
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut resize = tokio::time::interval(std::time::Duration::from_millis(500));
    let mut last_size = (cols, rows);
    let result: Result<()> = async {
        loop {
            tokio::select! {
                Some(data) = stdin_rx.recv() => {
                    if data.contains(&0x1c) { // Ctrl+\ detaches
                        break;
                    }
                    client.pty_input(id, &data).await?;
                }
                Ok((sid, data)) = out_rx.recv() => {
                    if sid == id {
                        stdout.write_all(&data)?;
                        stdout.flush()?;
                    }
                }
                Ok(ev) = ev_rx.recv() => {
                    if let Event::ProcessExited { session_id, exit_code, .. } = ev {
                        if session_id == id {
                            let _ = write!(stdout, "\r\n[session exited with code {:?}]\r\n", exit_code);
                            break;
                        }
                    }
                }
                _ = resize.tick() => {
                    if let Ok(sz) = terminal::size() {
                        if sz != last_size {
                            last_size = sz;
                            client.call("pty.resize", json!({ "id": id, "cols": sz.0, "rows": sz.1 })).await?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    .await;
    let _ = terminal::disable_raw_mode();
    let _ = client.call("pty.detach", json!({ "id": id })).await;
    println!();
    result
}
