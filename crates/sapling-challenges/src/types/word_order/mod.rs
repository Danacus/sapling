use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::generation::TargetText;
use crate::help::{HelpLevel, Step};
use crate::matcher::normalize;
use crate::serve::visible_tiles;
use crate::text::{is_punctuation_only, join_tokens};

use super::{any, exact, filled_common, ChallengePlugin, Common, Direction, Feedback, Graded};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[("word-order", include_str!("lessons/word-order.json"))];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WordOrderWire {
    pub prompt_native: String,
    #[schemars(length(min = 2))]
    pub words: Vec<TargetText>,
    #[serde(default)]
    pub distractor_words: Option<Vec<TargetText>>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum WordOrderTag {
    #[default]
    #[serde(rename = "word-order")]
    Tag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WordOrderChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: WordOrderTag,
    pub id: String,
    pub direction: Direction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instruction: Option<String>,
    pub tiles: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tiles_romanization: Option<Vec<String>>,
    pub answer_tokens: Vec<String>,
    pub answer: String,
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
#[serde(rename_all = "camelCase")]
pub struct WordOrderScreen {
    pub show_hint: bool,
    pub tiles: Vec<usize>,
    pub readings: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct WordOrderAnswer {
    pub positions: Vec<usize>,
}
pub struct WordOrder;

impl ChallengePlugin for WordOrder {
    const TAG: &'static str = "word-order";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = WordOrderChallenge;
    type Screen = WordOrderScreen;
    type Answer = WordOrderAnswer;
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
        if row.prompt.as_ref().is_some_and(String::is_empty)
            || row.tiles.len() < 2
            || row.answer_tokens.len() < 2
            || row.tiles.iter().any(String::is_empty)
            || row.answer_tokens.iter().any(String::is_empty)
            || row.answer.is_empty()
        {
            Err(format!(
                "{}: needs two tiles, two answer tokens and an answer",
                Self::TAG
            ))
        } else {
            Ok(())
        }
    }
    fn steps(row: &Self::Stored) -> Vec<Step> {
        if row.tiles.len() > row.answer_tokens.len() {
            vec![Step::Tiles, Step::Extra2]
        } else {
            vec![Step::Tiles]
        }
    }
    fn has_readings(row: &Self::Stored) -> bool {
        any(&row.tiles_romanization)
    }
    fn screen(row: &Self::Stored, at: HelpLevel) -> Self::Screen {
        let extras = if at.step == Step::Extra2 {
            row.tiles
                .len()
                .saturating_sub(row.answer_tokens.len())
                .min(2)
        } else {
            0
        };
        WordOrderScreen {
            show_hint: at.step == Step::Tiles,
            tiles: visible_tiles(&row.tiles, &row.answer_tokens, extras),
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        if row.direction == Direction::ToTarget && !row.answer.trim().is_empty() {
            vec![row.answer.trim().to_owned()]
        } else {
            vec![]
        }
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let chosen: Vec<&str> = answer
            .positions
            .iter()
            .filter_map(|&i| row.tiles.get(i))
            .map(String::as_str)
            .filter(|s| !is_punctuation_only(s))
            .collect();
        let expected: Vec<&str> = row
            .answer_tokens
            .iter()
            .map(String::as_str)
            .filter(|s| !is_punctuation_only(s))
            .collect();
        let verdict = exact(chosen == expected);
        let logged = join_tokens(
            &answer
                .positions
                .iter()
                .filter_map(|&i| row.tiles.get(i))
                .cloned()
                .collect::<Vec<_>>(),
        );
        Graded {
            verdict,
            closest_accepted: None,
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: row.answer.clone(),
                answer_is_target_language: true,
                answer_reading: row.answer_romanization.clone(),
                spoken_answer: if row.direction == Direction::ToTarget {
                    row.answer.trim().to_owned()
                } else {
                    String::new()
                },
            },
            logged,
        }
    }
    fn correct_answer(row: &Self::Stored, _: HelpLevel) -> Self::Answer {
        let mut used = vec![false; row.tiles.len()];
        let positions = row
            .answer_tokens
            .iter()
            .filter_map(|token| {
                let at = row
                    .tiles
                    .iter()
                    .enumerate()
                    .find(|(i, tile)| {
                        !used[*i] && normalize(tile, false) == normalize(token, false)
                    })?
                    .0;
                used[at] = true;
                Some(at)
            })
            .collect();
        WordOrderAnswer { positions }
    }
    fn measure(row: &Self::Stored) -> f64 {
        row.answer_tokens.len() as f64
    }
}
