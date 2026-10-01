//! What an answer logged before `shown` existed was shown at, reconstructed
//! once, during replay, from its weakest word's strength at the time — through
//! the serve ladders as they stood when those answers were given.
//!
//! These numbers are **frozen**: they describe screens already shown, so they
//! never change with serving again, and they stay here after serving stopped
//! reading ladders at all. Listening was a per-device preference nobody
//! recorded, so an old answer is taken as read, not heard; and the reading roll
//! was random, so an old answer's reading counts as hidden where the roll was
//! more likely to hide it than not.

use crate::challenge::Challenge;
use crate::help::{help_level_of, HelpLevel};

/// The rung floors the ladders were read at.
const FLOORS: [f64; 4] = [0.15, 0.3, 0.45, 0.7];
/// A cloze's bank by rung, answer included.
const CLOZE_BANK: [usize; 5] = [3, 4, 5, 6, 0];
/// A multi-cloze's distractors by rung, beyond its gaps.
const MULTI_CLOZE_DISTRACTORS: [usize; 5] = [0, 0, 0, 1, 2];
/// A word-order's distractor tiles by rung.
const WORD_ORDER_DISTRACTORS: [usize; 5] = [0, 0, 1, 2, 3];
/// The strength from which the reading roll hid more often than it showed:
/// halfway up the 0.35–0.85 ramp.
const READING_HIDDEN_FROM: f64 = 0.6;

fn rung(strength: f64) -> usize {
    FLOORS.iter().filter(|floor| strength >= **floor).count()
}

/// The help level an unrecorded answer was most likely shown at.
pub fn legacy_help_level(challenge: &Challenge, weakest_strength: f64) -> HelpLevel {
    let at = rung(weakest_strength);
    let (bank, tiles) = match challenge {
        Challenge::Cloze(c) => (
            c.word_bank.as_ref().map_or(0, Vec::len).min(CLOZE_BANK[at]),
            0,
        ),
        Challenge::MultiCloze(c) => (
            c.word_bank
                .len()
                .min(c.gaps.len() + MULTI_CLOZE_DISTRACTORS[at]),
            0,
        ),
        Challenge::WordOrder(c) => (
            0,
            c.tiles
                .len()
                .saturating_sub(c.answer_tokens.len())
                .min(WORD_ORDER_DISTRACTORS[at]),
        ),
        _ => (0, 0),
    };
    help_level_of(
        challenge,
        bank,
        tiles,
        weakest_strength < READING_HIDDEN_FROM,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cloze(reading: bool) -> Challenge {
        let mut row = json!({ "id": "c", "type": "cloze", "direction": "toTarget", "sentence": "我们想___。",
            "acceptedAnswers": ["买单"], "wordBank": ["买单", "a", "b", "c", "d", "e"], "itemIds": ["i"] });
        if reading {
            row["sentenceRomanization"] = json!("Wǒmen xiǎng ___.");
        }
        Challenge::from_value(row).unwrap()
    }

    #[test]
    fn an_old_cloze_climbs_the_frozen_bank_ladder() {
        assert_eq!(legacy_help_level(&cloze(false), 0.0).id(), "pick-4");
        assert_eq!(legacy_help_level(&cloze(false), 0.2).id(), "pick-4");
        assert_eq!(legacy_help_level(&cloze(false), 0.35).id(), "pick-6");
        assert_eq!(legacy_help_level(&cloze(false), 0.5).id(), "pick-6");
        assert_eq!(legacy_help_level(&cloze(false), 0.8).id(), "typed");
    }

    #[test]
    fn an_old_reading_counts_as_hidden_once_the_roll_favoured_hiding() {
        assert_eq!(legacy_help_level(&cloze(true), 0.2).id(), "pick-4");
        assert_eq!(legacy_help_level(&cloze(true), 0.65).id(), "pick-6-hidden");
        assert_eq!(legacy_help_level(&cloze(true), 0.9).id(), "typed-hidden");
    }
}
