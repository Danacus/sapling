//! Practice is one continuous stream that runs until the learner stops
//! (`docs/challenge-difficulty.md` §11): each next challenge is picked on its
//! own, against the store as it is now, rather than from a plan made up front.
//!
//! **The next pick** is the most urgent word with a row that fits it: due words
//! first, most overdue first, then the words not yet due, soonest first. Among
//! one word's rested rows the one whose best help level sits closest to the
//! aim wins (`fits.rs`), freshness breaking a tie. A due word with nothing
//! rested may take its least-recently-served resting row — the rest gap yields
//! to spaced repetition — but never a row this stream has already served. A
//! row that fits no help level for its words is never served.
//!
//! **Refill** is the stream's to ask for: [`outlook`] counts the upcoming words
//! that have a pick ready, and the host writes a batch in the background when
//! that falls below [`low_water_mark`] — sized so a batch comes back before the
//! learner runs out, at their pace — or when a due word is **stranded**, with
//! nothing that fits it: words not yet due can keep the count above the mark
//! while the words the schedule owes have nothing at all.
//!
//! **Pacing** is a rule on the stream, not a plan: a free match round after
//! every [`MATCH_PAIRS_EVERY`] challenges about early words, never when there
//! is nothing to follow it.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::MatchPairsChallenge;
use crate::fits::{best_fit, Fit, Serving};
use crate::kinds::kind_of;
use crate::match_pairs::make_match_pairs;
use crate::pool::{is_playable, is_rested, known_ids, PoolRow, UPCOMING};
use crate::rng::Rng;
use crate::topup::{by_urgency, top_up_coverage};
use crate::word::{by_id, ById, Word};

/// A free match round comes after every this many challenges about early words.
pub const MATCH_PAIRS_EVERY: usize = 4;

/// Below this strength a word is early material, which match rounds are drawn
/// from and follow. Pacing, not difficulty: a round is a warm-up between new
/// words, and a stream of words the learner owns reads as uninterrupted work.
pub const EARLY_STRENGTH: f64 = 0.3;

/// The fewest upcoming words a refill keeps ready, and the most.
pub const LOW_WATER_BOUNDS: [usize; 2] = [4, 20];

/// What a batch takes to come back and a challenge to answer, before the
/// stream has timed either.
pub const DEFAULT_BATCH_MS: f64 = 45_000.0;
pub const DEFAULT_PACE_MS: f64 = 15_000.0;

/// The next challenge: its position in the pool, the help level it is served
/// at, the predicted chance there, and whether its word is due.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Next {
    pub at: usize,
    pub shown: String,
    pub chance: f64,
    pub due: bool,
}

/// How the stream stands for the words about to come up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Outlook {
    /// Of the next [`UPCOMING`] words in urgency order, those with a pick ready.
    pub ready: usize,
    /// How many words that is out of: [`UPCOMING`], or fewer in a small collection.
    pub upcoming: usize,
    /// Words the schedule owes now.
    pub due: usize,
    /// Due words with no pick ready: the schedule owes them and nothing in the
    /// pool fits. Counted over every due word, not only the next [`UPCOMING`].
    pub stranded: usize,
    /// What a top-up would write now (`topup.rs`): zero when refilling cannot help.
    pub wants: usize,
}

pub(crate) struct Row<'a> {
    pub at: usize,
    pub row: &'a PoolRow,
}

fn id<'a>(row: &Row<'a>) -> &'a str {
    row.row.challenge.id()
}

fn by_recency(a: &Row, b: &Row) -> std::cmp::Ordering {
    let served = |r: &Row| r.row.last_served_at.unwrap_or(0.0);
    served(a)
        .partial_cmp(&served(b))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| id(a).cmp(id(b)))
}

/// Never served first, newest generation first among those; then [`by_recency`].
fn by_freshness(a: &Row, b: &Row) -> std::cmp::Ordering {
    let (a_new, b_new) = (
        a.row.last_served_at.is_none(),
        b.row.last_served_at.is_none(),
    );
    match (a_new, b_new) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (true, true) => b
            .row
            .generated_at
            .partial_cmp(&a.row.generated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| id(a).cmp(id(b))),
        (false, false) => by_recency(a, b),
    }
}

fn bucket<'a, 'r>(rows: &'r [Row<'a>]) -> HashMap<&'a str, Vec<&'r Row<'a>>> {
    let mut buckets: HashMap<&str, Vec<&Row>> = HashMap::new();
    for row in rows {
        for item in row.row.challenge.item_ids() {
            buckets.entry(item.as_str()).or_default().push(row);
        }
    }
    buckets
}

/// Each row's best fit, worked out once per pick.
struct Judge<'a, 'w> {
    words: &'a ById<'w>,
    serving: &'a Serving,
    fits: RefCell<HashMap<usize, Option<Fit>>>,
}

