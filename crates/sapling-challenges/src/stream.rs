//! Practice is one continuous stream that runs until the learner stops
//! (`docs/challenge-difficulty.md`), each challenge picked against the store
//! as it is now.
//!
//! **One list, one predicate.** [`upcoming`] is the next words in urgency
//! order — due first, most overdue first, then the rest soonest first — each
//! with how many rows are [`available`] to it. Serving takes the head: among
//! its available rows at every help level, the one whose rolled chance is
//! nearest the aim's target (`ratings.rs`' `Roll`). A head with nothing waits
//! for a refill while one is running or can be started for it, and only when
//! none can help is it passed for the first word further down the same list
//! that has something ([`head`]'s `pass`). Refill writes for the words in the
//! first [`low_water_mark`] of the same list that are short of stock
//! (`topup.rs`), so the two can never disagree.
//!
//! **Pacing** is a rule on the stream, not a plan: a free match round after
//! every [`MATCH_PAIRS_EVERY`] challenges about early words, never when there
//! is nothing to follow it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::fits::{help_levels, Serving};
use crate::help::HelpLevel;
use crate::kinds::{kind_of, WireType};
use crate::match_pairs::make_match_pairs;
use crate::model::{length_of, target, Evidence, Observation};
use crate::pool::{is_playable, is_rested, is_spent, known_ids, PoolRow};
use crate::ratings::{Ratings, Roll};
use crate::rng::Rng;
use crate::types::MatchPairsChallenge;
use crate::word::{by_id, ById, Word};

/// A free match round comes after every this many challenges about early words.
pub const MATCH_PAIRS_EVERY: usize = 4;

/// Below this strength a word is early material, which match rounds are drawn
/// from and follow. Pacing, not difficulty: a round is a warm-up between new
/// words, and a stream of words the learner owns reads as uninterrupted work.
pub const EARLY_STRENGTH: f64 = 0.3;

/// The fewest upcoming words a refill keeps written for, and the most.
pub const LOW_WATER_BOUNDS: [usize; 2] = [4, 20];

/// What a batch takes to come back and a challenge to answer, before the
/// stream has timed either.
pub const DEFAULT_BATCH_MS: f64 = 45_000.0;
pub const DEFAULT_PACE_MS: f64 = 15_000.0;

/// The next challenge: its position in the pool, the help level it is served
/// at, its rolled chance there, and whether its word is due.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Next {
    pub at: usize,
    pub shown: String,
    pub chance: f64,
    pub due: bool,
}

/// One word of the list and how many rows are available to it now.
pub struct Ahead<'w> {
    pub word: &'w Word,
    pub available: usize,
}

