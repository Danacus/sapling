//! A cloze cut from one of the learner's own imported subtitle cues, built on
//! this device (`local.rs`), never written by the model. Only the blanked term
//! is graded, so a caption's mis-hearings elsewhere in the line are context,
//! not answers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::help::{HelpLevel, Step};
use crate::matcher::validate_answer;
use crate::model::words_in;
use crate::serve::select_positions;
use crate::text::written_in_latin;

use super::{filled_common, unique_nonempty, ChallengePlugin, Common, Direction, Feedback, Graded};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum CueClozeTag {
    #[default]
    #[serde(rename = "cue-cloze")]
    Tag,
}

/// The cue a row was cut from: a copy of its span, so serving never joins texts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueRef {
    pub text_id: String,
    /// Only for a text whose media is a YouTube video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub video_id: Option<String>,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueClozeChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: CueClozeTag,
    pub id: String,
    pub direction: Direction,
    /// The cue's text with the term replaced by `___`.
    pub sentence: String,
    pub accepted_answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank: Option<Vec<String>>,
    /// The word's meaning, shown at the easiest step: a cue has no translation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meaning_hint: Option<String>,
    pub cue: CueRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<f64>,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueClozeScreen {
    pub show_hint: bool,
    pub bank: Vec<usize>,
    pub readings: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueClozeAnswer {
    pub text: String,
    pub picked: bool,
}

pub struct CueCloze;

fn completed(row: &CueClozeChallenge) -> String {
    let answer = row
        .accepted_answers
        .first()
        .map_or("", String::as_str)
        .trim();
    if answer.is_empty() {
        String::new()
    } else {
        row.sentence.replace("___", answer)
    }
}

/// A row's length: the cue's words, the blank counting as one.
pub fn measured(sentence: &str) -> f64 {
    words_in(&sentence.replace("___", " ")) + 1.0
}

impl ChallengePlugin for CueCloze {
    const TAG: &'static str = "cue-cloze";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = CueClozeChallenge;
    type Screen = CueClozeScreen;
    type Answer = CueClozeAnswer;
    fn common(row: &Self::Stored) -> Common<'_> {
        Common {
            id: &row.id,
            direction: row.direction,
            item_ids: &row.item_ids,
            explanation: row.explanation.as_deref(),
            asked_length: row.length,
        }
    }
    fn set_asked_length(row: &mut Self::Stored, length: f64) {
        row.length = Some(length);
    }
    fn check_shape(row: &Self::Stored) -> Result<(), String> {
        filled_common(Self::common(row), Self::TAG)?;
        if !row.sentence.contains("___") || row.accepted_answers.is_empty() {
            Err(format!(
                "{}: needs a blank and an accepted answer",
                Self::TAG
            ))
        } else {
            Ok(())
        }
    }
    fn steps(row: &Self::Stored) -> Vec<Step> {
        if row.word_bank.as_ref().is_some_and(|b| b.len() > 1) {
            vec![Step::Pick4, Step::Pick6, Step::Typed]
        } else {
            vec![Step::Typed]
        }
    }
    /// The frontend romanizes at render time, so a reading exists wherever
    /// the cue is not written in Latin.
    fn has_readings(row: &Self::Stored) -> bool {
        !written_in_latin(&row.sentence)
    }
    fn screen(row: &Self::Stored, at: HelpLevel) -> Self::Screen {
        let stored = row.word_bank.as_ref().map_or(0, Vec::len);
        let size = match at.step {
            Step::Pick4 => stored.min(4),
            Step::Pick6 => stored.min(6),
            _ => 0,
        };
        let answers: Vec<usize> = row
            .accepted_answers
            .first()
            .and_then(|answer| row.word_bank.as_ref()?.iter().position(|v| v == answer))
            .into_iter()
            .collect();
        CueClozeScreen {
            show_hint: at.step == Step::Pick4,
            bank: if size == 0 {
                vec![]
            } else {
                select_positions(stored, &answers, size)
            },
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        unique_nonempty([row.sentence.replace("___", "…"), completed(row)])
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let matched = validate_answer(&answer.text, &row.accepted_answers, !answer.picked);
        Graded {
            verdict: matched.verdict,
            closest_accepted: Some(matched.closest_accepted),
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: row.accepted_answers.first().cloned().unwrap_or_default(),
                answer_is_target_language: true,
                answer_reading: None,
                spoken_answer: completed(row),
            },
            logged: answer.text.clone(),
        }
    }
    fn correct_answer(row: &Self::Stored, at: HelpLevel) -> Self::Answer {
        CueClozeAnswer {
            text: row.accepted_answers.first().cloned().unwrap_or_default(),
            picked: !Self::screen(row, at).bank.is_empty(),
        }
    }
    fn measure(row: &Self::Stored) -> f64 {
        measured(&row.sentence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Challenge;
    use serde_json::json;

    fn row(sentence: &str) -> Challenge {
        Challenge::from_value(json!({
            "type": "cue-cloze", "id": "q", "direction": "toTarget", "sentence": sentence,
            "acceptedAnswers": ["Perro"], "wordBank": ["Perro", "gato", "casa"],
            "meaningHint": "dog", "cue": { "textId": "t", "videoId": "v", "start": 1000.0, "end": 2500.0 },
            "length": 4.0, "itemIds": ["i"]
        }))
        .unwrap()
    }

    #[test]
    fn readings_follow_the_script_and_the_hint_shows_only_at_the_easiest_step() {
        assert!(!row("El ___ ladra.").has_readings());
        assert!(row("我的___很大").has_readings());
        let Challenge::CueCloze(r) = row("El ___ ladra.") else {
            unreachable!()
        };
        assert!(CueCloze::screen(&r, HelpLevel::step(Step::Pick4)).show_hint);
        assert!(!CueCloze::screen(&r, HelpLevel::step(Step::Pick6)).show_hint);
        assert_eq!(
            CueCloze::audio_texts(&r),
            ["El … ladra.", "El Perro ladra."]
        );
        assert_eq!(measured("El ___ ladra."), 3.0);
    }
}
