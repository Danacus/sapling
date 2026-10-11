use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_domain::types::Verdict;

use crate::help::{HelpLevel, Step};

use super::{
    filled_common, some, unique_nonempty, ChallengePlugin, Common, Direction, Feedback, Graded,
};
pub const TYPE_JSON: &str = include_str!("type.json");
pub const LESSONS: &[(&str, &str)] = &[];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MatchPairsTag {
    #[default]
    #[serde(rename = "match-pairs")]
    Tag,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchPair {
    pub a: String,
    pub b: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub a_rom: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub b_rom: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchPairsChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MatchPairsTag,
    pub id: String,
    pub direction: Direction,
    pub pairs: Vec<MatchPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchPairsScreen {
    pub readings: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct MatchPairsAnswer {
    pub mistakes: usize,
}
pub struct MatchPairs;

impl ChallengePlugin for MatchPairs {
    const TAG: &'static str = "match-pairs";
    const REVIEWS: bool = false;
    const POOLED: bool = false;
    type Stored = MatchPairsChallenge;
    type Screen = MatchPairsScreen;
    type Answer = MatchPairsAnswer;
    fn common(row: &Self::Stored) -> Common<'_> {
        Common {
            id: &row.id,
            direction: row.direction,
            item_ids: &row.item_ids,
            explanation: row.explanation.as_deref(),
            asked_length: None,
        }
    }
    fn set_asked_length(_: &mut Self::Stored, _: f64) {}
    fn check_shape(row: &Self::Stored) -> Result<(), String> {
        filled_common(Self::common(row), Self::TAG)?;
        if row.pairs.len() < 2 || row.pairs.iter().any(|p| p.a.is_empty() || p.b.is_empty()) {
            Err(format!(
                "{}: needs two pairs, both sides filled in",
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
        row.pairs.iter().any(|p| some(&p.a_rom))
    }
    fn screen(_: &Self::Stored, at: HelpLevel) -> Self::Screen {
        MatchPairsScreen {
            readings: !at.reading_hidden,
        }
    }
    fn audio_texts(row: &Self::Stored) -> Vec<String> {
        unique_nonempty(row.pairs.iter().map(|p| p.a.trim().to_owned()))
    }
    fn grade(row: &Self::Stored, _: HelpLevel, answer: &Self::Answer) -> Graded {
        let verdict = if answer.mistakes == 0 {
            Verdict::Correct
        } else {
            Verdict::Almost
        };
        Graded {
            verdict,
            closest_accepted: None,
            item_verdicts: None,
            feedback: Feedback {
                correct_answer_text: String::new(),
                answer_is_target_language: false,
                answer_reading: None,
                spoken_answer: String::new(),
            },
            logged: format!(
                "{} pairs, {} mistake{}",
                row.pairs.len(),
                answer.mistakes,
                if answer.mistakes == 1 { "" } else { "s" }
            ),
        }
    }
    fn correct_answer(_: &Self::Stored, _: HelpLevel) -> Self::Answer {
        MatchPairsAnswer { mistakes: 0 }
    }
    fn measure(row: &Self::Stored) -> f64 {
        row.pairs.len() as f64
    }
}
