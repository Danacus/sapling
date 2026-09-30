//! Which pooled challenges a session plays, in order, at which help level, and
//! where its free match rounds go.
//!
//! **Due beats fresh.** The walk is item-first: every word the schedule owes,
//! most overdue first, claims the best challenge covering it, then a second
//! pass gives each a second angle; the same two passes then run over the words
//! not yet due, and the leftovers fill what is left — rested material first,
//! resting material last. A due word with nothing rested may take its
//! least-recently-served resting row on its first pass; nothing else bends the
//! rest gap.
//!
//! **What a word gets is decided by `fits` alone** (`fits.rs`): a row is served
//! only at a help level whose predicted chance lands inside the window around
//! the aim, and among one word's rows the one whose best help level sits
//! closest to the aim wins, freshness breaking a tie. A row that fits no help
//! level for its words is not served at all — the plan comes out shorter, and
//! coverage is what tells the learner to write more. The closeness orders one
//! word's bucket; the fillers keep their freshness and recency order.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::MatchPairsChallenge;
use crate::fits::{best_fit, Fit, Serving};
use crate::kinds::kind_of;
use crate::match_pairs::make_match_pairs;
use crate::pool::{is_playable, is_rested, known_ids, PoolRow, SESSION_LENGTH};
use crate::rng::Rng;
use crate::topup::by_urgency;
use crate::word::{by_id, ById, Word};

/// Challenges a session aims for.
pub const BATCH_TARGET: usize = 14;

/// A free match round goes in after every this many early-material challenges.
pub const MATCH_PAIRS_EVERY: usize = 4;

/// Below this strength a word is early material, which match rounds are drawn
/// from and follow. Pacing, not difficulty: a round is a warm-up between new
/// words, and a session of words the learner owns reads as uninterrupted work.
pub const EARLY_STRENGTH: f64 = 0.3;

/// One place in a session's queue: a planned challenge by its position in the
/// plan, or a match round built for that place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum Slot {
    Planned(usize),
    Round(MatchPairsChallenge),
}

/// One planned challenge: its position in the pool, and the help level it is
/// served at (`help.rs`'s id), which `presentationFor` turns into a screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Planned {
    pub at: usize,
    pub shown: String,
    /// The predicted chance of a correct answer at that help level.
    pub chance: f64,
}

pub(crate) struct Row<'a> {
    pub at: usize,
    pub row: &'a PoolRow,
}

fn id<'a>(row: &Row<'a>) -> &'a str {
    row.row.challenge.id()
}

pub(crate) fn by_recency(a: &Row, b: &Row) -> std::cmp::Ordering {
    let served = |r: &Row| r.row.last_served_at.unwrap_or(0.0);
    served(a)
        .partial_cmp(&served(b))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| id(a).cmp(id(b)))
}

/// Never served first, newest generation first among those; then [`by_recency`].
pub(crate) fn by_freshness(a: &Row, b: &Row) -> std::cmp::Ordering {
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

/// The playable rows of an active kind, with their places in the host's pool.
pub(crate) fn servable<'a>(pool: &'a [Option<PoolRow>], words: &[Word]) -> Vec<Row<'a>> {
    let known = known_ids(words);
    pool.iter()
        .enumerate()
        .filter_map(|(at, row)| {
            Some(Row {
                at,
                row: row.as_ref()?,
            })
        })
        .filter(|Row { row, .. }| {
            is_playable(row, &known) && kind_of(&row.challenge).is_some_and(|k| k.is_active())
        })
        .collect()
}

/// Each row's best fit, worked out once per plan.
pub(crate) struct Judge<'a, 'w> {
    pub words: &'a ById<'w>,
    pub serving: &'a Serving,
    fits: RefCell<HashMap<usize, Option<Fit>>>,
}

impl<'a, 'w> Judge<'a, 'w> {
    pub fn new(words: &'a ById<'w>, serving: &'a Serving) -> Self {
        Judge {
            words,
            serving,
            fits: RefCell::new(HashMap::new()),
        }
    }

    pub fn fit(&self, row: &Row) -> Option<Fit> {
        *self
            .fits
            .borrow_mut()
            .entry(row.at)
            .or_insert_with(|| best_fit(row.row, self.words, self.serving))
    }

