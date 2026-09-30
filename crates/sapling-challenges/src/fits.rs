//! The one check (`docs/challenge-difficulty.md` §5): serving and refill both
//! ask whether a stored row, shown at one of its help levels, puts its words'
//! predicted chance inside the window around the learner's aim.
//!
//! A row **fits** when at least one of its help levels lands inside the window;
//! its best fit is the help level closest to the aim, the easier one on a tie.
//!
//! The window's two edges read two different things. Too hard is the whole
//! chance under the bottom — forgetting the word counts. Too easy is the
//! chance *given the word is remembered* over the top: memory multiplies in,
//! and a due word's memory sits near FSRS's 0.9, so on the whole chance the
//! top edge would almost never be reached and a word would never outgrow its
//! first recognition rows.
//! Serving picks by it, refill counts coverage by it, so a row refill counts as
//! covering a word is exactly one serving would show, and one serving would
//! never show is never coverage.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::Challenge;
use crate::help::{can_listen, has_readings, steps_of, HelpLevel};
use crate::kinds::kind_of;
use crate::model::{chance, length_of, target, window, Aim, Shared, MULTI_WORD};
use crate::pool::PoolRow;
use crate::serve::RomanizationMode;
use crate::word::ById;

/// What a pick is made against besides the pool and the words: the learned
/// shared numbers, the learner's aim, and the two things that bound which help
/// levels exist at all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Serving {
    /// `getDifficultyParts`; empty is every part at its starting value.
    #[serde(default)]
    pub parts: Shared,
    #[serde(default)]
    pub aim: Aim,
    /// The learner's readings setting, an upper bound: `off` shows none, `on`
    /// always shows them, `adaptive` lets the pick decide.
    #[serde(default)]
    pub romanization_mode: RomanizationMode,
    /// Whether this device can speak and the learner wants listening.
    #[serde(default)]
    pub audio: bool,
}

/// Every help level a stored row can be shown at under these settings,
/// easiest first. A row with a reading shows it at every step and, where the
/// setting allows, hides it at the hardest step too; `off` hides it everywhere
/// and `on` never does. Listening, where the row can be heard and the device
/// can speak, is the hardest.
pub fn help_levels(challenge: &Challenge, serving: &Serving) -> Vec<HelpLevel> {
    let steps = steps_of(challenge);
    let readings = has_readings(challenge);
    let mut levels = Vec::with_capacity(steps.len() + 2);
    for (i, step) in steps.iter().enumerate() {
        if !readings {
            levels.push(HelpLevel::step(*step));
            continue;
        }
        match serving.romanization_mode {
            RomanizationMode::On => levels.push(HelpLevel::step(*step)),
            RomanizationMode::Off => levels.push(HelpLevel::hidden(*step)),
            RomanizationMode::Adaptive => {
                levels.push(HelpLevel::step(*step));
                if i + 1 == steps.len() {
                    levels.push(HelpLevel::hidden(*step));
                }
            }
        }
    }
    if serving.audio && can_listen(challenge) {
        levels.push(HelpLevel::LISTENING);
    }
    levels
}

/// The two halves of a prediction: the words' combined memory, and the
/// chance of managing the row given they are remembered.
fn halves(row: &PoolRow, help: HelpLevel, words: &ById, parts: &Shared) -> Option<(f64, f64)> {
    let kind = kind_of(&row.challenge)?;
    let ids = row.challenge.item_ids();
    let mut skills = Vec::with_capacity(ids.len());
    let mut memory = 1.0;
    for id in ids {
        let word = words.get(id.as_str())?;
        memory *= word.memory();
        skills.push(word.skill());
    }
    let difficulty = parts.difficulty(
        kind,
        help,
        length_of(&row.challenge),
        row.correction.unwrap_or(0.0),
    );
    Some((
        memory,
        chance(&[1.0], &skills, difficulty, MULTI_WORD).max(0.0),
    ))
}

/// The predicted chance of this row at this help level for its words, or
/// `None` for a match round or a row naming a word that is gone.
pub fn chance_of(row: &PoolRow, help: HelpLevel, words: &ById, parts: &Shared) -> Option<f64> {
    halves(row, help, words, parts).map(|(memory, manage)| memory * manage)
}

/// Whether a prediction's two halves sit inside an aim's window: the whole
/// chance no lower than its bottom, the remembered chance no higher than its top.
pub fn inside(memory: f64, manage: f64, aim: Aim) -> bool {
    let (low, high) = window(aim);
    memory * manage >= low && manage <= high
}

/// `fits`: the predicted chance, when it lands inside the window.
pub fn fits(row: &PoolRow, help: HelpLevel, words: &ById, serving: &Serving) -> Option<f64> {
    let (memory, manage) = halves(row, help, words, &serving.parts)?;
    inside(memory, manage, serving.aim).then_some(memory * manage)
}

/// A row's best fit: the help level inside the window closest to the aim.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub help: HelpLevel,
    pub chance: f64,
}

impl Fit {
    /// How far the pick sits from the aim: what serving ranks by.
    pub fn distance(&self, aim: Aim) -> f64 {
        (self.chance - target(aim)).abs()
    }
}

