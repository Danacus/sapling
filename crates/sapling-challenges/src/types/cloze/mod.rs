use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::generation::TargetText;
use crate::help::{HelpLevel, Step};
use crate::matcher::validate_answer;
use crate::model::words_in;
use crate::serve::select_positions;

use super::{
    any, filled_common, some, unique_nonempty, ChallengePlugin, Common, Direction, Feedback, Graded,
};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[("cloze", include_str!("lessons/cloze.json"))];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClozeWire {
    pub before: TargetText,
    pub answer: TargetText,
    pub after: TargetText,
    pub hint_native: String,
    #[serde(default)]
    pub distractor_words: Option<Vec<TargetText>>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ClozeTag {
    #[default]
    #[serde(rename = "cloze")]
    Tag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClozeChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: ClozeTag,
    pub id: String,
    pub direction: Direction,
    pub sentence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sentence_romanization: Option<String>,
    pub accepted_answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank_romanization: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub translation_hint: Option<String>,
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
pub struct ClozeScreen {
    pub show_hint: bool,
    pub bank: Vec<usize>,
    pub readings: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClozeAnswer {
    pub text: String,
    pub picked: bool,
}

pub struct Cloze;

fn completed(row: &ClozeChallenge) -> String {
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

impl ChallengePlugin for Cloze {
    const TAG: &'static str = "cloze";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = ClozeChallenge;
    type Screen = ClozeScreen;
    type Answer = ClozeAnswer;
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
        if row.sentence.is_empty() || row.accepted_answers.is_empty() {
            Err(format!(
                "{}: needs a sentence and an accepted answer",
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
    fn has_readings(row: &Self::Stored) -> bool {
        some(&row.sentence_romanization) || any(&row.word_bank_romanization)
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
        ClozeScreen {
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
        let spoken = if row.direction == Direction::ToTarget {
            completed(row)
        } else {
            String::new()
        };
        Graded {
            verdict: matched.verdict,
            closest_accepted: Some(matched.closest_accepted),
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: row.accepted_answers.first().cloned().unwrap_or_default(),
                answer_is_target_language: true,
                answer_reading: row.answer_romanization.clone(),
                spoken_answer: spoken,
            },
            logged: answer.text.clone(),
        }
    }
    fn correct_answer(row: &Self::Stored, at: HelpLevel) -> Self::Answer {
        ClozeAnswer {
            text: row.accepted_answers.first().cloned().unwrap_or_default(),
            picked: !Self::screen(row, at).bank.is_empty(),
        }
    }
    fn measure(row: &Self::Stored) -> f64 {
        words_in(&row.sentence.replace("___", " ")) + 1.0
    }
}