/// Soonest due first, id breaking the tie so the order ignores store order.
pub(crate) fn by_urgency(words: &[Word], now: f64) -> Vec<&Word> {
    let mut sorted: Vec<&Word> = words.iter().filter(|w| w.is_writable()).collect();
    sorted.sort_by(|a, b| {
        a.due_at(now)
            .total_cmp(&b.due_at(now))
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted
}

/// A challenge of `kind` about these words at this help level and length, as
/// the ratings read it now.
pub(crate) fn seen(
    id: &str,
    kind: WireType,
    help: HelpLevel,
    length: f64,
    words: &[&Word],
    now: f64,
) -> Observation {
    Observation {
        at: now,
        challenge_id: id.to_owned(),
        kind,
        help,
        length,
        words: words
            .iter()
            .map(|w| Evidence {
                item_id: w.id.clone(),
                memory: w.memory(),
                stability: w.stability(),
            })
            .collect(),
        outcome: 0.0,
    }
}

/// What [`available`] reads besides the row.
struct Context<'a> {
    now: f64,
    known: HashSet<&'a str>,
    served: HashSet<&'a str>,
    words: ById<'a>,
}

/// The one predicate: a row may be served to a word now when it is playable,
/// of an active kind, not spent, not yet served this stream, and rested — or
/// merely resting, when the word is due. Fit never makes a row unavailable.
fn available(row: &PoolRow, due: bool, cx: &Context) -> bool {
    is_playable(row, &cx.known)
        && kind_of(&row.challenge).is_some_and(|k| k.is_active())
        && !is_spent(row)
        && !cx.served.contains(row.challenge.id())
        && (due || is_rested(row, cx.now))
}

/// Never served (newest first) before served (longest ago first), id last:
/// what breaks a tie between rows the roll puts equally near.
fn fresher(a: &PoolRow, b: &PoolRow) -> std::cmp::Ordering {
    let key = |row: &PoolRow| match row.last_served_at {
        None => (false, -row.generated_at),
        Some(at) => (true, at),
    };
    let (ka, kb) = (key(a), key(b));
    ka.0.cmp(&kb.0)
        .then(ka.1.total_cmp(&kb.1))
        .then_with(|| a.challenge.id().cmp(b.challenge.id()))
}

/// The list, walked lazily: every word in urgency order, and for any of them
/// its available rows or the one it would be served now.
struct Walk<'w, 'a> {
    cx: Context<'a>,
    about: HashMap<&'a str, Vec<usize>>,
    pool: &'a [Option<PoolRow>],
    order: Vec<&'w Word>,
}

impl<'w, 'a> Walk<'w, 'a>
where
    'w: 'a,
{
    fn new(pool: &'a [Option<PoolRow>], words: &'w [Word], now: f64, served: &'a [String]) -> Self {
        let mut about: HashMap<&str, Vec<usize>> = HashMap::new();
        for (at, row) in pool.iter().enumerate() {
            for item in row.iter().flat_map(|r| r.challenge.item_ids()) {
                about.entry(item.as_str()).or_default().push(at);
            }
        }
        Walk {
            cx: Context {
                now,
                known: known_ids(words),
                served: served.iter().map(String::as_str).collect(),
                words: by_id(words),
            },
            about,
            pool,
            order: by_urgency(words, now),
        }
    }

    /// The positions of the rows available to `word` now.
    fn rows(&self, word: &Word) -> Vec<usize> {
        let due = word.is_due(self.cx.now);
        let mut rows: Vec<usize> = self
            .about
            .get(word.id.as_str())
            .into_iter()
            .flatten()
            .copied()
            .filter(|&at| {
                self.pool[at]
                    .as_ref()
                    .is_some_and(|row| available(row, due, &self.cx))
            })
            .collect();
        rows.dedup();
        rows
    }

    /// The row and help level `word` would be served now: each challenge
    /// rating rolled once, the option nearest the target taken.
    fn pick(&self, word: &Word, judge: Judge, rng: &mut Rng) -> Option<Next> {
        let cx = &self.cx;
        let aim = target(judge.serving.aim);
        let mut roll = Roll::new(judge.ratings, cx.now, rng);
        let mut best: Option<(usize, &PoolRow, HelpLevel, f64)> = None;
        for at in self.rows(word) {
            let row = self.pool[at].as_ref()?;
            let kind = kind_of(&row.challenge)?;
            let words: Vec<&Word> = row
                .challenge
                .item_ids()
                .iter()
                .filter_map(|id| cx.words.get(id.as_str()).copied())
                .collect();
            let length = length_of(&row.challenge);
            for help in help_levels(&row.challenge, judge.serving) {
                let o = seen(row.challenge.id(), kind, help, length, &words, cx.now);
                let chance = roll.chance(&o);
                let better = best.is_none_or(|(_, r, _, c)| {
                    let (d, e) = ((chance - aim).abs(), (c - aim).abs());
                    d < e || (d == e && fresher(row, r).is_lt())
                });
                if better {
                    best = Some((at, row, help, chance));
                }
            }
        }
        best.map(|(at, _, help, chance)| Next {
            at,
            shown: help.id(),
            chance,
            due: word.is_due(cx.now),
        })
    }
}

/// The next `n` words in urgency order, each with how many rows are available to it.
pub fn upcoming<'w>(
    pool: &[Option<PoolRow>],
    words: &'w [Word],
    now: f64,
    served: &[String],
    n: usize,
) -> Vec<Ahead<'w>> {
    let walk = Walk::new(pool, words, now, served);
    walk.order
        .iter()
        .take(n)
        .map(|word| Ahead {
            word,
            available: walk.rows(word).len(),
        })
        .collect()
}

