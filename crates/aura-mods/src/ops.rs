//! What a mod's `aura.*` calls do, with the permission checks of its manifest.

use crate::agents;
use crate::host::Inner;
use crate::http::{self, FetchArgs};
use crate::manifest::Permissions;
use crate::runtime::{ModError, OpResult, Ops};
use crate::storage::{collection_ns, kv_ns, sessions_ns, SETTINGS_NS};
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::process::Stdio;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// The ops of one mod. Holds the host weakly: the host owns the runtimes that own these.
pub struct ModOps {
    pub(crate) host: Weak<Inner>,
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) data_dir: std::path::PathBuf,
    pub(crate) permissions: Permissions,
}

fn arg<T: for<'de> Deserialize<'de>>(args: &Value, key: &str) -> Result<T, ModError> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| ModError::invalid(format!("{key}: {e}")))
}

fn opt<T: for<'de> Deserialize<'de>>(args: &Value, key: &str) -> Result<Option<T>, ModError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| ModError::invalid(format!("{key}: {e}"))),
    }
}

fn str_arg(args: &Value, key: &str) -> Result<String, ModError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ModError::invalid(format!("{key} is required")))
}

fn name_arg(args: &Value, key: &str) -> Result<String, ModError> {
    let v = str_arg(args, key)?;
    if v.is_empty() || v.len() > 512 {
        return Err(ModError::invalid(format!("{key} must be 1 to 512 characters")));
    }
    Ok(v)
}

impl ModOps {
    fn host(&self) -> Result<Arc<Inner>, ModError> {
        self.host
            .upgrade()
            .ok_or_else(|| ModError::unavailable("Aura is shutting down"))
    }

    fn need(&self, ok: bool, what: &str) -> Result<(), ModError> {
        if ok {
            Ok(())
        } else {
            Err(ModError::denied(format!(
                "{} has no permission to {what} (see permissions in its mod.json)",
                self.id
            )))
        }
    }

    fn info(&self) -> OpResult {
        let host = self.host()?;
        Ok(json!({
            "id": self.id,
            "version": self.version,
            "dataDir": self.data_dir.to_string_lossy(),
            "platform": if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" },
            "settings": host.settings_of(&self.id),
        }))
    }
}

impl Ops for ModOps {
    fn sync_op(&self, op: &str, args: Value) -> OpResult {
        match op {
            "info" => self.info(),
            "uuid" => Ok(json!(uuid::Uuid::new_v4().to_string())),
            "log" => {
                let level = args["level"].as_str().unwrap_or("info");
                let message = args["message"].as_str().unwrap_or("");
                match level {
                    "error" => tracing::error!(mod_id = %self.id, "{message}"),
                    "warn" => tracing::warn!(mod_id = %self.id, "{message}"),
                    "debug" => tracing::debug!(mod_id = %self.id, "{message}"),
                    _ => tracing::info!(mod_id = %self.id, "{message}"),
                }
                if let Ok(host) = self.host() {
                    host.log(&self.id, level, message);
                }
                Ok(Value::Null)
            }
            "emit" => {
                let name = name_arg(&args, "name")?;
                self.host()?.emit(&self.id, &name, args.get("payload").cloned().unwrap_or(Value::Null));
                Ok(Value::Null)
            }
            "notify" => {
                self.host()?.broadcast(
                    "mods.notify",
                    json!({"modId": self.id, "title": args["title"], "body": args["body"], "target": args["target"]}),
                );
                Ok(Value::Null)
            }
            "events.subscribe" => {
                let types: Vec<String> = arg(&args, "types")?;
                if !types.is_empty() {
                    self.need(self.permissions.reads_sessions(), "read sessions and their events")?;
                }
                self.host()?.set_event_types(&self.id, types.into_iter().collect());
                Ok(Value::Null)
            }
            "mods.subscribe" => {
                let subs: Vec<(String, String)> = arg(&args, "subs")?;
                for (m, _) in &subs {
                    self.need(self.permissions.mods.contains(m), &format!("listen to mod {m}"))?;
                }
                self.host()?.set_mod_subs(&self.id, subs.into_iter().collect());
                Ok(Value::Null)
            }
            "tools.set" => {
                let tools: Vec<Value> = arg(&args, "tools")?;
                if !tools.is_empty() {
                    self.need(self.permissions.orchestrator_tools, "offer orchestrator tools")?;
                }
                self.host()?.set_tools(&self.id, tools);
                Ok(Value::Null)
            }
            other => Err(ModError::invalid(format!("unknown op {other}"))),
        }
    }

