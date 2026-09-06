//! Spaced repetition: the `fsrs` crate's FSRS-6 memory model, driven through
//! the scheduler shape ts-fsrs gave this app.
//!
//! The split is deliberate. **The crate owns the formulas** — stability,
//! difficulty and the interval a stability implies, all of it FSRS-6 with the
//! default parameters and `desired_retention` 0.9, maintained upstream by the
//! same people who write ts-fsrs. **This module owns the card**: the
//! New/Learning/Review/Relearning machine, the learning steps `1m`/`10m` and
//! the relearning step `10m`, `reps`, `lapses`, `elapsed_days`,
//! `scheduled_days`, `due`, the hard < good < easy ordering rule, and the
//! `FsrsCardState` JSON the materializer stores. `fsrs::FSRS::next_states`
//! knows nothing about any of that.
//!
//! It is not a port any more, so it is not bit-comparable with ts-fsrs.
//! `src/lib/srs/scheduler.ts` still runs ts-fsrs for what the UI reads and for
//! the optimistic preview the session engine throws away — same algorithm and
//! the same 21 weights, but an approximation of what this module writes, never
//! a second source of truth for it.
//!
//! **A card is not bit-comparable across hosts either, and cannot be made so.**
//! The crate computes in `f32`, and `f32`'s `exp` and `powf` come from the
//! host's libm natively and from Rust's `libm` port on wasm32; those disagree by
//! an ulp or two, which a chain of them turns into a difference around the
//! seventh significant digit. The old port avoided this by working in `f64`,
//! where eight-decimal rounding sat eight orders of magnitude above the noise;
//! at `f32` no rounding can both keep the value and hide the gap. So a card is
//! widened to `f64` and cut to eight decimals — about all the precision an
//! `f32` carries, and enough to keep the JSON short and stable *per host* — and
//! `tests/golden.rs` is where the tolerance lives instead. Nothing downstream
//! reads a card that closely: `due` and `scheduled_days` are whole minutes and
//! days, and `wordStrength` is a log.
//!
//! Nothing here reads a clock or an RNG: `next_states` takes the elapsed days
//! explicitly and the crate's randomness lives only in its optimizer.

use std::sync::OnceLock;

use fsrs::{ItemState, MemoryState, NextStates, FSRS};
use serde::{Deserialize, Serialize};

use crate::js::{round, round_to};

/// ts-fsrs `Rating`, minus `Manual`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Grade {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

impl Grade {
    /// A stored grade back to the enum; anything but 1–4 is what ts-fsrs throws on.
    pub fn from_f64(grade: f64) -> Result<Grade, String> {
        if grade == 1.0 {
            Ok(Grade::Again)
        } else if grade == 2.0 {
            Ok(Grade::Hard)
        } else if grade == 3.0 {
            Ok(Grade::Good)
        } else if grade == 4.0 {
            Ok(Grade::Easy)
        } else {
            Err(format!(
                "Invalid grade \"{}\",expected 1-4",
                crate::js::number_to_string(grade)
            ))
        }
    }
}

/// The grade at or above which a review counts as correct.
pub const GOOD: f64 = 3.0;

/// ts-fsrs `State`.
pub const NEW: i64 = 0;
pub const LEARNING: i64 = 1;
pub const REVIEW: i64 = 2;
pub const RELEARNING: i64 = 3;

/// A ts-fsrs `Card` with its dates as epoch milliseconds — `FsrsCardState`.
///
/// Field order is the JSON order `fromFsrsCard` writes. The integral fields
/// are integers because ts-fsrs only ever assigns them rounded values; `due`
/// stays a double because it is a `Date.getTime()`, and JavaScript prints it
/// the same either way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FsrsCardState {
    pub due: f64,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: i64,
    pub scheduled_days: i64,
    pub learning_steps: i64,
    pub reps: i64,
    pub lapses: i64,
    pub state: i64,
    pub last_review: Option<f64>,
}

