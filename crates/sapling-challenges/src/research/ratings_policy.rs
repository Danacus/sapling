//! Choosing with ratings (`docs/challenge-difficulty.md` §6), the policy beside
//! `ratings.rs`; only the closed-loop simulation runs it.
//!
//! **Serving**: the head word's available challenges, at every help level,
//! each challenge rating rolled once within its margin; take the one whose
//! rolled chance is nearest the target. Fit only orders: nothing available is
//! ever refused, and the roll is the only exploration.
//!
//! **Writing**: each of the next words with fewer than [`STOCK`] available
//! challenges gets [`STOCK`] written, each type picked by the same roll.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::fits::{help_levels, written_levels};
use crate::help::HelpLevel;
use crate::kinds::{active_kinds, kind_of, ChallengeKind, Want, WantItem, WireType};
use crate::pool::{is_playable, is_rested, is_spent, known_ids};
use crate::research::policy_v2::{Ask, Pick};
use crate::research::ratings::{Key, Ratings};
use crate::research::sim::gaussian;
use crate::research::v1::{length_of, sigmoid, Evidence, Observation};
use crate::rng::Rng;
use crate::text::js_trim;
use crate::word::Word;

/// A word with fewer available challenges than this gets this many written.
pub const STOCK: usize = 2;

/// One roll per pick: each challenge rating drawn once within its margin,
/// everything else at its value.
struct Roll<'a> {
    ratings: &'a Ratings,
    now: f64,
    rng: &'a mut Rng,
    rolled: BTreeMap<Key, f64>,
}

impl Roll<'_> {
    fn chance(&mut self, o: &Observation) -> f64 {
        let mut z = 0.0;
        for t in self.ratings.terms(o) {
            let r = self.ratings.rating(&t.key, t.start, self.now);
            let value = match t.key {
                Key::Challenge(_) => *self
                    .rolled
                    .entry(t.key)
                    .or_insert_with(|| r.value + r.margin * gaussian(self.rng)),
                _ => r.value,
            };
            z += t.weight * value;
        }
        sigmoid(z)
    }
}

/// A challenge about these words at this help level, as the ratings read it.
fn seen(
    id: &str,
    kind: WireType,
    help: HelpLevel,
    length: f64,
    words: &[&Word],
    ask: &Ask,
) -> Observation {
    Observation {
        at: ask.now,
        challenge_id: id.to_owned(),
        kind,
        help,
        length,
        words: words
            .iter()
            .map(|w| Evidence {
                item_id: w.id.clone(),
                memory: w.memory(),
                stability: ask.stability.get(&w.id).copied().unwrap_or(0.0),
            })
            .collect(),
        outcome: 0.0,
    }
}

/// Due first, most overdue first, then soonest due; id breaks a tie.
fn urgency<'a>(ask: &Ask<'a>) -> Vec<&'a Word> {
    let mut words: Vec<&Word> = ask.words.iter().filter(|w| w.is_writable()).collect();
    words.sort_by(|a, b| {
        a.due_at(ask.now)
            .total_cmp(&b.due_at(ask.now))
            .then_with(|| a.id.cmp(&b.id))
    });
    words
}

/// Every available challenge of `word` at every help level: playable, not
/// spent, not shown this stream, rested or the word due.
fn available(word: &Word, ask: &Ask) -> Vec<(usize, Observation)> {
    let known = known_ids(ask.words);
    let served: HashSet<&str> = ask.served.iter().map(String::as_str).collect();
    let by_id: HashMap<&str, &Word> = ask.words.iter().map(|w| (w.id.as_str(), w)).collect();
    let mut out = Vec::new();
    for (at, row) in ask.pool.iter().enumerate() {
        let Some(row) = row.as_ref() else { continue };
        if !row.challenge.item_ids().contains(&word.id) {
            continue;
        }
        let Some(kind) = kind_of(&row.challenge).filter(|k| k.is_active()) else {
            continue;
        };
        let ok = is_playable(row, &known)
            && !is_spent(row)
            && !served.contains(row.challenge.id())
            && (word.is_due(ask.now) || is_rested(row, ask.now));
        if !ok {
            continue;
        }
        let words: Vec<&Word> = row
            .challenge
            .item_ids()
            .iter()
            .filter_map(|id| by_id.get(id.as_str()).copied())
            .collect();
        for help in help_levels(&row.challenge, ask.serving) {
            out.push((
                at,
                seen(
                    row.challenge.id(),
                    kind,
                    help,
                    length_of(&row.challenge),
                    &words,
                    ask,
                ),
            ));
        }
    }
    out
}

/// The head word's pick, or the first word further down with something.
pub fn pick(ask: &Ask, ratings: &Ratings, target: f64, rng: &mut Rng) -> Option<Pick> {
    for (i, word) in urgency(ask).into_iter().enumerate() {
        let options = available(word, ask);
        let mut roll = Roll {
            ratings,
            now: ask.now,
            rng,
            rolled: BTreeMap::new(),
        };
        let best = options
            .iter()
            .map(|(at, o)| (at, o, roll.chance(o)))
            .min_by(|a, b| (a.2 - target).abs().total_cmp(&(b.2 - target).abs()));
        if let Some((&at, o, sampled)) = best {
            return Some(Pick {
                word: word.id.clone(),
                at,
                help: o.help,
                sampled,
                passed: i > 0,
            });
        }
    }
    None
}

