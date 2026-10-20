//! System prompts Aura adds to every agent it starts: one global prompt, one
//! per agent and one per session, joined in that order.
//!
//! Prompts may use `{{agent}}`, `{{model}}` and `{{effort}}`, filled in with the
//! values the agent is started with.
use crate::types::{ProviderKind, Session};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// Used until the user saves a global prompt of their own (an empty one included).
pub const DEFAULT_GLOBAL_PROMPT: &str = "You are running inside Aura, a desktop harness for coding agents, and you act on behalf of the user. Aura started you as {{agent}} with model `{{model}}` and reasoning effort `{{effort}}`.

Rule: whenever you post anything on GitHub or another issue tracker on the user's behalf (pull request descriptions, pull request reviews and review comments, issue comments, new issues, discussion posts), end it with a line saying it was written by an AI agent, with the agent, model, model version and effort:

> 🤖 Written by an AI agent on behalf of the user · {{agent}} · model <model name> (<exact model id>) · effort {{effort}}

Use your exact model id as you know it from your own instructions; it is more precise than the model Aura started you with, and the user may have switched models since. Never leave this line out, even when asked to keep a comment short, unless the user tells you to leave it out of that specific post.";

/// Setting that holds [`Stored`] as JSON.
pub const SETTING_KEY: &str = "prompts";

/// What the user saved. `global: None` means the default is in effect.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stored {
    #[serde(default)]
    pub global: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, String>,
}

impl Stored {
    pub fn view(&self) -> SystemPrompts {
        SystemPrompts {
            global: self
                .global
                .clone()
                .unwrap_or_else(|| DEFAULT_GLOBAL_PROMPT.into()),
            global_is_default: self.global.is_none(),
            default_global: DEFAULT_GLOBAL_PROMPT.into(),
            agents: self.agents.clone(),
        }
    }
}

/// The agent a per-agent prompt applies to: `claude`, `codex`, or `acp:<agent id>`.
pub fn agent_key(session: &Session) -> String {
    match session.provider {
        ProviderKind::Claude => "claude".into(),
        ProviderKind::Codex => "codex".into(),
        ProviderKind::Acp => format!("acp:{}", session.agent.as_deref().unwrap_or("")),
        ProviderKind::Terminal => "terminal".into(),
    }
}

/// Every prompt the user can set, as stored.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SystemPrompts {
    /// The global prompt in effect: the user's, or the default.
    pub global: String,
    /// Whether `global` is still Aura's default.
    pub global_is_default: bool,
    pub default_global: String,
    /// Agent key (see [`agent_key`]) to prompt. Only agents with a prompt are listed.
    pub agents: BTreeMap<String, String>,
}