/// The head of the list: the most urgent word, and the challenge to serve —
/// its own, or, when the caller let the stream pass a head with nothing, the
/// first word further down that has one (`instead` names that word). `None`
/// only when there are no words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Head {
    pub word: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<Next>,
    /// The word `next` is about when it is not the head's: the head had
    /// nothing, and no batch could help it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instead: Option<String>,
}

/// What a pick is made against besides the pool and the words.
#[derive(Debug, Clone, Copy)]
pub struct Judge<'a> {
    pub serving: &'a Serving,
    pub ratings: &'a Ratings,
}

/// `served` being the ids this stream has already shown. With `pass`, a head
/// with nothing is passed for the first word further down the same list that
/// has an available row — what the stream does only when no batch can help
/// the head (`session.md`); without it, the head waits. `rng` rolls the
/// ratings: the same seed for the same stream position picks the same.
pub fn head(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    judge: Judge,
    served: &[String],
    pass: bool,
    rng: &mut Rng,
) -> Option<Head> {
    let walk = Walk::new(pool, words, now, served);
    let first = *walk.order.first()?;
    let next = walk.pick(first, judge, rng);
    let word = first.id.clone();
    if next.is_some() || !pass {
        return Some(Head {
            word,
            next,
            instead: None,
        });
    }
    let further = walk.order[1..]
        .iter()
        .find_map(|w| walk.pick(w, judge, rng).map(|next| (w.id.clone(), next)));
    Some(Head {
        word,
        instead: further.as_ref().map(|(id, _)| id.clone()),
        next: further.map(|(_, next)| next),
    })
}

/// The head's challenge, or `None` while the head has nothing.
pub fn next_pick(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    judge: Judge,
    served: &[String],
    rng: &mut Rng,
) -> Option<Next> {
    head(pool, words, now, judge, served, false, rng)?.next
}

/// How many words ahead refill keeps written for: enough to keep answering
/// while a batch comes back — the batch's time over the learner's pace, plus
/// two for slack — within [`LOW_WATER_BOUNDS`].
pub fn low_water_mark(pace_ms: Option<f64>, batch_ms: Option<f64>) -> usize {
    let pace = pace_ms
        .filter(|p| p.is_finite() && *p > 0.0)
        .unwrap_or(DEFAULT_PACE_MS);
    let batch = batch_ms
        .filter(|b| b.is_finite() && *b > 0.0)
        .unwrap_or(DEFAULT_BATCH_MS);
    let [low, high] = LOW_WATER_BOUNDS;
    ((batch / pace).ceil() as usize + 2).clamp(low, high)
}

/// Whether a challenge about these words counts towards the next match round.
pub fn is_early(item_ids: &[String], words: &[Word]) -> bool {
    let index = by_id(words);
    item_ids.iter().any(|id| {
        index
            .get(id.as_str())
            .is_some_and(|w| w.strength() < EARLY_STRENGTH)
    })
}

