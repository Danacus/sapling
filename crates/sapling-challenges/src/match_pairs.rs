//! The free round, built locally from words the learner already has: no model
//! call, never pooled, never reviewed.
//!
//! Every tile label is unique — two tiles reading the same make the round a
//! guess — so the first of a colliding group (after the shuffle) is kept. Given
//! a rung the round asks for that rung's pair count, and builds a smaller round
//! rather than none when words run short.

use crate::challenge::{Direction, MatchPair, MatchPairsChallenge, MatchPairsTag};
use crate::ladder::Word;
use crate::rng::shuffled;
use crate::text::{js_trim, label_key};
use crate::tuning::ladders;

pub fn make_match_pairs(
    words: &[Word],
    draw: &mut dyn FnMut() -> f64,
    rung: Option<u8>,
    id: String,
) -> Option<MatchPairsChallenge> {
    let ladder = &ladders().match_pairs;
    let [fewest_unsized, most_unsized] = ladders().unsized_match_pairs;
    let smallest = match rung {
        None => fewest_unsized,
        Some(_) => *ladder.iter().min().expect("a ladder"),
    };

    let usable: Vec<&Word> = words.iter().filter(|w| w.is_writable()).collect();
    if usable.len() < smallest {
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
    if distinct.len() < smallest {
        return None;
    }

    let wanted = match rung {
        Some(rung) => ladder[usize::from(rung.clamp(1, 5)) - 1],
        None => {
            let most = most_unsized.min(distinct.len());
            if most > fewest_unsized {
                fewest_unsized + (draw() * (most - fewest_unsized + 1) as f64).floor() as usize
            } else {
                fewest_unsized
            }
        }
    };
    let chosen = &distinct[..wanted.min(distinct.len())];

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
        }
    }

    fn five() -> Vec<Word> {
        ["perro", "gato", "casa", "pan", "agua"]
            .iter()
            .enumerate()
            .map(|(i, term)| word(&format!("k{i}"), term, &format!("meaning-{i}")))
            .collect()
    }

    fn build(words: &[Word], draw: f64, rung: Option<u8>) -> Option<MatchPairsChallenge> {
        make_match_pairs(words, &mut || draw, rung, "id".into())
    }

    #[test]
    fn declines_below_four_words_or_four_usable_ones() {
        assert!(build(&five()[..3], 0.5, None).is_none());
        assert!(build(&[], 0.5, None).is_none());
        let mut broken = five()[..4].to_vec();
        broken[3].meaning = "  ".into();
        assert!(build(&broken, 0.5, None).is_none());
    }

    #[test]
    fn builds_a_valid_round_of_four_or_five_pairs() {
        let words = five();
        let round = build(&words, 0.5, None).unwrap();
        let stored = Challenge::MatchPairs(round.clone());
        assert_eq!(stored.check_shape(), Ok(()));
        assert!((4..=5).contains(&round.pairs.len()));
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
        let round = build(&words, 0.5, None).unwrap();
        for pair in &round.pairs {
            let source = words.iter().find(|w| w.term == pair.a).unwrap();
            assert_eq!(pair.a_rom, source.romanization);
            assert!(pair.b_rom.is_none());
        }
        let latin = serde_json::to_string(&build(&five(), 0.5, None).unwrap()).unwrap();
        assert!(!latin.contains("Rom"));
    }

    #[test]
    fn never_shows_one_label_twice_on_either_side() {
        let mut clash = five();
        clash.push(word("k5", "pronto", "meaning-0"));
        for seed in 0..20 {
            let round = build(&clash, f64::from(seed) / 20.0, None).unwrap();
            let mut left: Vec<&str> = round.pairs.iter().map(|p| p.a.as_str()).collect();
            let mut right: Vec<&str> = round.pairs.iter().map(|p| p.b.as_str()).collect();
            left.sort_unstable();
            left.dedup();
            right.sort_unstable();
            right.dedup();
            assert!(round.pairs.len() >= 4);
            assert_eq!(left.len(), round.pairs.len());
            assert_eq!(right.len(), round.pairs.len());
        }
        let mut shouty = five();
        shouty.push(word("k9", "  PERRO  ", "the hound"));
        for seed in 0..20 {
            let round = build(&shouty, f64::from(seed) / 20.0, None).unwrap();
            let mut keys: Vec<String> = round.pairs.iter().map(|p| p.a.to_lowercase()).collect();
            keys.sort();
            keys.dedup();
            assert_eq!(keys.len(), round.pairs.len());
        }
        let mut four = five()[..3].to_vec();
        four.push(word("k9", "temprano", "meaning-0"));
        assert!(build(&four, 0.5, None).is_none());
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
    fn a_sized_round_honours_its_rung() {
        let counts: Vec<usize> = (1..=5)
            .map(|rung| build(&plenty(), 0.5, Some(rung)).unwrap().pairs.len())
            .collect();
        assert_eq!(counts, [3, 4, 5, 6, 6]);
    }

    #[test]
    fn a_short_vocabulary_builds_a_smaller_round_down_to_the_ladders_floor() {
        let words = plenty();
        assert_eq!(build(&words[..3], 0.5, Some(5)).unwrap().pairs.len(), 3);
        assert_eq!(build(&words[..5], 0.5, Some(4)).unwrap().pairs.len(), 5);
        assert!(build(&words[..2], 0.5, Some(1)).is_none());
        let mut clashing = words[..3].to_vec();
        clashing[2].meaning = words[0].meaning.clone();
        assert!(build(&clashing, 0.5, Some(3)).is_none());
    }

    #[test]
    fn an_unsized_round_stays_four_or_five() {
        for seed in 0..20 {
            let count = build(&plenty(), f64::from(seed) / 20.0, None)
                .unwrap()
                .pairs
                .len();
            assert!((4..=5).contains(&count));
        }
        assert!(build(&plenty()[..3], 0.5, None).is_none());
    }
}
