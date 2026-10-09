//! Practice is one continuous stream that runs until the learner stops
//! (`docs/challenge-difficulty.md` §11), each challenge picked against the
//! store as it is now.
//!
//! **One list, one predicate.** [`upcoming`] is the next words in urgency
//! order — due first, most overdue first, then the rest soonest first — each
//! with the row it would be served, if any is [`available`]. Serving takes the
//! head: a head with nothing waits for a refill while one is running or can be
//! started for it, and only when none can help is it passed for the first word
//! further down the same list that has something ([`head`]'s `pass`). Refill
//! writes for exactly the words in the first [`low_water_mark`] of the same
//! list that have nothing (`topup.rs`), so the two can never disagree.
//!
//! **Pacing** is a rule on the stream, not a plan: a free match round after
//! every [`MATCH_PAIRS_EVERY`] challenges about early words, never when there
//! is nothing to follow it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::MatchPairsChallenge;
use crate::fits::{best_fit, Fit, Serving};
use crate::kinds::kind_of;
use crate::match_pairs::make_match_pairs;
use crate::pool::{is_playable, is_rested, known_ids, PoolRow};
use crate::rng::Rng;
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
/// at, the chance there given the word is remembered, and whether its word is due.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Next {
    pub at: usize,
    pub shown: String,
    pub chance: f64,
    pub due: bool,
}

/// One word of the list and the row it would be served now, if any.
pub struct Ahead<'w> {
    pub word: &'w Word,
    pub next: Option<Next>,
}

/// Soonest due first, id breaking the tie so the order ignores store order.
fn by_urgency(words: &[Word], now: f64) -> Vec<&Word> {
    let mut sorted: Vec<&Word> = words.iter().filter(|w| w.is_writable()).collect();
    sorted.sort_by(|a, b| {
        a.due_at(now)
            .total_cmp(&b.due_at(now))
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted
}

/// What [`available`] reads besides the row.
struct Context<'a> {
    now: f64,
    known: HashSet<&'a str>,
    served: HashSet<&'a str>,
    words: ById<'a>,
    serving: &'a Serving,
}

/// The one predicate: a row may be served to a word now when it is playable,
/// of an active kind, not yet served this stream, rested — or merely resting,
/// when the word is due — and fits. Answers the fit.
fn available(row: &PoolRow, due: bool, cx: &Context) -> Option<Fit> {
    let ok = is_playable(row, &cx.known)
        && kind_of(&row.challenge).is_some_and(|k| k.is_active())
        && !cx.served.contains(row.challenge.id())
        && (due || is_rested(row, cx.now));
    ok.then(|| best_fit(row, &cx.words, cx.serving)).flatten()
}

/// Rested before resting, then closest to the aim, then never served (newest
/// first) before served (longest ago first), id last.
fn better(a: (&PoolRow, Fit), b: (&PoolRow, Fit), cx: &Context) -> bool {
    let key = |(row, fit): (&PoolRow, Fit)| {
        let (served, when) = match row.last_served_at {
            None => (false, -row.generated_at),
            Some(at) => (true, at),
        };
        (
            !is_rested(row, cx.now),
            fit.distance(cx.serving.aim),
            served,
            when,
        )
    };
    let (ka, kb) = (key(a), key(b));
    ka.0.cmp(&kb.0)
        .then(ka.1.total_cmp(&kb.1))
        .then(ka.2.cmp(&kb.2))
        .then(ka.3.total_cmp(&kb.3))
        .then_with(|| a.0.challenge.id().cmp(b.0.challenge.id()))
        .is_lt()
}

/// The list, walked lazily: every word in urgency order, and for any of them
/// the row it would be served now. [`upcoming`] takes the first `n`; [`head`]
/// stops at the first word with something when it may pass the head.
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
    fn new(
        pool: &'a [Option<PoolRow>],
        words: &'w [Word],
        now: f64,
        serving: &'a Serving,
        served: &'a [String],
    ) -> Self {
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
                serving,
            },
            about,
            pool,
            order: by_urgency(words, now),
        }
    }

    /// The row `word` would be served now, if any is available.
    fn ahead(&self, word: &'w Word) -> Ahead<'w> {
        let cx = &self.cx;
        let due = word.is_due(cx.now);
        let mut best: Option<(usize, &PoolRow, Fit)> = None;
        for &at in self.about.get(word.id.as_str()).into_iter().flatten() {
            let Some(row) = self.pool[at].as_ref() else {
                continue;
            };
            let Some(fit) = available(row, due, cx) else {
                continue;
            };
            if best.is_none_or(|(_, r, f)| better((row, fit), (r, f), cx)) {
                best = Some((at, row, fit));
            }
        }
        Ahead {
            word,
            next: best.map(|(at, _, fit)| Next {
                at,
                shown: fit.help.id(),
                chance: fit.chance,
                due,
            }),
        }
    }
}

