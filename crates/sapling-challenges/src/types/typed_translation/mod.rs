use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::generation::TargetText;
use crate::help::{HelpLevel, Step};
use crate::matcher::validate_answer;
use crate::model::words_in;

use super::{filled_common, some, ChallengePlugin, Common, Direction, Feedback, Graded};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[
    (
        "translate-to-native",
        include_str!("lessons/translate-to-native.json"),
    ),
    (
        "translate-to-target",
        include_str!("lessons/translate-to-target.json"),
    ),
];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateToNativeWire {
    pub prompt: TargetText,
    #[schemars(length(min = 1))]
    pub answers_native: Vec<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateToTargetWire {
    pub prompt_native: String,
    #[schemars(length(min = 1))]
    pub answers: Vec<TargetText>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum TypedTranslationTag {
    #[default]
    #[serde(rename = "typed-translation")]
    Tag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TypedTranslationChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: TypedTranslationTag,
    pub id: String,
    pub direction: Direction,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_romanization: Option<String>,
    pub accepted_answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<f64>,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TypedTranslationScreen {
    pub readings: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TypedTranslationAnswer {
    pub text: String,
}
pub struct TypedTranslation;

impl ChallengePlugin for TypedTranslation {
    const TAG: &'static str = "typed-translation";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = TypedTranslationChallenge;
    type Screen = TypedTranslationScreen;
    type Answer = TypedTranslationAnswer;
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
        if row.prompt.is_empty() || row.accepted_answers.is_empty() {
            Err(format!(
                "{}: needs a prompt and an accepted answer",
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
        some(&row.prompt_romanization)
    }
    fn screen(_: &Self::Stored, at: HelpLevel) -> Self::Screen {
        TypedTranslationScreen {
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        let text = if row.direction == Direction::ToNative {
            row.prompt.trim()
        } else {
            row.accepted_answers.first().map_or("", |s| s.trim())
        };
        if text.is_empty() {
            vec![]
        } else {
            vec![text.to_owned()]
        }
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let matched = validate_answer(&answer.text, &row.accepted_answers, true);
        let target = row.direction == Direction::ToTarget;
        let canonical = row.accepted_answers.first().cloned().unwrap_or_default();
        Graded {
            verdict: matched.verdict,
            closest_accepted: Some(matched.closest_accepted),
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: canonical.clone(),
                answer_is_target_language: target,
                answer_reading: target.then(|| row.answer_romanization.clone()).flatten(),
                spoken_answer: if target {
                    canonical.trim().to_owned()
                } else {
                    String::new()
                },
            },
            logged: answer.text.clone(),
        }
    }
    fn correct_answer(row: &Self::Stored, _: HelpLevel) -> Self::Answer {
        TypedTranslationAnswer {
            text: row.accepted_answers.first().cloned().unwrap_or_default(),
        }
    }
    fn measure(row: &Self::Stored) -> f64 {
        words_in(&row.prompt)
    }
}
