//! Help levels: one version of a stored challenge with more or less help on
//! screen — a cloze picked from four with its native hint, from six, or typed.
//!
//! A help level is a **step** from a short fixed list per type (easiest
//! first), plus two modifiers that exist only where they mean something: the
//! reading hidden (a row that stores readings) and listening (a recognize-style
//! multiple choice, played before it is read). It travels as one string —
//! `pick-6`, `typed-hidden`, `listening` — because that string is what an
//! answer event records as `shown` and what the shared difficulty numbers are
//! keyed by, so it has to stay stable across builds. An id this build does not
//! know still parses: [`HelpLevel::parse`] only fails on a step name, and
//! every consumer treats an unparsable id as "unknown", never as an error.

use std::fmt;

use crate::challenge::{Challenge, Direction};

/// The suffix a reading-hidden help level carries.
pub const HIDDEN_SUFFIX: &str = "-hidden";

/// The one listening help level's id.
pub const LISTENING: &str = "listening";

/// How much of a stored row a help level shows, before readings and listening.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Step {
    /// A type with one help level: the row as stored, native line included.
    Plain,
    /// A cloze picked from four, with its native hint.
    Pick4,
    /// A cloze picked from six, no hint.
    Pick6,
    /// A cloze typed from memory, no bank, no hint.
    Typed,
    /// A multi-cloze whose bank holds just its answers.
    Answers,
    /// A multi-cloze or word-order with two extra entries, no native line.
    Extra2,
    /// A word-order with just the sentence's own tiles, native line shown.
    Tiles,
}

impl Step {
    pub const fn as_str(self) -> &'static str {
        match self {
            Step::Plain => "plain",
            Step::Pick4 => "pick-4",
            Step::Pick6 => "pick-6",
            Step::Typed => "typed",
            Step::Answers => "answers",
            Step::Extra2 => "extra-2",
            Step::Tiles => "tiles",
        }
    }

    pub fn parse(name: &str) -> Option<Step> {
        [
            Step::Plain,
            Step::Pick4,
            Step::Pick6,
            Step::Typed,
            Step::Answers,
            Step::Extra2,
            Step::Tiles,
        ]
        .into_iter()
        .find(|step| step.as_str() == name)
    }

    /// Whether the native-language line shows at this step.
    pub fn shows_hint(self) -> bool {
        matches!(
            self,
            Step::Plain | Step::Pick4 | Step::Answers | Step::Tiles
        )
    }
}

/// One help level: a step, whether the reading is hidden, whether it listens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HelpLevel {
    pub step: Step,
    pub reading_hidden: bool,
    pub listening: bool,
}

impl HelpLevel {
    pub const fn step(step: Step) -> HelpLevel {
        HelpLevel {
            step,
            reading_hidden: false,
            listening: false,
        }
    }

    pub const fn hidden(step: Step) -> HelpLevel {
        HelpLevel {
            step,
            reading_hidden: true,
            listening: false,
        }
    }

    pub const LISTENING: HelpLevel = HelpLevel {
        step: Step::Plain,
        reading_hidden: false,
        listening: true,
    };

    pub fn id(&self) -> String {
        if self.listening {
            return LISTENING.to_owned();
        }
        let mut id = self.step.as_str().to_owned();
        if self.reading_hidden {
            id.push_str(HIDDEN_SUFFIX);
        }
        id
    }

    pub fn parse(id: &str) -> Option<HelpLevel> {
        if id == LISTENING {
            return Some(HelpLevel::LISTENING);
        }
        match id.strip_suffix(HIDDEN_SUFFIX) {
            Some(step) => Step::parse(step).map(HelpLevel::hidden),
            None => Step::parse(id).map(HelpLevel::step),
        }
    }
}

impl fmt::Display for HelpLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.id())
    }
}

/// Whether the stored row carries any reading: only then is "reading hidden"
/// a different screen from "reading shown".
pub fn has_readings(challenge: &Challenge) -> bool {
    let some = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
    let any = |value: &Option<Vec<String>>| {
        value
            .as_deref()
            .is_some_and(|v| v.iter().any(|r| !r.trim().is_empty()))
    };
    match challenge {
        Challenge::MultipleChoice(c) => {
            some(&c.prompt_romanization) || any(&c.options_romanization)
        }
        Challenge::Cloze(c) => some(&c.sentence_romanization) || any(&c.word_bank_romanization),
        Challenge::MultiCloze(c) => some(&c.passage_romanization) || any(&c.word_bank_romanization),
        Challenge::TypedTranslation(c) => some(&c.prompt_romanization),
        Challenge::MatchPairs(c) => c.pairs.iter().any(|p| some(&p.a_rom)),
        Challenge::WordOrder(c) => any(&c.tiles_romanization),
        Challenge::SpotError(c) => any(&c.tokens_romanization),
    }
}

/// Whether a row can be played before it is read: a recognize-style multiple
/// choice, whose prompt is the target-language text.
pub fn can_listen(challenge: &Challenge) -> bool {
    matches!(challenge, Challenge::MultipleChoice(c)
        if c.direction == Direction::ToNative && !crate::text::js_trim(&c.prompt).is_empty())
}

