//! Which ACP agents exist: a built-in list of agents that speak ACP natively,
//! plus user-defined ones from `<data dir>/acp-agents.json`.
//!
//! ```json
//! { "agents": [
//!   { "id": "claude-acp", "name": "Claude (ACP bridge)", "command": ["claude-agent-acp"] },
//!   { "id": "gemini", "command": ["/opt/gemini/bin/gemini", "--acp"], "env": { "GEMINI_API_KEY": "..." } }
//! ] }
//! ```
//!
//! A custom entry with the id of a built-in replaces it, so a built-in's
//! command can be changed without renaming it.

use aura_core::AgentInfo;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "acp-agents.json";

/// Launch commands as published in the ACP agent registry
/// (github.com/agentclientprotocol/registry). Only agents that speak ACP
/// natively are listed; bridges for other CLIs go in `acp-agents.json`.
const BUILTIN: &[(&str, &str, &[&str])] = &[
    ("gemini", "Gemini CLI", &["gemini", "--acp"]),
    ("copilot", "GitHub Copilot", &["copilot", "--acp"]),
    ("opencode", "OpenCode", &["opencode", "acp"]),
    ("goose", "goose", &["goose", "acp"]),
    ("cursor", "Cursor", &["cursor-agent", "acp"]),
    ("qwen", "Qwen Code", &["qwen", "--acp"]),
    ("kimi", "Kimi CLI", &["kimi", "acp"]),
    ("vibe", "Mistral Vibe", &["vibe-acp"]),
    ("cline", "Cline", &["cline", "--acp"]),
    ("auggie", "Auggie", &["auggie", "--acp"]),
];

#[derive(Debug, Clone, PartialEq)]
pub struct AgentSpec {
    pub id: String,
    pub display_name: String,
    pub command: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub source: &'static str,
}

/// An agent plus where its binary was found (None: not installed).
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAgent {
    pub spec: AgentSpec,
    pub binary: Option<String>,
}

impl ResolvedAgent {
    pub fn info(&self) -> AgentInfo {
        AgentInfo {
            id: self.spec.id.clone(),
            display_name: self.spec.display_name.clone(),
            command: self.spec.command.clone(),
            available: self.binary.is_some(),
            binary: self.binary.clone(),
            source: self.spec.source.to_string(),
        }
    }
}

#[derive(Deserialize)]
struct ConfigFile {
    #[serde(default)]
    agents: Vec<ConfigAgent>,
}

#[derive(Deserialize)]
struct ConfigAgent {
    id: String,
    name: Option<String>,
    command: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

pub fn builtin() -> Vec<AgentSpec> {
    BUILTIN
        .iter()
        .map(|(id, name, cmd)| AgentSpec {
            id: id.to_string(),
            display_name: name.to_string(),
            command: cmd.iter().map(|s| s.to_string()).collect(),
            env: BTreeMap::new(),
            source: "builtin",
        })
        .collect()
}

/// Parse `acp-agents.json`. Entries without an id or command are rejected so
/// a typo is reported instead of silently producing an agent that cannot start.
pub fn parse_config(text: &str) -> Result<Vec<AgentSpec>, String> {
    let file: ConfigFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for (i, a) in file.agents.into_iter().enumerate() {
        let id = a.id.trim().to_string();
        if id.is_empty() {
            return Err(format!("agents[{i}]: `id` is empty"));
        }
        if a.command
            .first()
            .map(|c| c.trim().is_empty())
            .unwrap_or(true)
        {
            return Err(format!(
                "agents[{i}] ({id}): `command` must start with the program to run"
            ));
        }
        out.push(AgentSpec {
            display_name: a.name.unwrap_or_else(|| id.clone()),
            id,
            command: a.command,
            env: a.env,
            source: "custom",
        });
    }
    Ok(out)
}

/// Built-ins with custom entries applied: same id replaces, new ids append.
pub fn merge(builtin: Vec<AgentSpec>, custom: Vec<AgentSpec>) -> Vec<AgentSpec> {
    let mut out = builtin;
    for c in custom {
        match out.iter_mut().find(|a| a.id == c.id) {
            Some(slot) => *slot = c,
            None => out.push(c),
        }
    }
    out
}

/// Load every agent and locate its binary. A broken config file is logged and
/// skipped so it cannot take the built-ins down with it.
pub fn load(config: Option<&Path>) -> Vec<ResolvedAgent> {
    let custom = match config {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(text) => parse_config(&text).unwrap_or_else(|e| {
                tracing::warn!("ignoring {}: {e}", path.display());
                vec![]
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
            Err(e) => {
                tracing::warn!("cannot read {}: {e}", path.display());
                vec![]
            }
        },
        None => vec![],
    };
    merge(builtin(), custom)
        .into_iter()
        .map(|spec| ResolvedAgent {
            binary: resolve(&spec.command[0]),
            spec,
        })
        .collect()
}

/// Where `program` lives. A path is used as is; a bare name is searched for
/// like the other providers' CLIs (PATH plus the usual install directories).
pub fn resolve(program: &str) -> Option<String> {
    let path = PathBuf::from(program);
    if path.components().count() > 1 {
        return path.is_file().then(|| program.to_string());
    }
    // npm installs Windows shims as `.cmd`; native installers use `.exe`.
    let names: Vec<String> = if cfg!(windows) && path.extension().is_none() {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            program.to_string(),
        ]
    } else {
        vec![program.to_string()]
    };
    names
        .iter()
        .find_map(|n| aura_core::which::find_binary(n, "", &[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_entries_replace_builtins_by_id_and_append_new_ones() {
        let custom = parse_config(
            r#"{ "agents": [
                { "id": "gemini", "command": ["/opt/gemini", "--acp"] },
                { "id": "claude-acp", "name": "Claude (ACP)", "command": ["claude-agent-acp"], "env": { "A": "1" } }
            ] }"#,
        )
        .unwrap();
        let merged = merge(builtin(), custom);
        let gemini = merged.iter().find(|a| a.id == "gemini").unwrap();
        assert_eq!(gemini.command, vec!["/opt/gemini", "--acp"]);
        assert_eq!(gemini.source, "custom");
        assert_eq!(gemini.display_name, "gemini", "name defaults to the id");
        let claude = merged.last().unwrap();
        assert_eq!(
            (claude.id.as_str(), claude.display_name.as_str()),
            ("claude-acp", "Claude (ACP)")
        );
        assert_eq!(claude.env["A"], "1");
        assert_eq!(merged.len(), builtin().len() + 1);
    }

    #[test]
    fn rejects_entries_that_cannot_start() {
        assert!(
            parse_config(r#"{ "agents": [ { "id": "x", "command": [] } ] }"#)
                .unwrap_err()
                .contains("command")
        );
        assert!(
            parse_config(r#"{ "agents": [ { "id": " ", "command": ["x"] } ] }"#)
                .unwrap_err()
                .contains("id")
        );
        assert!(parse_config("not json").is_err());
        assert_eq!(parse_config("{}").unwrap(), vec![]);
    }

    #[test]
    fn broken_config_keeps_builtins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        std::fs::write(&path, "{ oops").unwrap();
        assert_eq!(load(Some(&path)).len(), builtin().len());
        assert_eq!(
            load(Some(&dir.path().join("missing.json"))).len(),
            builtin().len()
        );
    }

    #[test]
    fn explicit_paths_are_not_searched() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("agent");
        std::fs::write(&bin, "").unwrap();
        let s = bin.to_string_lossy().to_string();
        assert_eq!(resolve(&s), Some(s.clone()));
        assert_eq!(resolve(&dir.path().join("nope").to_string_lossy()), None);
    }
}
