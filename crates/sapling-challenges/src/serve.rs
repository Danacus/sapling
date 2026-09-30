//! Everything about a *served* challenge decided from its weakest word's rung
//! rather than written by the model: the native hint line, how much of a
//! stored bank or tray shows, whether its readings show, and whether it is
//! played before it is read.
//!
//! A row is generated once and played for weeks while its word's rung moves,
//! so support is sized here, at serve time, and every ladder's first rung is
//! its most supportive. The `visible_*` functions pick *which* stored entries
//! show: the answers in their own positions, then the first distractors in
//! stored order — never reshuffled, and returned as positions so an
//! index-aligned reading array slices the same way.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::{Challenge, Direction, WordOrderChallenge};
use crate::help::help_level_of;
use crate::ladder::{level_for_strength, weakest_level, weakest_of, weakest_strength, ById, Word};
use crate::text::js_trim;
use crate::tuning::ladders;

/// The learner's romanization preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RomanizationMode {
    On,
    Off,
    Adaptive,
}

/// Which readings a served challenge shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPlan {
    /// The whole-challenge decision, from its weakest word: what a flat stored
    /// reading and any token no tracked word covers follow.
    pub sentence: bool,
    /// One decision per known word, keyed by its term — every word the learner
    /// has, not only the ones the challenge cites, since a passage carries
    /// words it does not exercise. Empty under `on`/`off`.
    pub by_term: BTreeMap<String, bool>,
}

/// Everything decided at serve time, rolled once per served challenge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    /// Whether the native-language line shows (a cloze's translation, a
    /// word-order's prompt, a spot-error's meaning).
    pub show_hint: bool,
    /// How many bank entries a cloze or multi-cloze shows, answers included; 0
    /// for a type with no bank.
    pub bank_size: usize,
    /// How many distractor tiles a word-order shows beyond its own; 0 otherwise.
    pub distractor_tiles: usize,
    pub readings: ReadingPlan,
    /// Whether the prompt is played before it is read: a recognize-style
    /// multiple choice, when the host said audio is available.
    pub listening: bool,
    /// The help level this screen is (`help.rs`): what the answer records as `shown`.
    pub shown: String,
}

/// True through [`hint_ceiling_level`](crate::tuning::Ladders::hint_ceiling_level): a step, not a roll.
pub fn show_hint(challenge: &Challenge, words: &ById) -> bool {
    weakest_level(challenge, words) <= ladders().hint_ceiling_level
}

/// A cloze's bank by an absolute ladder (it has one answer); a multi-cloze's
/// relative to its own gap count; never more than is stored.
pub fn bank_size(challenge: &Challenge, words: &ById) -> usize {
    let rung = usize::from(weakest_level(challenge, words)) - 1;
    match challenge {
        Challenge::Cloze(c) => {
            let stored = c.word_bank.as_ref().map_or(0, Vec::len);
            stored.min(ladders().cloze_bank[rung])
        }
        Challenge::MultiCloze(c) => c
            .word_bank
            .len()
            .min(c.gaps.len() + ladders().multi_cloze_distractors[rung]),
        _ => 0,
    }
}

pub fn distractor_tiles(challenge: &WordOrderChallenge, words: &ById) -> usize {
    let rung = level_for_strength(weakest_of(&challenge.item_ids, words)) - 1;
    let stored = challenge
        .tiles
        .len()
        .saturating_sub(challenge.answer_tokens.len());
    stored.min(ladders().word_order_distractors[usize::from(rung)])
}

/// Every answer position, then the first others in stored order up to `size`
/// — never fewer than the answers, never more than the bank.
fn select_positions(bank: usize, answers: &[usize], size: usize) -> Vec<usize> {
    let capped = size.max(answers.len()).min(bank);
    let mut selected: Vec<usize> = answers.to_vec();
    let mut i = 0;
    while selected.len() < capped && i < bank {
        if !selected.contains(&i) {
            selected.push(i);
        }
        i += 1;
    }
    selected.sort_unstable();
    selected
}

