//! aurad — the Aura daemon. Owns sessions, PTYs and adapter processes, and
//! serves them over a loopback WebSocket. Survives the desktop shell.

use anyhow::{Context, Result};
use aura_core::{Manager, Store};
use aura_rpc::server::{ExtHandler, RpcServer};
use clap::Parser;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "aurad", version, about = "Aura session daemon")]
struct Args {
    /// Data directory (default: ~/.aura or $AURA_DATA_DIR)
    #[arg(long)]
    data_dir: Option<std::path::PathBuf>,
    /// Log to stderr instead of the log file
    #[arg(long)]
    foreground: bool,
    /// Use an in-memory store (tests)
    #[arg(long)]
    ephemeral: bool,
    /// Providers to enable (default: all detected). Comma separated: claude,codex,acp,terminal
    #[arg(long)]
    providers: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let data_dir = args
        .data_dir
        .clone()
        .unwrap_or_else(aura_rpc::default_data_dir);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("create {}", data_dir.display()))?;
    init_logging(&data_dir, args.foreground)?;

    // The desktop app is launched by Launch Services, which does not read the
    // user's shell profile, so aurad inherits a bare PATH. Fix it here, before
    // anything is spawned: providers, PTY shells and git all inherit from us.
    aura_core::which::adopt_login_path();

    // Refuse to start twice. daemon.json gives the nicer message (it knows the
    // pid and port), but it is advisory: the lock below is what actually keeps a
    // second daemon off this SQLite database if that file is ever lost.
    if let Some(info) = aura_rpc::read_daemon_info(&data_dir) {
        if daemon_alive(info.port).await {
            eprintln!(
                "aurad already running (pid {}, port {})",
                info.pid, info.port
            );
            std::process::exit(2);
        }
    }
    // Held for the lifetime of the process; released by the OS on exit.
    let _data_dir_lock = match aura_rpc::lock_data_dir(&data_dir)? {
        Some(lock) => lock,
        None => {
            eprintln!(
                "aurad already running (another process holds {})",
                data_dir.join("daemon.lock").display()
            );
            std::process::exit(2);
        }
    };

    let store: Arc<dyn Store> = if args.ephemeral {
        Arc::new(aura_core::MemoryStore::default())
    } else {
        Arc::new(aura_store::SqliteStore::open(&data_dir.join("aura.db"))?)
    };

    let enabled: Vec<String> = args
        .providers
        .as_deref()
        .unwrap_or("claude,codex,acp,terminal")
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .collect();
    let mut providers: Vec<Arc<dyn aura_core::Provider>> = vec![];
    if enabled.iter().any(|p| p == "terminal") {
        providers.push(Arc::new(aura_terminal::TerminalProvider));
    }
    if enabled.iter().any(|p| p == "claude") {
        providers.push(Arc::new(aura_provider_claude::ClaudeProvider::new()));
    }
    if enabled.iter().any(|p| p == "codex") {
        providers.push(Arc::new(aura_provider_codex::CodexProvider::new()));
    }
    if enabled.iter().any(|p| p == "acp") {
        providers.push(Arc::new(aura_provider_acp::AcpProvider::new(&data_dir)));
    }

    let manager = Manager::new(store.clone(), providers, Some(Arc::new(aura_git::Git)));
    manager.enable_attachments(data_dir.join("attachments"));
    // Specialists suggested from repeated work are found by a cheap model,
    // run once and headless with Claude Code.
    manager.set_suggestion_model(Arc::new(aura_core::suggestions::ClaudeCli));
    manager.enable_orchestrator_dirs(
        std::fs::canonicalize(&data_dir)
            .unwrap_or_else(|_| data_dir.clone())
            .join("orchestrators"),
    );
    // Orchestrators get their tools from `aura mcp`, installed next to aurad.
    match std::env::current_exe()
        .map(|exe| exe.with_file_name(if cfg!(windows) { "aura.exe" } else { "aura" }))
    {
        Ok(aura) if aura.exists() => manager.enable_orchestration(
            aura,
            std::fs::canonicalize(&data_dir).unwrap_or_else(|_| data_dir.clone()),
        ),
        _ => tracing::warn!("`aura` not found next to aurad; orchestrators will have no tools"),
    }
    let restored = manager.restore()?;
    tracing::info!(restored, "sessions restored");

    // One client for every loop: they share gh's token, the caches and the rate limit.
    let github: Arc<dyn aura_github::Github> = Arc::new(aura_github::GhCli::default());
    let reviews = aura_review::ReviewService::new(
        store.clone(),
        github.clone(),
        Arc::new(aura_review::runner::CliRunner),
        manager.clone(),
        data_dir.join("review-workspaces"),
    )?;
    reviews.launch();
    let watches = aura_review::watch::WatchService::new(
        store.clone(),
        github.clone(),
        reviews.events.clone(),
    )?;
    watches.launch();
    // Review activity on a session's own PRs goes to that session's agent.
    let follows = aura_review::follow::FollowService::new(
        store,
        github.clone(),
        manager.clone(),
        reviews.events.clone(),
    )?;
    follows.launch();
    let service = reviews.clone();
    let ext: ExtHandler = Arc::new(move |method: String, params: Value| {
        let service = service.clone();
        let watches = watches.clone();
        let github = github.clone();
        Box::pin(async move {
            if let Some(result) = service.handle(&method, params.clone()).await? {
                return Ok(Some(result));
            }
            if let Some(result) = watches.handle(&method, params.clone()).await? {
                return Ok(Some(result));
            }
            if let Some(result) = github_methods(github.as_ref(), &method, &params).await? {
                return Ok(Some(result));
            }
            git_methods(&method, params).await
        })
    });
    let server = RpcServer::start_with_notifications(
        manager.clone(),
        &data_dir,
        Some(ext),
        Some(reviews.events.clone()),
    )
    .await?;
    tracing::info!(
        port = server.info.port,
        pid = server.info.pid,
        "aurad listening"
    );
    if args.foreground {
        eprintln!(
            "aurad listening on 127.0.0.1:{} (data dir {})",
            server.info.port,
            data_dir.display()
        );
    }

    let shutdown = server.shutdown.clone();
    tokio::spawn(async move {
        wait_for_signal().await;
        tracing::info!("signal received, shutting down");
        let _ = shutdown.send(());
    });

    let mut rx = server.shutdown.subscribe();
    let _ = rx.recv().await;
    reviews.shutdown();
    manager.shutdown().await;
    // Only remove daemon.json if it is still ours. A newer daemon may have
    // taken over the file while this one was being shut down; deleting it then
    // would make the next launch spawn yet another daemon.
    if aura_rpc::read_daemon_info(&data_dir).is_some_and(|i| i.pid == std::process::id()) {
        let _ = std::fs::remove_file(aura_rpc::daemon_info_path(&data_dir));
    }
    tracing::info!("aurad stopped");
    Ok(())
}