/// The steps a stored row can be shown at, easiest first — only the ones its
/// stored content can actually tell apart: a cloze with no bank is only ever
/// typed, a tray with no distractors only ever its own tiles.
pub fn steps_of(challenge: &Challenge) -> Vec<Step> {
    match challenge {
        Challenge::Cloze(c) => {
            if c.word_bank.as_ref().is_some_and(|bank| bank.len() > 1) {
                vec![Step::Pick4, Step::Pick6, Step::Typed]
            } else {
                vec![Step::Typed]
            }
        }
        Challenge::MultiCloze(c) => {
            if c.word_bank.len() > c.gaps.len() {
                vec![Step::Answers, Step::Extra2]
            } else {
                vec![Step::Answers]
            }
        }
        Challenge::WordOrder(c) => {
            if c.tiles.len() > c.answer_tokens.len() {
                vec![Step::Tiles, Step::Extra2]
            } else {
                vec![Step::Tiles]
            }
        }
        _ => vec![Step::Plain],
    }
}

/// The step a served screen corresponds to, from how much of the row it
/// showed: what an answer records, whatever decided the sizes.
pub fn step_for_sizes(challenge: &Challenge, bank_size: usize, distractor_tiles: usize) -> Step {
    match challenge {
        Challenge::Cloze(_) => match bank_size {
            0 => Step::Typed,
            1..=4 => Step::Pick4,
            _ => Step::Pick6,
        },
        Challenge::MultiCloze(c) => {
            if bank_size <= c.gaps.len() {
                Step::Answers
            } else {
                Step::Extra2
            }
        }
        Challenge::WordOrder(_) => {
            if distractor_tiles == 0 {
                Step::Tiles
            } else {
                Step::Extra2
            }
        }
        _ => Step::Plain,
    }
}

/// The help level a served screen was: its step, the reading hidden only where
/// the row has one to hide, and listening over both.
pub fn help_level_of(
    challenge: &Challenge,
    bank_size: usize,
    distractor_tiles: usize,
    reading_shown: bool,
    listening: bool,
) -> HelpLevel {
    if listening {
        return HelpLevel::LISTENING;
    }
    HelpLevel {
        step: step_for_sizes(challenge, bank_size, distractor_tiles),
        reading_hidden: !reading_shown && has_readings(challenge),
        listening: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: serde_json::Value) -> Challenge {
        let mut value = value;
        value["id"] = json!("c");
        value["itemIds"] = json!(["i"]);
        Challenge::from_value(value).unwrap()
    }

    fn cloze(bank: &[&str], reading: Option<&str>) -> Challenge {
        let mut value = json!({ "type": "cloze", "direction": "toTarget", "sentence": "我们想___。",
            "acceptedAnswers": ["买单"], "wordBank": bank });
        if let Some(reading) = reading {
            value["sentenceRomanization"] = json!(reading);
        }
        row(value)
    }

    #[test]
    fn an_id_round_trips_and_an_unknown_one_does_not_parse() {
        for step in [
            Step::Plain,
            Step::Pick4,
            Step::Pick6,
            Step::Typed,
            Step::Answers,
            Step::Extra2,
            Step::Tiles,
        ] {
            for level in [HelpLevel::step(step), HelpLevel::hidden(step)] {
                assert_eq!(HelpLevel::parse(&level.id()), Some(level));
            }
        }
        assert_eq!(HelpLevel::parse("listening"), Some(HelpLevel::LISTENING));
        assert_eq!(HelpLevel::step(Step::Pick6).id(), "pick-6");
        assert_eq!(HelpLevel::hidden(Step::Typed).id(), "typed-hidden");
        assert_eq!(HelpLevel::parse("pick-9"), None);
        assert_eq!(HelpLevel::parse(""), None);
    }

    #[test]
    fn a_served_screen_reads_back_as_its_step() {
        let c = cloze(&["买单", "a", "b", "c", "d", "e"], None);
        assert_eq!(step_for_sizes(&c, 0, 0), Step::Typed);
        assert_eq!(step_for_sizes(&c, 3, 0), Step::Pick4);
        assert_eq!(step_for_sizes(&c, 4, 0), Step::Pick4);
        assert_eq!(step_for_sizes(&c, 6, 0), Step::Pick6);
        let tiles = row(
            json!({ "type": "word-order", "direction": "toTarget", "tiles": ["a", "b", "x"],
            "answerTokens": ["a", "b"], "answer": "a b" }),
        );
        assert_eq!(step_for_sizes(&tiles, 0, 0), Step::Tiles);
        assert_eq!(step_for_sizes(&tiles, 0, 1), Step::Extra2);
        assert_eq!(steps_of(&tiles), [Step::Tiles, Step::Extra2]);
    }

    #[test]
    fn a_hidden_reading_counts_only_where_the_row_has_one() {
        let latin = cloze(&["a", "b", "c", "d"], None);
        assert_eq!(help_level_of(&latin, 4, 0, false, false).id(), "pick-4");
        let han = cloze(&["a", "b", "c", "d"], Some("Wǒmen xiǎng ___."));
        assert_eq!(
            help_level_of(&han, 4, 0, false, false).id(),
            "pick-4-hidden"
        );
        assert_eq!(help_level_of(&han, 4, 0, true, false).id(), "pick-4");
        assert_eq!(help_level_of(&han, 0, 0, false, true).id(), "listening");
    }

    #[test]
    fn a_bankless_cloze_is_only_ever_typed() {
        let bare = row(
            json!({ "type": "cloze", "direction": "toTarget", "sentence": "a ___", "acceptedAnswers": ["b"] }),
        );
        assert_eq!(steps_of(&bare), [Step::Typed]);
        assert_eq!(
            steps_of(&cloze(&["a", "b", "c", "d", "e", "f"], None)),
            [Step::Pick4, Step::Pick6, Step::Typed]
        );
    }
}