/// The bank positions a served cloze or multi-cloze shows at `size`; empty for
/// a row with no bank, and for any other type.
pub fn visible_bank(challenge: &Challenge, size: usize) -> Vec<usize> {
    let (bank, answers): (&[String], Vec<Option<&String>>) = match challenge {
        Challenge::Cloze(c) => (
            c.word_bank.as_deref().unwrap_or_default(),
            vec![c.accepted_answers.first()],
        ),
        Challenge::MultiCloze(c) => (
            &c.word_bank,
            c.gaps.iter().map(|g| g.accepted_answers.first()).collect(),
        ),
        _ => return Vec::new(),
    };
    if bank.is_empty() {
        return Vec::new();
    }
    let mut positions: Vec<usize> = Vec::new();
    for answer in answers.into_iter().flatten() {
        if let Some(at) = (0..bank.len()).find(|&i| &bank[i] == answer && !positions.contains(&i)) {
            positions.push(at);
        }
    }
    select_positions(bank.len(), &positions, size)
}

/// The tray positions a served word-order shows: every sentence tile (matched
/// by text, with multiplicity) and the first `count` distractors.
pub fn visible_tiles(challenge: &WordOrderChallenge, count: usize) -> Vec<usize> {
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for token in &challenge.answer_tokens {
        *remaining.entry(token.as_str()).or_default() += 1;
    }
    let mut answers = Vec::new();
    for (index, tile) in challenge.tiles.iter().enumerate() {
        if let Some(left) = remaining.get_mut(tile.as_str()).filter(|left| **left > 0) {
            *left -= 1;
            answers.push(index);
        }
    }
    let size = answers.len() + count;
    select_positions(challenge.tiles.len(), &answers, size)
}

/// Probability that a word of this strength has its reading hidden: nothing
/// below the floor, everything from the ceiling, linear between, so the crutch
/// fades over many encounters rather than vanishing on the day a line is crossed.
pub fn hide_reading_probability(strength: f64) -> f64 {
    let ramp = &ladders().hide_reading;
    ((strength - ramp.floor) / (ramp.ceiling - ramp.floor)).clamp(0.0, 1.0)
}

fn roll_show(strength: f64, draw: &mut dyn FnMut() -> f64) -> bool {
    draw() >= hide_reading_probability(strength)
}

/// Rolled once, when the challenge is served: the whole-challenge roll first,
/// then one per known word in id order, each from that word's own strength.
pub fn plan_readings(
    mode: RomanizationMode,
    challenge: &Challenge,
    words: &[Word],
    index: &ById,
    draw: &mut dyn FnMut() -> f64,
) -> ReadingPlan {
    let sentence = match mode {
        RomanizationMode::On => true,
        RomanizationMode::Off => false,
        RomanizationMode::Adaptive => roll_show(weakest_strength(challenge, index), draw),
    };
    let mut by_term = BTreeMap::new();
    if mode == RomanizationMode::Adaptive {
        let mut sorted: Vec<&Word> = words.iter().collect();
        sorted.sort_by(|a, b| a.id.cmp(&b.id));
        for word in sorted {
            if !word.term.is_empty() {
                by_term.insert(word.term.clone(), roll_show(word.strength(), draw));
            }
        }
    }
    ReadingPlan { sentence, by_term }
}

/// `audio` is the host's answer to "can this device speak, and does the
/// learner want listening at all?"; without it nothing is played first.
pub fn presentation_for(
    challenge: &Challenge,
    words: &[Word],
    index: &ById,
    mode: RomanizationMode,
    audio: bool,
    draw: &mut dyn FnMut() -> f64,
) -> Presentation {
    let bank_size = bank_size(challenge, index);
    let distractor_tiles = match challenge {
        Challenge::WordOrder(c) => distractor_tiles(c, index),
        _ => 0,
    };
    let readings = plan_readings(mode, challenge, words, index, draw);
    let listening = is_listening(challenge, audio);
    let shown = help_level_of(
        challenge,
        bank_size,
        distractor_tiles,
        readings.sentence,
        listening,
    )
    .id();
    Presentation {
        show_hint: show_hint(challenge, index),
        bank_size,
        distractor_tiles,
        readings,
        listening,
        shown,
    }
}