/// State for a freshly introduced item, due immediately — `createEmptyCard(now)`.
pub fn new_card_state(now: f64) -> FsrsCardState {
    FsrsCardState {
        due: date(now),
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

/// `new Date(ms).getTime()`: the time clip truncates towards zero.
fn date(ms: f64) -> f64 {
    ms.trunc()
}

/* ---- The model: everything below this line comes from the crate ------------- */

/// ts-fsrs's `request_retention`, which the crate calls `desired_retention`.
const DESIRED_RETENTION: f32 = 0.9;

/// The longest interval ts-fsrs will schedule. The crate has no such cap; it is
/// a scheduler policy, so it stays here.
const MAXIMUM_INTERVAL: f64 = 36500.0;

/// The model, with `DEFAULT_PARAMETERS` — FSRS-6's, the same 21 weights
/// `generatorParameters()` hands ts-fsrs. Built once: `FSRS::new` validates and
/// clips the parameter vector, and the answer never changes.
fn model() -> &'static FSRS {
    static MODEL: OnceLock<FSRS> = OnceLock::new();
    MODEL.get_or_init(FSRS::default)
}

/// The memory states and intervals for all four grades after `elapsed_days`.
///
/// `None` is how the crate is told to initialise rather than step, and a card
/// whose memory is still zero is exactly the card the model has never seen —
/// the same test the ported `next_state` made before returning the initial
/// difficulty and stability.
fn next_states(card: &FsrsCardState, elapsed_days: i64) -> Result<NextStates, String> {
    let memory = if card.stability == 0.0 && card.difficulty == 0.0 {
        None
    } else {
        Some(MemoryState {
            stability: card.stability as f32,
            difficulty: card.difficulty as f32,
        })
    };
    // A negative elapsed time means a clock that went backwards between two
    // devices; the forgetting curve has no meaning there, so it reads as "today".
    model()
        .next_states(memory, DESIRED_RETENTION, elapsed_days.max(0) as u32)
        .map_err(|err| {
            format!(
                "Invalid memory state {{ difficulty: {}, stability: {} }}: {err}",
                crate::js::number_to_string(card.difficulty),
                crate::js::number_to_string(card.stability)
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

/// The crate's `f32` as this module stores it: widened, then cut to eight
/// decimals so an `f32`'s binary tail never reaches `js.rs` or the fixtures.
fn store(value: f32) -> f64 {
    round_to(value as f64, 8)
}

/// The crate's interval as a whole number of days, clamped the way ts-fsrs
/// clamps it. `round` is `Math.round`, because the same value is printed by a
/// JavaScript host.
fn interval_days(state: &ItemState) -> f64 {
    round(state.interval as f64).clamp(1.0, MAXIMUM_INTERVAL)
}

/* ---- BasicScheduler --------------------------------------------------------- */

const LEARNING_STEPS_MINUTES: [f64; 2] = [1.0, 10.0];
const RELEARNING_STEPS_MINUTES: [f64; 1] = [10.0];

const MINUTE: f64 = 60.0 * 1e3;
const DAY: f64 = 24.0 * 60.0 * 60.0 * 1e3;

/// `dateDiffInDays`: whole UTC calendar days from `last` to `cur`.
fn date_diff_in_days(last: f64, cur: f64) -> i64 {
    let day = |ms: f64| (ms / DAY).floor();
    (day(cur) - day(last)) as i64
}

/// `BasicLearningStepsStrategy` for one grade: `(scheduled_minutes, next_step)`.
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
                round(steps[0] * 1.5)
            } else {
                round((steps[0] + steps[1]) / 2.0)
            };
            Some((minutes, cur_step))
        }
        Grade::Good => steps
            .get((cur_step + 1) as usize)
            .filter(|minutes| **minutes != 0.0)
            .map(|minutes| (round(*minutes), cur_step + 1)),
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
    /// `AbstractScheduler`'s constructor and `init()`.
    fn new(card: &FsrsCardState, now: f64) -> Scheduler {
        let review_time = date(now);
        let mut current = card.clone();
        let interval = match (card.state, card.last_review) {
            (state, Some(last_review)) if state != NEW => {
                date_diff_in_days(last_review, review_time)
            }
            _ => 0,
        };
        current.last_review = Some(review_time);
        current.elapsed_days = interval;
        current.reps += 1;
        Scheduler {
            last: card.clone(),
            current,
            review_time,
            elapsed_days: interval,
        }
    }

    fn review(&self, grade: Grade) -> Result<FsrsCardState, String> {
        let states = next_states(&self.current, self.elapsed_days)?;
        match self.last.state {
            NEW => Ok(self.learning(&states, grade, LEARNING)),
            LEARNING | RELEARNING => Ok(self.learning(&states, grade, self.last.state)),
            REVIEW => Ok(self.review_state(&states, grade)),
            state => Err(format!("Invalid state:[{state}]")),
        }
    }

    /// The card carrying one grade's next memory state, and nothing else.
    fn next_ds(&self, states: &NextStates, grade: Grade) -> FsrsCardState {
        let memory = state_for(states, grade).memory;
        let mut card = self.current.clone();
        card.difficulty = store(memory.difficulty);
        card.stability = store(memory.stability);
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
            next.due = self.review_time + round(scheduled_minutes) * MINUTE;
        } else {
            next.state = REVIEW;
            if scheduled_minutes >= 1440.0 {
                next.learning_steps = next_steps;
                next.due = self.review_time + round(scheduled_minutes) * MINUTE;
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

/// `reviewCard`: the state after grading `state` at `now`.
pub fn review_card(state: &FsrsCardState, grade: Grade, now: f64) -> Result<FsrsCardState, String> {
    Scheduler::new(state, now).review(grade)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: f64 = 1710061260000.0;

    #[test]
    fn a_fresh_card_is_due_now() {
        let card = new_card_state(T0);
        assert_eq!(card.due, T0);
        assert_eq!(card.state, NEW);
        assert_eq!(card.last_review, None);
    }

    #[test]
    fn the_crate_ships_the_weights_ts_fsrs_generates() {
        // Both sides are FSRS-6 with the published defaults, and the TypeScript
        // reads `retrievability` and `wordStrength` off cards this module wrote.
        // If these ever diverge, those two readings start lying.
        assert_eq!(
            fsrs::DEFAULT_PARAMETERS,
            [
                0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 1e-3, 1.8722, 0.1666, 0.796,
                1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
            ]
        );
    }

    #[test]
    fn the_broad_fixture_card_is_what_expected_json_records() {
        // `broad`: item-ni, introduced at T0, Good nine minutes later, then Hard
        // ninety seconds after that — the card `expected.json` records. These
        // are this host's numbers; the fixture's are the wasm build's, and
        // `tests/golden.rs` is the check that the two stay close.
        let good = review_card(&new_card_state(T0), Grade::Good, T0 + 540_000.0).unwrap();
        assert_eq!(good.stability, 2.30649996);
        assert_eq!(good.difficulty, 2.11810398);
        assert_eq!(good.state, LEARNING);
        assert_eq!(good.learning_steps, 1);
        assert_eq!(good.due, T0 + 540_000.0 + 10.0 * MINUTE);

        let hard = review_card(&good, Grade::Hard, T0 + 630_000.0).unwrap();
        assert_eq!(
            hard,
            FsrsCardState {
                due: 1710062250000.0,
                stability: 2.30649996,
                difficulty: 4.75285816,
                elapsed_days: 0,
                scheduled_days: 0,
                learning_steps: 1,
                reps: 2,
                lapses: 0,
                state: LEARNING,
                last_review: Some(T0 + 630_000.0),
            }
        );
    }

    #[test]
    fn a_stored_card_carries_eight_decimals_and_no_more() {
        // The crate computes in `f32`; what lands in the JSON must not.
        let card = review_card(&new_card_state(T0), Grade::Hard, T0).unwrap();
        for value in [card.stability, card.difficulty] {
            assert_eq!(value, round_to(value, 8));
        }
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
            assert!(card.difficulty <= 10.0, "difficulty {}", card.difficulty);
        }
        for n in 11..=20 {
            card = review_card(&card, Grade::Easy, T0 + n as f64 * DAY).unwrap();
            assert!(card.difficulty >= 1.0, "difficulty {}", card.difficulty);
        }
        // Only the first failure landed on a graduated card; the rest were
        // already relearning, and relearning does not lapse again.
        assert_eq!(card.lapses, 1);
    }

    #[test]
    fn a_clock_that_went_backwards_reads_as_today() {
        // Two devices, one of them wrong: `elapsed_days` is recorded as ts-fsrs
        // computes it, but the model is asked about zero days, not minus three.
        let card = review_card(&new_card_state(T0), Grade::Easy, T0 + 10.0 * DAY).unwrap();
        let backwards = review_card(&card, Grade::Good, T0 + 7.0 * DAY).unwrap();
        let same_day = review_card(&card, Grade::Good, T0 + 10.0 * DAY).unwrap();
        assert_eq!(backwards.elapsed_days, -3);
        assert_eq!(backwards.stability, same_day.stability);
        assert_eq!(backwards.difficulty, same_day.difficulty);
    }

    #[test]
    fn rejects_a_grade_ts_fsrs_would_throw_on() {
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
}
