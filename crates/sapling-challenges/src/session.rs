//! Which pooled challenges a session plays, in order, and where its free match
//! rounds go.
//!
//! **Due beats fresh.** The walk is item-first: every word the schedule owes,
//! most overdue first, claims the best challenge covering it, then a second
//! pass gives each a second angle; the same two passes then run over the words
//! not yet due, and the leftovers fill what is left — rested material first,
//! resting material last. A due word with nothing rested may take its
//! least-recently-served resting row on its first pass; nothing else bends the
//! rest gap. A plan is empty only when nothing is both playable and bearable.
//!
//! Two gates are absolute: a row must be playable, of an active kind every one
//! of its words' rungs still takes, and **bearable** by its weakest word. Among
//! one word's bearable rows the **fit** decides — the row whose difficulty sits
//! nearest the centre of that word's band — and freshness breaks a tie. Fit is
//! a distance to one word's target, so it orders one word's bucket and never the
//! fillers, which keep their freshness and recency order.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::{Challenge, MatchPairsChallenge};
use crate::difficulty::difficulty_of;
use crate::kinds::kind_of;
use crate::ladder::{bearable, by_id, level_band_centre, served_demand, weakest_level, ById, Word};
use crate::match_pairs::make_match_pairs;
use crate::pool::{is_playable, is_rested, known_ids, PoolRow, SESSION_LENGTH};
use crate::rng::Rng;
use crate::text::WordCount;
use crate::topup::by_urgency;

/// Challenges a session aims for.
pub const BATCH_TARGET: usize = 14;

/// A free match round goes in after every this many early-material challenges.
pub const MATCH_PAIRS_EVERY: usize = 4;

/// One place in a session's queue: a planned challenge by its position in the
/// plan, or a match round built for that place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum Slot {
    Planned(usize),
    Round(MatchPairsChallenge),
}

struct Row<'a> {
    at: usize,
    row: &'a PoolRow,
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

/// Per-row answers the walks ask repeatedly, computed once per plan.
struct Judge<'a, 'w> {
    words: &'a ById<'w>,
    count: WordCount<'a>,
    bearable: RefCell<HashMap<usize, bool>>,
    fit: RefCell<HashMap<usize, f64>>,
}

impl Judge<'_, '_> {
    fn bearable(&self, row: &Row) -> bool {
        *self
            .bearable
            .borrow_mut()
            .entry(row.at)
            .or_insert_with(|| bearable(&row.row.challenge, self.words))
    }

    /// How far the row's difficulty sits from the centre of its weakest word's band.
    fn fit(&self, row: &Row) -> f64 {
        *self.fit.borrow_mut().entry(row.at).or_insert_with(|| {
            let challenge = &row.row.challenge;
            let target = level_band_centre(weakest_level(challenge, self.words));
            (difficulty_of(challenge, self.count) - target).abs()
        })
    }

    /// Among the unclaimed bearable rows of one word's bucket, the nearest fit;
    /// the bucket's own order breaks a tie. Never an unbearable fallback.
    fn first_free<'r, 'a>(
        &self,
        bucket: Option<&Vec<&'r Row<'a>>>,
        taken: &HashSet<usize>,
    ) -> Option<&'r Row<'a>> {
        let mut best: Option<(&Row, f64)> = None;
        for row in bucket? {
            if taken.contains(&row.at) || !self.bearable(row) {
                continue;
            }
            let fit = self.fit(row);
            if best.is_none_or(|(_, rank)| fit < rank) {
                best = Some((row, fit));
            }
        }
        best.map(|(row, _)| row)
    }
}

