//! The numbers, as data: the rung floors and the serve-time ladders
//! (`data/ladders.json`) and the difficulty scales (`data/difficulty.json`).

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Floors {
    /// Constrained production becomes bearable: roughly one successful review.
    pub level2: f64,
    /// Bisects the constrained-production span; no demand boundary of its own.
    pub level3: f64,
    /// Free production becomes bearable: two to three successful reviews.
    pub level4: f64,
    /// Well inside free production: a word free-producible for a while.
    pub level5: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HideReading {
    pub floor: f64,
    pub ceiling: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ladders {
    pub floors: Floors,
    /// The last rung at which the native line still shows.
    pub hint_ceiling_level: u8,
    /// A cloze bank's size by rung, answer included; the one zero is typed recall.
    pub cloze_bank: [usize; 5],
    /// Multi-cloze distractors by rung, beyond the row's own gaps.
    pub multi_cloze_distractors: [usize; 5],
    /// Word-order distractor tiles by rung; the sentence's own always show.
    pub word_order_distractors: [usize; 5],
    /// Pairs in a match round by rung.
    pub match_pairs: [usize; 5],
    /// Pairs in a round built without a rung: this range, drawn.
    pub unsized_match_pairs: [usize; 2],
    pub hide_reading: HideReading,
    /// Share of eligible challenges presented audio-first.
    pub listening_share: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeScale {
    pub max_gaps: usize,
    pub passage_words: [f64; 2],
    pub placement_weight: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DifficultyScales {
    /// The one prose-length scale every type's length knob is read on.
    pub prompt_words: [f64; 2],
    /// Where each format stands among its tier-mates before any field is read.
    pub bases: HashMap<String, f64>,
    pub multi_cloze: MultiClozeScale,
    /// A match round's pair-count scale.
    pub match_pairs: [f64; 2],
}

pub fn ladders() -> &'static Ladders {
    static LADDERS: OnceLock<Ladders> = OnceLock::new();
    LADDERS.get_or_init(|| {
        serde_json::from_str(include_str!("../data/ladders.json")).expect("data/ladders.json")
    })
}

pub fn scales() -> &'static DifficultyScales {
    static SCALES: OnceLock<DifficultyScales> = OnceLock::new();
    SCALES.get_or_init(|| {
        serde_json::from_str(include_str!("../data/difficulty.json")).expect("data/difficulty.json")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::challenge::ChallengeType;

    #[test]
    fn the_floors_rise_and_the_ladders_never_fall_but_the_bank_goes_to_zero_once() {
        let l = ladders();
        let f = &l.floors;
        assert!(
            0.0 < f.level2 && f.level2 < f.level3 && f.level3 < f.level4 && f.level4 < f.level5
        );
        assert!(f.level5 < 1.0);
        for ladder in [
            &l.multi_cloze_distractors,
            &l.word_order_distractors,
            &l.match_pairs,
        ] {
            assert!(ladder.windows(2).all(|w| w[0] <= w[1]), "{ladder:?}");
        }
        assert_eq!(l.cloze_bank.iter().filter(|&&size| size == 0).count(), 1);
        assert!(l.hide_reading.floor < l.hide_reading.ceiling);
    }

    #[test]
    fn a_match_round_stays_inside_its_own_difficulty_scale() {
        let [fewest, most] = scales().match_pairs;
        for pairs in ladders()
            .match_pairs
            .iter()
            .chain(&ladders().unsized_match_pairs)
        {
            assert!((fewest..=most).contains(&(*pairs as f64)));
        }
    }

    #[test]
    fn every_base_names_a_stored_type() {
        for name in scales().bases.keys() {
            assert!(ChallengeType::parse(name).is_some(), "{name}");
        }
    }
}
