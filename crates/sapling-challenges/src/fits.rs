//! The one check (`docs/challenge-difficulty.md` §5): whether a row, at one
//! of its help levels, puts its words' chance *given they are remembered* —
//! `sigmoid(skill − difficulty)` — inside the window around the learner's aim.
//! Memory decides which word comes up (FSRS's order), never which row it gets.
//!
//! The window is widened, per skill, just far enough to take in the nearest
//! row a writer can produce ([`window_for`]): a word too weak for the easiest
//! kind at its shortest still fits that, one too strong for the hardest still
//! fits that, so every word always has something writable that serving takes.
//!
//! "A row a writer can produce" means the row *as it will be served*: each
//! kind at each step it is written with, its reading shown, hidden or both as
//! the readings setting allows when the target language is written with one
//! ([`Serving::readings`]), and heard first where it can be
//! ([`written_levels`]). The writer (`topup.rs`' `length_for`) asks the same
//! levels, so a row written as asked is a row serving takes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::Challenge;
use crate::help::{can_listen, has_readings, steps_of, HelpLevel, Step};
use crate::kinds::{active_kinds, kind_of, WireType};
use crate::model::{combined, length_of, sigmoid, target, window, Aim, Shared, MULTI_WORD};
use crate::pool::PoolRow;
use crate::serve::RomanizationMode;
use crate::word::ById;

/// What a pick is made against besides the pool and the words: the learned
/// shared numbers, the learner's aim, the two things that bound which help
/// levels exist at all, and whether a row written now carries readings.
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
    /// Whether a row written now carries readings: the target language is
    /// written in a script other than Latin, for which the lesson prompt has
    /// the model write a reading beside every target-language string. A
    /// stored row's levels are read off the row itself ([`help_levels`]);
    /// this is what a row not written yet is judged by ([`written_levels`]).
    /// Absent is `false`, a Latin-script language.
    #[serde(default)]
    pub readings: bool,
}

/// The help levels of a row with these steps, whether it carries readings and
/// whether it can be heard, under these settings, easiest first. A row with a
/// reading shows it at every step and, where the setting allows, hides it at
/// the hardest step too; `off` hides it everywhere and `on` never does.
/// Listening, where the row can be heard and the device can speak, is the
/// hardest.
fn levels(steps: &[Step], readings: bool, listen: bool, serving: &Serving) -> Vec<HelpLevel> {
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
    if serving.audio && listen {
        levels.push(HelpLevel::LISTENING);
    }
    levels
}

/// Every help level a stored row can be shown at under these settings,
/// easiest first: its own steps, its own readings, whether it can be heard.
pub fn help_levels(challenge: &Challenge, serving: &Serving) -> Vec<HelpLevel> {
    levels(
        &steps_of(challenge),
        has_readings(challenge),
        can_listen(challenge),
        serving,
    )
}

/// Every help level a row of `kind` written now will be shown at: the steps
/// it is written with (the resolver always writes the full bank, tray and
/// hint), a reading where the language has one, and listening where it can be
/// heard — exactly what [`help_levels`] reads off the row once it is stored.
pub fn written_levels(kind: WireType, serving: &Serving) -> Vec<HelpLevel> {
    levels(
        kind.written_steps(),
        serving.readings,
        kind.can_listen(),
        serving,
    )
}

/// Every difficulty a freshly written row can have: each active kind at each
/// level it will be served at, at every length in its range, before any
/// correction.
fn writable(serving: &Serving) -> impl Iterator<Item = f64> + '_ {
    let parts = &serving.parts;
    active_kinds().flat_map(move |kind| {
        let [shortest, longest] = kind.lengths().unwrap_or([1, 1]);
        let slope = parts.slope(kind);
        written_levels(kind, serving)
            .into_iter()
            .flat_map(move |help| {
                // `Shared::difficulty` at correction 0, its lookups hoisted.
                let base = parts.base(kind, help);
                (shortest..=longest).map(move |length| base + slope * f64::from(length))
            })
    })
}

