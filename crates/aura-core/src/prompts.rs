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