    fn async_op(&self, op: &str, args: Value) -> BoxFuture<'static, OpResult> {
        let op = op.to_string();
        let me = ModOps {
            host: self.host.clone(),
            id: self.id.clone(),
            version: self.version.clone(),
            data_dir: self.data_dir.clone(),
            permissions: self.permissions.clone(),
        };
        Box::pin(async move { me.run(&op, args).await })
    }
}

impl ModOps {
    async fn run(&self, op: &str, a: Value) -> OpResult {
        let host = self.host()?;
        let id = self.id.as_str();
        let p = &self.permissions;
        let records = &host.records;
        match op {
            "sleep" => {
                let ms = a["ms"].as_u64().unwrap_or(0).min(24 * 60 * 60 * 1000);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(Value::Null)
            }

            // ---- storage ----
            "kv.get" => Ok(records.get(&kv_ns(id), &name_arg(&a, "key")?)?.unwrap_or(Value::Null)),
            "kv.set" => {
                records.put(&kv_ns(id), &name_arg(&a, "key")?, &a["value"])?;
                Ok(Value::Null)
            }
            "kv.delete" => {
                records.delete(&kv_ns(id), &name_arg(&a, "key")?)?;
                Ok(Value::Null)
            }
            "kv.keys" => {
                let prefix = a["prefix"].as_str().unwrap_or("");
                Ok(json!(records
                    .all(&kv_ns(id))?
                    .into_iter()
                    .map(|(k, _)| k)
                    .filter(|k| k.starts_with(prefix))
                    .collect::<Vec<_>>()))
            }
            "collection.get" => Ok(records
                .get(&collection_ns(id, &name_arg(&a, "name")?), &name_arg(&a, "id")?)?
                .unwrap_or(Value::Null)),
            "collection.put" => {
                records.put(&collection_ns(id, &name_arg(&a, "name")?), &name_arg(&a, "id")?, &a["doc"])?;
                Ok(Value::Null)
            }
            "collection.delete" => {
                records.delete(&collection_ns(id, &name_arg(&a, "name")?), &name_arg(&a, "id")?)?;
                Ok(Value::Null)
            }
            "collection.all" => Ok(json!(records
                .all(&collection_ns(id, &name_arg(&a, "name")?))?
                .into_iter()
                .map(|(k, v)| json!([k, v]))
                .collect::<Vec<_>>())),
            "collection.clear" => {
                records.clear(&collection_ns(id, &name_arg(&a, "name")?))?;
                Ok(Value::Null)
            }
            "settings.set" => {
                host.set_setting(id, &name_arg(&a, "key")?, a["value"].clone())?;
                Ok(Value::Null)
            }

            // ---- sessions ----
            "sessions.list" => {
                self.need(p.reads_sessions(), "read sessions")?;
                Ok(serde_json::to_value(host.manager.list_sessions()).map_err(ModError::failed)?)
            }
            "sessions.get" => {
                self.need(p.reads_sessions(), "read sessions")?;
                Ok(host
                    .manager
                    .get_session(&str_arg(&a, "id")?)
                    .ok()
                    .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null))
            }
            "sessions.lastReply" => {
                self.need(p.reads_sessions(), "read sessions")?;
                Ok(json!(host.manager.last_reply(&str_arg(&a, "id")?)))
            }
            "sessions.create" => {
                self.need(p.writes_sessions(), "start sessions")?;
                let opts: aura_core::CreateSessionOpts = arg(&a, "opts")?;
                let s = host.manager.create_session(opts).await?;
                Ok(serde_json::to_value(s).map_err(ModError::failed)?)
            }
            "sessions.send" => {
                self.need(p.writes_sessions(), "send to sessions")?;
                let sid = str_arg(&a, "id")?;
                let text = str_arg(&a, "text")?;
                if a["whenFree"].as_bool().unwrap_or(false) {
                    host.manager.send_when_free(&sid, text).await?;
                } else {
                    let input: aura_core::Input =
                        serde_json::from_value(json!({"text": text})).map_err(ModError::failed)?;
                    host.manager.send(&sid, input).await?;
                }
                Ok(Value::Null)
            }
            "sessions.interrupt" => {
                self.need(p.writes_sessions(), "interrupt sessions")?;
                host.manager.interrupt(&str_arg(&a, "id")?).await?;
                Ok(Value::Null)
            }
            "sessions.stop" => {
                self.need(p.writes_sessions(), "stop sessions")?;
                host.manager.stop(&str_arg(&a, "id")?).await?;
                Ok(Value::Null)
            }
            "sessionData.get" => {
                self.need(p.reads_sessions(), "read session data")?;
                Ok(records
                    .get_field(&sessions_ns(id), &str_arg(&a, "id")?, &name_arg(&a, "key")?)?
                    .unwrap_or(Value::Null))
            }
            "sessionData.all" => {
                self.need(p.reads_sessions(), "read session data")?;
                Ok(records
                    .get(&sessions_ns(id), &str_arg(&a, "id")?)?
                    .unwrap_or_else(|| json!({})))
            }
            "sessionData.with" => {
                self.need(p.reads_sessions(), "read session data")?;
                let key = name_arg(&a, "key")?;
                Ok(json!(records
                    .all(&sessions_ns(id))?
                    .into_iter()
                    .filter_map(|(sid, doc)| doc.get(&key).filter(|v| !v.is_null()).cloned().map(|v| json!([sid, v])))
                    .collect::<Vec<_>>()))
            }
            "sessionData.set" | "sessionData.delete" => {
                self.need(p.writes_sessions(), "store session data")?;
                let sid = str_arg(&a, "id")?;
                if host.manager.get_session(&sid).is_err() {
                    return Err(ModError::new("not_found", format!("no session {sid}")));
                }
                let value = (op == "sessionData.set").then(|| a["value"].clone()).filter(|v| !v.is_null());
                records.set_field(&sessions_ns(id), &sid, &name_arg(&a, "key")?, value)?;
                Ok(Value::Null)
            }

            // ---- files, inside the mod's data dir only ----
            op if op.starts_with("fs.") => self.fs_op(op, &a).await,

            // ---- git ----
            op if op.starts_with("git.") => {
                self.need(p.git, "use git")?;
                git_op(op, a).await
            }

            // ---- processes and HTTP ----
            "process.run" => {
                let bin = str_arg(&a, "bin")?;
                self.need(p.process.contains(&bin), &format!("run {bin}"))?;
                run_process(&bin, &a).await
            }
            "http.fetch" => {
                let args: FetchArgs = serde_json::from_value(a).map_err(|e| ModError::invalid(e.to_string()))?;
                let h = http::host_of(&args.url)?;
                self.need(p.allows_host(&h), &format!("reach {h}"))?;
                host.http.fetch(id, args).await
            }

            // ---- agents ----
            "agents.providers" => {
                self.need(p.agents, "use agents")?;
                let list = host.manager.providers().await;
                Ok(json!(list
                    .into_iter()
                    .map(|i| json!({"kind": i.kind, "available": i.available, "version": i.version}))
                    .collect::<Vec<_>>()))
            }
            "agents.models" => {
                self.need(p.agents, "use agents")?;
                let kind: aura_core::ProviderKind = arg(&a, "provider")?;
                Ok(serde_json::to_value(host.manager.list_models(kind).await?).map_err(ModError::failed)?)
            }
            "agents.runOnce" => {
                self.need(p.agents, "run agents")?;
                let run_id = a["runId"].clone();
                let progress: Option<agents::Progress> = if a["progress"].as_bool().unwrap_or(false) {
                    let weak = self.host.clone();
                    let mod_id = self.id.clone();
                    Some(Arc::new(move |line: String| {
                        if let Some(h) = weak.upgrade() {
                            h.dispatch_to(&mod_id, "progress", json!({"runId": run_id, "line": line}));
                        }
                    }))
                } else {
                    None
                };
                let cancel_id = a.get("id").and_then(Value::as_str).map(|i| format!("{id}\u{0}{i}"));
                let args: agents::RunArgs = serde_json::from_value(a).map_err(|e| ModError::invalid(e.to_string()))?;
                let Some(key) = cancel_id else {
                    return agents::run_once(args, progress).await;
                };
                let (tx, rx) = tokio::sync::oneshot::channel::<()>();
                host.runs.lock().insert(key.clone(), tx);
                // Dropping the run's future kills the agent (its process is kill_on_drop).
                let result = tokio::select! {
                    r = agents::run_once(args, progress) => r,
                    _ = rx => Err(ModError::new("cancelled", "the agent run was cancelled")),
                };
                host.runs.lock().remove(&key);
                result
            }
            "agents.cancel" => {
                self.need(p.agents, "run agents")?;
                let key = format!("{id}\u{0}{}", str_arg(&a, "id")?);
                let found = host.runs.lock().remove(&key);
                Ok(json!(found.map(|tx| tx.send(()).is_ok()).unwrap_or(false)))
            }

            // ---- other mods, inbox ----
            "mods.call" => {
                let target = str_arg(&a, "modId")?;
                self.need(p.mods.contains(&target), &format!("call mod {target}"))?;
                let name = name_arg(&a, "name")?;
                host.call_mod(&target, &name, a["params"].clone(), json!({"kind": "mod", "id": id}))
                    .await
            }
            "inbox.set" => {
                let items: Vec<Value> = arg(&a, "items")?;
                host.set_inbox(id, items);
                Ok(Value::Null)
            }
            other => Err(ModError::invalid(format!("unknown op {other}"))),
        }
    }
}

