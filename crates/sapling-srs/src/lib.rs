//! Spaced repetition. The `fsrs` crate supplies the FSRS-6 memory model; this
//! crate owns the card around it — the New/Learning/Review/Relearning states,
//! the learning and relearning steps, the hard < good < easy ordering and
//! lapses — and the numbers a screen reads off a card ([`ItemSrs`]). It knows
//! nothing of events or SQL, and reads no clock: every function takes `now`.
//!
//! The model computes in `f32`, whose `exp`/`powf` differ slightly between the
//! native and wasm builds, so compare its outputs with a tolerance.

use std::sync::OnceLock;

use fsrs::{ItemState, MemoryState, NextStates, FSRS, FSRS6_DEFAULT_DECAY};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Grade {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

impl Grade {
    /// A stored grade back to the enum.
    pub fn from_f64(grade: f64) -> Result<Grade, String> {
        match grade {
            1.0 => Ok(Grade::Again),
            2.0 => Ok(Grade::Hard),
            3.0 => Ok(Grade::Good),
            4.0 => Ok(Grade::Easy),
            _ => Err(format!("invalid grade {grade}, expected 1-4")),
        }
    }
}

/// The grade at or above which a review counts as correct.
pub const GOOD: f64 = 3.0;

pub const NEW: i64 = 0;
pub const LEARNING: i64 = 1;
pub const REVIEW: i64 = 2;
pub const RELEARNING: i64 = 3;

/// A card, with its dates as epoch milliseconds. `stability` and `difficulty`
/// are the model's own `f32`s, which also keeps their JSON short.
///
/// The frontend treats it as opaque (`KnowledgeItem.fsrsCard` is `unknown`):
/// only the words ledger names its fields, to put them in columns. `state` is
/// one of `NEW`, `LEARNING`, `REVIEW`, `RELEARNING`, and `last_review` is
/// `null` until the first review.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct FsrsCardState {
    pub due: f64,
    pub stability: f32,
    pub difficulty: f32,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub learning_steps: i64,
    pub reps: i64,
    pub lapses: i64,
    pub state: i64,
    pub last_review: Option<f64>,
}

/// A freshly introduced item, due immediately.
pub fn new_card_state(now: f64) -> FsrsCardState {
    FsrsCardState {
        due: now,
        stability: 0.0,
        difficulty: 0.0,
        elapsed_days: 0,
        scheduled_days: 0,
        learning_steps: 0,
        reps: 0,
        lapses: 0,
        state: NEW,
        last_review: None,
    }
}

/* ---- The model -------------------------------------------------------------- */

const DESIRED_RETENTION: f32 = 0.9;

/// The longest interval ever scheduled. The model has no cap; this is policy.
const MAXIMUM_INTERVAL: f64 = 36500.0;

/// FSRS-6 with `DEFAULT_PARAMETERS`, built once: `FSRS::new` validates the
/// parameter vector, and the answer never changes.
fn model() -> &'static FSRS {
    static MODEL: OnceLock<FSRS> = OnceLock::new();
    MODEL.get_or_init(FSRS::default)
}

/// The memory states and intervals for all four grades after `elapsed_days`.
/// A card whose memory is still zero is one the model has never seen, and
/// `None` asks the model for initial states rather than a step.
fn next_states(card: &FsrsCardState, elapsed_days: i64) -> Result<NextStates, String> {
    let memory = if card.stability == 0.0 && card.difficulty == 0.0 {
        None
    } else {
        Some(MemoryState {
            stability: card.stability,
            difficulty: card.difficulty,
        })
    };
    // A negative elapsed time means a clock that went backwards between two
    // devices; the forgetting curve has no meaning there, so it reads as "today".
    model()
        .next_states(memory, DESIRED_RETENTION, elapsed_days.max(0) as u32)
        .map_err(|err| {
            format!(
                "invalid memory state (difficulty {}, stability {}): {err}",
                card.difficulty, card.stability
            )
        })
}

fn state_for(states: &NextStates, grade: Grade) -> &ItemState {
    match grade {
        Grade::Again => &states.again,
        Grade::Hard => &states.hard,
        Grade::Good => &states.good,
        Grade::Easy => &states.easy,
    }
}

