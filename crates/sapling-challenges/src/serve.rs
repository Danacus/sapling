//! What a served challenge shows, from the help level serving picked for it
//! (`fits.rs`): the native hint line, how much of a stored bank or tray shows,
//! whether its reading shows, and whether it is played before it is read.
//!
//! A row is generated once with everything any help level could need — the
//! full bank, the extra tiles, the hint, the readings — and each help level is
//! a view of it, sized here and capped at what the row stores. The `visible_*`
//! functions pick *which* stored entries show: the answers in their own
//! positions, then the first distractors in stored order — never reshuffled,
//! and returned as positions so an index-aligned reading array slices the
//! same way.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::{Challenge, WordOrderChallenge};
use crate::help::{HelpLevel, Step};

/// The learner's romanization preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RomanizationMode {
    On,
    Off,
    #[default]
    Adaptive,
}

/// Which readings a served challenge shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPlan {
    /// The whole-challenge decision: the help level's reading shown or hidden.
    pub sentence: bool,
    /// Per-word overrides, keyed by term. A help level decides the whole
    /// challenge, so serving leaves it empty; the type stays so a component
    /// reads one plan shape whoever made it.
    pub by_term: BTreeMap<String, bool>,
}

/// Everything decided at serve time: one help level, as a screen.
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
    /// Whether the prompt is played before it is read: the listening help level.
    pub listening: bool,
    /// The help level this screen is (`help.rs`): what the answer records as `shown`.
    pub shown: String,
}

