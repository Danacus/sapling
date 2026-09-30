//! The free round, built locally from words the learner already has: no model
//! call, never pooled, never reviewed.
//!
//! Every tile label is unique — two tiles reading the same make the round a
//! guess — so the first of a colliding group (after the shuffle) is kept. A
//! round is a fixed size, [`ROUND_PAIRS`], and a smaller one down to
//! [`MIN_ROUND_PAIRS`] rather than none when words run short: it is pacing
//! between challenges, not a difficulty of its own.

use crate::challenge::{Direction, MatchPair, MatchPairsChallenge, MatchPairsTag};
use crate::rng::shuffled;
use crate::text::{js_trim, label_key};
use crate::word::Word;

/// Pairs in a round.
pub const ROUND_PAIRS: usize = 5;

/// The fewest pairs worth a round.
pub const MIN_ROUND_PAIRS: usize = 3;

pub fn make_match_pairs(
    words: &[Word],
    draw: &mut dyn FnMut() -> f64,
    id: String,
) -> Option<MatchPairsChallenge> {
    let usable: Vec<&Word> = words.iter().filter(|w| w.is_writable()).collect();
    if usable.len() < MIN_ROUND_PAIRS {
        return None;
    }
    let pool = shuffled(&usable, draw);

    let mut terms = Vec::new();
    let mut meanings = Vec::new();
    let mut distinct: Vec<&Word> = Vec::new();
    for word in pool {
        let (term, meaning) = (label_key(&word.term), label_key(&word.meaning));
        if terms.contains(&term) || meanings.contains(&meaning) {
            continue;
        }
        terms.push(term);
        meanings.push(meaning);
        distinct.push(word);
    }
    if distinct.len() < MIN_ROUND_PAIRS {
        return None;
    }
    let chosen = &distinct[..ROUND_PAIRS.min(distinct.len())];

    Some(MatchPairsChallenge {
        kind: MatchPairsTag::Tag,
        id,
        direction: Direction::ToNative,
        item_ids: chosen.iter().map(|w| w.id.clone()).collect(),
        pairs: chosen
            .iter()
            .map(|w| MatchPair {
                a: js_trim(&w.term).to_owned(),
                b: js_trim(&w.meaning).to_owned(),
                a_rom: w
                    .romanization
                    .as_deref()
                    .map(js_trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_owned),
                b_rom: None,
            })
            .collect(),
        explanation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::challenge::Challenge;

    fn word(id: &str, term: &str, meaning: &str) -> Word {
        Word {
            id: id.into(),
            term: term.into(),
            meaning: meaning.into(),
            romanization: None,
            srs: None,
            skill: None,
        }
    }

    fn five() -> Vec<Word> {
        ["perro", "gato", "casa", "pan", "agua"]
            .iter()
            .enumerate()
            .map(|(i, term)| word(&format!("k{i}"), term, &format!("meaning-{i}")))
            .collect()
    }

    fn build(words: &[Word], draw: f64) -> Option<MatchPairsChallenge> {
        make_match_pairs(words, &mut || draw, "id".into())
    }

    #[test]
    fn declines_below_three_usable_words() {
        assert!(build(&five()[..2], 0.5).is_none());
        assert!(build(&[], 0.5).is_none());
        let mut broken = five()[..3].to_vec();
        broken[2].meaning = "  ".into();
        assert!(build(&broken, 0.5).is_none());
    }

    #[test]
    fn builds_a_valid_round_of_five_pairs() {
        let words = five();
        let round = build(&words, 0.5).unwrap();
        let stored = Challenge::MatchPairs(round.clone());
        assert_eq!(stored.check_shape(), Ok(()));
        assert_eq!(round.pairs.len(), ROUND_PAIRS);
        assert_eq!(round.item_ids.len(), round.pairs.len());
        for pair in &round.pairs {
            let source = words.iter().find(|w| w.term == pair.a).unwrap();
            assert_eq!(source.meaning, pair.b);
        }
    }

    #[test]
    fn carries_the_terms_reading_and_never_one_for_the_meaning() {
        let words: Vec<Word> = [
            ("菜单", "the menu", "càidān"),
            ("买单", "to pay the bill", "mǎidān"),
            ("筷子", "chopsticks", "kuàizi"),
            ("茶", "tea", "chá"),
        ]
        .iter()
        .enumerate()
        .map(|(i, (term, meaning, reading))| Word {
            romanization: Some((*reading).into()),
            ..word(&format!("z{i}"), term, meaning)
        })
        .collect();
        let round = build(&words, 0.5).unwrap();
        for pair in &round.pairs {
            let source = words.iter().find(|w| w.term == pair.a).unwrap();
            assert_eq!(pair.a_rom, source.romanization);
            assert!(pair.b_rom.is_none());
        }
        let latin = serde_json::to_string(&build(&five(), 0.5).unwrap()).unwrap();
        assert!(!latin.contains("Rom"));
    }

    #[test]
    fn never_shows_one_label_twice_on_either_side() {
        let mut clash = five();
        clash.push(word("k5", "pronto", "meaning-0"));
        for seed in 0..20 {
            let round = build(&clash, f64::from(seed) / 20.0).unwrap();
            let mut left: Vec<&str> = round.pairs.iter().map(|p| p.a.as_str()).collect();
            let mut right: Vec<&str> = round.pairs.iter().map(|p| p.b.as_str()).collect();
            left.sort_unstable();
            left.dedup();
            right.sort_unstable();
            right.dedup();
            assert!(round.pairs.len() >= MIN_ROUND_PAIRS);
            assert_eq!(left.len(), round.pairs.len());
            assert_eq!(right.len(), round.pairs.len());
        }
        let mut shouty = five();
        shouty.push(word("k9", "  PERRO  ", "the hound"));
        for seed in 0..20 {
            let round = build(&shouty, f64::from(seed) / 20.0).unwrap();
            let mut keys: Vec<String> = round.pairs.iter().map(|p| p.a.to_lowercase()).collect();
            keys.sort();
            keys.dedup();
            assert_eq!(keys.len(), round.pairs.len());
        }
        let mut three = five()[..2].to_vec();
        three.push(word("k9", "temprano", "meaning-0"));
        assert!(build(&three, 0.5).is_none());
    }

    fn plenty() -> Vec<Word> {
        (0..12)
            .map(|i| {
                word(
                    &format!("p{i}"),
                    &format!("term-{i}"),
                    &format!("meaning-{i}"),
                )
            })
            .collect()
    }

    #[test]
    fn a_round_is_five_pairs_and_smaller_when_words_run_short() {
        let words = plenty();
        for seed in 0..20 {
            let round = build(&words, f64::from(seed) / 20.0).unwrap();
            assert_eq!(round.pairs.len(), ROUND_PAIRS);
        }
        assert_eq!(build(&words[..3], 0.5).unwrap().pairs.len(), 3);
        assert!(build(&words[..2], 0.5).is_none());
        let mut clashing = words[..3].to_vec();
        clashing[2].meaning = words[0].meaning.clone();
        assert!(build(&clashing, 0.5).is_none());
    }
}