/// The model's interval as a whole number of days, within [1, MAXIMUM_INTERVAL].
fn interval_days(state: &ItemState) -> f64 {
    (state.interval as f64).round().clamp(1.0, MAXIMUM_INTERVAL)
}

/* ---- The scheduler ---------------------------------------------------------- */

const LEARNING_STEPS_MINUTES: [f64; 2] = [1.0, 10.0];
const RELEARNING_STEPS_MINUTES: [f64; 1] = [10.0];

const MINUTE: f64 = 60.0 * 1e3;
const DAY: f64 = 24.0 * 60.0 * 60.0 * 1e3;

/// Whole UTC calendar days from `last` to `cur`.
fn date_diff_in_days(last: f64, cur: f64) -> i64 {
    let day = |ms: f64| (ms / DAY).floor();
    (day(cur) - day(last)) as i64
}

/// The learning step one grade moves a card to: `(scheduled_minutes, next_step)`,
/// or `None` when the grade leaves the steps.
fn learning_step(state: i64, cur_step: i64, grade: Grade) -> Option<(f64, i64)> {
    let steps: &[f64] = if state == RELEARNING || state == REVIEW {
        &RELEARNING_STEPS_MINUTES
    } else {
        &LEARNING_STEPS_MINUTES
    };
    if steps.is_empty() || cur_step >= steps.len() as i64 {
        return None;
    }
    let step_info = steps[cur_step.max(0) as usize];
    if state == REVIEW {
        return match grade {
            Grade::Again => Some((step_info, 0)),
            _ => None,
        };
    }
    match grade {
        Grade::Again => Some((steps[0], 0)),
        Grade::Hard => {
            let minutes = if steps.len() == 1 {
                (steps[0] * 1.5).round()
            } else {
                ((steps[0] + steps[1]) / 2.0).round()
            };
            Some((minutes, cur_step))
        }
        Grade::Good => steps
            .get((cur_step + 1) as usize)
            .filter(|minutes| **minutes != 0.0)
            .map(|minutes| (minutes.round(), cur_step + 1)),
        Grade::Easy => None,
    }
}

struct Scheduler {
    last: FsrsCardState,
    current: FsrsCardState,
    review_time: f64,
    elapsed_days: i64,
}

impl Scheduler {
    fn new(card: &FsrsCardState, now: f64) -> Scheduler {
        let interval = match (card.state, card.last_review) {
            (state, Some(last_review)) if state != NEW => date_diff_in_days(last_review, now),
            _ => 0,
        };
        let mut current = card.clone();
        current.last_review = Some(now);
        current.elapsed_days = interval;
        current.reps += 1;
        Scheduler {
            last: card.clone(),
            current,
            review_time: now,
            elapsed_days: interval,
        }
    }

    fn review(&self, grade: Grade) -> Result<FsrsCardState, String> {
        let states = next_states(&self.current, self.elapsed_days)?;
        match self.last.state {
            NEW => Ok(self.learning(&states, grade, LEARNING)),
            LEARNING | RELEARNING => Ok(self.learning(&states, grade, self.last.state)),
            REVIEW => Ok(self.review_state(&states, grade)),
            state => Err(format!("invalid card state {state}")),
        }
    }

    /// The card carrying one grade's next memory state, and nothing else.
    fn next_ds(&self, states: &NextStates, grade: Grade) -> FsrsCardState {
        let memory = state_for(states, grade).memory;
        let mut card = self.current.clone();
        card.difficulty = memory.difficulty;
        card.stability = memory.stability;
        card
    }

    fn learning(&self, states: &NextStates, grade: Grade, to_state: i64) -> FsrsCardState {
        let mut next = self.next_ds(states, grade);
        let interval = interval_days(state_for(states, grade));
        self.apply_learning_steps(&mut next, grade, to_state, interval);
        next
    }

