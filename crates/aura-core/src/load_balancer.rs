//! The load balancer: when the user turns it on, orchestrators choose the
//! agent, model and effort of each worker themselves, across agents, by a
//! routing policy added to their system prompt. The user can rewrite the
//! policy and add rules of their own, which take precedence over it.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Setting that holds [`Stored`] as JSON.
pub const SETTING_KEY: &str = "load_balancer";

/// Used until the user saves a policy of their own.
pub const DEFAULT_POLICY: &str = "- Choose only from what `list_agents` shows: its agents, their models and the efforts each model takes. Call it before you start your first worker and again when a start fails. A model you know of but `list_agents` does not show is not available.
- Weigh every listed agent for every task, not only the one you are yourself. Route honestly: when another agent is known to do a kind of task better, or as well for fewer tokens, use it. Go by what you know of each model's strengths, the descriptions `list_agents` gives, and how workers did earlier in this conversation. When you cannot tell them apart, take the cheaper one and check its result.
- Match the model and the effort to how hard the task is, not to how important the project is:
  - Mechanical work (fully specified small edits, renames, formatting, updating call sites, bumping versions, running a command and reporting the output): the smallest or fastest model, the lowest effort.
  - Features and refactors that are well specified and touch a few files: a mid-tier model, medium effort.
  - Debugging an unknown cause, concurrency, security, data migrations, architecture and refactors across many files: the strongest model, high effort.
  - Research (reading code or docs to answer a question): a fast model, medium effort. Use a stronger one only when the answer takes judgement.
  - Review: an agent other than the one that wrote the change, when one is listed, because a model from another vendor catches other mistakes. Medium effort for small changes, high for risky ones.
  - UI work: the model you expect to write the best frontend code, medium effort, and have the worker look at the result in the running app when it can.
  - Long-running autonomous tasks: an agent and model that stay on track over many steps, with a precise brief, a definition of done and how to verify it. Prefer medium effort over the highest: effort is paid again on every step.
- Effort costs tokens on every turn. Raise it only where a mistake is expensive or the problem is hard, and lower it again for the routine work that follows.
- Start cheap and escalate. When a worker on a cheap model fails or gets it wrong, give the task to a stronger model or another agent, with what was learned, rather than retrying the same setup.
- Do not split work over more workers than it needs: every worker reads the code again. Give small related tasks to one worker.
- Pass `model` and `effort` to `start_session` every time, so the choice is on record and does not depend on an agent's defaults.
- State the reason for every choice.";

/// What the user saved. `policy: None` means the default is in effect.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Stored {
    pub enabled: bool,
    pub policy: Option<String>,
    /// The user's own rules, free text.
    pub rules: String,
    /// Agents or models to prefer.
    pub prefer: Vec<String>,
    /// Agents or models never to use; workers asking for them are refused.
    pub avoid: Vec<String>,
}

/// The load balancer as the settings show it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoadBalancer {
    pub enabled: bool,
    /// The policy in effect: the user's, or the default.
    pub policy: String,
    /// Whether `policy` is still Aura's default.
    pub policy_is_default: bool,
    pub default_policy: String,
    pub rules: String,
    pub prefer: Vec<String>,
    pub avoid: Vec<String>,
}

/// A change to the load balancer. `policy: None` goes back to the default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct LoadBalancerUpdate {
    pub enabled: bool,
    pub policy: Option<String>,
    pub rules: String,
    pub prefer: Vec<String>,
    pub avoid: Vec<String>,
}

impl From<LoadBalancerUpdate> for Stored {
    fn from(u: LoadBalancerUpdate) -> Self {
        let list = |v: Vec<String>| -> Vec<String> {
            let mut out: Vec<String> = vec![];
            for e in v.iter().map(|e| e.trim()).filter(|e| !e.is_empty()) {
                if !out.iter().any(|o| o.eq_ignore_ascii_case(e)) {
                    out.push(e.to_string());
                }
            }
            out
        };
        Stored {
            enabled: u.enabled,
            // Saving the default text keeps following the default; an empty
            // policy leaves only the user's rules.
            policy: u.policy.filter(|p| p.trim() != DEFAULT_POLICY),
            rules: u.rules.trim().to_string(),
            prefer: list(u.prefer),
            avoid: list(u.avoid),
        }
    }
}

impl Stored {
    pub fn view(&self) -> LoadBalancer {
        LoadBalancer {
            enabled: self.enabled,
            policy: self.policy.clone().unwrap_or_else(|| DEFAULT_POLICY.into()),
            policy_is_default: self.policy.is_none(),
            default_policy: DEFAULT_POLICY.into(),
            rules: self.rules.clone(),
            prefer: self.prefer.clone(),
            avoid: self.avoid.clone(),
        }
    }