/// Everything a stored row shows at one help level: the steps' sizes, capped
/// at what the row stores; the reading shown or hidden as a whole; listening.
pub fn presentation_for(challenge: &Challenge, help: HelpLevel) -> Presentation {
    let step = help.step;
    let bank_size = match challenge {
        Challenge::Cloze(c) => {
            let stored = c.word_bank.as_ref().map_or(0, Vec::len);
            match step {
                Step::Pick4 => stored.min(4),
                Step::Pick6 => stored.min(6),
                _ => 0,
            }
        }
        Challenge::MultiCloze(c) => {
            let extra = if step == Step::Extra2 { 2 } else { 0 };
            c.word_bank.len().min(c.gaps.len() + extra)
        }
        _ => 0,
    };
    let distractor_tiles = match challenge {
        Challenge::WordOrder(c) if step == Step::Extra2 => {
            c.tiles.len().saturating_sub(c.answer_tokens.len()).min(2)
        }
        _ => 0,
    };
    Presentation {
        show_hint: step.shows_hint(),
        bank_size,
        distractor_tiles,
        readings: ReadingPlan {
            sentence: !help.reading_hidden,
            by_term: BTreeMap::new(),
        },
        listening: help.listening,
        shown: help.id(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cloze(bank: &[&str]) -> Challenge {
        let mut row = json!({ "id": "c1", "type": "cloze", "direction": "toTarget", "sentence": "Yo ___ un libro.",
            "acceptedAnswers": [bank.first().copied().unwrap_or("leo")], "wordBank": bank, "itemIds": ["w"] });
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

    fn word_order(answer: &[&str], tiles: &[&str]) -> WordOrderChallenge {
        serde_json::from_value(
            json!({ "id": "w1", "type": "word-order", "direction": "toTarget",
            "tiles": tiles, "answerTokens": answer, "answer": answer.join(" "), "itemIds": ["w"] }),
        )
        .unwrap()
    }

    const BIG_BANK: [&str; 6] = ["leo", "como", "bebo", "corro", "salto", "duermo"];

    #[test]
    fn a_cloze_shows_four_with_its_hint_then_six_then_nothing() {
        let c = cloze(&BIG_BANK);
        let at = |step| presentation_for(&c, HelpLevel::step(step));
        assert_eq!(
            (at(Step::Pick4).bank_size, at(Step::Pick4).show_hint),
            (4, true)
        );
        assert_eq!(
            (at(Step::Pick6).bank_size, at(Step::Pick6).show_hint),
            (6, false)
        );
        assert_eq!(
            (at(Step::Typed).bank_size, at(Step::Typed).show_hint),
            (0, false)
        );
        // Never more than the row stores.
        let short = cloze(&["leo", "como", "bebo"]);
        assert_eq!(
            presentation_for(&short, HelpLevel::step(Step::Pick6)).bank_size,
            3
        );
    }

    #[test]
    fn a_multi_cloze_shows_its_answers_then_two_more() {
        let two = multi(
            &["a", "b"],
            &["leo", "como"],
            &["leo", "como", "d1", "d2", "d3"],
        );
        assert_eq!(
            presentation_for(&two, HelpLevel::step(Step::Answers)).bank_size,
            2
        );
        assert_eq!(
            presentation_for(&two, HelpLevel::step(Step::Extra2)).bank_size,
            4
        );
        let tight = multi(&["a", "b"], &["leo", "como"], &["leo", "como", "d1"]);
        assert_eq!(
            presentation_for(&tight, HelpLevel::step(Step::Extra2)).bank_size,
            3
        );
    }

    #[test]
    fn a_tray_shows_its_own_tiles_with_the_line_then_two_extra_without_it() {
        let tray = Challenge::WordOrder(word_order(
            &["Yo", "leo", "un", "libro."],
            &["Yo", "leo", "un", "libro.", "d1", "d2", "d3"],
        ));
        let tiles = presentation_for(&tray, HelpLevel::step(Step::Tiles));
        assert_eq!((tiles.distractor_tiles, tiles.show_hint), (0, true));
        let extra = presentation_for(&tray, HelpLevel::step(Step::Extra2));
        assert_eq!((extra.distractor_tiles, extra.show_hint), (2, false));
    }

    #[test]
    fn the_reading_and_listening_come_from_the_help_level_and_it_is_recorded() {
        let c = cloze(&BIG_BANK);
        let hidden = presentation_for(&c, HelpLevel::hidden(Step::Typed));
        assert!(!hidden.readings.sentence && hidden.readings.by_term.is_empty());
        assert_eq!(hidden.shown, "typed-hidden");
        let shown = presentation_for(&c, HelpLevel::step(Step::Pick4));
        assert!(shown.readings.sentence && !shown.listening);
        let mc = Challenge::from_value(json!({ "id": "m", "type": "multiple-choice", "direction": "toNative",
            "prompt": "猫", "options": ["cat", "dog", "bird", "fish"], "correctIndex": 0, "itemIds": ["w"] }))
        .unwrap();
        let heard = presentation_for(&mc, HelpLevel::LISTENING);
        assert!(heard.listening);
        assert_eq!(heard.shown, "listening");
    }

    #[test]
    fn a_visible_bank_keeps_its_answers_and_takes_distractors_in_stored_order() {
        let bank = ["d1", "leo", "d2", "d3", "d4", "d5"];
        assert_eq!(visible_bank(&cloze(&bank), 3), [0, 1, 2]);
        assert_eq!(visible_bank(&cloze(&bank), 4), [0, 1, 2, 3]);
        assert_eq!(visible_bank(&cloze(&["leo", "d1"]), 6), [0, 1]);
        let two = multi(&["a", "b"], &["x", "y"], &["d1", "x", "d2", "y", "d3"]);
        assert_eq!(visible_bank(&two, 1), [1, 3]);
        assert!(visible_bank(&cloze(&[]), 3).is_empty());
    }

    #[test]
    fn visible_tiles_keep_every_sentence_tile_with_multiplicity() {
        let tray = word_order(&["yo", "yo", "leo"], &["yo", "d1", "yo", "leo", "d2"]);
        assert_eq!(visible_tiles(&tray, 0), [0, 2, 3]);
        assert_eq!(visible_tiles(&tray, 1), [0, 1, 2, 3]);
        let short = word_order(&["Yo", "leo"], &["Yo", "leo", "d1"]);
        assert_eq!(visible_tiles(&short, 5), [0, 1, 2]);
    }
}
