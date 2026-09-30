//! The part of a `KnowledgeItem` the challenge layer reads, and the two facts
//! about a word that are *display*, never difficulty: how far along it looks
//! (the home page's garden and the reader's colours) and how likely the reader
//! is to hide its reading. Neither decides what a challenge asks — that is the
//! difficulty model's (`model.rs`, `fits.rs`) — so their cut points live here,
//! read off the strength bar alone.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_srs::ItemSrs;

use crate::model::{starting_skill, tuning};

/// The part of a `KnowledgeItem` the challenge layer reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: String,
    pub term: String,
    pub meaning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub romanization: Option<String>,
    /// As of the read; absent for a word never scheduled, which reads as brand new.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub srs: Option<ItemSrs>,
    /// The difficulty model's skill for the word, learned from its answers;
    /// absent until it has any, which reads as the starting skill.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skill: Option<f64>,
}

impl Word {
    /// The strength bar: display only.
    pub fn strength(&self) -> f64 {
        self.srs.as_ref().map_or(0.0, |srs| srs.strength)
    }

    /// When the schedule owes this word; a word never scheduled is owed now.
    pub fn due_at(&self, now: f64) -> f64 {
        self.srs.as_ref().map_or(now, |srs| srs.due)
    }

    pub fn is_due(&self, now: f64) -> bool {
        self.due_at(now) <= now
    }

    /// FSRS's chance the word is remembered now. A word FSRS has no curve for
    /// — never reviewed — reads the model's new-word memory, as replay does.
    pub fn memory(&self) -> f64 {
        match &self.srs {
            Some(srs) if srs.retrievability > 0.0 => srs.retrievability,
            _ => tuning().new_word_memory,
        }
    }

    pub fn skill(&self) -> f64 {
        self.skill.unwrap_or_else(starting_skill)
    }

    /// A word with nothing to write or grade a challenge about.
    pub fn is_writable(&self) -> bool {
        !crate::text::js_trim(&self.term).is_empty()
            && !crate::text::js_trim(&self.meaning).is_empty()
    }
}

/// The words by id, built once per question over many challenges.
pub type ById<'a> = HashMap<&'a str, &'a Word>;

pub fn by_id(words: &[Word]) -> ById<'_> {
    words.iter().map(|word| (word.id.as_str(), word)).collect()
}

/// How far along a word looks, in three coarse steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Maturity {
    New,
    Young,
    Solid,
}

/// Where the strength bar reads young (about one good review) and solid
/// (about three). Display cut points — nothing is served by them.
const YOUNG_FROM: f64 = 0.15;
const SOLID_FROM: f64 = 0.45;

pub fn maturity_for_strength(strength: f64) -> Maturity {
    if strength >= SOLID_FROM {
        Maturity::Solid
    } else if strength >= YOUNG_FROM {
        Maturity::Young
    } else {
        Maturity::New
    }
}

/// The reader's ramp: nothing hidden below this strength, everything from
/// the ceiling, linear between. Challenges no longer read it — a challenge's
/// reading is a help level — but a text in the reader still fades per word.
const HIDE_FLOOR: f64 = 0.35;
const HIDE_CEILING: f64 = 0.85;

/// Probability that the reader hides a word's reading at this strength.
pub fn hide_reading_probability(strength: f64) -> f64 {
    ((strength - HIDE_FLOOR) / (HIDE_CEILING - HIDE_FLOOR)).clamp(0.0, 1.0)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn word(id: &str, strength: Option<f64>) -> Word {
        Word {
            id: id.into(),
            term: id.into(),
            meaning: format!("meaning of {id}"),
            romanization: None,
            srs: strength.map(|strength| ItemSrs {
                due: 0.0,
                retrievability: 1.0,
                strength,
            }),
            skill: None,
        }
    }

    #[test]
    fn maturity_reads_the_strength_bar_in_three_steps() {
        assert_eq!(maturity_for_strength(0.0), Maturity::New);
        assert_eq!(maturity_for_strength(0.118), Maturity::New);
        assert_eq!(maturity_for_strength(0.32), Maturity::Young);
        assert_eq!(maturity_for_strength(0.698), Maturity::Solid);
        assert_eq!(maturity_for_strength(YOUNG_FROM), Maturity::Young);
        assert_eq!(maturity_for_strength(SOLID_FROM), Maturity::Solid);
    }

    #[test]
    fn the_readers_ramp_is_linear_between_its_floor_and_ceiling() {
        assert_eq!(hide_reading_probability(0.0), 0.0);
        assert_eq!(hide_reading_probability(HIDE_FLOOR), 0.0);
        assert_eq!(hide_reading_probability(HIDE_CEILING), 1.0);
        assert_eq!(hide_reading_probability(2.0), 1.0);
        assert!((hide_reading_probability((HIDE_FLOOR + HIDE_CEILING) / 2.0) - 0.5).abs() < 1e-10);
    }

    #[test]
    fn a_word_never_reviewed_reads_the_new_word_memory_and_the_starting_skill() {
        let fresh = word("w", None);
        assert_eq!(fresh.memory(), tuning().new_word_memory);
        assert_eq!(fresh.skill(), starting_skill());
        let mut known = word("w", Some(0.5));
        known.srs.as_mut().unwrap().retrievability = 0.7;
        known.skill = Some(3.0);
        assert_eq!(known.memory(), 0.7);
        assert_eq!(known.skill(), 3.0);
    }
}