impl Judge<'_, '_> {
    fn fit(&self, row: &Row) -> Option<Fit> {
        *self
            .fits
            .borrow_mut()
            .entry(row.at)
            .or_insert_with(|| best_fit(row.row, self.words, self.serving))
    }

    /// Among one word's rows that fit, the one closest to the aim; the
    /// bucket's own order breaks a tie.
    fn best<'r, 'x>(&self, bucket: Option<&Vec<&'r Row<'x>>>) -> Option<(&'r Row<'x>, Fit)> {
        let mut best: Option<(&Row, Fit)> = None;
        for row in bucket? {
            let Some(fit) = self.fit(row) else {
                continue;
            };
            let aim = self.serving.aim;
            if best.is_none_or(|(_, b)| fit.distance(aim) < b.distance(aim)) {
                best = Some((row, fit));
            }
        }
        best
    }
}

/// The pool as the stream sees it: playable rows of an active kind this
/// stream has not served yet, split into rested (freshest first) and resting
/// (longest-rested first).
struct Buckets<'a> {
    rested: Vec<Row<'a>>,
    resting: Vec<Row<'a>>,
}

fn buckets<'a>(
    pool: &'a [Option<PoolRow>],
    words: &[Word],
    now: f64,
    served: &HashSet<&str>,
) -> Buckets<'a> {
    let known = known_ids(words);
    let (mut rested, mut resting): (Vec<Row>, Vec<Row>) = pool
        .iter()
        .enumerate()
        .filter_map(|(at, row)| {
            Some(Row {
                at,
                row: row.as_ref()?,
            })
        })
        .filter(|Row { row, .. }| {
            is_playable(row, &known)
                && kind_of(&row.challenge).is_some_and(|k| k.is_active())
                && !served.contains(row.challenge.id())
        })
        .partition(|r| is_rested(r.row, now));
    rested.sort_by(by_freshness);
    resting.sort_by(by_recency);
    Buckets { rested, resting }
}

/// Walks the words in urgency order, handing each one whether it is due and
/// the pick it would get, until `visit` answers `false`.
fn walk(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    served: &[String],
    visit: &mut dyn FnMut(bool, Option<Next>) -> bool,
) {
    let served: HashSet<&str> = served.iter().map(String::as_str).collect();
    let Buckets { rested, resting } = buckets(pool, words, now, &served);
    let rested_by_item = bucket(&rested);
    let resting_by_item = bucket(&resting);
    let index = by_id(words);
    let judge = Judge {
        words: &index,
        serving,
        fits: RefCell::new(HashMap::new()),
    };
    for word in by_urgency(words, now) {
        let due = word.is_due(now);
        let mut found = judge.best(rested_by_item.get(word.id.as_str()));
        if found.is_none() && due {
            found = judge.best(resting_by_item.get(word.id.as_str()));
        }
        let next = found.map(|(row, fit)| Next {
            at: row.at,
            shown: fit.help.id(),
            chance: fit.chance,
            due,
        });
        if !visit(due, next) {
            break;
        }
    }
}

/// The next challenge, or `None` when nothing in the pool fits any word —
/// `served` being the ids this stream has already shown.
pub fn next_pick(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    served: &[String],
) -> Option<Next> {
    let mut found = None;
    walk(pool, words, now, serving, served, &mut |_, next| {
        found = next;
        found.is_none()
    });
    found
}

/// How many of the upcoming words have a pick ready, and whether a top-up
/// has anything to write.
pub fn outlook(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    served: &[String],
) -> Outlook {
    let mut ready = 0;
    let mut upcoming = 0;
    let mut stranded = 0;
    // Due words come first in the walk, so it runs past the next `UPCOMING`
    // only while there are due words left to count.
    let mut walked = 0;
    walk(pool, words, now, serving, served, &mut |due, next| {
        walked += 1;
        if walked <= UPCOMING {
            upcoming += 1;
            if next.is_some() {
                ready += 1;
            }
        }
        if due && next.is_none() {
            stranded += 1;
        }
        walked < UPCOMING || due
    });
    let readable: Vec<&PoolRow> = pool.iter().flatten().collect();
    let coverage = top_up_coverage(&readable, words, now, serving);
    Outlook {
        ready,
        upcoming,
        due: words.iter().filter(|w| w.is_due(now)).count(),
        stranded,
        wants: coverage.wants,
    }
}

/// The ready words below which the stream asks for a batch: enough to keep
/// answering while one comes back — the batch's time over the learner's pace,
/// plus two for slack — within [`LOW_WATER_BOUNDS`].
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
mod tests {
    use super::*;
    use crate::challenge::Challenge;
    use crate::kinds::WireType;
    use crate::pool::RESERVE_GAP;
    use crate::topup::tests::{pooled, word, DAY, NOW};
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

    fn rows(pool: &[PoolRow]) -> Vec<Option<PoolRow>> {
        pool.iter().cloned().map(Some).collect()
    }