async fn daemon_alive(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/healthz");
    match tokio::time::timeout(
        std::time::Duration::from_millis(800),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Ok(mut stream)) => {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let req =
                "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".to_string();
            if stream.write_all(req.as_bytes()).await.is_err() {
                return false;
            }
            let mut buf = vec![0u8; 512];
            match tokio::time::timeout(std::time::Duration::from_millis(800), stream.read(&mut buf))
                .await
            {
                Ok(Ok(n)) => String::from_utf8_lossy(&buf[..n]).contains("200"),
                _ => false,
            }
        }
        _ => {
            let _ = url;
            false
        }
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm");
        let mut int = signal(SignalKind::interrupt()).expect("sigint");
        let mut hup = signal(SignalKind::hangup()).expect("sighup");
        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
            _ = hup.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn init_logging(data_dir: &std::path::Path, foreground: bool) -> Result<()> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,aura_core=debug,aura_provider_claude=debug,aura_provider_codex=debug,aura_provider_acp=debug"));
    if foreground {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .init();
    } else {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data_dir.join("aurad.log"))?;
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .init();
    }
    Ok(())
}

/// GitHub reads for the new-session dialog and a session's branch status.
async fn github_methods(
    gh: &dyn aura_github::Github,
    method: &str,
    params: &Value,
) -> Result<Option<Value>> {
    Ok(match method {
        "github.issues" => {
            let repo = params
                .get("repo")
                .and_then(|v| v.as_str())
                .context("repo is required")?;
            let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let today = chrono::Local::now().date_naive();
            Some(serde_json::to_value(
                aura_github::issues::open_issues(gh, repo, query, today).await?,
            )?)
        }
        "github.branch_pull" => {
            let str_param = |key: &str| {
                params
                    .get(key)
                    .and_then(|v| v.as_str())
                    .with_context(|| format!("{key} is required"))
            };
            let (repo, head_repo, branch) = (
                str_param("repo")?,
                str_param("head_repo")?,
                str_param("branch")?,
            );
            Some(serde_json::to_value(
                aura_github::branch::branch_pull(gh, repo, head_repo, branch).await?,
            )?)
        }
        _ => None,
    })
}