/// The next `n` words in urgency order, each with the row it would be served.
pub fn upcoming<'w>(
    pool: &[Option<PoolRow>],
    words: &'w [Word],
    now: f64,
    serving: &Serving,
    served: &[String],
    n: usize,
) -> Vec<Ahead<'w>> {
    let walk = Walk::new(pool, words, now, serving, served);
    walk.order
        .iter()
        .take(n)
        .map(|word| walk.ahead(word))
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

/// `served` being the ids this stream has already shown. With `pass`, a head
/// with nothing is passed for the first word further down the same list that
/// has an available row — what the stream does only when no batch can help
/// the head (`session.md`); without it, the head waits.
pub fn head(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    served: &[String],
    pass: bool,
) -> Option<Head> {
    let walk = Walk::new(pool, words, now, serving, served);
    let first = walk.ahead(walk.order.first()?);
    let word = first.word.id.clone();
    if first.next.is_some() || !pass {
        return Some(Head {
            word,
            next: first.next,
            instead: None,
        });
    }
    let further = walk.order[1..]
        .iter()
        .map(|w| walk.ahead(w))
        .find(|a| a.next.is_some());
    Some(Head {
        word,
        next: further.as_ref().and_then(|a| a.next.clone()),
        instead: further.map(|a| a.word.id.clone()),
    })
}