    /// Among the unclaimed rows of one word's bucket that fit, the one closest
    /// to the aim; the bucket's own order breaks a tie. Never one that does not fit.
    pub fn first_free<'r, 'x>(
        &self,
        bucket: Option<&Vec<&'r Row<'x>>>,
        taken: &HashSet<usize>,
    ) -> Option<(&'r Row<'x>, Fit)> {
        let mut best: Option<(&Row, Fit)> = None;
        for row in bucket? {
            if taken.contains(&row.at) {
                continue;
            }
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

/// The session: positions into `pool`, in play order, each with its help level.
pub fn plan_session(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    serving: &Serving,
    target: Option<i64>,
    limit: Option<i64>,
) -> Vec<Planned> {
    let limit = limit.unwrap_or(SESSION_LENGTH as i64).max(0);
    let target = target.unwrap_or(BATCH_TARGET as i64).max(0).min(limit) as usize;
    if target == 0 {
        return Vec::new();
    }

    let index = by_id(words);
    let (mut rested, mut resting): (Vec<Row>, Vec<Row>) = servable(pool, words)
        .into_iter()
        .partition(|r| is_rested(r.row, now));
    rested.sort_by(by_freshness);
    resting.sort_by(by_recency);
    let rested_by_item = bucket(&rested);
    let resting_by_item = bucket(&resting);
    let judge = Judge::new(&index, serving);

    let walk = by_urgency(words, now);
    let (owed, ahead): (Vec<&Word>, Vec<&Word>) = walk.into_iter().partition(|w| w.is_due(now));
    let mut chosen: Vec<Planned> = Vec::new();
    let mut taken: HashSet<usize> = HashSet::new();
    let mut take = |row: &Row, fit: Fit, chosen: &mut Vec<Planned>| {
        if taken.insert(row.at) {
            chosen.push(Planned {
                at: row.at,
                shown: fit.help.id(),
                chance: fit.chance,
            });
        }
    };

    // Two passes over each queue, one angle apiece then a second; only a due
    // word may take its longest-resting row, and only on its first pass.
    for (queue, spend_gap) in [(&owed, true), (&ahead, false)] {
        for pass in 0..2 {
            for word in queue.iter() {
                if chosen.len() >= target {
                    break;
                }
                let claimed: HashSet<usize> = chosen.iter().map(|p| p.at).collect();
                let mut next = judge.first_free(rested_by_item.get(word.id.as_str()), &claimed);
                if next.is_none() && spend_gap && pass == 0 {
                    next = judge.first_free(resting_by_item.get(word.id.as_str()), &claimed);
                }
                if let Some((row, fit)) = next {
                    take(row, fit, &mut chosen);
                }
            }
        }
    }

    for row in rested.iter().chain(resting.iter()) {
        if chosen.len() >= target {
            break;
        }
        if let Some(fit) = judge.fit(row) {
            take(row, fit, &mut chosen);
        }
    }
    chosen
}

/// The queue the learn screen walks: the plan, with a free round after every
/// [`MATCH_PAIRS_EVERY`]th challenge that touches an early word, drawn from
/// those words only and never last.
pub fn interleave_match_rounds(plan: &[Vec<String>], words: &[Word], rng: &mut Rng) -> Vec<Slot> {
    let early: Vec<Word> = words
        .iter()
        .filter(|w| w.strength() < EARLY_STRENGTH)
        .cloned()
        .collect();
    let early_ids: HashSet<&str> = early.iter().map(|w| w.id.as_str()).collect();
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
        if let Some(round) = make_match_pairs(&early, &mut || rng.next_f64(), id) {
            queue.push(Slot::Round(round));
        }
    }
    queue
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
    fn strong(id: &str, offset: f64) -> Word {
        word(id, offset, 0.9)
    }
    fn skilled(id: &str, offset: f64, skill: f64) -> Word {
        let mut w = word(id, offset, 0.5);
        w.skill = Some(skill);
        w
    }

    /// A recognize-mc row: fits any word the model has not lost.
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
            _ => unreachable!(),
        }
        row
    }
    /// A bankless cloze: typed, the hardest thing in the pool.
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
        plan_session(&rows, words, NOW, &Serving::default(), target, limit)
            .into_iter()
            .map(|p| pool[p.at].challenge.id().to_owned())
            .collect()
    }

    #[test]
    fn a_retired_row_is_not_served() {
        let words = [fresh("due", -DAY)];
        let legacy = pooled("legacy", WireType::TranslateToTarget, &["due"], None);
        assert_eq!(
            plan(&[legacy, row("active", &["due"])], &words, Some(2)),
            ["active"]
        );
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
        let kept = [fresh("kept", -DAY)];
        let mut flagged = row("flagged", &["kept"]);
        flagged.reported = true;
        let pool = [
            flagged,
            row("orphan", &["deleted"]),
            row("half-orphan", &["kept", "deleted"]),
            row("nothing", &[]),
            row("fine", &["kept"]),
        ];
        assert_eq!(plan(&pool, &kept, None), ["fine"]);
    }

    #[test]
    fn a_word_is_served_only_what_fits_it() {
        // A brand-new word manages a recognition question, not a typed cloze.
        let words = [fresh("due", -DAY)];
        let pool = [
            generated(typed_row("typed", &["due"]), NOW),
            generated(row("choice", &["due"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["choice"]);
        assert!(plan(&[typed_row("typed", &["due"])], &words, Some(2)).is_empty());
        // A word the model knows is strong gets the typed cloze, and no longer
        // the recognition question it has outgrown.
        let owned = [skilled("due", -DAY, 5.0)];
        assert_eq!(plan(&pool, &owned, Some(2)), ["typed"]);
    }

    #[test]
    fn the_closer_fit_beats_the_fresher_row_and_freshness_breaks_a_tie() {
        let words = [skilled("due", -DAY, 2.4)];
        let long = "perdona me podrías decir dónde está la estación de tren más cercana";
        let pool = [
            generated(row("short", &["due"]), NOW),
            generated(with_prompt(row("long", &["due"]), long), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["long", "short"]);
        let pool = [
            generated(row("newer", &["due"]), NOW),
            generated(row("older", &["due"]), NOW - 5.0 * DAY),
        ];
        assert_eq!(plan(&pool, &words, Some(2)), ["newer", "older"]);
    }

    #[test]
    fn a_pick_carries_its_help_level() {
        let rows = vec![Some(typed_row("typed", &["due"]))];
        let planned = plan_session(
            &rows,
            &[skilled("due", -DAY, 5.0)],
            NOW,
            &Serving::default(),
            None,
            None,
        );
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].shown, "typed");
        assert!((0.65..=0.92).contains(&planned[0].chance));
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
    fn a_row_is_planned_once_and_the_plan_respects_its_target_and_cap() {
        let words = [fresh("a", -2.0 * DAY), fresh("b", -DAY)];
        let both = row("both", &["a", "b"]);
        assert_eq!(
            plan(&[both, row("just-b", &["b"])], &words, Some(4)),
            ["just-b"]
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
        let one = [fresh("a", DAY)];
        let pool = [
            resting("hot", &["a"], 3_600_000.0),
            row("fresh", &["a"]),
            resting("cooler", &["a"], 2.0 * DAY),
        ];
        assert_eq!(plan(&pool, &one, Some(3)), ["fresh", "cooler", "hot"]);
    }

    #[test]
    fn an_unreadable_pool_row_is_skipped_in_place() {
        let words = [fresh("due", -DAY)];
        let rows = vec![None, Some(row("fine", &["due"]))];
        let planned = plan_session(&rows, &words, NOW, &Serving::default(), None, None);
        assert_eq!(planned.iter().map(|p| p.at).collect::<Vec<_>>(), [1]);
    }

    #[test]
    fn rows_an_older_build_wrote_still_play() {
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
            skilled("a", -3.0 * DAY, 3.0),
            skilled("b", -2.0 * DAY, 3.0),
            word("c", -DAY, 0.0),
        ];
        let planned = plan_session(&pool, &words, NOW, &Serving::default(), None, None);
        assert_eq!(planned.iter().map(|p| p.at).collect::<Vec<_>>(), [0, 1, 2]);
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
        let exact = interleave_match_rounds(
            &about(2 * MATCH_PAIRS_EVERY, "k0"),
            &early(6),
            &mut Rng::seeded(1),
        );
        assert_eq!(exact.len(), 2 * MATCH_PAIRS_EVERY + 1);
        assert!(matches!(exact.last(), Some(Slot::Planned(_))));
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
}
