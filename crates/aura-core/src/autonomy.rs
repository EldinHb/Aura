//! How much a feature owner decides on its own before it comes back to the
//! user. One level for every feature owner, set in the settings, which a
//! feature can override (see [`crate::features::Feature::autonomy`]).
//!
//! The level shapes the feature owner's system prompt, and Aura enforces what
//! it can: `ask_user` is refused in autonomous mode unless the question is
//! about an irreversible or outward-facing action, a checkpoint the user chose
//! becomes a question the user must answer, and a delivery report is refused
//! until the user approved the delivery checkpoint.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Setting that holds [`Autonomy`] as JSON.
pub const SETTING_KEY: &str = "feature_owner_autonomy";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AutonomyLevel {
    /// Decide everything; ask only before irreversible or outward-facing actions.
    Autonomous,
    /// Decide what can be decided; ask when a decision is the user's and blocks the work.
    #[default]
    BlockingDecisions,
    /// Like `BlockingDecisions`, and stop for the user's review at the chosen checkpoints.
    Checkpoints,
}

/// A point in a feature's life where the user can ask to review the work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Checkpoint {
    /// The design (UX flows, UI, architecture) is done, before it is built.
    AfterDesign,
    /// The plan is ready and implementation is about to start.
    BeforeImplementation,
    /// The work is done and about to be delivered: merged, released or reported.
    BeforeDelivery,
}

impl Checkpoint {
    pub const ALL: [Checkpoint; 3] = [
        Checkpoint::AfterDesign,
        Checkpoint::BeforeImplementation,
        Checkpoint::BeforeDelivery,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            Checkpoint::AfterDesign => "after_design",
            Checkpoint::BeforeImplementation => "before_implementation",
            Checkpoint::BeforeDelivery => "before_delivery",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|c| c.as_str() == s.trim().to_ascii_lowercase().replace([' ', '-'], "_"))
    }

    /// "after design"
    pub fn label(&self) -> &'static str {
        match self {
            Checkpoint::AfterDesign => "after design",
            Checkpoint::BeforeImplementation => "before implementation",
            Checkpoint::BeforeDelivery => "before delivery",
        }
    }
}

/// An autonomy level with the checkpoints it stops at. The checkpoints only
/// apply at [`AutonomyLevel::Checkpoints`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct Autonomy {
    pub level: AutonomyLevel,
    pub checkpoints: Vec<Checkpoint>,
}

impl Default for Autonomy {
    fn default() -> Self {
        Autonomy {
            level: AutonomyLevel::default(),
            checkpoints: Checkpoint::ALL.to_vec(),
        }
    }
}

impl Autonomy {
    /// The same, with checkpoints in their natural order and once each.
    pub fn tidy(mut self) -> Self {
        self.checkpoints = Checkpoint::ALL
            .into_iter()
            .filter(|c| self.checkpoints.contains(c))
            .collect();
        self
    }

    /// Whether the owner must stop for the user's review at `c`.
    pub fn stops_at(&self, c: Checkpoint) -> bool {
        self.level == AutonomyLevel::Checkpoints && self.checkpoints.contains(&c)
    }

