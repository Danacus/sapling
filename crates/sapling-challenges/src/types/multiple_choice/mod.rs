use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::generation::TargetText;
use crate::help::{HelpLevel, Step};
use crate::model::words_in;
use crate::text::js_trim;

use super::{any, filled_common, some, ChallengePlugin, Common, Direction, Feedback, Graded};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[
    ("recognize-mc", include_str!("lessons/recognize-mc.json")),
    ("produce-mc", include_str!("lessons/produce-mc.json")),
    ("context-mc", include_str!("lessons/context-mc.json")),
];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeMcWire {
    pub shown: TargetText,
    pub correct_meaning: String,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProduceMcWire {
    pub prompt_native: String,
    pub correct: TargetText,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<TargetText>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextMcWire {
    pub prompt: TargetText,
    pub correct: TargetText,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<TargetText>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MultipleChoiceTag {
    #[default]
    #[serde(rename = "multiple-choice")]
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
pub struct MultipleChoiceChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MultipleChoiceTag,
    pub id: String,
    pub direction: Direction,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "true")]
    pub prompt_is_target: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instruction: Option<String>,
    pub options: [String; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options_romanization: Option<Vec<String>>,
    #[serde(deserialize_with = "index")]
    pub correct_index: usize,
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
pub struct MultipleChoiceScreen {
    pub readings: bool,
    pub listening: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MultipleChoiceAnswer {
    pub index: usize,
}

pub struct MultipleChoice;

impl ChallengePlugin for MultipleChoice {
    const TAG: &'static str = "multiple-choice";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = MultipleChoiceChallenge;
    type Screen = MultipleChoiceScreen;
    type Answer = MultipleChoiceAnswer;

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
        if row.prompt.is_empty() || row.correct_index > 3 {
            return Err(format!(
                "{}: needs a prompt and a correct index in 0..=3",
                Self::TAG
            ));
        }
        if row
            .options_romanization
            .as_ref()
            .is_some_and(|r| r.len() != 4)
        {
            return Err(format!(
                "{}: optionsRomanization must align with the four options",
                Self::TAG
            ));
        }
        Ok(())
    }
    fn steps(_: &Self::Stored) -> Vec<Step> {
        vec![Step::Plain]
    }
    fn has_readings(row: &Self::Stored) -> bool {
        some(&row.prompt_romanization) || any(&row.options_romanization)
    }
    fn can_listen(row: &Self::Stored) -> bool {
        row.direction == Direction::ToNative && !js_trim(&row.prompt).is_empty()
    }
    fn screen(_: &Self::Stored, at: HelpLevel) -> Self::Screen {
        MultipleChoiceScreen {
            readings: !at.reading_hidden,
            listening: at.listening,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        let text = if row.direction == Direction::ToNative {
            row.prompt.trim()
        } else {
            row.options.get(row.correct_index).map_or("", |s| s.trim())
        };
        if text.is_empty() {
            vec![]
        } else {
            vec![text.to_owned()]
        }
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let correct = row
            .options
            .get(row.correct_index)
            .cloned()
            .unwrap_or_default();
        let given = row.options.get(answer.index).cloned().unwrap_or_default();
        let target = row.direction == Direction::ToTarget;
        Graded {
            verdict: super::exact(answer.index == row.correct_index),
            closest_accepted: None,
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: correct.clone(),
                answer_is_target_language: target,
                answer_reading: target
                    .then(|| {
                        row.options_romanization
                            .as_ref()?
                            .get(row.correct_index)
                            .cloned()
                    })
                    .flatten(),
                spoken_answer: if target {
                    correct.trim().to_owned()
                } else {
                    String::new()
                },
            },
            logged: given,
        }
    }
    fn correct_answer(row: &Self::Stored, _: HelpLevel) -> Self::Answer {
        MultipleChoiceAnswer {
            index: row.correct_index,
        }
    }
    fn measure(row: &Self::Stored) -> f64 {
        words_in(&row.prompt)
    }
}