/// The head's challenge, or `None` while the head has nothing.
pub fn next_pick(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    served: &[String],
) -> Option<Next> {
    head(pool, words, now, serving, served, false)?.next
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
    use crate::challenge::Challenge;
    use crate::kinds::WireType;
    use crate::pool::RESERVE_GAP;
    use crate::topup::tests::{pooled, word, DAY, NOW};
    use crate::topup::Scope;
    use serde_json::json;

    fn fresh(id: &str, offset: f64) -> Word {
        word(id, offset, 0.0)
    }
    fn skilled(id: &str, offset: f64, skill: f64) -> Word {
        let mut w = word(id, offset, 0.5);
        w.skill = Some(skill);
        w
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
    fn with_prompt(mut row: PoolRow, prompt: &str) -> PoolRow {
        match &mut row.challenge {
            Challenge::MultipleChoice(c) => c.prompt = prompt.into(),
            _ => unreachable!(),
        }
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
            correction: None,
        }
    }

    pub(crate) fn rows(pool: &[PoolRow]) -> Vec<Option<PoolRow>> {
        pool.iter().cloned().map(Some).collect()
    }

    /// The ids the stream serves, one pick at a time, as if each were
    /// answered straight away and its words reviewed far ahead.
    fn stream(pool: &[PoolRow], words: &[Word], limit: usize) -> Vec<String> {
        let rows = rows(pool);
        let mut words = words.to_vec();
        let mut shown: Vec<String> = Vec::new();
        while shown.len() < limit {
            let Some(next) = next_pick(&rows, &words, NOW, &Serving::default(), &shown) else {
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
    fn a_word_is_picked_the_row_closest_to_the_aim_and_freshness_breaks_a_tie() {
        let words = [skilled("due", -DAY, 2.4)];
        let pool = [
            generated(row("short", &["due"]), NOW),
            generated(
                with_prompt(row("closer", &["due"]), "dónde está la"),
                NOW - 5.0 * DAY,
            ),
        ];
        assert_eq!(stream(&pool, &words, 2), ["closer", "short"]);
        let pool = [
            generated(row("older", &["due"]), NOW - 5.0 * DAY),
            generated(row("newer", &["due"]), NOW),
        ];
        assert_eq!(stream(&pool, &words, 2), ["newer", "older"]);
    }

    #[test]
    fn nothing_that_does_not_fit_is_served() {
        let words = [fresh("due", -DAY)];
        assert!(stream(&[typed_row("typed", &["due"])], &words, 5).is_empty());
        let owned = [skilled("due", -DAY, 5.0)];
        let pool = [row("choice", &["due"]), typed_row("typed", &["due"])];
        assert_eq!(stream(&pool, &owned, 5), ["typed"]);
        let next = next_pick(&rows(&pool), &owned, NOW, &Serving::default(), &[]).unwrap();
        assert_eq!((next.shown.as_str(), next.due), ("typed", true));
    }

    #[test]
    fn a_due_word_may_take_a_resting_row_but_never_one_this_stream_served() {
        let words = [fresh("due", -DAY)];
        let pool = rows(&[
            served(row("yesterday", &["due"]), NOW - DAY),
            served(row("two-days", &["due"]), NOW - 2.0 * DAY),
        ]);
        let serving = Serving::default();
        let first = next_pick(&pool, &words, NOW, &serving, &[]).unwrap();
        assert_eq!(first.at, 1);
        let second = next_pick(&pool, &words, NOW, &serving, &["two-days".into()]).unwrap();
        assert_eq!(second.at, 0);
        let all = ["two-days".into(), "yesterday".into()];
        assert!(next_pick(&pool, &words, NOW, &serving, &all).is_none());
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
        let pool = [
            flagged,
            row("orphan", &["kept", "deleted"]),
            pooled("legacy", WireType::TranslateToTarget, &["kept"], None),
            row("fine", &["kept"]),
        ];
        assert_eq!(stream(&pool, &words, 5), ["fine"]);
        let unreadable = vec![None, Some(row("fine", &["kept"]))];
        let next = next_pick(&unreadable, &words, NOW, &Serving::default(), &[]).unwrap();
        assert_eq!(next.at, 1);
    }

    /// The head is the most urgent word whatever is ready behind it: serving
    /// waits for it unless told no batch can help, and refill reads the same
    /// list and writes for it.
    #[test]
    fn the_head_waits_unless_passed_and_refill_reads_the_same_list() {
        let words = [
            fresh("first", -2.0 * DAY),
            fresh("second", -DAY),
            fresh("third", DAY),
        ];
        let pool = rows(&[row("c2", &["second"]), row("c3", &["third"])]);
        let serving = Serving::default();
        assert!(next_pick(&pool, &words, NOW, &serving, &[]).is_none());
        let passed = head(&pool, &words, NOW, &serving, &[], true).unwrap();
        assert_eq!(passed.word, "first");
        assert_eq!(passed.instead.as_deref(), Some("second"));
        assert_eq!(passed.next.map(|n| n.at), Some(0));
        let list = upcoming(&pool, &words, NOW, &serving, &[], 3);
        let order: Vec<(&str, bool)> = list
            .iter()
            .map(|a| (a.word.id.as_str(), a.next.is_some()))
            .collect();
        assert_eq!(order, [("first", false), ("second", true), ("third", true)]);
        let wants = crate::topup::plan_top_up(
            &pool,
            &words,
            NOW,
            &serving,
            Scope {
                limit: Some(3),
                ..Scope::default()
            },
            &mut || 0.0,
        );
        assert!(wants.len() == 2 && wants.iter().all(|w| w.item.id == "first"));
        // Served this stream, a row covers nothing for refill either.
        let served = ["c2".to_owned()];
        let wants = crate::topup::plan_top_up(
            &pool,
            &words,
            NOW,
            &serving,
            Scope {
                served: &served,
                limit: Some(2),
                ..Scope::default()
            },
            &mut || 0.0,
        );
        assert_eq!(wants.len(), 4);
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
