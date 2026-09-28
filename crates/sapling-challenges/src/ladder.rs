//! Which *kind* of question a word is ready for.
//!
//! A word's strength (log-stability × retrievability, derived by the core when
//! the item is read) is sliced into five rungs on four floors. Rung 1 bears
//! recognition only, rungs 2-3 constrained production, 4-5 free production —
//! the same boundaries the demand tiers of `difficulty.rs` are measured on, so
//! a challenge's difficulty and the strength that makes it bearable are one
//! axis. A challenge is judged by its **weakest** word, and an id that no
//! longer resolves is the weakest word there is.
//!
//! Bearability is a serving rule, not a grading one: grading stays type-blind,
//! because a verdict is FSRS's evidence about the word.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_srs::ItemSrs;

use crate::challenge::Challenge;
use crate::difficulty::{demand_of, Demand};
use crate::tuning::ladders;

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
}

impl Word {
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

    pub fn level(&self) -> u8 {
        level_for_strength(self.strength())
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

/// How far along a word is in three coarse steps: the ladder read at coarser
/// resolution (1 new, 2-3 young, 4-5 solid).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Maturity {
    New,
    Young,
    Solid,
}

/// The rung a bare strength sits on, inclusive at each floor.
pub fn level_for_strength(strength: f64) -> u8 {
    let f = &ladders().floors;
    if strength >= f.level5 {
        5
    } else if strength >= f.level4 {
        4
    } else if strength >= f.level3 {
        3
    } else if strength >= f.level2 {
        2
    } else {
        1
    }
}

/// The `[start, end)` span of strength each rung owns (closed at 1).
pub fn level_band(level: u8) -> (f64, f64) {
    let f = &ladders().floors;
    match level.clamp(1, 5) {
        1 => (0.0, f.level2),
        2 => (f.level2, f.level3),
        3 => (f.level3, f.level4),
        4 => (f.level4, f.level5),
        _ => (f.level5, 1.0),
    }
}

/// The strength a challenge written *for* a rung aims at: what the planner
/// matches a pooled challenge's difficulty against, rather than raw strength,
/// which in the upper half of every band would always pick its hardest row.
pub fn level_band_centre(level: u8) -> f64 {
    let (start, end) = level_band(level);
    (start + end) / 2.0
}

/// The demand tier a rung can bear.
pub fn demand_for_level(level: u8) -> Demand {
    match level {
        4.. => 2,
        2..=3 => 1,
        _ => 0,
    }
}

pub fn maturity_for_strength(strength: f64) -> Maturity {
    match level_for_strength(strength) {
        4.. => Maturity::Solid,
        2..=3 => Maturity::Young,
        _ => Maturity::New,
    }
}

/// The strength that decides what a challenge may ask: its weakest word's.
pub fn weakest_strength(challenge: &Challenge, words: &ById) -> f64 {
    weakest_of(challenge.item_ids(), words)
}

pub fn weakest_of(ids: &[String], words: &ById) -> f64 {
    if ids.is_empty() {
        return 0.0;
    }
    ids.iter()
        .map(|id| words.get(id.as_str()).map_or(0.0, |word| word.strength()))
        .fold(1.0, f64::min)
}

pub fn weakest_level(challenge: &Challenge, words: &ById) -> u8 {
    level_for_strength(weakest_strength(challenge, words))
}

/// The rung at which a served cloze shows no bank: the ladder's one zero.
pub fn cloze_typed_level() -> u8 {
    let at = ladders()
        .cloze_bank
        .iter()
        .position(|&size| size == 0)
        .expect("the cloze bank ladder has a zero rung");
    at as u8 + 1
}

/// The demand a *served* challenge asks: [`demand_of`], except that a banked
/// cloze whose bank the served view has trimmed away is answered like a typed
/// one.
pub fn served_demand(challenge: &Challenge, words: &ById) -> Demand {
    let demand = demand_of(challenge);
    if matches!(challenge, Challenge::Cloze(_))
        && demand == 1
        && weakest_level(challenge, words) >= cloze_typed_level()
    {
        return 2;
    }
    demand
}

/// The highest tier this challenge's weakest word can bear, inclusive at the floors.
pub fn bearable_demand(challenge: &Challenge, words: &ById) -> Demand {
    demand_for_level(weakest_level(challenge, words))
}

/// Whether this challenge may be served to its words at all.
pub fn bearable(challenge: &Challenge, words: &ById) -> bool {
    served_demand(challenge, words) <= bearable_demand(challenge, words)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::{json, Value};

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
        }
    }

    pub fn challenge(sample: Value, item_ids: &[&str]) -> Challenge {
        let mut row = sample;
        row["id"] = json!("c1");
        row["itemIds"] = json!(item_ids);
        Challenge::from_value(row).unwrap()
    }

    const SHAKY: f64 = 0.118;
    const LEARNED: f64 = 0.32;
    const OWNED: f64 = 0.698;
    const MASTERED: f64 = 0.9;

    fn vocabulary() -> Vec<Word> {
        vec![
            word("brand-new", Some(0.0)),
            word("shaky", Some(SHAKY)),
            word("learned", Some(LEARNED)),
            word("owned", Some(OWNED)),
            word("mastered", Some(MASTERED)),
            word("cardless", None),
        ]
    }

    fn mc() -> Value {
        json!({ "type": "multiple-choice", "direction": "toNative", "prompt": "p",
            "options": ["a", "b", "c", "d"], "correctIndex": 0 })
    }
    fn typed(direction: &str) -> Value {
        json!({ "type": "typed-translation", "direction": direction, "prompt": "p", "acceptedAnswers": ["a"] })
    }
    fn word_order() -> Value {
        json!({ "type": "word-order", "direction": "toTarget", "tiles": ["a", "b"],
            "answerTokens": ["a", "b"], "answer": "a b" })
    }
    fn cloze(bank: Option<&[&str]>) -> Value {
        let mut row = json!({ "type": "cloze", "direction": "toTarget", "sentence": "Yo ___.", "acceptedAnswers": ["a"] });
        if let Some(bank) = bank {
            row["wordBank"] = json!(bank);
        }
        row
    }

    #[test]
    fn the_weakest_word_decides_and_a_missing_one_is_weakest() {
        let words = vocabulary();
        let index = by_id(&words);
        assert_eq!(
            weakest_strength(&challenge(mc(), &["owned", "shaky"]), &index),
            SHAKY
        );
        assert_eq!(
            weakest_strength(&challenge(mc(), &["owned", "gone"]), &index),
            0.0
        );
        assert_eq!(
            weakest_strength(&challenge(mc(), &["cardless"]), &index),
            0.0
        );
        assert_eq!(weakest_strength(&challenge(mc(), &[]), &index), 0.0);
    }

    #[test]
    fn bearable_demand_climbs_a_tier_at_each_floor_inclusive() {
        let words = vocabulary();
        let index = by_id(&words);
        let on = |id: &str| bearable_demand(&challenge(mc(), &[id]), &index);
        assert_eq!(on("brand-new"), 0);
        assert_eq!(on("shaky"), 0);
        assert_eq!(on("learned"), 1);
        assert_eq!(on("owned"), 2);
        let floors = [
            word("c", Some(ladders().floors.level2)),
            word("f", Some(ladders().floors.level4)),
        ];
        let at = by_id(&floors);
        assert_eq!(bearable_demand(&challenge(mc(), &["c"]), &at), 1);
        assert_eq!(bearable_demand(&challenge(mc(), &["f"]), &at), 2);
        assert_eq!(
            bearable_demand(&challenge(mc(), &["owned", "brand-new"]), &index),
            0
        );
    }

    #[test]
    fn bearability_opens_production_as_a_word_grows() {
        let words = vocabulary();
        let index = by_id(&words);
        let on = |sample: Value, id: &str| bearable(&challenge(sample, &[id]), &index);
        assert!(on(mc(), "brand-new"));
        assert!(on(typed("toNative"), "brand-new"));
        assert!(!on(word_order(), "brand-new"));
        assert!(!on(cloze(Some(&["a", "b"])), "brand-new"));
        assert!(!on(typed("toTarget"), "brand-new"));

        assert!(on(word_order(), "learned"));
        assert!(on(cloze(Some(&["a", "b"])), "learned"));
        assert!(!on(cloze(None), "learned"));
        assert!(!on(typed("toTarget"), "learned"));

        for sample in [typed("toTarget"), cloze(None), word_order(), mc()] {
            assert!(on(sample, "owned"));
        }
        assert!(!on(typed("toTarget"), "gone"));
        assert!(on(mc(), "gone"));
    }

    #[test]
    fn a_banked_cloze_is_served_typed_at_the_top_rung() {
        let words = vocabulary();
        let index = by_id(&words);
        let banked = |id: &str| challenge(cloze(Some(&["a", "b"])), &[id]);
        assert_eq!(demand_of(&banked("learned")), 1);
        assert_eq!(served_demand(&banked("learned"), &index), 1);
        assert_eq!(demand_of(&banked("mastered")), 1);
        assert_eq!(served_demand(&banked("mastered"), &index), 2);
        assert_eq!(
            served_demand(&challenge(cloze(None), &["mastered"]), &index),
            2
        );
        for sample in [mc(), typed("toTarget"), typed("toNative"), word_order()] {
            let c = challenge(sample, &["mastered"]);
            assert_eq!(served_demand(&c, &index), demand_of(&c));
        }
    }

    #[test]
    fn the_ladder_climbs_a_rung_at_each_floor_and_calls_a_cardless_word_new() {
        let f = &ladders().floors;
        assert_eq!(level_for_strength(0.0), 1);
        assert_eq!(level_for_strength(SHAKY), 1);
        assert_eq!(word("x", None).level(), 1);
        for (floor, level) in [(f.level2, 2), (f.level3, 3), (f.level4, 4), (f.level5, 5)] {
            assert_eq!(level_for_strength(floor), level);
        }
        assert!((2..=3).contains(&level_for_strength(LEARNED)));
        assert!(level_for_strength(OWNED) >= 4);
    }

    #[test]
    fn the_bands_tile_the_axis_and_their_centres_rise_inside_them() {
        assert_eq!(level_band(1).0, 0.0);
        assert_eq!(level_band(5).1, 1.0);
        let mut previous = -1.0;
        for level in 1..=5 {
            if level > 1 {
                assert_eq!(level_band(level).0, level_band(level - 1).1);
            }
            assert_eq!(level_for_strength(level_band(level).0), level);
            let centre = level_band_centre(level);
            let (start, end) = level_band(level);
            assert!(start < centre && centre < end);
            assert_eq!(level_for_strength(centre), level);
            assert!(centre > previous);
            previous = centre;
        }
    }

    #[test]
    fn maturity_is_the_ladder_at_coarser_resolution() {
        assert_eq!(maturity_for_strength(0.0), Maturity::New);
        assert_eq!(maturity_for_strength(SHAKY), Maturity::New);
        assert_eq!(maturity_for_strength(LEARNED), Maturity::Young);
        assert_eq!(maturity_for_strength(OWNED), Maturity::Solid);
        assert_eq!(maturity_for_strength(OWNED / 2.0), Maturity::Young);
        for strength in [0.0, SHAKY, LEARNED, OWNED] {
            let expected = match level_for_strength(strength) {
                1 => Maturity::New,
                2 | 3 => Maturity::Young,
                _ => Maturity::Solid,
            };
            assert_eq!(maturity_for_strength(strength), expected);
        }
    }

    #[test]
    fn the_typed_rung_is_the_top_one() {
        assert_eq!(cloze_typed_level(), 5);
    }
}