pub fn best_fit(row: &PoolRow, words: &ById, serving: &Serving) -> Option<Fit> {
    let mut best: Option<Fit> = None;
    for help in help_levels(&row.challenge, serving) {
        let Some(chance) = fits(row, help, words, serving) else {
            continue;
        };
        let fit = Fit { help, chance };
        if best.is_none_or(|b| fit.distance(serving.aim) < b.distance(serving.aim)) {
            best = Some(fit);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::model::starting_skill;
    use crate::word::tests::word;
    use crate::word::{by_id, Word};
    use serde_json::json;

    fn row(value: serde_json::Value) -> PoolRow {
        let mut value = value;
        value["generatedAt"] = json!(0);
        value["timesServed"] = json!(0);
        value["lastServedAt"] = json!(null);
        value["reported"] = json!(false);
        serde_json::from_value(value).unwrap()
    }

    fn cloze(reading: bool) -> PoolRow {
        let mut value = json!({ "id": "c", "type": "cloze", "direction": "toTarget",
            "sentence": "我们想___。", "acceptedAnswers": ["买单"],
            "wordBank": ["买单", "a", "b", "c", "d", "e"], "itemIds": ["w"] });
        if reading {
            value["sentenceRomanization"] = json!("Wǒmen xiǎng ___.");
        }
        row(value)
    }

    fn recognize() -> PoolRow {
        row(
            json!({ "id": "m", "type": "multiple-choice", "direction": "toNative", "prompt": "猫",
            "options": ["cat", "dog", "bird", "fish"], "correctIndex": 0, "itemIds": ["w"] }),
        )
    }

    fn skilled(skill: f64) -> Word {
        let mut w = word("w", Some(0.5));
        w.skill = Some(skill);
        w
    }

    #[test]
    fn the_readings_setting_bounds_the_help_levels() {
        let adaptive = Serving::default();
        let ids = |r: &PoolRow, s: &Serving| -> Vec<String> {
            help_levels(&r.challenge, s)
                .iter()
                .map(|h| h.id())
                .collect()
        };
        assert_eq!(
            ids(&cloze(true), &adaptive),
            ["pick-4", "pick-6", "typed", "typed-hidden"]
        );
        assert_eq!(ids(&cloze(false), &adaptive), ["pick-4", "pick-6", "typed"]);
        let off = Serving {
            romanization_mode: RomanizationMode::Off,
            ..Serving::default()
        };
        assert_eq!(
            ids(&cloze(true), &off),
            ["pick-4-hidden", "pick-6-hidden", "typed-hidden"]
        );
        let on = Serving {
            romanization_mode: RomanizationMode::On,
            ..Serving::default()
        };
        assert_eq!(ids(&cloze(true), &on), ["pick-4", "pick-6", "typed"]);
        assert_eq!(ids(&recognize(), &adaptive), ["plain"]);
        let heard = Serving {
            audio: true,
            ..Serving::default()
        };
        assert_eq!(ids(&recognize(), &heard), ["plain", "listening"]);
    }

    #[test]
    fn a_new_word_fits_the_easiest_question_and_not_a_typed_one() {
        let words = [word("w", None)];
        let index = by_id(&words);
        let serving = Serving::default();
        let easy = best_fit(&recognize(), &index, &serving).unwrap();
        assert_eq!(easy.help, HelpLevel::step(Step::Plain));
        assert!(fits(
            &cloze(false),
            HelpLevel::step(Step::Typed),
            &index,
            &serving
        )
        .is_none());
        assert_eq!(words[0].skill(), starting_skill());
    }

    #[test]
    fn a_stronger_word_is_served_the_harder_help_level() {
        let serving = Serving::default();
        let pick = |skill: f64| {
            let words = [skilled(skill)];
            best_fit(&cloze(false), &by_id(&words), &serving).map(|f| f.help.step)
        };
        assert_eq!(pick(3.0), Some(Step::Pick4));
        assert_eq!(pick(5.8), Some(Step::Typed));
        // Far too weak for any of it: the row does not fit, and is not served.
        assert_eq!(pick(-2.0), None);
    }

    #[test]
    fn a_learned_correction_moves_a_row_out_of_reach() {
        let words = [skilled(3.0)];
        let index = by_id(&words);
        let serving = Serving::default();
        let mut hard = cloze(false);
        assert!(best_fit(&hard, &index, &serving).is_some());
        hard.correction = Some(6.0);
        assert!(best_fit(&hard, &index, &serving).is_none());
    }

    #[test]
    fn a_harder_aim_picks_a_harder_help_level() {
        let words = [skilled(4.2)];
        let index = by_id(&words);
        let easier = Serving {
            aim: Aim::Easier,
            ..Serving::default()
        };
        let harder = Serving {
            aim: Aim::Harder,
            ..Serving::default()
        };
        let a = best_fit(&cloze(false), &index, &easier).unwrap();
        let b = best_fit(&cloze(false), &index, &harder).unwrap();
        assert!(a.chance > b.chance);
    }

    #[test]
    fn a_missing_word_or_a_match_round_has_no_chance() {
        let serving = Serving::default();
        assert!(chance_of(
            &cloze(false),
            HelpLevel::step(Step::Pick4),
            &by_id(&[]),
            &serving.parts
        )
        .is_none());
    }
}