    /// Places the card on a learning step, or graduates it to `interval` days.
    fn apply_learning_steps(
        &self,
        next: &mut FsrsCardState,
        grade: Grade,
        to_state: i64,
        interval: f64,
    ) {
        let (scheduled_minutes, next_steps) =
            match learning_step(self.current.state, self.current.learning_steps, grade) {
                Some((minutes, step)) => (minutes.max(0.0), step.max(0)),
                None => (0.0, 0),
            };
        if scheduled_minutes > 0.0 && scheduled_minutes < 1440.0 {
            next.learning_steps = next_steps;
            next.scheduled_days = 0;
            next.state = to_state;
            next.due = self.review_time + scheduled_minutes.round() * MINUTE;
        } else {
            next.state = REVIEW;
            if scheduled_minutes >= 1440.0 {
                next.learning_steps = next_steps;
                next.due = self.review_time + scheduled_minutes.round() * MINUTE;
                next.scheduled_days = (scheduled_minutes / 1440.0).floor() as i64;
            } else {
                next.learning_steps = 0;
                next.scheduled_days = interval as i64;
                next.due = self.review_time + interval * DAY;
            }
        }
    }

    /// A card that has graduated. All four intervals are computed because the
    /// ordering rule — hard < good < easy, whatever the model said — is a
    /// comparison between them, not a property of any one.
    fn review_state(&self, states: &NextStates, grade: Grade) -> FsrsCardState {
        let mut again = self.next_ds(states, Grade::Again);
        let mut hard = self.next_ds(states, Grade::Hard);
        let mut good = self.next_ds(states, Grade::Good);
        let mut easy = self.next_ds(states, Grade::Easy);

        let mut hard_interval = interval_days(&states.hard);
        let mut good_interval = interval_days(&states.good);
        hard_interval = hard_interval.min(good_interval);
        good_interval = good_interval.max(hard_interval + 1.0);
        let easy_interval = interval_days(&states.easy).max(good_interval + 1.0);
        for (card, interval) in [
            (&mut hard, hard_interval),
            (&mut good, good_interval),
            (&mut easy, easy_interval),
        ] {
            card.scheduled_days = interval as i64;
            card.due = self.review_time + interval * DAY;
            card.state = REVIEW;
            card.learning_steps = 0;
        }

        self.apply_learning_steps(
            &mut again,
            Grade::Again,
            RELEARNING,
            interval_days(&states.again),
        );
        again.lapses += 1;

        match grade {
            Grade::Again => again,
            Grade::Hard => hard,
            Grade::Good => good,
            Grade::Easy => easy,
        }
    }
}

/// The card after grading `state` at `now`.
pub fn review_card(state: &FsrsCardState, grade: Grade, now: f64) -> Result<FsrsCardState, String> {
    Scheduler::new(state, now).review(grade)
}

/* ---- The reading side ------------------------------------------------------- */

/// What a screen reads off a card, attached to every item a read returns.
///
/// The frontend has no FSRS, so it cannot derive any of this: it gets the three
/// numbers and does arithmetic on them. `due` is the card's own due timestamp,
/// passed straight through and *not* turned into a boolean here — whether it has
/// arrived is a comparison against the caller's own `now`, and the session's
/// `now` is explicit for a reason. The other two are the forgetting curve and
/// the strength bar, which do need the model and the weights.
///
/// **These are computed when the row is fetched**, not when it is looked at. A
/// page left open across a due date shows the schedule as of its last read until
/// something refetches; the word list and the home page refetch on navigation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ItemSrs {
    pub due: f64,
    pub retrievability: f64,
    pub strength: f64,
}

/// Stability (in days) treated as "this word is mature" by [`word_strength`].
const MATURE_STABILITY_DAYS: f64 = 30.0;

/// Whole elapsed 24-hour periods, floored, never negative. Not the calendar-day
/// difference [`date_diff_in_days`] takes — this is the axis the forgetting
/// curve is drawn on.
fn elapsed_since(last_review: f64, now: f64) -> f64 {
    (((now - last_review) / DAY).floor()).max(0.0)
}

/// Probability of recall (0..1) at `now`. A card the model has never seen has
/// no curve, so it reads 0 rather than dividing by a stability of zero.
pub fn current_retrievability(card: &FsrsCardState, now: f64) -> f64 {
    let Some(last_review) = card.last_review else {
        return 0.0;
    };
    if card.state == NEW || card.stability <= 0.0 {
        return 0.0;
    }
    let state = MemoryState {
        stability: card.stability,
        difficulty: card.difficulty,
    };
    let elapsed = elapsed_since(last_review, now) as f32;
    fsrs::current_retrievability(state, elapsed, FSRS6_DEFAULT_DECAY) as f64
}

