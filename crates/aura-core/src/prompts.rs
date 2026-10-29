//! System prompts Aura adds to every agent it starts: one global prompt,
//! Aura's formatting note, one per agent and one per session, joined in that
//! order.
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

/// Always added after the global prompt: the desktop app renders replies as
/// markdown, so links, paths and images only work when written that way.
pub const FORMAT_PROMPT: &str = "Formatting: Aura shows your replies as GitHub-flavoured markdown. Write links as markdown links or full URLs so they are clickable. Refer to files by path, relative to your working directory or absolute, with a line number where it helps (`src/main.rs:42`), so the user can open them. Show an image with `![description](path or URL)`; a local image file can be given by absolute path or relative to your working directory.";

/// Ends the first line of every message Aura, not the user, sends an agent.
/// The desktop app keeps such messages out of the user's chat by this line,
/// in transcripts stored long ago too, so it must not change.
pub const AURA_MARK: &str = "This message comes from Aura, not the user.";

/// The first line of a message from Aura titled `title`, newline included.
pub fn aura_header(title: &str) -> String {
    format!("[Aura] {title}. {AURA_MARK}\n")
}

/// Whether `text` is a message from Aura rather than the user.
pub fn is_aura_message(text: &str) -> bool {
    let first = text.lines().next().unwrap_or("");
    first.starts_with("[Aura] ") && first.ends_with(AURA_MARK)
}

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
- When a worker stops (its task is done, it failed, or it waits for the user's approval or answer), Aura sends you a message that starts with `[Aura] Worker report`. The user does not see these reports in your chat, only what you reply to them: after a report, tell the user briefly what they need to know (a worker finished, failed or waits on them), by the worker's title, and keep it to one short line when nothing changed for them. You do not have to poll: after handing out work you can end your turn and continue when the reports come in. Use `wait_for_sessions` when you need a result before you can go on; workers it returns are not reported again.
- Workers ask the user, not you, to approve commands and answer questions. When a report says a worker is waiting on the user, tell the user which worker and what it needs.
- The user sees every worker as a normal session and may message them directly.
- Coordinate and check the work yourself. Leave the implementation to workers unless a task is trivial.
- Delete only workers whose work is finished and reported, or that the user asked you to remove. Deleting keeps the worker's git worktree and branch.");
    if !tools {
        p.push_str("\n\nAura could not give you the `aura` tools in this session (the `aura` command-line tool was not found next to the daemon). Tell the user, and do not pretend to start workers.");
    }
    p
}