/// The remembered chances a word of this skill may be served at: the aim's
/// window, widened just enough to take in the nearest writable row.
pub fn window_for(skill: f64, serving: &Serving) -> (f64, f64) {
    let (low, high) = window(serving.aim);
    let gap = |c: f64| (low - c).max(c - high);
    let mut nearest: Option<f64> = None;
    for difficulty in writable(serving) {
        let c = sigmoid(skill - difficulty);
        if gap(c) <= 0.0 {
            return (low, high);
        }
        if nearest.is_none_or(|n| gap(c) < gap(n)) {
            nearest = Some(c);
        }
    }
    match nearest {
        Some(c) if c < low => (c, high),
        Some(c) => (low, c),
        None => (low, high),
    }
}

pub fn inside(chance: f64, (low, high): (f64, f64)) -> bool {
    chance >= low - 1e-12 && chance <= high + 1e-12
}

/// The words' combined skill and the row's difficulty at this help level, or
/// `None` for a match round or a row naming a word that is gone.
fn judged(row: &PoolRow, help: HelpLevel, words: &ById, parts: &Shared) -> Option<(f64, f64)> {
    let kind = kind_of(&row.challenge)?;
    let mut skills = Vec::new();
    for id in row.challenge.item_ids() {
        skills.push(words.get(id.as_str())?.skill());
    }
    let difficulty = parts.difficulty(
        kind,
        help,
        length_of(&row.challenge),
        row.correction.unwrap_or(0.0),
    );
    Some((combined(&skills, MULTI_WORD)?, difficulty))
}

/// The predicted chance of a correct answer, memory included: what the model
/// is scored on, never what a row is picked by.
pub fn chance_of(row: &PoolRow, help: HelpLevel, words: &ById, parts: &Shared) -> Option<f64> {
    let (skill, difficulty) = judged(row, help, words, parts)?;
    let memory: f64 = row
        .challenge
        .item_ids()
        .iter()
        .filter_map(|id| words.get(id.as_str()))
        .map(|w| w.memory())
        .product();
    Some(memory * sigmoid(skill - difficulty))
}

/// `fits`: the remembered chance, when it lands inside the word's window.
pub fn fits(row: &PoolRow, help: HelpLevel, words: &ById, serving: &Serving) -> Option<f64> {
    let (skill, difficulty) = judged(row, help, words, &serving.parts)?;
    let chance = sigmoid(skill - difficulty);
    inside(chance, window_for(skill, serving)).then_some(chance)
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
    let mut window = None;
    for help in help_levels(&row.challenge, serving) {
        let (skill, difficulty) = judged(row, help, words, &serving.parts)?;
        let chance = sigmoid(skill - difficulty);
        if !inside(
            chance,
            *window.get_or_insert_with(|| window_for(skill, serving)),
        ) {
            continue;
        }
        let fit = Fit { help, chance };
        if best.is_none_or(|b| fit.distance(serving.aim) < b.distance(serving.aim)) {
            best = Some(fit);
        }
    }
    best
}