    /// The ids the stream serves, one pick at a time, as if each were
    /// answered straight away and nothing else changed.
    fn stream(pool: &[PoolRow], words: &[Word], limit: usize) -> Vec<String> {
        let rows = rows(pool);
        let mut shown: Vec<String> = Vec::new();
        while shown.len() < limit {
            let Some(next) = next_pick(&rows, words, NOW, &Serving::default(), &shown) else {
                break;
            };
            shown.push(pool[next.at].challenge.id().to_owned());
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
        let long = "perdona me podrías decir dónde está la estación de tren más cercana";
        let pool = [
            generated(row("short", &["due"]), NOW),
            generated(with_prompt(row("long", &["due"]), long), NOW - 5.0 * DAY),
        ];
        assert_eq!(stream(&pool, &words, 2), ["long", "short"]);
        let pool = [
            generated(row("older", &["due"]), NOW - 5.0 * DAY),
            generated(row("newer", &["due"]), NOW),
        ];
        assert_eq!(stream(&pool, &words, 2), ["newer", "older"]);
    }

    #[test]
    fn nothing_that_does_not_fit_is_served_and_the_stream_then_ends() {
        let words = [fresh("due", -DAY)];
        assert!(stream(&[typed_row("typed", &["due"])], &words, 5).is_empty());
        let owned = [skilled("due", -DAY, 5.0)];
        let pool = [row("choice", &["due"]), typed_row("typed", &["due"])];
        assert_eq!(stream(&pool, &owned, 5), ["typed"]);
        let next = next_pick(&rows(&pool), &owned, NOW, &Serving::default(), &[]).unwrap();
        assert_eq!((next.shown.as_str(), next.due), ("typed", true));
    }

    #[test]
    fn a_due_word_spends_the_rest_gap_once_but_never_on_a_row_this_stream_served() {
        let words = [fresh("due", -DAY)];
        let pool = [
            served(row("yesterday", &["due"]), NOW - DAY),
            served(row("two-days", &["due"]), NOW - 2.0 * DAY),
        ];
        assert_eq!(stream(&pool, &words, 5), ["two-days", "yesterday"]);
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
            row("orphan", &["deleted"]),
            pooled("legacy", WireType::TranslateToTarget, &["kept"], None),
            row("fine", &["kept"]),
        ];
        assert_eq!(stream(&pool, &words, 5), ["fine"]);
        let unreadable = vec![None, Some(row("fine", &["kept"]))];
        let next = next_pick(&unreadable, &words, NOW, &Serving::default(), &[]).unwrap();
        assert_eq!(next.at, 1);
    }

    /// Words ahead of schedule with rows of their own keep `ready` above any
    /// mark; the due words with nothing are what says a batch is owed.
    #[test]
    fn a_due_word_with_nothing_is_stranded_whatever_is_ready_ahead() {
        let mut words: Vec<Word> = (0..5)
            .map(|i| fresh(&format!("d{i}"), -f64::from(i + 1) * DAY))
            .collect();
        words.extend((0..15).map(|i| fresh(&format!("a{i}"), f64::from(i + 1) * DAY)));
        let pool: Vec<PoolRow> = (0..15)
            .map(|i| row(&format!("c{i}"), &[&format!("a{i}")]))
            .collect();
        let seen = outlook(&rows(&pool), &words, NOW, &Serving::default(), &[]);
        assert_eq!((seen.ready, seen.due, seen.stranded), (15, 5, 5));
        // Past the next `UPCOMING` words, a due one still counts.
        let many: Vec<Word> = (0..30)
            .map(|i| fresh(&format!("m{i}"), -f64::from(i + 1) * DAY))
            .collect();
        let seen = outlook(&[], &many, NOW, &Serving::default(), &[]);
        assert_eq!((seen.upcoming, seen.stranded), (UPCOMING, 30));
    }

    #[test]
    fn the_outlook_counts_the_upcoming_words_with_a_pick_ready() {
        let words: Vec<Word> = (0..5)
            .map(|i| fresh(&format!("w{i}"), -f64::from(i + 1) * DAY))
            .collect();
        let pool = [row("c0", &["w0"]), row("c1", &["w1"]), row("c2", &["w2"])];
        let seen = outlook(&rows(&pool), &words, NOW, &Serving::default(), &[]);
        assert_eq!(
            seen,
            Outlook {
                ready: 3,
                upcoming: 5,
                due: 5,
                stranded: 2,
                wants: 4
            }
        );
        let after = outlook(
            &rows(&pool),
            &words,
            NOW,
            &Serving::default(),
            &["c0".into()],
        );
        assert_eq!(after.ready, 2);
        let many: Vec<Word> = (0..30)
            .map(|i| fresh(&format!("m{i}"), f64::from(i) * DAY))
            .collect();
        assert_eq!(
            outlook(&[], &many, NOW, &Serving::default(), &[]).upcoming,
            UPCOMING
        );
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
