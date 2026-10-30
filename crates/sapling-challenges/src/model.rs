//! What the difficulty model reads off an answer and a challenge, shared by
//! the ratings (`ratings.rs`), replay and the calibration command: the
//! numbers in `data/model.json`, a challenge's length, the key a challenge
//! type's rating is stored under, and one answer as the model sees it.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::help::HelpLevel;
use crate::kinds::WireType;
use crate::text::{is_word_char, uses_inter_word_spaces};
use crate::Challenge;

pub use sapling_domain::types::Aim;

/// The chance of a right answer each aim serves towards.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Targets {
    pub easier: f64,
    pub normal: f64,
    pub harder: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub targets: Targets,
    /// What a rating's margin² widens by per day without an answer.
    pub widen: f64,
    /// Where every word sits above a new challenge type before any answer,
    /// and how sure that is.
    pub word_start: f64,
    pub word_margin: f64,
    /// How unsure a challenge type at a help level is before any answer.
    pub challenge_margin: f64,
    /// The stability scale's start and margin.
    pub scale_start: [f64; 2],
    /// Each kind's length slope's start and margin.
    pub slope_start: [f64; 2],
    /// The memory of a word that has never been reviewed: FSRS has no curve
    /// for it, but the learner met it where they added it.
    pub new_word_memory: f64,
}

pub fn tuning() -> &'static Tuning {
    static TUNING: OnceLock<Tuning> = OnceLock::new();
    TUNING.get_or_init(|| {
        serde_json::from_str(include_str!("../data/model.json")).expect("data/model.json")
    })
}

/// The chance of a right answer an aim serves towards.
pub fn target(aim: Aim) -> f64 {
    let t = &tuning().targets;
    match aim {
        Aim::Easier => t.easier,
        Aim::Normal => t.normal,
        Aim::Harder => t.harder,
    }
}

pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

pub fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-6, 1.0 - 1e-6);
    (p / (1.0 - p)).ln()
}

/* ---- Length -------------------------------------------------------------- */

/// A text's length in words, the same on every host: a spaced word counts
/// one, a character of a script without spaces counts half (a Chinese or
/// Japanese word runs about two). Not the host's segmenter, because the
/// numbers learned from a length are derived data that every device — and
/// the Worker, which has no segmenter — must reproduce exactly.
pub fn words_in(text: &str) -> f64 {
    let mut words = 0.0;
    let mut in_word = false;
    for c in text.chars() {
        if !is_word_char(c) {
            in_word = false;
            continue;
        }
        if !uses_inter_word_spaces(&c.to_string()) {
            words += 0.5;
            in_word = false;
            continue;
        }
        if !in_word {
            words += 1.0;
            in_word = true;
        }
    }
    words
}

/// How long a challenge reads, on the one scale every kind's length slope is per:
/// the length it was asked to be written at, or for a row from before that
/// was recorded, its measured shape.
pub fn length_of(challenge: &Challenge) -> f64 {
    if let Some(length) = challenge.asked_length().filter(|l| l.is_finite()) {
        return length;
    }
    challenge.measure()
}

/// The key a challenge type's rating is stored under: `cloze/pick-6`.
pub fn part_key(kind: WireType, help: HelpLevel) -> String {
    format!("{}/{}", kind.as_str(), help.id())
}

/// One word's part in one answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    pub item_id: String,
    /// FSRS retrievability just before the answer.
    pub memory: f64,
    /// FSRS stability in days just before the answer; 0 for a word never
    /// reviewed. What a word's side of the ratings is read from.
    pub stability: f64,
}

/// One answer, ready for the model: everything replay could work out, and
/// nothing that depends on the model itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub at: f64,
    pub challenge_id: String,
    pub kind: WireType,
    pub help: HelpLevel,
    pub length: f64,
    pub words: Vec<Evidence>,
    /// 1 correct, 0.5 almost, 0 wrong.
    pub outcome: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_aims_are_the_profile_settings() {
        assert_eq!(Aim::default(), Aim::Normal);
        assert!(target(Aim::Easier) > target(Aim::Normal));
        assert!(target(Aim::Normal) > target(Aim::Harder));
    }

    #[test]
    fn length_counts_spaced_words_and_half_a_character_without_spaces() {
        assert_eq!(words_in("Yo leo un libro."), 4.0);
        assert_eq!(words_in("我们想买单"), 2.5);
        assert_eq!(words_in("买单 please"), 2.0);
        assert_eq!(words_in(""), 0.0);
        let cloze = Challenge::from_value(
            serde_json::json!({ "id": "c", "type": "cloze", "direction": "toTarget",
            "sentence": "Yo ___ un libro.", "acceptedAnswers": ["leo"], "itemIds": ["i"] }),
        )
        .unwrap();
        assert_eq!(length_of(&cloze), 4.0);
        // A row stamped with the length it was asked for is judged at that, `null` read as absent.
        let mut asked = cloze.clone();
        asked.set_asked_length(7.0);
        assert_eq!(length_of(&asked), 7.0);
        let stored = serde_json::to_value(&asked).unwrap();
        assert_eq!(stored["length"], serde_json::json!(7.0));
        assert_eq!(length_of(&Challenge::from_value(stored).unwrap()), 7.0);
        let mut unset = serde_json::to_value(&cloze).unwrap();
        unset["length"] = serde_json::Value::Null;
        assert_eq!(length_of(&Challenge::from_value(unset).unwrap()), 4.0);
        let multi = Challenge::from_value(serde_json::json!({ "id": "m", "type": "multi-cloze", "direction": "toTarget",
            "passage": "___1___ leo. ___2___ bebe.", "gaps": [
                { "itemId": "a", "acceptedAnswers": ["Yo"] }, { "itemId": "b", "acceptedAnswers": ["Ella"] }],
            "wordBank": ["Yo", "Ella"], "itemIds": ["a", "b"] }))
        .unwrap();
        assert_eq!(length_of(&multi), 4.0);
    }
}
