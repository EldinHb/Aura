//! Session templates: a name and the options of a new session, kept by the
//! daemon so the desktop and the phone share them. Starting a session from a
//! template is the client's `session.create` with those options, so it gets
//! every check that call has (a remote device's included); a template itself
//! grants nothing.

use crate::autonomy::Autonomy;
use crate::types::{ProviderKind, SessionMode};
use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The longest template name, in characters.
pub const TEMPLATE_NAME_MAX: usize = 60;
/// The longest prompt or system prompt a template keeps, in characters.
pub const TEMPLATE_TEXT_MAX: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum TemplateKind {
    #[default]
    Agent,
    Orchestrator,
    FeatureOwner,
}

/// What a template sets for a new session. Everything but the provider is
/// optional: what is left out is what the new-session dialog defaults to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TemplateInput {
    pub name: String,
    #[serde(default)]
    pub kind: TemplateKind,
    pub provider: ProviderKind,
    /// The ACP agent, for `acp`.
    #[serde(default)]
    pub agent: Option<String>,
    /// The folder. None: the dialog's (the selected session's, the default
    /// one); for an orchestrator or feature owner, no folder of its own.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Start in a new git worktree, on a branch named after `branch_pattern`.
    #[serde(default)]
    pub worktree: bool,
    /// The branch name, with `{slug}` (the title, or the template's name, in
    /// lower case with hyphens), `{date}` (YYYYMMDD) and `{time}` (HHMM)
    /// filled in by the client. Default `aura/{slug}-{date}`.
    #[serde(default)]
    pub branch_pattern: Option<String>,
    /// The workspace id. None: the one the user is in.
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub mode: Option<SessionMode>,
    /// Command (argv) of a terminal session.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// A feature owner's own autonomy. None follows the setting for all.
    #[serde(default)]
    pub autonomy: Option<Autonomy>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// The first message (a feature owner's goal), which the user can still
    /// change before starting.
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionTemplate {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub input: TemplateInput,
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn clean_text(v: Option<String>, what: &str) -> Result<Option<String>> {
    let v = v.filter(|s| !s.trim().is_empty());
    if let Some(s) = &v {
        if s.chars().count() > TEMPLATE_TEXT_MAX {
            bail!("the {what} is longer than {TEMPLATE_TEXT_MAX} characters");
        }
    }
    Ok(v)
}

/// The input made tidy (trimmed, empty strings dropped) and checked, against
/// the other templates' names (`others`, without the one being changed).
pub fn validate(input: TemplateInput, others: &[&str]) -> Result<TemplateInput> {
    let name = input.name.trim().to_string();
    let len = name.chars().count();
    if len == 0 || len > TEMPLATE_NAME_MAX {
        bail!("a template name is 1 to {TEMPLATE_NAME_MAX} characters");
    }
    if others.iter().any(|o| o.trim().eq_ignore_ascii_case(&name)) {
        bail!("there is already a template called `{name}`");
    }
    let terminal =
        input.provider == ProviderKind::Terminal || input.mode == Some(SessionMode::Terminal);
    if terminal && input.kind != TemplateKind::Agent {
        bail!("a terminal session cannot orchestrate: pick claude, codex or acp for an orchestrator or feature owner");
    }
    let agent = clean(input.agent);
    if input.provider == ProviderKind::Acp && agent.is_none() {
        bail!("an acp template needs the agent (`agent`)");
    }
    let branch_pattern = clean(input.branch_pattern);
    if let Some(b) = &branch_pattern {
        if b.chars().any(char::is_whitespace) || b.contains("..") || b.starts_with(['/', '-']) {
            bail!("`{b}` is not a branch name: no spaces or `..`, and not starting with / or -");
        }
    }
    let cwd = clean(input.cwd);
    if let Some(c) = &cwd {
        if !(c.starts_with('/') || c.starts_with('~') || c.chars().nth(1) == Some(':')) {
            bail!("the folder must be an absolute path, not `{c}`");
        }
    }
    if input.worktree && cwd.is_none() {
        bail!("a template that starts in a worktree needs a folder in a repository");
    }
    let command = input.command.filter(|c| !c.is_empty() && terminal);
    Ok(TemplateInput {
        name,
        kind: input.kind,
        provider: input.provider,
        agent,
        cwd,
        worktree: input.worktree,
        branch_pattern: if input.worktree { branch_pattern } else { None },
        workspace: clean(input.workspace),
        group: clean(input.group),
        mode: input.mode,
        command,
        model: clean(input.model),
        effort: clean(input.effort),
        permission_mode: clean(input.permission_mode),
        sandbox_mode: clean(input.sandbox_mode),
        autonomy: if input.kind == TemplateKind::FeatureOwner {
            input.autonomy
        } else {
            None
        },
        system_prompt: clean_text(input.system_prompt, "system prompt")?,
        prompt: clean_text(input.prompt, "prompt")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> TemplateInput {
        TemplateInput {
            name: name.into(),
            provider: ProviderKind::Claude,
            ..Default::default()
        }
    }

    #[test]
    fn names_are_trimmed_unique_and_bounded() {
        assert_eq!(validate(input("  Review  "), &[]).unwrap().name, "Review");
        let e = validate(input("review"), &["Review"])
            .unwrap_err()
            .to_string();
        assert!(e.contains("already"), "{e}");
        assert!(validate(input(" "), &[]).is_err());
        assert!(validate(input(&"x".repeat(61)), &[]).is_err());
    }

    #[test]
    fn options_that_cannot_go_together_are_refused() {
        let mut t = input("T");
        t.provider = ProviderKind::Terminal;
        t.kind = TemplateKind::Orchestrator;
        assert!(validate(t, &[])
            .unwrap_err()
            .to_string()
            .contains("cannot orchestrate"));
        let mut t = input("T");
        t.provider = ProviderKind::Acp;
        assert!(validate(t, &[]).unwrap_err().to_string().contains("agent"));
        let mut t = input("T");
        t.worktree = true;
        assert!(validate(t, &[]).unwrap_err().to_string().contains("folder"));
        let mut t = input("T");
        t.cwd = Some("/src/app".into());
        t.worktree = true;
        t.branch_pattern = Some("my branch".into());
        assert!(validate(t, &[]).unwrap_err().to_string().contains("branch"));
        let mut t = input("T");
        t.cwd = Some("relative/path".into());
        assert!(validate(t, &[]).is_err());
    }

    #[test]
    fn empty_values_are_dropped_and_options_of_other_kinds_with_them() {
        let mut t = input("T");
        t.model = Some(" ".into());
        t.autonomy = Some(Autonomy::default());
        t.branch_pattern = Some("aura/{slug}".into());
        t.command = Some(vec!["zsh".into()]);
        let t = validate(t, &[]).unwrap();
        assert_eq!(t.model, None);
        assert_eq!(
            t.autonomy, None,
            "only a feature owner has its own autonomy"
        );
        assert_eq!(t.branch_pattern, None, "no worktree, no branch");
        assert_eq!(t.command, None, "only a terminal has a command");
    }

    #[test]
    fn a_template_is_flat_on_the_wire() {
        let t = SessionTemplate {
            id: "id".into(),
            created_at: "2026-11-01T00:00:00Z".parse().unwrap(),
            updated_at: "2026-11-01T00:00:00Z".parse().unwrap(),
            input: input("T"),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["name"], "T");
        assert_eq!(v["provider"], "claude");
        assert_eq!(v["kind"], "agent");
    }
}
