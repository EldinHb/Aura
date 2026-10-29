//! How a feature owner's team meets. One setting for every feature owner,
//! which a feature can override (see [`crate::features::Feature::meeting_mode`]).
//!
//! - **Written** (the default): every attendee answers the owner's question
//!   once, all at the same time, without seeing the others' answers. One turn
//!   per attendee.
//! - **Live**: a shared thread the owner chairs. In each round every attendee
//!   speaks in turn and sees the thread so far; after each round the owner
//!   reads the round and steers another one (`continue_meeting`) or closes
//!   the meeting (`close_meeting`). The rounds are capped, and each turn has a
//!   word budget stated in the prompt, so a live meeting costs at most
//!   attendees × rounds turns of a bounded size.
//!
//! In written mode `live` is refused, so the user decides whether live
//! meetings are worth their tokens.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Setting that holds [`MeetingSettings`] as JSON.
pub const SETTING_KEY: &str = "feature_owner_meetings";

/// The most rounds a live meeting may have.
pub const MAX_ROUNDS: u32 = 5;
/// The fewest and most words an attendee's turn may be asked to keep to.
pub const TURN_WORDS: (u32, u32) = (30, 400);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MeetingMode {
    /// Every attendee answers once, at the same time.
    #[default]
    Written,
    /// A shared thread in rounds, chaired by the owner.
    Live,
}

impl MeetingMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            MeetingMode::Written => "written",
            MeetingMode::Live => "live",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "written" => Some(MeetingMode::Written),
            "live" => Some(MeetingMode::Live),
            _ => None,
        }
    }
}

/// How feature owners' teams meet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct MeetingSettings {
    /// The mode meetings are held in; in `written`, live meetings are refused.
    pub mode: MeetingMode,
    /// Rounds a live meeting may have at most, 1 to [`MAX_ROUNDS`].
    pub max_rounds: u32,
    /// Words an attendee's turn in a live meeting keeps to.
    pub turn_words: u32,
}

impl Default for MeetingSettings {
    fn default() -> Self {
        MeetingSettings {
            mode: MeetingMode::Written,
            max_rounds: 2,
            turn_words: 150,
        }
    }
}

impl MeetingSettings {
    /// The same, with the numbers in their bounds.
    pub fn tidy(mut self) -> Self {
        self.max_rounds = self.max_rounds.clamp(1, MAX_ROUNDS);
        self.turn_words = self.turn_words.clamp(TURN_WORDS.0, TURN_WORDS.1);
        self
    }

    /// The part of a feature owner's system prompt about meetings in `mode`,
    /// the mode its feature follows.
    pub fn prompt(&self, mode: MeetingMode) -> String {
        match mode {
            MeetingMode::Written => "## Meetings: written\n\nThe user set meetings to written: `hold_meeting` sends every attendee your question at once and each answers once. Live meetings are refused; `continue_meeting` does not apply.".into(),
            MeetingMode::Live => format!(
                "## Meetings: live allowed\n\nThe user allows live meetings, and `hold_meeting` holds one unless you pass `mode: \"written\"`. In a live meeting you chair a shared thread: in each round every attendee speaks in turn, sees what was said before and keeps to about {} words. After each round Aura sends you the round in a message that starts with `[Aura] Live meeting notes`; then call `continue_meeting` with a steer for the next round (at most {} rounds), or `close_meeting` with the outcome. A live meeting costs a turn per attendee per round and each turn reads the thread so far, so it costs several times a written one. Hold one only when the attendees must react to each other to get to a decision, such as design and engineering weighing a trade-off with consequences for both; otherwise hold a written meeting (`mode: \"written\"`), and close a live one as soon as you can decide.",
                self.turn_words, self.max_rounds
            ),
        }
    }
}

/// The value of [`SETTING_KEY`] as saved; values read from older or newer
/// versions fall back to the default.
pub fn parse_stored(raw: &str) -> MeetingSettings {
    serde_json::from_str::<MeetingSettings>(raw)
        .map(MeetingSettings::tidy)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meetings_are_written_by_default_with_two_live_rounds_at_most() {
        let s = MeetingSettings::default();
        assert_eq!(s.mode, MeetingMode::Written);
        assert_eq!((s.max_rounds, s.turn_words), (2, 150));
        assert!(s
            .prompt(MeetingMode::Written)
            .contains("Live meetings are refused"));
        let live = s.prompt(MeetingMode::Live);
        assert!(live.contains("about 150 words"), "{live}");
        assert!(live.contains("at most 2 rounds"), "{live}");
        assert!(live.contains("`continue_meeting`") && live.contains("`close_meeting`"));
    }

    #[test]
    fn settings_stay_in_their_bounds_and_unreadable_ones_fall_back() {
        let s = MeetingSettings {
            mode: MeetingMode::Live,
            max_rounds: 9,
            turn_words: 5,
        }
        .tidy();
        assert_eq!((s.max_rounds, s.turn_words), (MAX_ROUNDS, TURN_WORDS.0));
        assert_eq!(
            parse_stored("{\"mode\":\"loud\"}"),
            MeetingSettings::default()
        );
        assert_eq!(
            parse_stored("{\"mode\":\"live\",\"max_rounds\":0}"),
            MeetingSettings {
                mode: MeetingMode::Live,
                max_rounds: 1,
                turn_words: 150
            }
        );
        assert_eq!(MeetingMode::parse(" Live "), Some(MeetingMode::Live));
        assert_eq!(MeetingMode::parse("loud"), None);
    }
}