impl ModOps {
    /// A path under the mod's data dir; `..` and absolute paths elsewhere are refused.
    fn data_path(&self, a: &Value, key: &str) -> Result<std::path::PathBuf, ModError> {
        let raw = str_arg(a, key)?;
        let p = std::path::Path::new(&raw);
        let full = if p.is_absolute() { p.to_path_buf() } else { self.data_dir.join(p) };
        let mut clean = std::path::PathBuf::new();
        for c in full.components() {
            match c {
                std::path::Component::ParentDir => {
                    if !clean.pop() {
                        return Err(ModError::denied(format!("{raw} is outside the mod's data folder")));
                    }
                }
                std::path::Component::CurDir => {}
                other => clean.push(other.as_os_str()),
            }
        }
        if !clean.starts_with(&self.data_dir) {
            return Err(ModError::denied(format!("{raw} is outside the mod's data folder")));
        }
        Ok(clean)
    }

    async fn fs_op(&self, op: &str, a: &Value) -> OpResult {
        let io = |e: std::io::Error| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ModError::new("not_found", e.to_string())
            } else {
                ModError::failed(e)
            }
        };
        let path = self.data_path(a, "path")?;
        match op {
            "fs.exists" => Ok(json!(tokio::fs::try_exists(&path).await.unwrap_or(false))),
            "fs.readText" => Ok(json!(tokio::fs::read_to_string(&path).await.map_err(io)?)),
            "fs.writeText" => {
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(io)?;
                }
                tokio::fs::write(&path, str_arg(a, "text")?).await.map_err(io)?;
                Ok(Value::Null)
            }
            "fs.mkdir" => {
                tokio::fs::create_dir_all(&path).await.map_err(io)?;
                Ok(Value::Null)
            }
            "fs.remove" => {
                match tokio::fs::metadata(&path).await {
                    Ok(m) if m.is_dir() => tokio::fs::remove_dir_all(&path).await.map_err(io)?,
                    Ok(_) => tokio::fs::remove_file(&path).await.map_err(io)?,
                    Err(_) => {}
                }
                Ok(Value::Null)
            }
            "fs.rename" => {
                let to = self.data_path(a, "to")?;
                if let Some(parent) = to.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(io)?;
                }
                tokio::fs::rename(&path, &to).await.map_err(io)?;
                Ok(Value::Null)
            }
            "fs.list" => {
                let mut out = vec![];
                let mut rd = tokio::fs::read_dir(&path).await.map_err(io)?;
                while let Some(e) = rd.next_entry().await.map_err(io)? {
                    let dir = e.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                    out.push(json!({"name": e.file_name().to_string_lossy(), "dir": dir}));
                }
                Ok(json!(out))
            }
            other => Err(ModError::invalid(format!("unknown op {other}"))),
        }
    }
}