/// How well a word is known, 0..1 — the number behind the strength bars.
///
/// [`current_retrievability`] alone is the wrong axis, tempting as it looks: the
/// scheduler's whole job is to keep it pinned in 0.9–1.0, so a learner who is on
/// schedule sees every bar full and the display tells them nothing. Stability —
/// the days it takes recall to decay to 90% — is the quantity that actually
/// spans their range: a word met this morning sits under a day, a word they own
/// sits at weeks. [`MATURE_STABILITY_DAYS`] is taken as the top of that range,
/// and the log scale spends the bar's width where the movement is (the first
/// fortnight) instead of squashing it against zero.
///
/// Multiplying by retrievability is what keeps the bar honest about *now*: a
/// mature word left unreviewed for a month visibly sags below the same word
/// reviewed yesterday, which is exactly the word the learner should go find.
pub fn word_strength(card: &FsrsCardState, now: f64) -> f64 {
    let stability = (card.stability as f64).max(0.0);
    let maturity = (stability.ln_1p() / MATURE_STABILITY_DAYS.ln_1p()).min(1.0);
    maturity * current_retrievability(card, now)
}

/// The three derived numbers for one card, as of `now`.
pub fn item_srs(card: &FsrsCardState, now: f64) -> ItemSrs {
    ItemSrs {
        due: card.due,
        retrievability: current_retrievability(card, now),
        strength: word_strength(card, now),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: f64 = 1710061260000.0;

    /// Relative closeness: the model's floats are never compared exactly.
    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() <= 1e-4 * a.abs().max(b.abs())
    }

    #[test]
    fn a_fresh_card_is_due_now() {
        let card = new_card_state(T0);
        assert_eq!(card.due, T0);
        assert_eq!(card.state, NEW);
        assert_eq!(card.last_review, None);
    }

    #[test]
    fn the_crate_ships_the_fsrs6_default_weights() {
        // Pinned so an upstream refit of the weights arrives as a failing test
        // and a `DERIVED_SCHEMA_VERSION` bump in `sapling-db`, not as cards that
        // quietly fold differently.
        let expected = [
            0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 1e-3, 1.8722, 0.1666, 0.796,
            1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
        ];
        assert_eq!(fsrs::DEFAULT_PARAMETERS.len(), expected.len());
        for (actual, expected) in fsrs::DEFAULT_PARAMETERS.iter().zip(expected) {
            assert!(close(*actual, expected), "{actual} vs {expected}");
        }
    }

    #[test]
    fn the_broad_fixture_card_is_what_expected_json_records() {
        // `broad`: item-ni, introduced at T0, Good nine minutes later, then Hard
        // ninety seconds after that — the card `expected.json` records.
        let good = review_card(&new_card_state(T0), Grade::Good, T0 + 540_000.0).unwrap();
        assert!(close(good.stability, 2.3065), "{}", good.stability);
        assert!(close(good.difficulty, 2.118104), "{}", good.difficulty);
        assert_eq!(good.state, LEARNING);
        assert_eq!(good.learning_steps, 1);
        assert_eq!(good.due, T0 + 540_000.0 + 10.0 * MINUTE);

        let hard = review_card(&good, Grade::Hard, T0 + 630_000.0).unwrap();
        assert!(close(hard.stability, 2.3065), "{}", hard.stability);
        assert!(close(hard.difficulty, 4.752858), "{}", hard.difficulty);
        assert_eq!(hard.due, 1710062250000.0);
        assert_eq!(hard.elapsed_days, 0);
        assert_eq!(hard.scheduled_days, 0);
        assert_eq!(hard.learning_steps, 1);
        assert_eq!(hard.reps, 2);
        assert_eq!(hard.lapses, 0);
        assert_eq!(hard.state, LEARNING);
        assert_eq!(hard.last_review, Some(T0 + 630_000.0));
    }

    #[test]
    fn a_card_stored_with_f64_numbers_still_reads() {
        let card: FsrsCardState = serde_json::from_str(
            r#"{"due":1,"stability":2.30649996,"difficulty":4.75285816,"elapsed_days":0,
            "scheduled_days":0,"learning_steps":1,"reps":2,"lapses":0,"state":1,"last_review":1}"#,
        )
        .unwrap();
        assert!(close(card.stability, 2.3065));
        assert!(close(card.difficulty, 4.752858));
    }

    #[test]
    fn learning_steps_follow_the_defaults() {
        // New → Again: 1 minute. New → Hard: round(5.5) = 6 minutes. New → Easy: graduates.
        let again = review_card(&new_card_state(T0), Grade::Again, T0).unwrap();
        assert_eq!(again.due, T0 + MINUTE);
        assert_eq!(again.state, LEARNING);
        assert_eq!(again.learning_steps, 0);

        let hard = review_card(&new_card_state(T0), Grade::Hard, T0).unwrap();
        assert_eq!(hard.due, T0 + 6.0 * MINUTE);
        assert_eq!(hard.state, LEARNING);

        // Good is the second step, ten minutes out; a second Good graduates it.
        let good = review_card(&new_card_state(T0), Grade::Good, T0).unwrap();
        assert_eq!(good.due, T0 + 10.0 * MINUTE);
        assert_eq!(good.learning_steps, 1);
        let graduated = review_card(&good, Grade::Good, good.due).unwrap();
        assert_eq!(graduated.state, REVIEW);
        assert_eq!(graduated.learning_steps, 0);

        let easy = review_card(&new_card_state(T0), Grade::Easy, T0).unwrap();
        assert_eq!(easy.state, REVIEW);
        assert!(easy.scheduled_days >= 1);
        assert_eq!(easy.due, T0 + easy.scheduled_days as f64 * DAY);
    }

    #[test]
    fn a_review_card_lapses_on_again_and_orders_its_intervals() {
        let mut card = review_card(&new_card_state(T0), Grade::Easy, T0).unwrap();
        card = review_card(&card, Grade::Good, T0 + 10.0 * DAY).unwrap();
        assert_eq!(card.state, REVIEW);
        let later = T0 + 40.0 * DAY;
        let hard = review_card(&card, Grade::Hard, later).unwrap();
        let good = review_card(&card, Grade::Good, later).unwrap();
        let easy = review_card(&card, Grade::Easy, later).unwrap();
        assert!(hard.scheduled_days < good.scheduled_days);
        assert!(good.scheduled_days < easy.scheduled_days);
        // A harder grade never leaves the card more stable than an easier one.
        assert!(hard.stability < good.stability);
        assert!(good.stability < easy.stability);
        let again = review_card(&card, Grade::Again, later).unwrap();
        assert_eq!(again.lapses, card.lapses + 1);
        assert_eq!(again.state, RELEARNING);
        assert_eq!(again.due, later + 10.0 * MINUTE);
        assert_eq!(again.elapsed_days, 30);
        // Failing a mature card costs it stability but never the whole card.
        assert!(again.stability < card.stability);
        assert!(again.stability > 0.0);
    }

    #[test]
    fn difficulty_stays_inside_the_models_range() {
        // Ten straight failures, then ten straight Easys: the crate clamps to
        // [1, 10] at both ends and this module never widens that.
        let mut card = review_card(&new_card_state(T0), Grade::Easy, T0).unwrap();
        for n in 1..=10 {
            card = review_card(&card, Grade::Again, T0 + n as f64 * DAY).unwrap();
            assert!(
                card.difficulty <= 10.0 + 1e-4,
                "difficulty {}",
                card.difficulty
            );
        }
        for n in 11..=20 {
            card = review_card(&card, Grade::Easy, T0 + n as f64 * DAY).unwrap();
            assert!(
                card.difficulty >= 1.0 - 1e-4,
                "difficulty {}",
                card.difficulty
            );
        }
        // Only the first failure landed on a graduated card; the rest were
        // already relearning, and relearning does not lapse again.
        assert_eq!(card.lapses, 1);
    }

    #[test]
    fn a_clock_that_went_backwards_reads_as_today() {
        // Two devices, one of them wrong: `elapsed_days` records the negative
        // gap, but the model is asked about zero days, not minus three.
        let card = review_card(&new_card_state(T0), Grade::Easy, T0 + 10.0 * DAY).unwrap();
        let backwards = review_card(&card, Grade::Good, T0 + 7.0 * DAY).unwrap();
        let same_day = review_card(&card, Grade::Good, T0 + 10.0 * DAY).unwrap();
        assert_eq!(backwards.elapsed_days, -3);
        assert!(close(backwards.stability, same_day.stability));
        assert!(close(backwards.difficulty, same_day.difficulty));
    }

    #[test]
    fn rejects_a_grade_outside_one_to_four() {
        assert!(Grade::from_f64(0.0).is_err());
        assert!(Grade::from_f64(2.5).is_err());
        assert_eq!(Grade::from_f64(4.0), Ok(Grade::Easy));
    }

    #[test]
    fn rejects_a_card_in_no_state_at_all() {
        let mut card = new_card_state(T0);
        card.state = 9;
        assert!(review_card(&card, Grade::Good, T0).is_err());
    }

    /* ---- The reading side ------------------------------------------------ */
    //
    // Shaped as properties rather than pinned decimals: the numbers are the
    // model's, and what the app depends on is the shape of the two curves —
    // retrievability falls with time, strength separates a young card from a
    // mature one where retrievability cannot.

    /// A card of a given stability, reviewed at `reviewed_at`.
    fn mature(stability: f32, reviewed_at: f64) -> FsrsCardState {
        FsrsCardState {
            due: reviewed_at + stability as f64 * DAY,
            stability,
            difficulty: 5.0,
            state: REVIEW,
            reps: 4,
            last_review: Some(reviewed_at),
            ..new_card_state(T0)
        }
    }

    #[test]
    fn retrievability_decreases_as_now_advances_past_the_review() {
        let card = review_card(&new_card_state(T0), Grade::Good, T0).unwrap();
        let reviewed = card.last_review.unwrap();
        let soon = current_retrievability(&card, reviewed + DAY);
        let later = current_retrievability(&card, reviewed + 30.0 * DAY);
        assert!(soon > 0.0 && soon <= 1.0, "retrievability {soon}");
        assert!(later < soon);
    }

    #[test]
    fn retrievability_is_at_its_maximum_at_the_moment_of_review() {
        let card = review_card(&new_card_state(T0), Grade::Good, T0).unwrap();
        let reviewed = card.last_review.unwrap();
        assert!(
            current_retrievability(&card, reviewed)
                > current_retrievability(&card, reviewed + 100.0 * DAY)
        );
    }

    #[test]
    fn a_card_the_model_has_never_seen_has_no_curve() {
        let fresh = new_card_state(T0);
        assert_eq!(current_retrievability(&fresh, T0), 0.0);
        assert_eq!(word_strength(&fresh, T0), 0.0);
        assert_eq!(item_srs(&fresh, T0).due, T0);
    }

    #[test]
    fn strength_scores_a_mature_card_just_reviewed_at_nearly_full() {
        for stability in [30.0, 90.0] {
            let strength = word_strength(&mature(stability, T0), T0);
            assert!(strength > 0.99, "stability {stability}: {strength}");
            assert!(strength <= 1.0 + 1e-6);
        }
    }

    #[test]
    fn strength_sags_for_an_overdue_card_at_the_same_stability() {
        let fresh = word_strength(&mature(20.0, T0), T0);
        let overdue = word_strength(&mature(20.0, T0 - 120.0 * DAY), T0);
        assert!(overdue < fresh);
    }

    #[test]
    fn strength_separates_a_young_card_from_a_mature_one_where_retrievability_would_not() {
        let young = mature(1.0, T0);
        let old = mature(30.0, T0);
        assert!(word_strength(&young, T0) < word_strength(&old, T0));
        // The point of the formula: both are perfectly recallable right now.
        let gap = current_retrievability(&young, T0) - current_retrievability(&old, T0);
        assert!(gap.abs() < 1e-3, "retrievability gap {gap}");
    }

    #[test]
    fn the_curve_reads_whole_elapsed_days_never_a_negative_one() {
        // A clock that went backwards, and the hours inside a day: both read as
        // "reviewed today".
        let card = mature(10.0, T0);
        let at_review = current_retrievability(&card, T0);
        let near = |r: f64| (r - at_review).abs() <= 1e-4 * at_review;
        assert!(near(current_retrievability(&card, T0 - 3.0 * DAY)));
        assert!(near(current_retrievability(
            &card,
            T0 + 23.0 * 60.0 * MINUTE
        )));
        assert!(current_retrievability(&card, T0 + DAY) < at_review);
    }
}