    /// "blocking decisions", "checkpoints (after design, before delivery)"
    pub fn describe(&self) -> String {
        match self.level {
            AutonomyLevel::Autonomous => "autonomous".into(),
            AutonomyLevel::BlockingDecisions => "blocking decisions".into(),
            AutonomyLevel::Checkpoints if self.checkpoints.is_empty() => {
                "checkpoints (none chosen)".into()
            }
            AutonomyLevel::Checkpoints => format!(
                "checkpoints ({})",
                self.checkpoints
                    .iter()
                    .map(Checkpoint::label)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }

    /// The part of a feature owner's system prompt that says when to come back to the user.
    pub fn prompt(&self) -> String {
        let mut p = format!(
            "## Autonomy: {}\n\nThe user set how much you decide on your own. ",
            self.describe()
        );
        p.push_str(match self.level {
            AutonomyLevel::Autonomous => "Decide everything yourself, product questions included, and record each decision that matters with `record_decision`. Use `ask_user` only before an action that is irreversible or reaches outside this machine (see below), with `kind: \"irreversible\"`; Aura refuses any other question. Everything else you decide, and the user reads your decisions in the feature's log and in your delivery report.",
            AutonomyLevel::BlockingDecisions | AutonomyLevel::Checkpoints => "Decide what you and your team can decide: technical choices, how to build, which specialist does what, small product details with an obvious answer. Record each decision that matters with `record_decision`. Use `ask_user` only when a decision is truly the user's and the work cannot go on well without it: scope, product direction, trade-offs with consequences the user will notice, anything that contradicts what they asked for, and irreversible or outward-facing actions. Batch related questions into one, and keep working on what does not depend on the answer.",
        });
        if self.level == AutonomyLevel::Checkpoints {
            if self.checkpoints.is_empty() {
                p.push_str("\n\nThe user chose no checkpoints, so `checkpoint` only records where you are.");
            } else {
                p.push_str("\n\nThe user also wants to review the work at these checkpoints. When you reach one, call `checkpoint` with the stage and a short summary of what there is to review and where; Aura turns it into a question for the user. End your turn and wait for their answer before you go past it:\n");
                for c in &self.checkpoints {
                    p.push_str(&format!(
                        "- `{}`: {}\n",
                        c.as_str(),
                        match c {
                            Checkpoint::AfterDesign => "the design (flows, screens, architecture) is done, before anyone builds it.",
                            Checkpoint::BeforeImplementation => "the plan is ready, before implementation starts.",
                            Checkpoint::BeforeDelivery => "the work is done and tested, before you merge, release or deliver it. Aura refuses `deliver_report` until the user approved this checkpoint.",
                        }
                    ));
                }
                p = p.trim_end().to_string();
            }
        } else {
            p.push_str("\n\nCall `checkpoint` at the end of design, before implementation and before delivery anyway: it records the feature's progress for the user, and Aura tells you whether to stop there.");
        }
        p.push_str("\n\nIrreversible or outward-facing actions always need the user's yes through `ask_user` with `kind: \"irreversible\"`, at every level: pushing to a shared branch or merging, opening, publishing or commenting on pull requests and issues, releases and deployments, deleting data or branches that are not your team's own, sending anything to other people or services, and spending money.");
        p
    }
}

/// The value of [`SETTING_KEY`] as saved; levels read from older or newer
/// versions fall back to the default.
pub fn parse_stored(raw: &str) -> Autonomy {
    serde_json::from_str::<Autonomy>(raw)
        .map(Autonomy::tidy)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_asks_about_blocking_decisions_and_keeps_every_checkpoint_ready() {
        let a = Autonomy::default();
        assert_eq!(a.level, AutonomyLevel::BlockingDecisions);
        assert!(!a.stops_at(Checkpoint::BeforeDelivery));
        let p = a.prompt();
        assert!(p.contains("## Autonomy: blocking decisions"), "{p}");
        assert!(p.contains("truly the user's"), "{p}");
        assert!(p.contains("kind: \"irreversible\""), "{p}");
    }

    #[test]
    fn autonomous_owners_only_ask_about_irreversible_actions() {
        let a = Autonomy {
            level: AutonomyLevel::Autonomous,
            checkpoints: vec![],
        };
        let p = a.prompt();
        assert!(p.contains("Decide everything yourself"), "{p}");
        assert!(p.contains("Aura refuses any other question"), "{p}");
    }

    #[test]
    fn checkpoints_are_listed_in_order_and_stop_the_owner() {
        let a = Autonomy {
            level: AutonomyLevel::Checkpoints,
            checkpoints: vec![
                Checkpoint::BeforeDelivery,
                Checkpoint::AfterDesign,
                Checkpoint::AfterDesign,
            ],
        }
        .tidy();
        assert_eq!(
            a.checkpoints,
            vec![Checkpoint::AfterDesign, Checkpoint::BeforeDelivery]
        );
        assert!(a.stops_at(Checkpoint::AfterDesign));
        assert!(!a.stops_at(Checkpoint::BeforeImplementation));
        let p = a.prompt();
        assert!(
            p.contains("## Autonomy: checkpoints (after design, before delivery)"),
            "{p}"
        );
        let design = p.find("`after_design`").unwrap();
        let delivery = p.find("`before_delivery`").unwrap();
        assert!(design < delivery);
        assert!(p.contains("refuses `deliver_report`"), "{p}");
        assert!(!p.contains("`before_implementation`"), "{p}");
    }

    #[test]
    fn checkpoints_parse_loosely_and_unreadable_settings_fall_back() {
        assert_eq!(
            Checkpoint::parse("Before delivery"),
            Some(Checkpoint::BeforeDelivery)
        );
        assert_eq!(
            Checkpoint::parse("after-design"),
            Some(Checkpoint::AfterDesign)
        );
        assert_eq!(Checkpoint::parse("later"), None);
        assert_eq!(parse_stored("{\"level\":\"soon\"}"), Autonomy::default());
        assert_eq!(
            parse_stored("{\"level\":\"autonomous\"}"),
            Autonomy {
                level: AutonomyLevel::Autonomous,
                checkpoints: Checkpoint::ALL.to_vec()
            }
        );
    }
}