/// What to write for the first `limit` words of the list.
pub fn refill(ask: &Ask, limit: usize, ratings: &Ratings, target: f64, rng: &mut Rng) -> Vec<Want> {
    let mut wants = Vec::new();
    for word in urgency(ask).into_iter().take(limit) {
        let rows: HashSet<usize> = available(word, ask).into_iter().map(|(at, _)| at).collect();
        if rows.len() >= STOCK {
            continue;
        }
        let cued = ask.cued.contains(&word.id);
        let mut roll = Roll {
            ratings,
            now: ask.now,
            rng,
            rolled: BTreeMap::new(),
        };
        // Each type is judged by its help level nearest the target, at the
        // middle of its lengths.
        let mut kinds: Vec<(WireType, u8, f64)> = active_kinds()
            .filter(|k| cued || !k.is_local())
            .filter_map(|kind| {
                let [short, long] = kind.lengths()?;
                let length = short + (long - short) / 2;
                let distance = written_levels(kind, ask.serving)
                    .into_iter()
                    .map(|help| roll.chance(&seen("", kind, help, f64::from(length), &[word], ask)))
                    .map(|c| (c - target).abs())
                    .fold(f64::INFINITY, f64::min);
                Some((kind, length, distance))
            })
            .collect();
        kinds.sort_by(|a, b| a.2.total_cmp(&b.2));
        for (kind, length, _) in kinds.into_iter().take(STOCK) {
            wants.push(Want {
                item: WantItem {
                    id: word.id.clone(),
                    term: js_trim(&word.term).to_owned(),
                    meaning: js_trim(&word.meaning).to_owned(),
                },
                kind: ChallengeKind { kind },
                length,
            });
        }
    }
    wants
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fits::Serving;
    use crate::pool::PoolRow;
    use crate::research::ratings::Settings;
    use crate::stream::tests::rows;
    use crate::topup::tests::{pooled, word, DAY, NOW};

    fn ask<'a>(
        pool: &'a [Option<PoolRow>],
        words: &'a [Word],
        serving: &'a Serving,
        stability: &'a HashMap<String, f64>,
    ) -> Ask<'a> {
        Ask {
            pool,
            words,
            now: NOW,
            served: &[],
            cued: &[],
            serving,
            stability,
        }
    }

    fn settle(r: &mut Ratings, kind: WireType, right: usize, answers: usize) {
        for i in 0..answers {
            let o = Observation {
                at: NOW,
                challenge_id: String::new(),
                kind,
                help: HelpLevel::step(crate::help::Step::Plain),
                length: 1.0,
                words: vec![Evidence {
                    item_id: format!("other-{i}"),
                    memory: 1.0,
                    stability: 0.0,
                }],
                outcome: f64::from(u8::from(i % 10 < right)),
            };
            r.learn(&o);
        }
    }

    /// How often the second of two rows about one word is picked.
    fn second(r: &Ratings, seeds: u64) -> usize {
        let words = [word("w", -DAY, 0.5)];
        let pool = rows(&[
            pooled("easy", WireType::RecognizeMc, &["w"], None),
            pooled("other", WireType::TranslateToNative, &["w"], None),
        ]);
        let (serving, stability) = (Serving::default(), HashMap::new());
        (0..seeds)
            .filter(|&seed| {
                let p = pick(
                    &ask(&pool, &words, &serving, &stability),
                    r,
                    0.8,
                    &mut Rng::seeded(seed),
                );
                p.unwrap().at == 1
            })
            .count()
    }

    /// A type rated hard on many answers is almost never rolled into reach;
    /// on two it now and then is; never answered, it often is.
    #[test]
    fn a_sure_bad_type_is_rarely_picked_an_unsure_one_sometimes() {
        let with = |answers: usize| {
            let mut r = Ratings::new(Settings::default());
            settle(&mut r, WireType::RecognizeMc, 8, 100);
            settle(&mut r, WireType::TranslateToNative, 0, answers);
            second(&r, 400)
        };
        let (sure, thin, unknown) = (with(200), with(2), with(0));
        assert!(sure < 4, "{sure}");
        assert!(
            thin > sure && unknown > thin + 20,
            "{sure} {thin} {unknown}"
        );
    }

    #[test]
    fn a_word_short_of_stock_gets_two_types_and_a_replay_under_a_seed() {
        let words = [word("a", -DAY, 0.5), word("b", -DAY, 0.5)];
        let pool = rows(&[
            pooled("c1", WireType::Cloze, &["a"], None),
            pooled("c2", WireType::RecognizeMc, &["a"], None),
        ]);
        let (serving, stability) = (Serving::default(), HashMap::new());
        let r = Ratings::new(Settings::default());
        let run = |seed| {
            refill(
                &ask(&pool, &words, &serving, &stability),
                5,
                &r,
                0.8,
                &mut Rng::seeded(seed),
            )
        };
        assert_eq!(run(3), run(3));
        let wants = run(3);
        assert_eq!(wants.len(), STOCK);
        assert!(wants.iter().all(|w| w.item.id == "b"));
        assert_ne!(wants[0].kind, wants[1].kind);
    }
}