/// A free round drawn from the early words, or `None` when there are too few.
pub fn match_round(words: &[Word], rng: &mut Rng) -> Option<MatchPairsChallenge> {
    let early: Vec<Word> = words
        .iter()
        .filter(|w| w.strength() < EARLY_STRENGTH)
        .cloned()
        .collect();
    let id = rng.uuid();
    make_match_pairs(&early, &mut || rng.next_f64(), id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::help::Step;
    use crate::kinds::WireType;
    use crate::pool::RESERVE_GAP;
    use crate::topup::tests::{pooled, word, DAY, NOW};
    use crate::topup::{Scope, STOCK};
    use crate::Challenge;
    use serde_json::json;

    fn fresh(id: &str, offset: f64) -> Word {
        word(id, offset, 0.0)
    }
    fn row(id: &str, item_ids: &[&str]) -> PoolRow {
        pooled(id, WireType::RecognizeMc, item_ids, None)
    }
    fn generated(mut row: PoolRow, at: f64) -> PoolRow {
        row.generated_at = at;
        row
    }
    fn served(mut row: PoolRow, at: f64) -> PoolRow {
        row.times_served = 1.0;
        row.last_served_at = Some(at);
        row
    }
    fn typed_row(id: &str, item_ids: &[&str]) -> PoolRow {
        let row = json!({ "id": id, "type": "cloze", "direction": "toTarget", "sentence": "Yo ___ ayer.",
            "acceptedAnswers": ["corrí"], "itemIds": item_ids });
        PoolRow {
            challenge: Challenge::from_value(row).unwrap(),
            generated_at: NOW - DAY,
            times_served: 0.0,
            last_served_at: None,
            reported: false,
            topic: None,
        }
    }

    pub(crate) fn rows(pool: &[PoolRow]) -> Vec<Option<PoolRow>> {
        pool.iter().cloned().map(Some).collect()
    }

    /// The pick for the default serving and these ratings under `seed`.
    pub(crate) fn pick_with(
        pool: &[Option<PoolRow>],
        words: &[Word],
        ratings: &Ratings,
        served: &[String],
        seed: u64,
    ) -> Option<Next> {
        let serving = Serving::default();
        let judge = Judge {
            serving: &serving,
            ratings,
        };
        next_pick(pool, words, NOW, judge, served, &mut Rng::seeded(seed))
    }
    fn pick(pool: &[Option<PoolRow>], words: &[Word], served: &[String]) -> Option<Next> {
        pick_with(pool, words, &Ratings::default(), served, 1)
    }

    /// The ids the stream serves, one pick at a time, as if each were
    /// answered straight away and its words reviewed far ahead.
    fn stream(pool: &[PoolRow], words: &[Word], limit: usize) -> Vec<String> {
        let rows = rows(pool);
        let mut words = words.to_vec();
        let mut shown: Vec<String> = Vec::new();
        while shown.len() < limit {
            let Some(next) = pick(&rows, &words, &shown) else {
                break;
            };
            let row = &pool[next.at].challenge;
            for word in words.iter_mut().filter(|w| row.item_ids().contains(&w.id)) {
                word.srs.as_mut().unwrap().due = NOW + (100 + shown.len()) as f64 * DAY;
            }
            shown.push(row.id().to_owned());
        }
        shown
    }

    /// Many answers by other words to `kind` at its plain level, `right` in ten right.
    pub(crate) fn settle(r: &mut Ratings, kind: WireType, right: usize, answers: usize) {
        for i in 0..answers {
            r.learn(&Observation {
                at: NOW,
                challenge_id: String::new(),
                kind,
                help: HelpLevel::step(Step::Plain),
                length: crate::ratings::centre(kind),
                words: vec![Evidence {
                    item_id: format!("other-{i}"),
                    memory: 1.0,
                    stability: 0.0,
                }],
                outcome: f64::from(u8::from(i % 10 < right)),
            });
        }
    }

    #[test]
    fn due_words_come_first_most_overdue_first_then_the_words_ahead() {
        let words = [
            fresh("a", -DAY),
            fresh("b", -10.0 * DAY),
            fresh("later", 5.0 * DAY),
            fresh("soon", DAY),
        ];
        let pool = [
            generated(row("c-later", &["later"]), NOW),
            row("ca", &["a"]),
            row("cb", &["b"]),
            row("c-soon", &["soon"]),
        ];
        assert_eq!(stream(&pool, &words, 9), ["cb", "ca", "c-soon", "c-later"]);
    }

    #[test]
    fn rows_the_roll_puts_level_are_served_freshest_first() {
        let words = [fresh("due", -DAY)];
        let pool = [
            generated(row("older", &["due"]), NOW - 5.0 * DAY),
            generated(row("newer", &["due"]), NOW),
        ];
        assert_eq!(stream(&pool, &words, 2), ["newer", "older"]);
    }

    /// Fit only orders: a brand-new word with nothing but a typed cloze is
    /// served it rather than kept waiting.
    #[test]
    fn fit_never_makes_a_row_unavailable() {
        let words = [fresh("due", -DAY)];
        assert_eq!(
            stream(&[typed_row("typed", &["due"])], &words, 5),
            ["typed"]
        );
        let next = pick(&rows(&[typed_row("t", &["due"])]), &words, &[]).unwrap();
        assert!(next.due && ["pick-4", "pick-6", "typed"].contains(&next.shown.as_str()));
    }

    #[test]
    fn a_due_word_may_take_a_resting_row_but_never_one_this_stream_served() {
        let words = [fresh("due", -DAY)];
        let pool = rows(&[
            served(row("yesterday", &["due"]), NOW - DAY),
            served(row("two-days", &["due"]), NOW - 2.0 * DAY),
        ]);
        assert_eq!(pick(&pool, &words, &[]).unwrap().at, 1);
        assert_eq!(pick(&pool, &words, &["two-days".into()]).unwrap().at, 0);
        let all = ["two-days".into(), "yesterday".into()];
        assert!(pick(&pool, &words, &all).is_none());
        // A word not yet due waits out the gap.
        let ahead = [fresh("ahead", DAY)];
        let pool = [served(row("hot", &["ahead"]), NOW - DAY)];
        assert!(stream(&pool, &ahead, 5).is_empty());
        let pool = [served(row("rested", &["ahead"]), NOW - RESERVE_GAP)];
        assert_eq!(stream(&pool, &ahead, 5), ["rested"]);
    }

    #[test]
    fn reported_orphaned_and_retired_rows_never_play() {
        let words = [fresh("kept", -DAY)];
        let mut flagged = row("flagged", &["kept"]);
        flagged.reported = true;
        let mut spent = served(row("spent", &["kept"]), NOW - 10.0 * DAY);
        spent.times_served = crate::pool::MAX_SERVES;
        let pool = [
            flagged,
            spent,
            row("orphan", &["kept", "deleted"]),
            pooled("legacy", WireType::TranslateToTarget, &["kept"], None),
            row("fine", &["kept"]),
        ];
        assert_eq!(stream(&pool, &words, 5), ["fine"]);
        let unreadable = vec![None, Some(row("fine", &["kept"]))];
        assert_eq!(pick(&unreadable, &words, &[]).unwrap().at, 1);
    }

    /// The roll is seeded per stream position: the same seed picks the same,
    /// so peeking the head and then serving it agree.
    #[test]
    fn a_seed_replays_the_pick_and_a_peek_is_what_is_served() {
        let words = [fresh("w", -DAY)];
        let pool = rows(&[
            pooled("mc", WireType::RecognizeMc, &["w"], None),
            pooled("cloze", WireType::Cloze, &["w"], None),
            pooled("order", WireType::WordOrder, &["w"], None),
        ]);
        let r = Ratings::default();
        let serving = Serving::default();
        let judge = Judge {
            serving: &serving,
            ratings: &r,
        };
        for seed in 0..20 {
            let peek = head(
                &pool,
                &words,
                NOW,
                judge,
                &[],
                false,
                &mut Rng::seeded(seed),
            );
            let served = pick_with(&pool, &words, &r, &[], seed);
            assert_eq!(peek.unwrap().next, served);
        }
        let picks: HashSet<(usize, String)> = (0..40)
            .filter_map(|seed| pick_with(&pool, &words, &r, &[], seed))
            .map(|n| (n.at, n.shown))
            .collect();
        assert!(picks.len() > 2, "{picks:?}");
    }

    /// How often the second of two rows about one word is served.
    fn second(r: &Ratings, seeds: u64) -> usize {
        let words = [word("w", -DAY, 0.5)];
        let pool = rows(&[
            pooled("easy", WireType::RecognizeMc, &["w"], None),
            pooled("other", WireType::TranslateToNative, &["w"], None),
        ]);
        (0..seeds)
            .filter(|&seed| pick_with(&pool, &words, r, &[], seed).unwrap().at == 1)
            .count()
    }

    /// A type rated hard on many answers is almost never rolled into reach;
    /// on two it now and then is; never answered, it often is.
    #[test]
    fn a_type_rated_hard_on_many_answers_is_rarely_served_an_unsure_one_sometimes() {
        let with = |answers: usize| {
            let mut r = Ratings::default();
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

    /// The head is the most urgent word whatever is ready behind it: serving
    /// waits for it unless told no batch can help, and refill reads the same
    /// list and writes for it first.
    #[test]
    fn the_head_waits_unless_passed_and_refill_reads_the_same_list() {
        let words = [
            fresh("first", -2.0 * DAY),
            fresh("second", -DAY),
            fresh("third", DAY),
        ];
        let pool = rows(&[row("c2", &["second"]), row("c3", &["third"])]);
        assert!(pick(&pool, &words, &[]).is_none());
        let serving = Serving::default();
        let r = Ratings::default();
        let judge = Judge {
            serving: &serving,
            ratings: &r,
        };
        let passed = head(&pool, &words, NOW, judge, &[], true, &mut Rng::seeded(1)).unwrap();
        assert_eq!(passed.word, "first");
        assert_eq!(passed.instead.as_deref(), Some("second"));
        assert_eq!(passed.next.map(|n| n.at), Some(0));
        let list = upcoming(&pool, &words, NOW, &[], 3);
        let order: Vec<(&str, usize)> = list
            .iter()
            .map(|a| (a.word.id.as_str(), a.available))
            .collect();
        assert_eq!(order, [("first", 0), ("second", 1), ("third", 1)]);
        let plan = |served: &[String], limit| {
            crate::topup::plan_top_up(
                &pool,
                &words,
                NOW,
                judge,
                Scope {
                    served,
                    limit: Some(limit),
                    ..Scope::default()
                },
                &mut Rng::seeded(1),
            )
        };
        let wants = plan(&[], 1);
        assert!(wants.len() == STOCK && wants.iter().all(|w| w.item.id == "first"));
        assert_eq!(plan(&[], 3).len(), 3 * STOCK);
        assert_eq!(plan(&["c2".to_owned()], 2).len(), 2 * STOCK);
    }

    #[test]
    fn the_low_water_mark_covers_a_batch_at_the_learners_pace() {
        assert_eq!(low_water_mark(None, None), 5);
        assert_eq!(low_water_mark(Some(5_000.0), Some(60_000.0)), 14);
        assert_eq!(low_water_mark(Some(60_000.0), Some(10_000.0)), 4);
        assert_eq!(low_water_mark(Some(1_000.0), Some(120_000.0)), 20);
        assert_eq!(low_water_mark(Some(0.0), Some(f64::NAN)), 5);
    }

    #[test]
    fn early_words_pace_the_match_rounds() {
        let words = [fresh("new", -DAY), word("owned", -DAY, 0.9)];
        assert!(is_early(&["new".into()], &words));
        assert!(!is_early(&["owned".into()], &words));
        assert!(!is_early(&["gone".into()], &words));
        let early: Vec<Word> = (0..8).map(|i| fresh(&format!("k{i}"), -DAY)).collect();
        let round = match_round(&early, &mut Rng::seeded(1)).unwrap();
        assert_eq!(round.pairs.len(), crate::match_pairs::ROUND_PAIRS);
        let again = match_round(&early, &mut Rng::seeded(1)).unwrap();
        assert_eq!(round.item_ids, again.item_ids);
        let mature: Vec<Word> = (0..8).map(|i| word(&format!("k{i}"), -DAY, 0.9)).collect();
        assert!(match_round(&mature, &mut Rng::seeded(1)).is_none());
    }
}
