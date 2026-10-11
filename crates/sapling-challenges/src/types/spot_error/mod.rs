use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::generation::TargetText;
use crate::help::{HelpLevel, Step};

use super::{any, exact, filled_common, ChallengePlugin, Common, Direction, Feedback, Graded};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[("spot-error", include_str!("lessons/spot-error.json"))];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpotErrorWire {
    #[schemars(length(min = 3))]
    pub words: Vec<TargetText>,
    pub wrong_word: TargetText,
    pub wrong_position: u32,
    pub meaning_native: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum SpotErrorTag {
    #[default]
    #[serde(rename = "spot-error")]
    Tag,
}
fn index<'de, D: Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    use serde::de::Error as _;
    let value = f64::deserialize(deserializer)?;
    if value >= 0.0 && value.fract() == 0.0 {
        Ok(value as usize)
    } else {
        Err(D::Error::custom(format!("{value} is not an index")))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SpotErrorChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: SpotErrorTag,
    pub id: String,
    pub direction: Direction,
    pub tokens: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens_romanization: Option<Vec<String>>,
    #[serde(deserialize_with = "index")]
    pub correct_index: usize,
    pub intended_word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub intended_word_romanization: Option<String>,
    pub corrected_sentence: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meaning: Option<String>,
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
pub struct SpotErrorScreen {
    pub show_hint: bool,
    pub readings: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct SpotErrorAnswer {
    pub index: usize,
}
pub struct SpotError;

impl ChallengePlugin for SpotError {
    const TAG: &'static str = "spot-error";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = SpotErrorChallenge;
    type Screen = SpotErrorScreen;
    type Answer = SpotErrorAnswer;
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
        if row.tokens.len() < 3
            || row.tokens.iter().any(String::is_empty)
            || row.intended_word.is_empty()
            || row.corrected_sentence.is_empty()
            || row.meaning.as_ref().is_some_and(String::is_empty)
        {
            Err(format!(
                "{}: needs three tokens, the intended word and the corrected sentence",
                Self::TAG
            ))
        } else {
            Ok(())
        }
    }
    fn steps(_: &Self::Stored) -> Vec<Step> {
        vec![Step::Plain]
    }
    fn has_readings(row: &Self::Stored) -> bool {
        any(&row.tokens_romanization)
    }
    fn screen(_: &Self::Stored, at: HelpLevel) -> Self::Screen {
        SpotErrorScreen {
            show_hint: true,
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        let text = row.corrected_sentence.trim();
        if text.is_empty() {
            vec![]
        } else {
            vec![text.to_owned()]
        }
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let given = row.tokens.get(answer.index).cloned().unwrap_or_default();
        Graded {
            verdict: exact(answer.index == row.correct_index),
            closest_accepted: None,
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: row.intended_word.clone(),
                answer_is_target_language: true,
                answer_reading: row.intended_word_romanization.clone(),
                spoken_answer: row.corrected_sentence.trim().to_owned(),
            },
            logged: given,
        }
    }
    fn correct_answer(row: &Self::Stored, _: HelpLevel) -> Self::Answer {
        SpotErrorAnswer {
            index: row.correct_index,
        }
    }
    fn measure(row: &Self::Stored) -> f64 {
        row.tokens.len() as f64
    }
}
