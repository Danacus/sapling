use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_domain::types::Verdict;

use crate::generation::TargetText;
use crate::grade::{multi_cloze_marker, GapVerdict};
use crate::help::{HelpLevel, Step};
use crate::matcher::validate_answer;
use crate::model::words_in;
use crate::serve::select_positions;

use super::{
    any, filled_common, some, unique_nonempty, ChallengePlugin, Common, Direction, Feedback, Graded,
};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[("multi-cloze", include_str!("lessons/multi-cloze.json"))];

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GapWire {
    pub item_id: String,
    pub answer: TargetText,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeWire {
    #[schemars(length(min = 3, max = 5))]
    pub parts: Vec<TargetText>,
    #[schemars(length(min = 2, max = 4))]
    pub gaps: Vec<GapWire>,
    #[schemars(length(min = 2))]
    pub distractor_words: Vec<TargetText>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MultiClozeTag {
    #[default]
    #[serde(rename = "multi-cloze")]
    Tag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeGap {
    pub item_id: String,
    pub accepted_answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MultiClozeTag,
    pub id: String,
    pub direction: Direction,
    pub passage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub passage_romanization: Option<String>,
    pub gaps: Vec<MultiClozeGap>,
    pub word_bank: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank_romanization: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<f64>,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MultiClozeScreen {
    pub bank: Vec<usize>,
    pub readings: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MultiClozeAnswer {
    pub positions: Vec<usize>,
}
pub struct MultiCloze;

fn completed(row: &MultiClozeChallenge) -> String {
    row.gaps
        .iter()
        .enumerate()
        .fold(row.passage.clone(), |passage, (i, gap)| {
            passage.replace(
                &multi_cloze_marker(i),
                gap.accepted_answers.first().map_or("", String::as_str),
            )
        })
}
fn logged(values: &[String]) -> String {
    values
        .iter()
        .enumerate()
        .map(|(i, value)| {
            format!(
                "{}: {}",
                i + 1,
                if value.trim().is_empty() {
                    "—"
                } else {
                    value.trim()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

impl ChallengePlugin for MultiCloze {
    const TAG: &'static str = "multi-cloze";
    const REVIEWS: bool = true;
    const POOLED: bool = true;
    type Stored = MultiClozeChallenge;
    type Screen = MultiClozeScreen;
    type Answer = MultiClozeAnswer;
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
        let blank = |v: &[String]| v.iter().any(String::is_empty);
        if row.direction != Direction::ToTarget
            || row.passage.is_empty()
            || !(2..=4).contains(&row.gaps.len())
            || row.word_bank.len() < row.gaps.len() + 2
            || blank(&row.word_bank)
            || row.gaps.iter().any(|g| {
                g.item_id.is_empty() || g.accepted_answers.is_empty() || blank(&g.accepted_answers)
            })
        {
            return Err(format!(
                "{}: needs 2-4 filled gaps and a bank of two more",
                Self::TAG
            ));
        }
        let mut ids: Vec<&str> = row.gaps.iter().map(|g| g.item_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != row.gaps.len() {
            return Err(format!("{}: every gap needs its own item", Self::TAG));
        }
        if row.item_ids.len() != row.gaps.len()
            || row.gaps.iter().any(|g| !row.item_ids.contains(&g.item_id))
        {
            return Err(format!(
                "{}: itemIds must contain exactly the gap items",
                Self::TAG
            ));
        }
        for i in 0..row.gaps.len() {
            let marker = multi_cloze_marker(i);
            if row.passage.matches(&marker).count() != 1 {
                return Err(format!(
                    "{}: the passage must contain {marker} exactly once",
                    Self::TAG
                ));
            }
        }
        Ok(())
    }
    fn steps(row: &Self::Stored) -> Vec<Step> {
        if row.word_bank.len() > row.gaps.len() {
            vec![Step::Answers, Step::Extra2]
        } else {
            vec![Step::Answers]
        }
    }
    fn has_readings(row: &Self::Stored) -> bool {
        some(&row.passage_romanization) || any(&row.word_bank_romanization)
    }
    fn screen(row: &Self::Stored, at: HelpLevel) -> Self::Screen {
        let size = row
            .word_bank
            .len()
            .min(row.gaps.len() + if at.step == Step::Extra2 { 2 } else { 0 });
        let mut answers = Vec::new();
        for gap in &row.gaps {
            if let Some(answer) = gap.accepted_answers.first() {
                if let Some(at) = row
                    .word_bank
                    .iter()
                    .enumerate()
                    .find(|(i, v)| !answers.contains(i) && *v == answer)
                    .map(|(i, _)| i)
                {
                    answers.push(at);
                }
            }
        }
        MultiClozeScreen {
            bank: select_positions(row.word_bank.len(), &answers, size),
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        let mut asked = row.passage.clone();
        for i in 0..row.gaps.len() {
            asked = asked.replace(&multi_cloze_marker(i), "…");
        }
        unique_nonempty([asked.trim().to_owned(), completed(row).trim().to_owned()])
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let values: Vec<String> = answer
            .positions
            .iter()
            .map(|&i| row.word_bank.get(i).cloned().unwrap_or_default())
            .collect();
        let item_verdicts: Vec<GapVerdict> = row
            .gaps
            .iter()
            .enumerate()
            .map(|(i, gap)| GapVerdict {
                item_id: gap.item_id.clone(),
                verdict: validate_answer(
                    values.get(i).map_or("", String::as_str),
                    &gap.accepted_answers,
                    false,
                )
                .verdict,
            })
            .collect();
        let verdict = if item_verdicts.iter().any(|g| g.verdict == Verdict::Wrong) {
            Verdict::Wrong
        } else if item_verdicts.iter().any(|g| g.verdict == Verdict::Almost) {
            Verdict::Almost
        } else {
            Verdict::Correct
        };
        let correct = logged(
            &row.gaps
                .iter()
                .map(|g| g.accepted_answers.first().cloned().unwrap_or_default())
                .collect::<Vec<_>>(),
        );
        Graded {
            verdict,
            closest_accepted: None,
            item_verdicts: Some(item_verdicts),
            feedback: Feedback {
                correct_answer_text: correct,
                answer_is_target_language: true,
                answer_reading: None,
                spoken_answer: completed(row).trim().to_owned(),
            },
            logged: logged(&values),
        }
    }
    fn correct_answer(row: &Self::Stored, _: HelpLevel) -> Self::Answer {
        let mut used = Vec::new();
        for gap in &row.gaps {
            if let Some(answer) = gap.accepted_answers.first() {
                if let Some(at) = row
                    .word_bank
                    .iter()
                    .enumerate()
                    .find(|(i, v)| !used.contains(i) && *v == answer)
                    .map(|(i, _)| i)
                {
                    used.push(at);
                }
            }
        }
        MultiClozeAnswer { positions: used }
    }
    fn measure(row: &Self::Stored) -> f64 {
        let mut passage = row.passage.clone();
        for i in 0..row.gaps.len() {
            passage = passage.replace(&multi_cloze_marker(i), " ");
        }
        words_in(&passage) + row.gaps.len() as f64
    }
}