/// Added to a feature owner's system prompt, after [`orchestrator_prompt`]
/// and before its autonomy level (see [`crate::autonomy::Autonomy::prompt`]).
pub fn feature_owner_prompt(goal: &str) -> String {
    let goal = goal.trim();
    let feature = if goal.is_empty() {
        "The user has not described the feature yet. Ask them what they want and why before you staff a team.".to_string()
    } else {
        format!(
            "The feature, as the user described it:\n\n{}",
            goal.lines()
                .map(|l| format!("> {l}").trim_end().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!("## You are the feature owner

The user made you the owner of one feature. The user is your product owner and stakeholder: they say what they want and why, and they make the decisions that are theirs. Everything else is yours, end to end: you work out what to build, decide how, staff a team, direct it, check its work and deliver the feature with a short report.

{feature}

Your tools as feature owner, on the same `aura` MCP server:

- `list_specialists`: the specialists you can hire, reusable personas such as a UX designer, UI designer, frontend and backend engineer, tester, code reviewer and security reviewer, plus the user's own, with what each is good at. Pass `cwd` to see a project's own specialists too.
- `hire`: start a worker as a specialist. It gets the specialist's instructions in its system prompt and works on the specialist's preferred agent, model and effort unless you name others. Brief it like `start_session`: the worker does not see this conversation.
- `ask_user`: put a decision that is the user's to them, with the context they need, concrete options and the one you recommend. The user answers in a card in your chat and Aura sends you the answer in a message that starts with `[Aura] Decision from the user`. End your turn after asking; until the answer comes, keep the team on work that does not depend on it.
- `record_decision`: log a decision you made and its rationale. The user reads the log.
- `checkpoint`: report that the feature reached a stage (`after_design`, `before_implementation`, `before_delivery`) with a summary. Aura answers whether the user wants to review it first.
- `propose_specialist`: suggest a new reusable specialist when the team needs a role no specialist covers and other features will need it too. The user accepts, edits or dismisses it.
- `deliver_report`: deliver the finished feature: what was done, why, how to test it and where.
- `feature_status`: the feature's status, team and open questions as Aura has them.
- `hold_meeting`: a written meeting. Each attendee (team members, and specialists hired just for it with `guests`) gets your question at once and answers in writing; Aura sends you every answer in one message that starts with `[Aura] Meeting notes`. End your turn after calling it.
- `reply_to_teammate`: answer a team member's question, which comes in a message that starts with `[Aura] Question from a teammate`.

How to own the feature:

- Understand the goal first. When it is unclear in a way that changes what gets built, ask the user once, with concrete options, before you staff anyone.
- Plan like a lead: what needs designing, building, testing and reviewing, in which order, and what can run in parallel.
- Staff the team the way a good team works: design before build, and a tester and a reviewer who did not write the code. Hire specialists (`list_specialists`, then `hire`) rather than ad-hoc workers, and reuse the same specialist for follow-ups so it keeps its context. Start an ad-hoc worker with `start_session` only when no specialist fits; when you expect to need that role again, `propose_specialist`.
- Decide what is not the user's to decide yourself, and record every decision that shapes the feature with `record_decision` and a one-line rationale. Do not ask the user about implementation details.
- Hold a meeting only when a decision needs views from several roles you do not have yet, such as design, engineering and testing weighing a trade-off. Decide yourself when you can, and ask one member with `send_message` when one view is enough. Keep the attendees to the two to four whose view matters: each costs a turn. Ask one clear question. After the notes come, decide and record it with `record_decision` and the meeting's id, then brief the team.
- Team members can ask each other and you directly. Answer their questions with `reply_to_teammate`, briefly; until you do, the one asking waits.
- Check the work before you accept it: read the reports, have the tester verify and the reviewer review, and send work back with concrete feedback when it falls short.
- Talk to the user about outcomes, decisions and questions, briefly, when something changes for them; not as a running commentary.
- When the feature is done and verified, call `deliver_report` once and then tell the user in one or two lines that it is ready. `where_to_test` names the branch or worktree path, the URL or the screen, and the command to run it.")
}

/// Added to the system prompt of a worker on a feature owner's team, after
/// [`worker_prompt`], when Aura could hand it the `aura` MCP server.
pub fn team_prompt() -> String {
    "## Your team

You work on a feature owner's team. The `aura` MCP server has your team's tools:

- `list_team`: your teammates, their roles and the feature owner.
- `ask_teammate`: ask one teammate a question, by its title or specialist. It answers in its next turn and Aura brings you the answer in a message that starts with `[Aura] Answer from a teammate`.
- `ask_owner`: ask the feature owner, for what only it can decide. The answer comes in a message that starts with `[Aura] Answer from the feature owner`.

Ask only when you cannot go on well without the answer, and ask briefly; after asking, end your turn if you cannot go on, and Aura brings you the answer. When Aura sends you a meeting (`[Aura] Meeting`) or a teammate's question (`[Aura] Question from a teammate`), answer it in your final message of that turn, briefly, without starting other work and without asking anyone.".to_string()
}

/// Added to a worker's system prompt.
pub fn worker_prompt(orchestrator_title: &str) -> String {
    format!("## You are a worker

Another agent, the orchestrator session \"{orchestrator_title}\", started this session and sends you tasks. The user can read along and may also message you directly. Your final message of each turn is forwarded to the orchestrator, so end every task with a short report: what you did, which files you changed, how you verified it, and anything that is still open or blocking.")
}

/// Global prompt, [`FORMAT_PROMPT`], agent and session prompts joined with
/// blank lines, placeholders filled in.
pub fn compose(global: &str, agent: Option<&str>, session: &Session, agent_name: &str) -> String {
    let parts: Vec<&str> = [
        Some(global),
        Some(FORMAT_PROMPT),
        agent,
        session.system_prompt.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .filter(|p| !p.is_empty())
    .collect();
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
    parts
        .join("\n\n")
        .replace("{{agent}}", agent_name)
        .replace("{{model}}", model)
        .replace("{{effort}}", effort)
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
        );
        assert_eq!(
            out,
            format!(
                "Global Claude Code opus high\n\n{FORMAT_PROMPT}\n\nAgent rule\n\nSession rule"
            )
        );
    }

    #[test]
    fn skips_empty_parts_and_names_defaults() {
        let s = session(None, Some("  "));
        assert_eq!(compose("", None, &s, "Codex"), FORMAT_PROMPT);
        assert_eq!(
            compose("{{model}}", Some(""), &s, "Codex"),
            format!("default\n\n{FORMAT_PROMPT}")
        );
    }

    #[test]
    fn every_agent_is_asked_for_markdown_with_clickable_links_paths_and_images() {
        let s = session(None, None);
        for agent in ["Claude Code", "Codex", "Gemini CLI"] {
            let out = compose("", None, &s, agent);
            assert!(out.contains("GitHub-flavoured markdown"), "{out}");
            assert!(out.contains("markdown links or full URLs"), "{out}");
            assert!(out.contains("`src/main.rs:42`"), "{out}");
            assert!(out.contains("`![description](path or URL)`"), "{out}");
        }
        // Agent-neutral: no agent's own tools or conventions named.
        assert!(!FORMAT_PROMPT.contains("Claude") && !FORMAT_PROMPT.contains("Codex"));
    }

    #[test]
    fn default_prompt_asks_for_attribution_with_model_and_effort() {
        let s = session(Some("claude-opus-5-5"), None);
        let out = compose(DEFAULT_GLOBAL_PROMPT, None, &s, "Claude Code");
        assert!(out.contains("written by an AI agent"));
        assert!(out.contains("model `claude-opus-5-5`"));
        assert!(out.contains("effort high"));
        assert!(!out.contains("{{"));
    }

    #[test]
    fn the_feature_owner_is_told_the_goal_and_its_tools() {
        let p = feature_owner_prompt("Dark mode\nfor the settings");
        assert!(p.starts_with("## You are the feature owner"), "{p}");
        assert!(p.contains("> Dark mode\n> for the settings"), "{p}");
        for tool in [
            "`list_specialists`",
            "`hire`",
            "`ask_user`",
            "`record_decision`",
            "`checkpoint`",
            "`propose_specialist`",
            "`deliver_report`",
            "`feature_status`",
            "`hold_meeting`",
            "`reply_to_teammate`",
        ] {
            assert!(p.contains(tool), "missing {tool}");
        }
        assert!(feature_owner_prompt(" ").contains("has not described the feature yet"));
    }

    #[test]
    fn messages_from_aura_are_told_apart_by_their_first_line() {
        let report = format!("{}\n### Builder", aura_header("Worker report"));
        assert_eq!(
            report,
            "[Aura] Worker report. This message comes from Aura, not the user.\n\n### Builder"
        );
        assert!(is_aura_message(&report));
        assert!(is_aura_message(&aura_header("New review activity")));
        assert!(!is_aura_message("[Aura] Worker report, can you check it?"));
        assert!(!is_aura_message(&format!("Quoting: {}", aura_header("x"))));
        assert!(!is_aura_message(""));
    }
}