async fn git_op(op: &str, a: Value) -> OpResult {
    use aura_git::ops;
    let cwd = str_arg(&a, "cwd")?;
    if op == "git.run" {
        let args: Vec<String> = arg(&a, "args")?;
        let ok_codes: Vec<i32> = opt(&a, "okCodes")?.unwrap_or_default();
        let timeout = Duration::from_millis(opt::<u64>(&a, "timeoutMs")?.unwrap_or(10 * 60 * 1000));
        let env: BTreeMap<String, Option<String>> = opt(&a, "env")?.unwrap_or_default();
        let mut cmd = tokio::process::Command::new("git");
        // Never wait for credentials on a terminal nobody sees.
        cmd.arg("-C").arg(&cwd).args(&args).env("GIT_TERMINAL_PROMPT", "0");
        for (k, v) in env {
            match v {
                Some(v) => cmd.env(k, v),
                None => cmd.env_remove(k),
            };
        }
        let out = output(cmd, opt(&a, "stdin")?, timeout).await?;
        let code = out.status.code().unwrap_or(-1);
        if !out.status.success() && !ok_codes.contains(&code) {
            return Err(ModError {
                code: "failed".into(),
                message: format!(
                    "git {} failed ({}): {}",
                    args.join(" "),
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
                data: Some(json!({"exitCode": code, "stderr": String::from_utf8_lossy(&out.stderr)})),
            });
        }
        return Ok(json!(String::from_utf8_lossy(&out.stdout)));
    }
    let op = op.to_string();
    tokio::task::spawn_blocking(move || -> OpResult {
        Ok(match op.as_str() {
            "git.repoRoot" => json!(ops::repo_root(&cwd)?),
            "git.mainRepoRoot" => json!(ops::main_repo_root(&cwd)?),
            "git.currentBranch" => json!(ops::current_branch(&cwd).ok()),
            "git.branchStatus" => serde_json::to_value(ops::branch_status(&cwd)?).map_err(ModError::failed)?,
            "git.remotes" => json!(remotes(&cwd)?),
            other => return Err(ModError::invalid(format!("unknown op {other}"))),
        })
    })
    .await
    .map_err(ModError::failed)?
}

/// `git remote -v`, one entry per remote (its fetch URL).
pub fn remotes(cwd: &str) -> Result<Vec<Value>, ModError> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(["remote", "-v"]);
    let out = aura_core::process::hide_window(&mut cmd)
        .output()
        .map_err(|e| ModError::failed(format!("run git: {e}")))?;
    if !out.status.success() {
        return Ok(vec![]);
    }
    let mut seen = HashSet::new();
    let mut list = vec![];
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(url)) = (parts.next(), parts.next()) {
            if seen.insert(name.to_string()) {
                list.push(json!({"name": name, "url": url}));
            }
        }
    }
    Ok(list)
}