/// Git methods exposed to clients. All take `cwd`.
async fn git_methods(method: &str, params: Value) -> Result<Option<Value>> {
    use aura_git::ops;
    let cwd = params
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".")
        .to_string();
    let p = params.clone();
    let m = method.to_string();
    let res = tokio::task::spawn_blocking(move || -> Result<Option<Value>> {
        Ok(match m.as_str() {
            "git.repo_root" => Some(json!(ops::repo_root(&cwd)?)),
            "git.github_repo" => Some(json!(ops::github_repo(&cwd)?)),
            "git.status" => Some(serde_json::to_value(ops::status(&cwd)?)?),
            "git.diff" => {
                let opts = ops::DiffOpts {
                    path: p
                        .get("path")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    staged: p.get("staged").and_then(|v| v.as_bool()).unwrap_or(false),
                    base: p
                        .get("base")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                };
                Some(json!(ops::diff(&cwd, &opts)?))
            }
            "git.diff_stat" => {
                let base = p
                    .get("base")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                Some(serde_json::to_value(ops::diff_stat(
                    &cwd,
                    base.as_deref(),
                )?)?)
            }
            "git.branch_status" => Some(serde_json::to_value(ops::branch_status(&cwd)?)?),
            "git.current_branch" => Some(json!(ops::current_branch(&cwd)?)),
            "git.branches" => Some(json!(ops::branches(&cwd)?)),
            "git.commit" => {
                let message = p
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let all = p.get("all").and_then(|v| v.as_bool()).unwrap_or(true);
                Some(json!(ops::commit(&cwd, &message, all)?))
            }
            "git.push" => {
                let set_upstream = p
                    .get("set_upstream")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                Some(json!(ops::push(&cwd, set_upstream)?))
            }
            "git.log" => {
                let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
                Some(serde_json::to_value(ops::log(&cwd, limit)?)?)
            }
            "git.worktrees" => Some(serde_json::to_value(ops::worktrees(&cwd)?)?),
            "git.main_repo_root" => Some(json!(ops::main_repo_root(&cwd)?)),
            "git.cleanup_candidates" => {
                let fetch = p.get("fetch").and_then(|v| v.as_bool()).unwrap_or(true);
                Some(serde_json::to_value(aura_git::cleanup::candidates(
                    &cwd, fetch,
                )?)?)
            }
            "git.cleanup" => {
                let branches: Vec<String> =
                    serde_json::from_value(p.get("branches").cloned().unwrap_or_default())
                        .context("branches must be a list of names")?;
                let prune = p
                    .get("prune_worktrees")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                Some(serde_json::to_value(aura_git::cleanup::clean(
                    &cwd, &branches, prune,
                )?)?)
            }
            _ => None,
        })
    })
    .await??;
    Ok(res)
}