/// The session: positions into `pool`, in play order.
pub fn plan_session(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    target: Option<i64>,
    limit: Option<i64>,
    count: WordCount,
) -> Vec<usize> {
    let limit = limit.unwrap_or(SESSION_LENGTH as i64).max(0);
    let target = target.unwrap_or(BATCH_TARGET as i64).max(0).min(limit) as usize;
    if target == 0 {
        return Vec::new();
    }

    let known = known_ids(words);
    let index = by_id(words);
    let playable: Vec<Row> = pool
        .iter()
        .enumerate()
        .filter_map(|(at, row)| {
            Some(Row {
                at,
                row: row.as_ref()?,
            })
        })
        .filter(|Row { row, .. }| {
            if !is_playable(row, &known) {
                return false;
            }
            let Some(kind) = kind_of(&row.challenge).filter(|k| k.is_active()) else {
                return false;
            };
            row.challenge.item_ids().iter().all(|item| {
                index
                    .get(item.as_str())
                    .is_some_and(|word| kind.available_at(word.level()))
            })
        })
        .collect();
    let (mut rested, mut resting): (Vec<Row>, Vec<Row>) =
        playable.into_iter().partition(|r| is_rested(r.row, now));
    rested.sort_by(by_freshness);
    resting.sort_by(by_recency);
    let rested_by_item = bucket(&rested);
    let resting_by_item = bucket(&resting);
    let judge = Judge {
        words: &index,
        count,
        bearable: RefCell::new(HashMap::new()),
        fit: RefCell::new(HashMap::new()),
    };

    let walk = by_urgency(words, now);
    let (owed, ahead): (Vec<&Word>, Vec<&Word>) = walk.into_iter().partition(|w| w.is_due(now));
    let mut chosen: Vec<&Row> = Vec::new();
    let mut taken: HashSet<usize> = HashSet::new();

    // Two passes over each queue, one angle apiece then a second; only a due
    // word may take its longest-resting row, and only on its first pass.
    for (queue, spend_gap) in [(&owed, true), (&ahead, false)] {
        for pass in 0..2 {
            for word in queue.iter() {
                if chosen.len() >= target {
                    break;
                }
                let mut next = judge.first_free(rested_by_item.get(word.id.as_str()), &taken);
                if next.is_none() && spend_gap && pass == 0 {
                    next = judge.first_free(resting_by_item.get(word.id.as_str()), &taken);
                }
                if let Some(row) = next {
                    taken.insert(row.at);
                    chosen.push(row);
                }
            }
        }
    }

    let fillers = rested
        .iter()
        .filter(|r| judge.bearable(r))
        .chain(resting.iter().filter(|r| judge.bearable(r)));
    for row in fillers {
        if chosen.len() >= target {
            break;
        }
        if taken.insert(row.at) {
            chosen.push(row);
        }
    }

    let challenges: Vec<&Challenge> = chosen.iter().map(|r| &r.row.challenge).collect();
    smooth_demand(&challenges, &index)
        .into_iter()
        .map(|i| chosen[i].at)
        .collect()
}

/// One local repair over a finished plan: wherever the served demand jumps by
/// two, the nearest later challenge at the missing middle tier is pulled
/// forward between them. Not a sort — due-first order is load-bearing — so
/// nothing else moves. Answers the new order as positions into `challenges`.
pub fn smooth_demand(challenges: &[&Challenge], words: &ById) -> Vec<usize> {
    let demand: Vec<u8> = challenges.iter().map(|c| served_demand(c, words)).collect();
    let mut order: Vec<usize> = (0..challenges.len()).collect();
    for i in 1..order.len() {
        let (prev, curr) = (demand[order[i - 1]], demand[order[i]]);
        if curr != prev + 2 {
            continue;
        }
        if let Some(found) = (i + 1..order.len()).find(|&j| demand[order[j]] == prev + 1) {
            let pulled = order.remove(found);
            order.insert(i, pulled);
        }
    }
    order
}