async fn output(
    mut cmd: tokio::process::Command,
    stdin: Option<String>,
    timeout: Duration,
) -> Result<std::process::Output, ModError> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    aura_core::process::hide_window_tokio(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| ModError::failed(format!("start: {e}")))?;
    if let Some(text) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = pipe.write_all(text.as_bytes()).await;
            });
        }
    }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(ModError::failed),
        Err(_) => Err(ModError::new("timeout", "the program did not finish in time")),
    }
}

async fn run_process(bin: &str, a: &Value) -> OpResult {
    let path = aura_core::which::find_binary(bin, "", &[])
        .ok_or_else(|| ModError::unavailable(format!("{bin} is not installed or not on PATH")))?;
    let args: Vec<String> = opt(a, "args")?.unwrap_or_default();
    let env: BTreeMap<String, Option<String>> = opt(a, "env")?.unwrap_or_default();
    let timeout = Duration::from_millis(opt::<u64>(a, "timeoutMs")?.unwrap_or(60_000));
    let mut cmd = tokio::process::Command::new(path);
    cmd.args(&args);
    if let Some(cwd) = opt::<String>(a, "cwd")? {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let out = output(cmd, opt(a, "stdin")?, timeout).await?;
    let cap = |b: &[u8]| {
        let s = String::from_utf8_lossy(b);
        if s.len() > 32 * 1024 * 1024 {
            s[..32 * 1024 * 1024].to_string()
        } else {
            s.into_owned()
        }
    };
    Ok(json!({
        "code": out.status.code().unwrap_or(-1),
        "stdout": cap(&out.stdout),
        "stderr": cap(&out.stderr),
    }))
}

/// Settings documents live in [`SETTINGS_NS`]; re-exported for the host.
pub const SETTINGS: &str = SETTINGS_NS;