    /// The part of an orchestrator's system prompt it adds. `None` when off.
    pub fn prompt(&self) -> Option<String> {
        if !self.enabled {
            return None;
        }
        let policy = self.policy.as_deref().unwrap_or(DEFAULT_POLICY).trim();
        let mut p = String::from("## Load balancer

The user turned on Aura's load balancer: you choose the agent, model and effort of every worker yourself, following the routing policy and the user's rules below, and spend as few tokens as you can while still getting the work done well. This takes the place of any instruction to ask the user which agent, model or effort to use. When the user names an agent, model or effort for a task, use that.

When you start workers, tell the user which agent, model and effort each one got and why, one line per worker, like: `<title>`: <agent> · <model> · <effort>, <reason>.");
        if !policy.is_empty() {
            p.push_str(&format!("\n\n### Routing policy\n\n{policy}"));
        }
        let quoted = |v: &[String]| {
            v.iter()
                .map(|e| format!("`{e}`"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut rules = vec![];
        if !self.prefer.is_empty() {
            rules.push(format!(
                "- Prefer these agents and models where they fit the task: {}.",
                quoted(&self.prefer)
            ));
        }
        if !self.avoid.is_empty() {
            rules.push(format!(
                "- Never use these agents or models; Aura refuses to start workers with them: {}.",
                quoted(&self.avoid)
            ));
        }
        if !self.rules.trim().is_empty() {
            rules.push(self.rules.trim().to_string());
        }
        if !rules.is_empty() {
            p.push_str(&format!(
                "\n\n### The user's rules\n\nThese take precedence over the routing policy.\n\n{}",
                rules.join("\n")
            ));
        }
        Some(p)
    }

    /// The entry of `avoid` that forbids a worker of `agent` (`claude`,
    /// `codex` or an ACP agent id) on `model`, while the load balancer is on.
    /// An entry names an agent, a model id, or words of one: `opus` forbids
    /// `claude-opus-4`.
    pub fn forbidden(&self, agent: &str, model: Option<&str>) -> Option<&str> {
        if !self.enabled {
            return None;
        }
        let agent = agent.trim();
        let agent = agent.strip_prefix("acp:").unwrap_or(agent);
        self.avoid
            .iter()
            .find(|e| {
                let e = e.trim();
                e.strip_prefix("acp:")
                    .unwrap_or(e)
                    .eq_ignore_ascii_case(agent)
                    || model.is_some_and(|m| names_model(e, m))
            })
            .map(String::as_str)
    }
}

/// Whether `entry` is `model` or a run of the words in it.
fn names_model(entry: &str, model: &str) -> bool {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_ascii_lowercase)
            .collect()
    };
    let (e, m) = (words(entry), words(model));
    !e.is_empty() && m.windows(e.len()).any(|w| w == e.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> Stored {
        Stored {
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn off_adds_nothing_and_forbids_nothing() {
        let s = Stored {
            avoid: vec!["codex".into()],
            ..Default::default()
        };
        assert_eq!(s.prompt(), None);
        assert_eq!(s.forbidden("codex", None), None);
    }

    #[test]
    fn on_lets_the_orchestrator_choose_and_explain_with_the_default_policy() {
        let p = on().prompt().unwrap();
        assert!(p.contains("you choose the agent, model and effort"), "{p}");
        assert!(p.contains("takes the place of any instruction to ask the user"));
        assert!(p.contains("tell the user which agent, model and effort each one got and why"));
        assert!(p.contains(DEFAULT_POLICY));
        assert!(!p.contains("The user's rules"));
    }

    #[test]
    fn default_policy_covers_routing() {
        for needle in [
            "`list_agents`",
            "Mechanical work",
            "refactors",
            "Debugging",
            "Research",
            "Review: an agent other than the one that wrote the change",
            "UI work",
            "Long-running autonomous tasks",
            "effort",
            "State the reason",
        ] {
            assert!(DEFAULT_POLICY.contains(needle), "missing {needle}");
        }
    }

    #[test]
    fn user_rules_follow_the_policy_and_take_precedence() {
        let s = Stored {
            policy: Some("Own policy".into()),
            rules: "Always use Codex for Rust.".into(),
            prefer: vec!["codex".into()],
            avoid: vec!["opus".into()],
            ..on()
        };
        let p = s.prompt().unwrap();
        assert!(!p.contains(DEFAULT_POLICY));
        let policy = p.find("Own policy").unwrap();
        let rules = p
            .find("These take precedence over the routing policy")
            .unwrap();
        assert!(policy < rules, "{p}");
        assert!(p.contains("Prefer these agents and models where they fit the task: `codex`."));
        assert!(p.contains("Aura refuses to start workers with them: `opus`."));
        assert!(p.ends_with("Always use Codex for Rust."), "{p}");
    }

    #[test]
    fn avoid_matches_agents_model_ids_and_words_of_them() {
        let s = Stored {
            avoid: vec![
                "Codex".into(),
                "acp:goose".into(),
                "opus".into(),
                "gpt-5".into(),
            ],
            ..on()
        };
        assert_eq!(s.forbidden("codex", None), Some("Codex"));
        assert_eq!(s.forbidden("goose", None), Some("acp:goose"));
        assert_eq!(s.forbidden("acp:goose", None), Some("acp:goose"));
        assert_eq!(s.forbidden("claude", Some("opus")), Some("opus"));
        assert_eq!(s.forbidden("claude", Some("claude-opus-4-1")), Some("opus"));
        assert_eq!(s.forbidden("acp:x", Some("gpt-5-mini")), Some("gpt-5"));
        assert_eq!(s.forbidden("claude", Some("sonnet")), None);
        assert_eq!(s.forbidden("claude", Some("opusx")), None);
        assert_eq!(s.forbidden("claude", None), None);
    }

    #[test]
    fn updates_are_tidied_and_the_default_text_stays_the_default() {
        let s: Stored = LoadBalancerUpdate {
            enabled: true,
            policy: Some(format!("{DEFAULT_POLICY}\n")),
            rules: "  r  ".into(),
            prefer: vec![" codex ".into(), "".into(), "CODEX".into()],
            avoid: vec![],
        }
        .into();
        assert_eq!(s.policy, None);
        assert_eq!(s.rules, "r");
        assert_eq!(s.prefer, vec!["codex"]);
        assert!(s.view().policy_is_default);
    }
}