/// Whether a row just written fits its words now: [`best_fit`] of the row as
/// it lands in the pool — never served, no correction yet. A row's fit does
/// not depend on which of its words it is served for (they are judged by
/// their combined skill), so a row that fits here is available to every word
/// it names. The writer asks it before counting a row as a want filled
/// (`sapling-llm`'s `fill_request`): a row about several words is judged by
/// their average, which the length was solved for one of them alone.
pub fn fits_fresh(challenge: &Challenge, words: &ById, serving: &Serving) -> bool {
    let row = PoolRow {
        challenge: challenge.clone(),
        generated_at: 0.0,
        times_served: 0.0,
        last_served_at: None,
        reported: false,
        topic: None,
        correction: None,
    };
    best_fit(&row, words, serving).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::model::starting_skill;
    use crate::sim::synthetic;
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

    /// What the writer reasons over is what serving reads off the row once
    /// it is stored, for every kind and every setting.
    #[test]
    fn a_written_row_is_served_at_the_levels_it_was_written_for() {
        use crate::sim::with_readings;
        for readings in [false, true] {
            for mode in [
                RomanizationMode::Off,
                RomanizationMode::On,
                RomanizationMode::Adaptive,
            ] {
                for audio in [false, true] {
                    let serving = Serving {
                        readings,
                        romanization_mode: mode,
                        audio,
                        ..Serving::default()
                    };
                    for kind in active_kinds() {
                        let mut value = synthetic(kind, "c", &["w", "v"], 6);
                        if readings {
                            value = with_readings(value);
                        }
                        let stored = row(value);
                        assert_eq!(
                            help_levels(&stored.challenge, &serving),
                            written_levels(kind, &serving),
                            "{kind:?} {serving:?}"
                        );
                    }
                }
            }
        }
    }

    /// Readings off hides a reading at every step, so a language written with
    /// one is judged — and widened — at the hidden levels, while a language
    /// without is untouched by the setting.
    #[test]
    fn readings_off_moves_the_window_only_where_there_are_readings() {
        let with = |readings: bool, mode: RomanizationMode| Serving {
            readings,
            romanization_mode: mode,
            ..Serving::default()
        };
        for skill in [-6.0, 0.0, 1.6, 4.0, 9.0] {
            let latin = window_for(skill, &Serving::default());
            assert_eq!(
                window_for(skill, &with(false, RomanizationMode::Off)),
                latin
            );
            assert_eq!(window_for(skill, &with(false, RomanizationMode::On)), latin);
        }
        // Too weak for the easiest row shown, weaker still for it hidden: the
        // window reaches down to the hidden one.
        let shown = window_for(-6.0, &with(true, RomanizationMode::On));
        let hidden = window_for(-6.0, &with(true, RomanizationMode::Off));
        assert!(hidden.0 < shown.0);
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
        // Far too weak for any of it: the row does not fit, though an easier kind would.
        assert_eq!(pick(-2.0), None);
    }

    /// Memory picks the word, never the row: an overdue word is judged as it
    /// would be on time, and only its predicted chance knows it is fading.
    #[test]
    fn memory_decides_nothing_a_row_is_picked_by() {
        let at = |memory: f64| {
            let mut w = skilled(3.0);
            w.srs.as_mut().unwrap().retrievability = memory;
            w
        };
        let serving = Serving::default();
        let late = best_fit(&cloze(false), &by_id(&[at(0.2)]), &serving).unwrap();
        let due = best_fit(&cloze(false), &by_id(&[at(0.9)]), &serving).unwrap();
        assert_eq!(late, due);
        let real = chance_of(&cloze(false), late.help, &by_id(&[at(0.2)]), &serving.parts);
        assert!((real.unwrap() - 0.2 * late.chance).abs() < 1e-12);
    }

    /// The window widens to the nearest writable row, so a word beyond every
    /// option at either end still fits the option nearest it.
    #[test]
    fn a_word_beyond_every_option_still_fits_the_nearest_one() {
        let serving = Serving::default();
        let rows: Vec<PoolRow> = active_kinds()
            .flat_map(|kind| {
                let [shortest, longest] = kind.lengths().unwrap();
                (shortest..=longest).map(move |length| {
                    let id = format!("{}-{length}", kind.as_str());
                    row(synthetic(kind, &id, &["w"], usize::from(length)))
                })
            })
            .collect();
        for skill in [-12.0, -6.0, 0.0, 3.0, 8.0, 12.0] {
            let words = [skilled(skill)];
            let index = by_id(&words);
            let fitting = rows
                .iter()
                .filter(|r| best_fit(r, &index, &serving).is_some());
            assert!(fitting.count() > 0, "skill {skill}");
        }
        let (low, high) = window(serving.aim);
        assert!(window_for(-12.0, &serving).0 < low);
        assert!(window_for(12.0, &serving).1 > high);
        assert_eq!(window_for(starting_skill(), &serving), (low, high));
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

    /// A passage is judged by its words' average: a strong word paired with a
    /// weak one can land where it fits neither.
    #[test]
    fn a_fresh_row_about_two_words_fits_by_their_average() {
        let serving = Serving::default();
        let passage = |length: f64| {
            let mut c = row(synthetic(WireType::MultiCloze, "p", &["a", "b"], 10)).challenge;
            c.set_asked_length(length);
            c
        };
        let pair = |a: f64, b: f64| {
            let mut x = skilled(a);
            x.id = "a".into();
            let mut y = skilled(b);
            y.id = "b".into();
            [x, y]
        };
        let even = pair(4.5, 4.5);
        assert!(fits_fresh(&passage(10.0), &by_id(&even), &serving));
        let apart = pair(4.5, -6.0);
        assert!(!fits_fresh(&passage(10.0), &by_id(&apart), &serving));
        // A word that is gone cannot be judged at all.
        assert!(!fits_fresh(&passage(10.0), &by_id(&even[..1]), &serving));
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