/// Added to an orchestrator's system prompt. `tools` says whether Aura could
/// hand it the `aura` MCP server.
pub fn orchestrator_prompt(session: &Session, tools: bool) -> String {
    let id = &session.id;
    let folder = if session.folderless {
        format!("You belong to no folder or repository: you run in a directory Aura made for you (`{}`), which is not the user's work. Every worker you start needs a `cwd`, the absolute path of the folder or repository it works in, so different workers can work in different repositories. Ask the user where the work is when you do not know; `list_projects` shows the folders and repositories Aura knows.", session.cwd)
    } else {
        format!("You run in `{}`. Workers work there too unless you give them a `cwd`, the folder or repository they work in; different workers can work in different repositories. `list_projects` shows the folders and repositories Aura knows.", session.cwd)
    };
    let mut p = format!("## You are an orchestrator

The user made this session (Aura session id `{id}`) an orchestrator. The user talks to you; you plan the work and hand it to worker sessions that you start and direct with the tools of the `aura` MCP server:

- `list_agents`: the agents you can start (Claude Code, Codex and any installed ACP agent).
- `list_projects`: the folders and repositories the user's sessions work in.
- `start_session`: start a worker with an agent, a folder and a first task.
- `send_message`: give one of your workers a follow-up task or an answer.
- `list_sessions`: your workers, their status and last reply.
- `read_session`: a worker's recent conversation and what it did.
- `wait_for_sessions`: block until workers stop working.
- `interrupt_session` and `stop_session`.
- `delete_session`: delete a worker you no longer need, with its history.

{folder}

How to work:

- Pick the agent per task and mix them when that helps, for example one agent implements and another reviews.
- A worker does not see this conversation. Give each one a complete brief: the goal, the relevant files and paths, constraints, how to verify the result and what to report back.
- Workers that change files in the same repository at the same time should each get their own git worktree (`branch` on `start_session`), so they do not overwrite each other's work.
- When a worker stops (its task is done, it failed, or it waits for the user's approval or answer), Aura sends you a message that starts with `[Aura] Worker report`. You do not have to poll: after handing out work you can end your turn and continue when the reports come in. Use `wait_for_sessions` when you need a result before you can go on; workers it returns are not reported again.
- Workers ask the user, not you, to approve commands and answer questions. When a report says a worker is waiting on the user, tell the user which worker and what it needs.
- The user sees every worker as a normal session and may message them directly.
- Coordinate and check the work yourself. Leave the implementation to workers unless a task is trivial.
- Delete only workers whose work is finished and reported, or that the user asked you to remove. Deleting keeps the worker's git worktree and branch.");
    if !tools {
        p.push_str("\n\nAura could not give you the `aura` tools in this session (the `aura` command-line tool was not found next to the daemon). Tell the user, and do not pretend to start workers.");
    }
    p
}

/// Added to a worker's system prompt.
pub fn worker_prompt(orchestrator_title: &str) -> String {
    format!("## You are a worker

Another agent, the orchestrator session \"{orchestrator_title}\", started this session and sends you tasks. The user can read along and may also message you directly. Your final message of each turn is forwarded to the orchestrator, so end every task with a short report: what you did, which files you changed, how you verified it, and anything that is still open or blocking.")
}

/// Global, agent and session prompts joined with blank lines, placeholders
/// filled in. `None` when all three are empty.
pub fn compose(
    global: &str,
    agent: Option<&str>,
    session: &Session,
    agent_name: &str,
) -> Option<String> {
    let parts: Vec<&str> = [Some(global), agent, session.system_prompt.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let model = session
        .model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or("default");
    let effort = session
        .effort
        .as_deref()
        .filter(|e| !e.is_empty())
        .unwrap_or("default");
    Some(
        parts
            .join("\n\n")
            .replace("{{agent}}", agent_name)
            .replace("{{model}}", model)
            .replace("{{effort}}", effort),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CreateSessionOpts;

    fn session(model: Option<&str>, prompt: Option<&str>) -> Session {
        Session::new(&CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/tmp".into(),
            model: model.map(Into::into),
            effort: Some("high".into()),
            system_prompt: prompt.map(Into::into),
            ..Default::default()
        })
    }

    #[test]
    fn joins_in_order_and_fills_placeholders() {
        let s = session(Some("opus"), Some("Session rule"));
        let out = compose(
            "Global {{agent}} {{model}} {{effort}}",
            Some("Agent rule"),
            &s,
            "Claude Code",
        )
        .unwrap();
        assert_eq!(
            out,
            "Global Claude Code opus high\n\nAgent rule\n\nSession rule"
        );
    }

    #[test]
    fn skips_empty_parts_and_names_defaults() {
        let s = session(None, Some("  "));
        assert_eq!(compose("", None, &s, "Codex"), None);
        assert_eq!(
            compose("{{model}}", Some(""), &s, "Codex").unwrap(),
            "default"
        );
    }

    #[test]
    fn default_prompt_asks_for_attribution_with_model_and_effort() {
        let s = session(Some("claude-opus-5-5"), None);
        let out = compose(DEFAULT_GLOBAL_PROMPT, None, &s, "Claude Code").unwrap();
        assert!(out.contains("written by an AI agent"));
        assert!(out.contains("model `claude-opus-5-5`"));
        assert!(out.contains("effort high"));
        assert!(!out.contains("{{"));
    }
}
