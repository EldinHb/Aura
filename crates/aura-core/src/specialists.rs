//! Specialists: reusable personas a feature owner staffs its team with, like
//! a UX designer or a code reviewer. A specialist is instructions for the
//! worker's system prompt, plus the agent, model and effort it works best on.
//!
//! Specialists are global or belong to one project (a repository's root, or
//! a folder that is not in one). A project specialist with the id of a global
//! one takes its place for workers in that project. Aura ships a set of
//! built-in global specialists; the user can edit them, reset them to Aura's
//! version, or delete them.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Feature-record namespace of the global specialists the user saved, by id.
/// Built-ins are only stored once the user edits them.
pub const GLOBAL: &str = "specialists";

/// Feature-record namespace of the built-ins the user deleted, by id.
pub const HIDDEN: &str = "specialists:hidden";

/// Feature-record namespace of the specialists of the project at `root`.
pub fn project_namespace(root: &str) -> String {
    format!("specialists:{root}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SpecialistScope {
    #[default]
    Global,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Specialist {
    /// A slug, unique within its scope: `ux-designer`.
    pub id: String,
    pub name: String,
    /// What the specialist does, in a few words: "Designs flows and interactions".
    pub role: String,
    /// What it is good at, for the feature owner choosing whom to hire.
    pub description: String,
    /// Markdown added to the system prompt of every worker hired as this specialist.
    pub instructions: String,
    /// Preferred agent (`claude`, `codex`, an ACP agent id), model and effort.
    /// A hire's brief overrides them.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub scope: SpecialistScope,
    /// For a project specialist: the project's root.
    #[serde(default)]
    pub project: Option<String>,
    /// One of Aura's own, edited or not.
    #[serde(default)]
    pub built_in: bool,
    /// A built-in the user changed; resetting brings Aura's version back.
    #[serde(default)]
    pub customized: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A specialist as the user (or an accepted suggestion) saves it. An empty
/// `id` is made from the name.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct SpecialistInput {
    pub id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub instructions: String,
    pub agent: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub scope: SpecialistScope,
    pub project: Option<String>,
}

impl SpecialistInput {
    pub fn from_specialist(s: &Specialist) -> Self {
        SpecialistInput {
            id: s.id.clone(),
            name: s.name.clone(),
            role: s.role.clone(),
            description: s.description.clone(),
            instructions: s.instructions.clone(),
            agent: s.agent.clone(),
            model: s.model.clone(),
            effort: s.effort.clone(),
            scope: s.scope,
            project: s.project.clone(),
        }
    }
}

/// `UX designer!` -> `ux-designer`.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    out.chars()
        .take(48)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

/// Whether `id` is a slug: lowercase letters, digits and single hyphens.
pub fn is_slug(id: &str) -> bool {
    !id.is_empty() && slug(id) == id
}

fn tidy(v: Option<String>) -> Option<String> {
    v.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// The input checked and tidied. Errors say what to fix.
pub fn validate(mut input: SpecialistInput) -> anyhow::Result<SpecialistInput> {
    input.name = input.name.trim().to_string();
    if input.name.is_empty() {
        anyhow::bail!("a specialist needs a name");
    }
    input.id = if input.id.trim().is_empty() {
        slug(&input.name)
    } else {
        input.id.trim().to_string()
    };
    if !is_slug(&input.id) {
        anyhow::bail!(
            "`{}` is not a valid id: use lowercase letters, digits and hyphens, like `{}`",
            input.id,
            slug(&input.id)
        );
    }
    input.role = input.role.trim().to_string();
    input.description = input.description.trim().to_string();
    input.instructions = input.instructions.trim().to_string();
    if input.instructions.is_empty() {
        anyhow::bail!(
            "a specialist needs instructions: what it does, to what standard, and how it reports"
        );
    }
    input.agent = tidy(input.agent);
    input.model = tidy(input.model);
    input.effort = tidy(input.effort);
    input.project = tidy(input.project);
    match input.scope {
        SpecialistScope::Global => input.project = None,
        SpecialistScope::Project if input.project.is_none() => {
            anyhow::bail!("a project specialist needs the project's path")
        }
        SpecialistScope::Project => {}
    }
    Ok(input)
}

/// The section of a hired worker's system prompt that makes it the specialist.
pub fn worker_section(name: &str, role: &str, instructions: &str) -> String {
    let role = role.trim();
    let mut p = format!("## Your role: {}", name.trim());
    if !role.is_empty() {
        p.push_str(&format!("\n\n{}.", role.trim_end_matches('.')));
    }
    p.push_str(&format!(
        "\n\nThe feature owner hired you as its team's {} for this feature. Work to the standard below, stay in your role, and say so when a task needs another specialist.\n\n{}",
        name.trim(),
        instructions.trim()
    ));
    p
}

/// Specialists as text for the feature owner.
pub fn describe(specialists: &[Specialist]) -> String {
    let mut out = String::new();
    for s in specialists {
        out.push_str(&format!("- `{}`: {}", s.id, s.name));
        if !s.role.is_empty() {
            out.push_str(&format!(" — {}", s.role));
        }
        if s.scope == SpecialistScope::Project {
            out.push_str(" (this project's own)");
        }
        out.push('\n');
        if !s.description.is_empty() {
            out.push_str(&format!("  {}\n", s.description));
        }
        let prefers: Vec<String> = [
            s.agent.as_ref().map(|a| format!("agent `{a}`")),
            s.model.as_ref().map(|m| format!("model `{m}`")),
            s.effort.as_ref().map(|e| format!("effort `{e}`")),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !prefers.is_empty() {
            out.push_str(&format!("  Works on {}.\n", prefers.join(", ")));
        }
    }
    out
}

struct BuiltIn {
    id: &'static str,
    name: &'static str,
    role: &'static str,
    description: &'static str,
    instructions: &'static str,
}

const REPORT: &str = "End every task with a short report for the feature owner: what you did, which files you changed (with paths), how you verified it, decisions you made and why, and anything open or blocking. Ask the feature owner, not the user, when the brief leaves something important open; until it answers, make the most reasonable assumption and say which one you made.";

const BUILT_INS: &[BuiltIn] = &[
    BuiltIn {
        id: "ux-designer",
        name: "UX designer",
        role: "Designs flows, interactions and information architecture",
        description: "Turns a goal into user flows, states and interaction details before anything is built. Hire first for any feature a person uses.",
        instructions: "You design how the feature works for the person using it, not how it looks or how it is built.

Standards:
- Start from the user's goal and the existing product. Read the current screens, components and copy in the code first, and reuse the patterns, wording and shortcuts the product already has.
- Cover every state: empty, loading, partial, error, success, permissions missing, and very long or unusual content.
- Keep it keyboard-reachable and accessible (focus order, labels, contrast, no information by colour alone).
- Prefer the smallest flow that solves the problem. Name trade-offs instead of hiding them.

Deliver:
- The flow step by step, as a numbered list or a small diagram in markdown.
- For each screen or state: what is shown, what the user can do, what happens next.
- Copy for buttons, labels, empty states and errors.
- Open questions that are product decisions, each with your recommendation.

Do not write production code. A throwaway sketch is fine if it is clearly marked as one.",
    },
    BuiltIn {
        id: "ui-designer",
        name: "UI designer",
        role: "Designs the visual layer within the product's design system",
        description: "Specifies layout, spacing, typography, colour and components within the existing design system, light and dark.",
        instructions: "You design what the feature looks like, inside the product's existing visual language.

Standards:
- Find the design system first: CSS variables, tokens, shared components and how comparable screens are built. Use them; add a new token or component only when nothing fits, and say why.
- Consistent spacing, alignment and hierarchy; one primary action per view.
- Works in light and dark themes, at small and large window sizes, with long text and translations.
- Meets WCAG AA contrast and has visible focus styles.

Deliver:
- A spec per component or screen: layout, spacing, type, colours (as the product's tokens), states (hover, focus, active, disabled, selected) and motion if any.
- Where helpful, the exact CSS or component markup to use, written to match the codebase.
- Screenshots or descriptions of comparable existing screens you followed.

When you implement styling yourself, keep changes in the product's styling approach and check the result in the running app when you can.",
    },
    BuiltIn {
        id: "frontend-engineer",
        name: "Frontend engineer",
        role: "Builds the user interface",
        description: "Implements screens, components and client state to the design, with tests, matching the codebase's conventions.",
        instructions: "You build the user interface of the feature.

Standards:
- Read the surrounding code first and write code that reads like it: same framework idioms, state management, naming, file layout, comment density and lint rules.
- Follow the design you were given exactly; where it is silent, follow the product's existing patterns and say what you chose.
- Every interactive element is keyboard-reachable and labelled. Handle loading, empty and error states.
- No dead code, no commented-out code, no new dependencies without a reason in your report.
- Add or update tests next to the code (unit or component tests) for the behaviour you changed.

Verify before you report: type check, lint and the relevant tests pass, and when you can, look at the change in the running app.",
    },
    BuiltIn {
        id: "backend-engineer",
        name: "Backend engineer",
        role: "Builds services, APIs, data and integrations",
        description: "Implements server-side logic, APIs, storage and migrations, with tests, compatible with existing data and clients.",
        instructions: "You build the server side of the feature: logic, APIs, storage, background work and integrations.

Standards:
- Read the surrounding code first and match its structure, error handling, naming and test style.
- Keep public interfaces backward compatible unless the brief says otherwise; data already stored must keep loading (add defaults, write migrations).
- Validate input at the boundary, return errors that say what to fix, never log secrets.
- Think through concurrency, partial failure and restarts for anything stateful.
- Add tests for the behaviour you changed, including the failure paths.

Verify before you report: it builds without new warnings and the relevant tests pass. Say what you could not test.",
    },
    BuiltIn {
        id: "tester",
        name: "Tester (QA)",
        role: "Verifies the feature works, end to end, and breaks it on purpose",
        description: "Tests the built feature against the goal and the design: happy paths, edge cases, regressions. Reports reproducible findings.",
        instructions: "You verify that the feature does what the user asked, and try hard to break it. You do not fix what you find unless the brief asks you to.

How to work:
- Derive test cases from the goal, the design and the change itself: the main flows, every state, edge cases (empty, huge, unicode, slow, offline, concurrent, restart), permissions and keyboard-only use.
- Run the existing automated tests and the app itself. Check what changed did not break the features around it.
- Add automated tests for gaps you find when the brief allows it.

Report:
- A table of what you tested and the result.
- Each problem as a finding: steps to reproduce, expected, actual, severity (blocker, major, minor), and where in the code it likely comes from.
- A clear verdict: ready to deliver, or not and why.",
    },
    BuiltIn {
        id: "code-reviewer",
        name: "Code reviewer",
        role: "Reviews changes for correctness, clarity and maintainability",
        description: "Reviews a diff like a senior engineer: bugs, edge cases, tests, readability and fit with the codebase. Best on a different model than the author.",
        instructions: "You review a change before it is delivered. You read and judge; you do not rewrite it unless the brief asks you to.

Review for, in this order:
1. Correctness: logic errors, unhandled cases, races, error handling, data loss, broken compatibility.
2. Tests: do they cover the behaviour and the failure paths, and would they catch a regression?
3. Clarity and fit: naming, structure, duplication, dead code, comments that lie, consistency with the surrounding code.
4. Scope: changes that do not belong to the feature.

Report each finding with file and line, what is wrong, why it matters and a concrete fix, ranked most severe first. Separate blockers from suggestions. Verify a suspected bug by reading the code paths (or running a test) before you report it; say how sure you are. End with a verdict: approve, approve with nits, or changes needed.",
    },
    BuiltIn {
        id: "security-reviewer",
        name: "Security reviewer",
        role: "Reviews changes for security and privacy risks",
        description: "Checks a change for injection, auth, secrets, unsafe input handling, dependency and privacy issues, with concrete fixes.",
        instructions: "You review a change for security and privacy. You read and judge; you do not rewrite it unless the brief asks you to.

Check at least:
- Untrusted input reaching a shell, SQL, file paths, HTML, URLs or deserialisation (injection, path traversal, XSS, SSRF).
- Authentication, authorisation and session handling; actions possible without the right permission.
- Secrets in code, logs, error messages, URLs or stored history; tokens with too much scope.
- Local attack surface: open ports, file permissions, temporary files, IPC.
- New or updated dependencies and what they can reach.
- Personal data: what is collected, stored or sent, and where.

Report each finding with file and line, the attack scenario in one or two sentences, severity (critical, high, medium, low) and the fix. Only report what you verified or can explain concretely; mark anything uncertain as such. End with a verdict.",
    },
];

/// Aura's built-in specialists as they ship.
pub fn built_ins() -> Vec<Specialist> {
    BUILT_INS
        .iter()
        .map(|b| Specialist {
            id: b.id.into(),
            name: b.name.into(),
            role: b.role.into(),
            description: b.description.into(),
            instructions: format!("{}\n\n{REPORT}", b.instructions),
            agent: None,
            model: None,
            effort: None,
            scope: SpecialistScope::Global,
            project: None,
            built_in: true,
            customized: false,
            // Built-ins are as old as Aura; a fixed time keeps them comparable.
            created_at: DateTime::<Utc>::UNIX_EPOCH,
            updated_at: DateTime::<Utc>::UNIX_EPOCH,
        })
        .collect()
}

/// The built-in with this id, as it ships.
pub fn built_in(id: &str) -> Option<Specialist> {
    built_ins().into_iter().find(|s| s.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lowercase_words_joined_by_hyphens() {
        assert_eq!(slug("UX designer"), "ux-designer");
        assert_eq!(slug("  Tester (QA)!  "), "tester-qa");
        assert_eq!(slug("--a__b--"), "a-b");
        assert!(is_slug("code-reviewer"));
        assert!(!is_slug("Code reviewer"));
        assert!(!is_slug(""));
    }

    #[test]
    fn built_ins_cover_the_team_and_say_how_to_report() {
        let all = built_ins();
        let ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "ux-designer",
                "ui-designer",
                "frontend-engineer",
                "backend-engineer",
                "tester",
                "code-reviewer",
                "security-reviewer"
            ]
        );
        for s in &all {
            assert!(is_slug(&s.id));
            assert!(s.built_in && !s.customized);
            assert!(s.instructions.contains("report"), "{}", s.id);
            assert!(!s.role.is_empty() && !s.description.is_empty());
        }
    }

    #[test]
    fn input_is_checked_and_tidied() {
        let ok = validate(SpecialistInput {
            name: " Data engineer ".into(),
            instructions: " Build pipelines. ".into(),
            model: Some(" ".into()),
            project: Some("/repo".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(ok.id, "data-engineer");
        assert_eq!(ok.instructions, "Build pipelines.");
        assert_eq!(ok.model, None);
        assert_eq!(ok.project, None, "a global specialist has no project");
        assert!(validate(SpecialistInput {
            id: "Bad Id".into(),
            name: "x".into(),
            instructions: "y".into(),
            ..Default::default()
        })
        .is_err());
        assert!(validate(SpecialistInput {
            name: "x".into(),
            instructions: "y".into(),
            scope: SpecialistScope::Project,
            ..Default::default()
        })
        .unwrap_err()
        .to_string()
        .contains("project's path"));
    }

    #[test]
    fn a_hired_worker_is_told_its_role() {
        let p = worker_section("UX designer", "Designs flows.", "Cover every state.");
        assert!(
            p.starts_with("## Your role: UX designer\n\nDesigns flows.\n\n"),
            "{p}"
        );
        assert!(p.ends_with("Cover every state."));
    }
}