/// The rung a round over these words is sized at: the lower median of the
/// rungs of the words a round could be drawn from.
fn median_round_rung(words: &[&Word]) -> u8 {
    let mut rungs: Vec<u8> = words
        .iter()
        .filter(|w| w.is_writable())
        .map(|w| w.level())
        .collect();
    rungs.sort_unstable();
    rungs
        .get(rungs.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(1)
}

/// The queue the learn screen walks: the plan, with a free round after every
/// [`MATCH_PAIRS_EVERY`]th challenge that touches an early word (rung 2 or
/// below), drawn from those words only and never last.
pub fn interleave_match_rounds(plan: &[Vec<String>], words: &[Word], rng: &mut Rng) -> Vec<Slot> {
    let early: Vec<Word> = words.iter().filter(|w| w.level() <= 2).cloned().collect();
    let early_ids: HashSet<&str> = early.iter().map(|w| w.id.as_str()).collect();
    let rung = median_round_rung(&early.iter().collect::<Vec<_>>());
    let mut queue = Vec::new();
    let mut touched = 0;
    for (index, item_ids) in plan.iter().enumerate() {
        queue.push(Slot::Planned(index));
        let is_early = item_ids.iter().any(|id| early_ids.contains(id.as_str()));
        if is_early {
            touched += 1;
        }
        if !is_early || touched % MATCH_PAIRS_EVERY != 0 || index == plan.len() - 1 {
            continue;
        }
        let id = rng.uuid();
        if let Some(round) = make_match_pairs(&early, &mut || rng.next_f64(), Some(rung), id) {
            queue.push(Slot::Round(round));
        }
    }
    queue
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kinds::WireType;
    use crate::pool::RESERVE_GAP;
    use crate::text::fallback_word_count;
    use crate::topup::tests::{pooled, word, DAY, NOW};
    use serde_json::json;

    fn fresh(id: &str, offset: f64) -> Word {
        word(id, offset, 0.0)
    }
    fn strong(id: &str, offset: f64) -> Word {
        word(id, offset, 0.9)
    }

    /// A recognize-mc row: any word can bear it.
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
    fn resting(id: &str, item_ids: &[&str], ago: f64) -> PoolRow {
        served(row(id, item_ids), NOW - ago)
    }
    fn with_prompt(mut row: PoolRow, prompt: &str) -> PoolRow {
        match &mut row.challenge {
            Challenge::MultipleChoice(c) => c.prompt = prompt.into(),
            Challenge::TypedTranslation(c) => c.prompt = prompt.into(),
            _ => unreachable!(),
        }
        row
    }
    /// An active cloze whose served demand is free production at the top rung,
    /// and which a fresh word cannot bear at any rung.
    fn cloze_row(id: &str, item_ids: &[&str], bank: bool) -> PoolRow {
        let mut row = json!({ "id": id, "type": "cloze", "direction": "toTarget", "sentence": "Yo ___ ayer.",
            "acceptedAnswers": ["corrí"], "itemIds": item_ids });
        if bank {
            row["wordBank"] = json!(["corrí", "fui", "comí"]);
        }
        PoolRow {
            challenge: Challenge::from_value(row).unwrap(),
            generated_at: NOW - DAY,
            times_served: 0.0,
            last_served_at: None,
            reported: false,
            topic: None,
        }
    }

    fn plan(pool: &[PoolRow], words: &[Word], target: Option<i64>) -> Vec<String> {
        plan_limited(pool, words, target, None)
    }
    fn plan_limited(
        pool: &[PoolRow],
        words: &[Word],
        target: Option<i64>,
        limit: Option<i64>,
    ) -> Vec<String> {
        let rows: Vec<Option<PoolRow>> = pool.iter().cloned().map(Some).collect();
        plan_session(&rows, words, NOW, target, limit, &fallback_word_count)
            .into_iter()
            .map(|at| pool[at].challenge.id().to_owned())
            .collect()
    }

    #[test]
    fn a_retired_or_above_level_row_is_not_served() {
        let words = [fresh("due", -DAY)];
        let legacy = pooled("legacy", WireType::TranslateToTarget, &["due"], None);
        assert_eq!(
            plan(&[legacy, row("active", &["due"])], &words, Some(2)),
            ["active"]
        );
        let tiles = pooled("word-order", WireType::WordOrder, &["due"], None);
        assert!(plan(&[tiles], &words, Some(1)).is_empty());
    }

    #[test]
    fn a_due_word_comes_before_fresher_material_for_one_that_is_not() {
        let words = [fresh("due", -5.0 * DAY), fresh("fine", 5.0 * DAY)];
        let pool = [
            generated(row("fresh", &["fine"]), NOW),
            generated(row("old-but-due", &["due"]), NOW - 30.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(1)), ["old-but-due"]);
    }

    #[test]
    fn due_words_go_most_overdue_first() {
        let words = [
            fresh("a", -DAY),
            fresh("b", -10.0 * DAY),
            fresh("c", -3.0 * DAY),
        ];
        let pool = [row("ca", &["a"]), row("cb", &["b"]), row("cc", &["c"])];
        assert_eq!(plan(&pool, &words, Some(3)), ["cb", "cc", "ca"]);
    }

    #[test]
    fn within_a_word_unseen_beats_served_newest_beats_older_and_stale_recycles_first() {
        let words = [fresh("due", -DAY)];
        let pool = [
            served(row("served", &["due"]), NOW - 10.0 * DAY),
            row("unseen", &["due"]),
        ];
        assert_eq!(plan(&pool, &words, Some(1)), ["unseen"]);
        let pool = [
            generated(row("older", &["due"]), NOW - 2.0 * DAY),
            generated(row("newest", &["due"]), NOW),
        ];
        assert_eq!(plan(&pool, &words, Some(1)), ["newest"]);
        let pool = [
            served(row("recent", &["due"]), NOW - 4.0 * DAY),
            served(row("stale", &["due"]), NOW - 30.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["stale", "recent"]);
        let pool = [
            served(row("hot", &["due"]), NOW - RESERVE_GAP + 1.0),
            served(row("rested", &["due"]), NOW - RESERVE_GAP),
        ];
        assert_eq!(plan(&pool, &words, None), ["rested", "hot"]);
    }

    #[test]
    fn the_rest_gap_yields_once_to_each_due_word() {
        let words = [fresh("due", -DAY)];
        assert_eq!(
            plan(&[resting("hot", &["due"], DAY)], &words, None),
            ["hot"]
        );
        let pool = [
            resting("yesterday", &["due"], DAY),
            resting("two-days", &["due"], 2.0 * DAY),
            resting("an-hour", &["due"], 3_600_000.0),
        ];
        assert_eq!(plan(&pool, &words, Some(1)), ["two-days"]);

        let two = [fresh("a", -2.0 * DAY), fresh("b", -DAY)];
        let pool = [
            resting("a1", &["a"], 2.0 * DAY),
            resting("a2", &["a"], DAY),
            resting("b1", &["b"], DAY),
        ];
        assert_eq!(plan(&pool, &two, Some(4)), ["a1", "b1", "a2"]);

        let mixed = [fresh("due", -DAY), fresh("later", 5.0 * DAY)];
        let pool = [
            row("due-rested", &["due"]),
            resting("later-hot", &["later"], DAY),
            resting("due-hot", &["due"], DAY),
        ];
        assert_eq!(
            plan(&pool, &mixed, Some(4)),
            ["due-rested", "due-hot", "later-hot"]
        );
    }

    #[test]
    fn reported_orphaned_and_itemless_rows_never_play() {
        let words = [fresh("due", -DAY)];
        let mut flagged = resting("flagged", &["due"], DAY);
        flagged.reported = true;
        let pool = [
            flagged,
            resting("orphan", &["due", "deleted"], DAY),
            resting("itemless", &[], DAY),
        ];
        assert!(plan(&pool, &words, None).is_empty());

        let kept = [fresh("kept", -DAY)];
        let pool = [
            row("orphan", &["deleted"]),
            row("half-orphan", &["kept", "deleted"]),
            row("nothing", &[]),
            row("fine", &["kept"]),
        ];
        assert_eq!(plan(&pool, &kept, None), ["fine"]);
    }

    #[test]
    fn a_word_gets_what_it_can_bear_and_nothing_above_it() {
        let words = [fresh("due", -DAY)];
        let pool = [
            generated(cloze_row("typed", &["due"], false), NOW),
            generated(row("choice", &["due"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(1)), ["choice"]);
        assert_eq!(plan(&pool, &words, Some(2)), ["choice"]);
        assert!(plan(&[cloze_row("typed", &["due"], false)], &words, Some(2)).is_empty());

        let pool = [
            cloze_row("typed-rested", &["due"], false),
            served(row("choice-hot", &["due"]), NOW - DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["choice-hot"]);
        assert_eq!(plan(&pool, &words, Some(1)), ["choice-hot"]);

        let later = [fresh("later", 5.0 * DAY)];
        let pool = [
            generated(cloze_row("typed", &["later"], false), NOW),
            generated(row("choice", &["later"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &later, Some(2)), ["choice"]);
        let a = [fresh("a", DAY)];
        let pool = [
            generated(cloze_row("typed", &["a"], false), NOW),
            generated(row("choice", &["a"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &a, Some(2)), ["choice"]);
        assert_eq!(plan(&pool, &[strong("a", DAY)], Some(2)), ["typed"]);
    }

    #[test]
    fn the_closer_fit_beats_the_fresher_row_and_freshness_breaks_a_tie() {
        let words = [word("due", -DAY, 0.2)];
        let pool = [
            generated(row("choice", &["due"]), NOW),
            generated(cloze_row("typed", &["due"], true), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["typed", "choice"]);
        let pool = [
            generated(row("newer", &["due"]), NOW),
            generated(row("older", &["due"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["newer", "older"]);
    }

    #[test]
    fn fit_aims_at_the_middle_of_the_band_not_at_raw_strength() {
        let words = [word("mid", -DAY, 0.1)];
        let long = "perdona, ¿me podrías decir dónde está la estación de tren más cercana?";
        let pool = [
            generated(with_prompt(row("long", &["mid"]), long), NOW),
            generated(
                with_prompt(row("short", &["mid"]), "el perro"),
                NOW - 5.0 * DAY,
            ),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["short", "long"]);
    }

    #[test]
    fn a_due_word_gets_its_second_angle_before_filler() {
        let words = [fresh("due", -DAY), fresh("later", DAY)];
        let pool = [
            generated(row("due-1", &["due"]), NOW - 2.0 * DAY),
            generated(row("due-2", &["due"]), NOW - 3.0 * DAY),
            generated(row("filler", &["later"]), NOW),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["due-1", "due-2"]);
    }

    #[test]
    fn leftovers_are_filled_newest_first_then_recyclables() {
        let words = [fresh("due", -DAY), fresh("later", DAY)];
        let pool = [
            row("due-1", &["due"]),
            generated(row("fill-old", &["later"]), NOW - 5.0 * DAY),
            generated(row("fill-new", &["later"]), NOW),
            generated(row("fill-older", &["later"]), NOW - 9.0 * DAY),
            served(row("fill-served", &["later"]), NOW - 10.0 * DAY),
        ];
        assert_eq!(
            plan(&pool, &words, Some(5)),
            ["due-1", "fill-new", "fill-old", "fill-older", "fill-served"]
        );
    }

    #[test]
    fn the_filler_is_ordered_by_freshness_never_by_fit() {
        let words = [strong("strong", DAY), fresh("weak", 2.0 * DAY)];
        // `stale` is the better fit for its word and `fresh` the worse for
        // its; freshness decides between them, and only freshness.
        let strong_row = |id: &str| cloze_row(id, &["strong"], false);
        let weak_row = |id: &str| with_prompt(row(id, &["weak"]), "the bill");
        let pool = [
            generated(strong_row("s1"), NOW),
            generated(strong_row("s2"), NOW - DAY),
            generated(weak_row("w1"), NOW),
            generated(weak_row("w2"), NOW - DAY),
            generated(weak_row("fresh"), NOW - 2.0 * DAY),
            served(strong_row("stale"), NOW - 14.0 * DAY),
        ];
        assert_eq!(
            plan(&pool, &words, Some(6)),
            ["s1", "w1", "s2", "w2", "fresh", "stale"]
        );
    }

    #[test]
    fn a_row_is_planned_once_and_the_plan_respects_its_target_and_cap() {
        let words = [fresh("a", -2.0 * DAY), fresh("b", -DAY)];
        assert_eq!(
            plan(
                &[row("both", &["a", "b"]), row("just-b", &["b"])],
                &words,
                Some(4)
            ),
            ["both", "just-b"]
        );

        let due = [fresh("due", -DAY)];
        let pool: Vec<PoolRow> = (0..40)
            .map(|i| generated(row(&format!("c{i:02}"), &["due"]), NOW - f64::from(i)))
            .collect();
        assert_eq!(plan(&pool, &due, None).len(), BATCH_TARGET);
        assert_eq!(plan(&pool, &due, Some(5)).len(), 5);
        assert_eq!(plan(&pool, &due, Some(999)).len(), SESSION_LENGTH);
        assert_eq!(plan_limited(&pool, &due, Some(999), Some(3)).len(), 3);
        assert!(plan(&pool, &due, Some(-1)).is_empty());
    }

    #[test]
    fn the_plan_is_deterministic_and_ignores_pool_order() {
        let words = [fresh("a", -2.0 * DAY), fresh("b", -DAY), fresh("c", DAY)];
        let pool = vec![
            row("c1", &["a"]),
            served(row("c2", &["b"]), NOW - 9.0 * DAY),
            generated(row("c3", &["c"]), NOW),
            generated(row("c4", &["a"]), NOW - 4.0 * DAY),
        ];
        let once = plan(&pool, &words, None);
        assert_eq!(plan(&pool, &words, None), once);
        let reversed: Vec<PoolRow> = pool.iter().rev().cloned().collect();
        assert_eq!(plan(&reversed, &words, None), once);
        assert!(plan(&[], &words, None).is_empty());
        assert!(plan(&[row("c1", &["due"])], &[], None).is_empty());
    }

    #[test]
    fn past_the_schedule_the_walk_keeps_going() {
        let words = [fresh("a", 2.0 * DAY), fresh("b", 5.0 * DAY)];
        assert_eq!(
            plan(
                &[resting("ca", &["a"], DAY), resting("cb", &["b"], DAY)],
                &words,
                None
            ),
            ["ca", "cb"]
        );

        let three = [
            fresh("late", 5.0 * DAY),
            fresh("soon", DAY),
            fresh("later", 10.0 * DAY),
        ];
        let pool = [
            row("c-late", &["late"]),
            row("c-soon", &["soon"]),
            row("c-later", &["later"]),
        ];
        assert_eq!(
            plan(&pool, &three, Some(3)),
            ["c-soon", "c-late", "c-later"]
        );

        let words = [fresh("overdue", -5.0 * DAY), fresh("ahead", 5.0 * DAY)];
        let pool = [
            generated(row("c-ahead", &["ahead"]), NOW),
            row("c-overdue", &["overdue"]),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["c-overdue", "c-ahead"]);

        let one = [fresh("a", DAY)];
        let pool = [
            resting("hot", &["a"], 3_600_000.0),
            row("fresh", &["a"]),
            resting("cooler", &["a"], 2.0 * DAY),
        ];
        assert_eq!(plan(&pool, &one, Some(3)), ["fresh", "cooler", "hot"]);
        let pool = [
            generated(row("r-new", &["a"]), NOW),
            generated(row("r-old", &["a"]), NOW - 5.0 * DAY),
            resting("s-cool", &["a"], 2.0 * DAY),
            resting("s-hot", &["a"], 3_600_000.0),
        ];
        assert_eq!(
            plan(&pool, &one, Some(4)),
            ["r-new", "r-old", "s-cool", "s-hot"]
        );
    }

    #[test]
    fn an_unreadable_pool_row_is_skipped_in_place() {
        let words = [fresh("due", -DAY)];
        let rows = vec![None, Some(row("fine", &["due"]))];
        assert_eq!(
            plan_session(&rows, &words, NOW, None, None, &fallback_word_count),
            [1]
        );
    }

    #[test]
    fn rows_an_older_build_wrote_still_play() {
        // Written before the native lines and the readings, with `null` where a
        // field was never set, an index printed as a float, and a field from
        // some later build — read off the host's JSON as the pool arrives.
        let pool: Vec<Option<PoolRow>> = [
            json!({ "id": "spot", "type": "spot-error", "direction": "toNative", "tokens": ["Quiero", "pagar", "la", "cuenta"],
                "correctIndex": 1.0, "intendedWord": "pedir", "correctedSentence": "Quiero pedir la cuenta", "itemIds": ["a"],
                "generatedAt": NOW - 90.0 * DAY, "timesServed": 3, "lastServedAt": NOW - 30.0 * DAY, "reported": false }),
            json!({ "id": "tiles", "type": "word-order", "direction": "toTarget", "tiles": ["la", "cuenta"],
                "answerTokens": ["la", "cuenta"], "answer": "la cuenta", "prompt": null, "itemIds": ["b"],
                "generatedAt": NOW - 90.0 * DAY, "timesServed": 0, "lastServedAt": null, "reported": false, "shinyNewField": 1 }),
            json!({ "id": "mc", "type": "multiple-choice", "direction": "toNative", "prompt": "la cuenta",
                "options": ["the bill", "the menu", "the tea", "the water"], "correctIndex": 0, "itemIds": ["c"],
                "generatedAt": NOW - 90.0 * DAY, "timesServed": 0, "lastServedAt": null, "reported": false }),
        ]
        .into_iter()
        .map(|row| serde_json::from_value(row).ok())
        .collect();
        let words = [
            word("a", -3.0 * DAY, 0.2),
            word("b", -2.0 * DAY, 0.2),
            word("c", -DAY, 0.0),
        ];
        let planned = plan_session(&pool, &words, NOW, None, None, &fallback_word_count);
        assert_eq!(planned, [0, 1, 2]);
    }

    fn by_demand(ids_and_demands: &[(&str, u8)]) -> Vec<Challenge> {
        ids_and_demands
            .iter()
            .map(|(id, demand)| {
                let row = match demand {
                    0 => json!({ "type": "multiple-choice", "direction": "toNative", "prompt": "p",
                        "options": ["a", "b", "c", "d"], "correctIndex": 0 }),
                    1 => json!({ "type": "word-order", "direction": "toTarget", "tiles": ["a", "b"],
                        "answerTokens": ["a", "b"], "answer": "a b" }),
                    _ => json!({ "type": "typed-translation", "direction": "toTarget", "prompt": "p", "acceptedAnswers": ["a"] }),
                };
                let mut row = row;
                row["id"] = json!(id);
                row["itemIds"] = json!([id]);
                Challenge::from_value(row).unwrap()
            })
            .collect()
    }

    fn smoothed(plan: &[Challenge], words: &[Word]) -> Vec<String> {
        let refs: Vec<&Challenge> = plan.iter().collect();
        smooth_demand(&refs, &by_id(words))
            .into_iter()
            .map(|i| plan[i].id().to_owned())
            .collect()
    }

    #[test]
    fn a_two_tier_jump_pulls_the_nearest_later_middle_tier_forward_and_nothing_else() {
        assert_eq!(
            smoothed(&by_demand(&[("a", 0), ("b", 2), ("c", 1)]), &[]),
            ["a", "c", "b"]
        );
        assert_eq!(
            smoothed(&by_demand(&[("a", 0), ("b", 2), ("c", 0)]), &[]),
            ["a", "b", "c"]
        );
        assert_eq!(
            smoothed(&by_demand(&[("a", 0), ("b", 1), ("c", 2)]), &[]),
            ["a", "b", "c"]
        );
        assert_eq!(
            smoothed(
                &by_demand(&[("a", 0), ("b", 0), ("c", 2), ("d", 1), ("e", 0)]),
                &[]
            ),
            ["a", "b", "d", "c", "e"]
        );
    }

    #[test]
    fn a_top_rung_banked_cloze_is_smoothed_as_free_production() {
        let owned = [strong("owned", -DAY)];
        let banked = cloze_row("banked", &["owned"], true).challenge;
        let mut plan = by_demand(&[("recognition", 0)]);
        plan.push(banked);
        plan.extend(by_demand(&[("middle", 1)]));
        assert_eq!(smoothed(&plan, &owned), ["recognition", "middle", "banked"]);
    }

    fn early(count: usize) -> Vec<Word> {
        (0..count).map(|i| fresh(&format!("k{i}"), -DAY)).collect()
    }
    fn about(count: usize, id: &str) -> Vec<Vec<String>> {
        vec![vec![id.to_owned()]; count]
    }
    fn rounds(queue: &[Slot]) -> Vec<&MatchPairsChallenge> {
        queue
            .iter()
            .filter_map(|slot| match slot {
                Slot::Round(round) => Some(round),
                Slot::Planned(_) => None,
            })
            .collect()
    }

    #[test]
    fn a_round_follows_every_nth_early_challenge_but_never_the_last() {
        let queue = interleave_match_rounds(&about(9, "k0"), &early(6), &mut Rng::seeded(1));
        let shape: Vec<bool> = queue.iter().map(|s| matches!(s, Slot::Round(_))).collect();
        assert_eq!(
            shape,
            [false, false, false, false, true, false, false, false, false, true, false]
        );
        let planned: Vec<usize> = queue
            .iter()
            .filter_map(|s| match s {
                Slot::Planned(i) => Some(*i),
                _ => None,
            })
            .collect();
        assert_eq!(planned, (0..9).collect::<Vec<_>>());

        let exact = interleave_match_rounds(
            &about(2 * MATCH_PAIRS_EVERY, "k0"),
            &early(6),
            &mut Rng::seeded(1),
        );
        assert_eq!(exact.len(), 2 * MATCH_PAIRS_EVERY + 1);
        assert!(matches!(exact.last(), Some(Slot::Planned(_))));
        assert!(matches!(exact[MATCH_PAIRS_EVERY], Slot::Round(_)));
        assert!(interleave_match_rounds(&[], &early(6), &mut Rng::seeded(1)).is_empty());
    }

    #[test]
    fn mature_or_scarce_vocabulary_gets_no_rounds() {
        let mature: Vec<Word> = (0..9).map(|i| strong(&format!("k{i}"), -DAY)).collect();
        let plan: Vec<Vec<String>> = (0..9).map(|i| vec![format!("k{i}")]).collect();
        assert!(rounds(&interleave_match_rounds(
            &plan,
            &mature,
            &mut Rng::seeded(1)
        ))
        .is_empty());
        assert!(rounds(&interleave_match_rounds(
            &about(9, "k0"),
            &early(2),
            &mut Rng::seeded(1)
        ))
        .is_empty());
    }

    #[test]
    fn each_round_is_its_own_draw_and_a_seed_replays_them() {
        let queue = interleave_match_rounds(&about(9, "k0"), &early(8), &mut Rng::seeded(1));
        let built = rounds(&queue);
        assert_eq!(built.len(), 2);
        assert_ne!(built[0].id, built[1].id);
        assert_ne!(built[0].item_ids, built[1].item_ids);
        let again = interleave_match_rounds(&about(9, "k0"), &early(8), &mut Rng::seeded(1));
        let replayed: Vec<&Vec<String>> = rounds(&again).iter().map(|r| &r.item_ids).collect();
        assert_eq!(
            replayed,
            built.iter().map(|r| &r.item_ids).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_round_is_sized_at_the_lower_median_rung_of_the_early_words() {
        let pairs = |words: &[Word], planned: usize| -> Vec<usize> {
            rounds(&interleave_match_rounds(
                &about(planned, "k0"),
                words,
                &mut Rng::seeded(3),
            ))
            .iter()
            .map(|r| r.pairs.len())
            .collect()
        };
        assert_eq!(pairs(&early(8), 9), [3, 3]);
        let mut mixed = early(7);
        mixed.push(strong("k7", -DAY));
        assert_eq!(pairs(&mixed, 5), [3]);
        let rung_two: Vec<Word> = (0..8).map(|i| word(&format!("k{i}"), -DAY, 0.2)).collect();
        assert_eq!(pairs(&rung_two, 5), [4]);
        let words: Vec<&Word> = rung_two.iter().collect();
        assert_eq!(median_round_rung(&words), 2);
        assert_eq!(median_round_rung(&[]), 1);
    }
}