/// FNV-1a over the id's UTF-16 units, into `[0, 1)`: stable across devices.
fn id_fraction(id: &str) -> f64 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in id.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    f64::from(hash) / 4_294_967_296.0
}

/// Whether a challenge is played before it is read: only a recognize-style
/// multiple choice has a target prompt to listen to, and a hash of the id —
/// not a coin — picks the share, so a row comes back presented the same way.
pub fn is_listening(challenge: &Challenge, enabled: bool) -> bool {
    let Challenge::MultipleChoice(c) = challenge else {
        return false;
    };
    enabled
        && c.direction == Direction::ToNative
        && !js_trim(&c.prompt).is_empty()
        && id_fraction(&c.id) < ladders().listening_share
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ladder::tests::word;
    use crate::ladder::{by_id, level_band, level_band_centre};
    use serde_json::json;

    fn at(level: u8) -> f64 {
        level_band_centre(level)
    }

    fn cloze(item_ids: &[&str], bank: &[&str]) -> Challenge {
        let mut row = json!({ "id": "c1", "type": "cloze", "direction": "toTarget", "sentence": "Yo ___ un libro.",
            "acceptedAnswers": [bank.first().copied().unwrap_or("leo")], "wordBank": bank, "itemIds": item_ids });
        if bank.is_empty() {
            row.as_object_mut().unwrap().remove("wordBank");
        }
        Challenge::from_value(row).unwrap()
    }

    fn multi(item_ids: &[&str], answers: &[&str], bank: &[&str]) -> Challenge {
        let gaps: Vec<_> = item_ids
            .iter()
            .enumerate()
            .map(|(i, id)| json!({ "itemId": id, "acceptedAnswers": [answers.get(i).or(answers.first()).copied().unwrap_or("")] }))
            .collect();
        Challenge::from_value(json!({ "id": "m1", "type": "multi-cloze", "direction": "toTarget",
            "passage": "___1___ leo un libro.", "gaps": gaps, "wordBank": bank, "itemIds": item_ids }))
        .unwrap()
    }

    fn word_order(item_ids: &[&str], answer: &[&str], tiles: &[&str]) -> WordOrderChallenge {
        serde_json::from_value(json!({ "id": "w1", "type": "word-order", "direction": "toTarget",
            "tiles": tiles, "answerTokens": answer, "answer": answer.join(" "), "itemIds": item_ids }))
        .unwrap()
    }

    fn rung(level: u8, ids: &[&str]) -> Vec<Word> {
        ids.iter().map(|id| word(id, Some(at(level)))).collect()
    }

    const BIG_BANK: [&str; 6] = ["leo", "como", "bebo", "corro", "salto", "duermo"];

    #[test]
    fn a_cloze_bank_follows_its_ladder_and_goes_to_zero_at_the_top() {
        for level in 1..=5 {
            let words = rung(level, &["w"]);
            assert_eq!(
                bank_size(&cloze(&["w"], &BIG_BANK), &by_id(&words)),
                ladders().cloze_bank[usize::from(level) - 1],
                "rung {level}"
            );
        }
        assert_eq!(
            bank_size(&cloze(&["w"], &BIG_BANK), &by_id(&rung(5, &["w"]))),
            0
        );
        assert_eq!(
            bank_size(&cloze(&["w"], &["leo", "como"]), &by_id(&rung(4, &["w"]))),
            2
        );
    }

    #[test]
    fn a_multi_cloze_bank_is_its_gaps_plus_the_rungs_distractors_capped_at_what_is_stored() {
        let answers = ["leo", "como", "bebo"];
        let bank = ["leo", "como", "bebo", "d1", "d2", "d3", "d4", "d5"];
        for level in 1..=5 {
            let words = rung(level, &["a", "b", "c"]);
            assert_eq!(
                bank_size(&multi(&["a", "b", "c"], &answers, &bank), &by_id(&words)),
                3 + ladders().multi_cloze_distractors[usize::from(level) - 1]
            );
        }
        let two = multi(
            &["a", "b"],
            &["leo", "como"],
            &["leo", "como", "d1", "d2", "d3"],
        );
        for (level, expected) in [(3, 2), (4, 3), (5, 4)] {
            assert_eq!(bank_size(&two, &by_id(&rung(level, &["a", "b"]))), expected);
        }
        let short = multi(&["a", "b"], &["leo", "como"], &["leo", "como", "d1"]);
        assert_eq!(bank_size(&short, &by_id(&rung(5, &["a", "b"]))), 3);
        let exact = multi(
            &["a", "b", "c", "d"],
            &["leo", "como", "bebo", "corro"],
            &["leo", "como", "bebo", "corro"],
        );
        assert_eq!(
            bank_size(&exact, &by_id(&rung(1, &["a", "b", "c", "d"]))),
            4
        );
        let four = multi(
            &["a", "b", "c", "d"],
            &["leo", "como", "bebo", "corro"],
            &["leo", "como", "bebo", "corro", "d1", "d2", "d3", "d4", "d5"],
        );
        let two = multi(
            &["a", "b"],
            &["leo", "como"],
            &["leo", "como", "d1", "d2", "d3", "d4", "d5"],
        );
        assert_ne!(
            bank_size(&two, &by_id(&rung(4, &["a", "b"]))),
            bank_size(&four, &by_id(&rung(4, &["a", "b", "c", "d"])))
        );
    }

    #[test]
    fn an_unknown_or_missing_word_gets_the_most_support() {
        assert_eq!(
            bank_size(&cloze(&["gone"], &["leo", "como", "bebo"]), &by_id(&[])),
            ladders().cloze_bank[0]
        );
        assert_eq!(
            bank_size(
                &cloze(&[], &["leo", "como", "bebo"]),
                &by_id(&rung(5, &["w"]))
            ),
            ladders().cloze_bank[0]
        );
        let words = [word("owned", Some(at(5))), word("new", Some(at(1)))];
        let bank: Vec<String> = "abcdefghi".chars().map(String::from).collect();
        let bank: Vec<&str> = bank.iter().map(String::as_str).collect();
        assert_eq!(
            bank_size(
                &multi(&["owned", "new"], &["leo", "como"], &bank),
                &by_id(&words)
            ),
            2 + ladders().multi_cloze_distractors[0]
        );
    }

    #[test]
    fn a_tray_shows_its_rungs_distractors_capped_at_what_is_stored() {
        let answer = ["Yo", "leo", "un", "libro."];
        let tray = ["Yo", "leo", "un", "libro.", "d1", "d2", "d3"];
        for level in 1..=5 {
            assert_eq!(
                distractor_tiles(
                    &word_order(&["w"], &answer, &tray),
                    &by_id(&rung(level, &["w"]))
                ),
                ladders().word_order_distractors[usize::from(level) - 1]
            );
        }
        let one = word_order(&["w"], &answer, &["Yo", "leo", "un", "libro.", "d1"]);
        assert_eq!(distractor_tiles(&one, &by_id(&rung(5, &["w"]))), 1);
        assert_eq!(
            distractor_tiles(&word_order(&["gone"], &answer, &tray), &by_id(&[])),
            ladders().word_order_distractors[0]
        );
    }

    #[test]
    fn a_visible_bank_keeps_its_answers_and_takes_distractors_in_stored_order() {
        let bank = ["d1", "leo", "d2", "d3", "d4", "d5"];
        assert_eq!(visible_bank(&cloze(&["w"], &bank), 3), [0, 1, 2]);
        assert_eq!(visible_bank(&cloze(&["w"], &bank), 4), [0, 1, 2, 3]);
        assert_eq!(visible_bank(&cloze(&["w"], &["leo", "d1"]), 6), [0, 1]);
        let two = multi(&["a", "b"], &["x", "y"], &["d1", "x", "d2", "y", "d3"]);
        assert_eq!(visible_bank(&two, 1), [1, 3]);
        assert!(visible_bank(&cloze(&["w"], &[]), 3).is_empty());
    }

    #[test]
    fn visible_tiles_keep_every_sentence_tile_with_multiplicity() {
        let tray = word_order(
            &["w"],
            &["yo", "yo", "leo"],
            &["yo", "d1", "yo", "leo", "d2"],
        );
        assert_eq!(visible_tiles(&tray, 0), [0, 2, 3]);
        assert_eq!(visible_tiles(&tray, 1), [0, 1, 2, 3]);
        let short = word_order(&["w"], &["Yo", "leo"], &["Yo", "leo", "d1"]);
        assert_eq!(visible_tiles(&short, 5), [0, 1, 2]);
    }

    #[test]
    fn the_hint_shows_on_the_early_rungs_and_steps_off_at_the_ceiling() {
        let hinted = |ids: &[&str]| {
            Challenge::from_value(json!({ "id": "c1", "type": "cloze", "direction": "toTarget", "sentence": "我们想___。",
                "acceptedAnswers": ["买单"], "translationHint": "We would like to pay the bill.", "itemIds": ids }))
            .unwrap()
        };
        for level in 1..=2 {
            assert!(show_hint(&hinted(&["w"]), &by_id(&rung(level, &["w"]))));
        }
        for level in 3..=5 {
            assert!(!show_hint(&hinted(&["w"]), &by_id(&rung(level, &["w"]))));
        }
        let ceiling = ladders().hint_ceiling_level;
        let (_, end) = level_band(ceiling);
        assert_eq!(level_for_strength(end), ceiling + 1);
        assert!(show_hint(
            &hinted(&["w"]),
            &by_id(&[word("w", Some(end - 1e-9))])
        ));
        assert!(!show_hint(&hinted(&["w"]), &by_id(&[word("w", Some(end))])));
        let words = [word("owned", Some(at(5))), word("new", Some(at(1)))];
        assert!(show_hint(&hinted(&["owned", "new"]), &by_id(&words)));
        assert!(!show_hint(&hinted(&["owned"]), &by_id(&words)));
        assert!(show_hint(&hinted(&["owned", "gone"]), &by_id(&words)));
        assert!(show_hint(&hinted(&[]), &by_id(&words)));
    }

    #[test]
    fn a_presentation_folds_the_hint_the_bank_the_tray_and_the_readings() {
        let mut never = || -> f64 { unreachable!("no roll under on") };
        let words = rung(1, &["w"]);
        let index = by_id(&words);
        let all = ReadingPlan {
            sentence: true,
            by_term: BTreeMap::new(),
        };
        assert_eq!(
            presentation_for(
                &cloze(&["w"], &BIG_BANK),
                &words,
                &index,
                RomanizationMode::On,
                false,
                &mut never
            ),
            Presentation {
                show_hint: true,
                bank_size: ladders().cloze_bank[0],
                distractor_tiles: 0,
                readings: all.clone(),
                listening: false,
                shown: "pick-4".into(),
            }
        );
        let words2 = rung(2, &["w"]);
        let answer = ["Yo", "leo", "un", "libro."];
        let tray = Challenge::WordOrder(word_order(
            &["w"],
            &answer,
            &["Yo", "leo", "un", "libro.", "d1", "d2", "d3"],
        ));
        assert_eq!(
            presentation_for(
                &tray,
                &words2,
                &by_id(&words2),
                RomanizationMode::On,
                false,
                &mut never
            ),
            Presentation {
                show_hint: true,
                bank_size: 0,
                distractor_tiles: ladders().word_order_distractors[1],
                readings: all,
                listening: false,
                shown: "tiles".into(),
            }
        );
        let off = presentation_for(
            &cloze(&["w"], &BIG_BANK),
            &words,
            &index,
            RomanizationMode::Off,
            false,
            &mut never,
        );
        assert!(!off.readings.sentence);
        // A Latin-script row has no reading to hide, so Off is not a different screen.
        assert_eq!(off.shown, "pick-4");
        let heard = presentation_for(
            &mc(&["w"]),
            &words,
            &index,
            RomanizationMode::On,
            true,
            &mut never,
        );
        assert_eq!(heard.listening, is_listening(&mc(&["w"]), true));
        assert_eq!(heard.shown == "listening", heard.listening);
    }

    fn mc(item_ids: &[&str]) -> Challenge {
        Challenge::from_value(
            json!({ "id": "c1", "type": "multiple-choice", "direction": "toNative", "prompt": "猫",
            "options": ["cat", "dog", "bird", "fish"], "correctIndex": 0, "itemIds": item_ids }),
        )
        .unwrap()
    }

    #[test]
    fn the_hiding_ramp_is_linear_between_its_floor_and_ceiling() {
        let ramp = &ladders().hide_reading;
        assert_eq!(hide_reading_probability(0.0), 0.0);
        assert_eq!(hide_reading_probability(ramp.floor), 0.0);
        assert_eq!(hide_reading_probability(-1.0), 0.0);
        assert_eq!(hide_reading_probability(ramp.ceiling), 1.0);
        assert_eq!(hide_reading_probability(2.0), 1.0);
        assert!((hide_reading_probability((ramp.floor + ramp.ceiling) / 2.0) - 0.5).abs() < 1e-10);
        assert!((hide_reading_probability(ramp.floor + 0.125) - 0.25).abs() < 1e-10);
        let mut previous = -1.0;
        for step in 0..=20 {
            let probability = hide_reading_probability(f64::from(step) * 0.05);
            assert!(probability >= previous);
            previous = probability;
        }
    }

    fn plan(
        mode: RomanizationMode,
        challenge: &Challenge,
        words: &[Word],
        draws: &[f64],
    ) -> ReadingPlan {
        let mut at = 0;
        let mut draw = || {
            let value = draws[at.min(draws.len() - 1)];
            at += 1;
            value
        };
        plan_readings(mode, challenge, words, &by_id(words), &mut draw)
    }

    #[test]
    fn on_and_off_ignore_the_words_and_decide_nothing_per_word() {
        let owned = [word("strong", Some(1.0))];
        let on = plan(RomanizationMode::On, &mc(&["strong"]), &owned, &[1.0]);
        assert!(on.sentence && on.by_term.is_empty());
        let weak = [word("weak", Some(0.0))];
        let off = plan(RomanizationMode::Off, &mc(&["weak"]), &weak, &[0.0]);
        assert!(!off.sentence && off.by_term.is_empty());
    }

    #[test]
    fn adaptive_always_shows_a_new_word_and_always_hides_an_owned_one() {
        for roll in [0.0, 0.5, 0.999] {
            assert!(
                plan(
                    RomanizationMode::Adaptive,
                    &mc(&["weak"]),
                    &[word("weak", Some(0.0))],
                    &[roll]
                )
                .sentence
            );
            assert!(
                !plan(
                    RomanizationMode::Adaptive,
                    &mc(&["strong"]),
                    &[word("strong", Some(1.0))],
                    &[roll]
                )
                .sentence
            );
        }
        let mixed = [word("strong", Some(1.0)), word("weak", Some(0.0))];
        assert!(
            plan(
                RomanizationMode::Adaptive,
                &mc(&["strong", "weak"]),
                &mixed,
                &[0.0]
            )
            .sentence
        );
    }

    #[test]
    fn adaptive_splits_on_the_roll_mid_ramp() {
        let mid = [word("mid", Some(0.6))];
        let hide = hide_reading_probability(0.6);
        assert!(
            !plan(
                RomanizationMode::Adaptive,
                &mc(&["mid"]),
                &mid,
                &[hide - 0.01]
            )
            .sentence
        );
        assert!(
            plan(
                RomanizationMode::Adaptive,
                &mc(&["mid"]),
                &mid,
                &[hide + 0.01]
            )
            .sentence
        );
    }

    #[test]
    fn each_known_word_rolls_on_its_own_strength_in_id_order_after_the_sentence() {
        let mixed = [word("strong", Some(1.0)), word("weak", Some(0.0))];
        let one = plan(
            RomanizationMode::Adaptive,
            &mc(&["strong", "weak"]),
            &mixed,
            &[0.5],
        );
        assert_eq!(one.by_term.get("strong"), Some(&false));
        assert_eq!(one.by_term.get("weak"), Some(&true));
        assert!(one.sentence);

        let hide = hide_reading_probability(0.6);
        let words = [
            word("a-word", Some(0.6)),
            word("b-word", Some(0.6)),
            word("c-bystander", Some(0.6)),
        ];
        let rolled = plan(
            RomanizationMode::Adaptive,
            &mc(&["a-word", "b-word"]),
            &words,
            &[hide + 0.01, hide - 0.01, hide + 0.01, hide - 0.01],
        );
        assert!(rolled.sentence);
        assert_eq!(rolled.by_term.get("a-word"), Some(&false));
        assert_eq!(rolled.by_term.get("b-word"), Some(&true));
        assert_eq!(rolled.by_term.get("c-bystander"), Some(&false));
    }

    #[test]
    fn per_word_decisions_are_keyed_by_term_and_skip_missing_words() {
        let mut cat = word("i1", Some(1.0));
        cat.term = "猫".into();
        let keyed = plan(RomanizationMode::Adaptive, &mc(&["i1"]), &[cat], &[0.5]);
        assert_eq!(keyed.by_term.keys().collect::<Vec<_>>(), ["猫"]);
        let gone = plan(
            RomanizationMode::Adaptive,
            &mc(&["strong", "gone"]),
            &[word("strong", Some(1.0))],
            &[0.5],
        );
        assert_eq!(gone.by_term.keys().collect::<Vec<_>>(), ["strong"]);
        assert!(gone.sentence);
    }

    fn recognize(id: &str, prompt: &str) -> Challenge {
        Challenge::from_value(json!({ "id": id, "type": "multiple-choice", "direction": "toNative", "prompt": prompt,
            "options": ["the menu", "the bill", "the tea", "the water"], "correctIndex": 0, "itemIds": ["i1"] }))
        .unwrap()
    }

    #[test]
    fn listening_takes_about_its_share_of_recognize_mc_and_nothing_else() {
        let ids: Vec<String> = (0..400).map(|i| format!("challenge-{i}")).collect();
        assert!(!ids
            .iter()
            .any(|id| is_listening(&recognize(id, "菜单"), false)));
        let share = ids
            .iter()
            .filter(|id| is_listening(&recognize(id, "菜单"), true))
            .count() as f64
            / 400.0;
        let target = ladders().listening_share;
        assert!(share > target - 0.1 && share < target + 0.1);
        for id in &ids[..50] {
            assert_eq!(
                is_listening(&recognize(id, "菜单"), true),
                is_listening(&recognize(id, "菜单"), true)
            );
        }
        for id in &ids[..40] {
            assert!(!is_listening(&recognize(id, "   "), true));
            let mut produce = serde_json::to_value(recognize(id, "the menu")).unwrap();
            produce["direction"] = json!("toTarget");
            assert!(!is_listening(
                &Challenge::from_value(produce).unwrap(),
                true
            ));
            let typed = Challenge::from_value(
                json!({ "id": id, "type": "typed-translation", "direction": "toNative",
                "prompt": "买单", "acceptedAnswers": ["to pay the bill"], "itemIds": ["i1"] }),
            )
            .unwrap();
            assert!(!is_listening(&typed, true));
        }
    }
}
