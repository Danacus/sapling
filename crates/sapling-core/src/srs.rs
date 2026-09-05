//! Spaced repetition: ts-fsrs 5.4.1's short-term scheduler with its default
//! parameters, ported operation for operation.
//!
//! `src/lib/srs/scheduler.ts` calls `fsrs().next(card, now, grade)` and
//! nothing else, so this is that one path — `BasicScheduler` over `FSRS-6.0`
//! with the default weights, `request_retention` 0.9, learning steps `1m`/`10m`,
//! relearning step `10m`, fuzz off. Every formula keeps the TypeScript's
//! operation order and its `roundTo(x, 8)` calls, because a card is compared
//! bit for bit: the materializer stores it as JSON, and the golden fixtures
//! diff that JSON.
//!
//! Transcendentals (`exp`, `ln`, `powf`) come from the platform's libm here and
//! from V8's fdlibm port in the browser. Both are within an ulp of the true
//! value and the eight-decimal rounding that follows every use absorbs that,
//! unless a value lands within ~1e-16 of a rounding boundary. The fixtures are
//! the check.

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

    fn as_f64(self) -> f64 {
        self as i64 as f64
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

/* ---- Parameters: `generatorParameters()` with nothing overridden ------------ */

const W: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 1e-3, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const REQUEST_RETENTION: f64 = 0.9;
const MAXIMUM_INTERVAL: f64 = 36500.0;
const S_MIN: f64 = 1e-3;
const S_MAX: f64 = 36500.0;
const LEARNING_STEPS_MINUTES: [f64; 2] = [1.0, 10.0];
const RELEARNING_STEPS_MINUTES: [f64; 1] = [10.0];

const MINUTE: f64 = 60.0 * 1e3;
const DAY: f64 = 24.0 * 60.0 * 60.0 * 1e3;

/* ---- FSRSAlgorithm ---------------------------------------------------------- */

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// `computeDecayFactor(w)`. `Math.pow(decay, -1)` is fdlibm's `1 / decay` exactly.
fn decay_factor() -> (f64, f64) {
    let decay = -W[20];
    let factor = ((1.0 / decay) * 0.9f64.ln()).exp() - 1.0;
    (decay, round_to(factor, 8))
}

fn forgetting_curve(elapsed_days: f64, stability: f64) -> f64 {
    let (decay, factor) = decay_factor();
    round_to((1.0 + factor * elapsed_days / stability).powf(decay), 8)
}

fn interval_modifier() -> f64 {
    let (decay, factor) = decay_factor();
    round_to((REQUEST_RETENTION.powf(1.0 / decay) - 1.0) / factor, 8)
}

fn init_stability(g: Grade) -> f64 {
    W[g as usize - 1].max(0.1)
}

fn init_difficulty(g: Grade) -> f64 {
    round_to(W[4] - ((g.as_f64() - 1.0) * W[5]).exp() + 1.0, 8)
}

/// `next_interval` with `apply_fuzz` off: `Math.round` of an already-integral value.
///
/// `Math.min(Math.max(x, 1), max)` spelled with the same two calls rather than
/// `f64::clamp`, whose NaN and `min > max` behaviour differ from JavaScript's.
#[allow(clippy::manual_clamp)]
fn next_interval(s: f64) -> f64 {
    let interval = round(s * interval_modifier())
        .max(1.0)
        .min(MAXIMUM_INTERVAL);
    round(interval)
}

fn linear_damping(delta_d: f64, old_d: f64) -> f64 {
    round_to(delta_d * (10.0 - old_d) / 9.0, 8)
}

fn mean_reversion(init: f64, current: f64) -> f64 {
    round_to(W[7] * init + (1.0 - W[7]) * current, 8)
}

fn next_difficulty(d: f64, g: Grade) -> f64 {
    let delta_d = -W[6] * (g.as_f64() - 3.0);
    let next_d = d + linear_damping(delta_d, d);
    clamp(
        mean_reversion(init_difficulty(Grade::Easy), next_d),
        1.0,
        10.0,
    )
}

fn next_recall_stability(d: f64, s: f64, r: f64, g: Grade) -> f64 {
    let hard_penalty = if g == Grade::Hard { W[15] } else { 1.0 };
    let easy_bound = if g == Grade::Easy { W[16] } else { 1.0 };
    round_to(
        clamp(
            s * (1.0
                + W[8].exp()
                    * (11.0 - d)
                    * s.powf(-W[9])
                    * (((1.0 - r) * W[10]).exp() - 1.0)
                    * hard_penalty
                    * easy_bound),
            S_MIN,
            S_MAX,
        ),
        8,
    )
}

fn next_forget_stability(d: f64, s: f64, r: f64) -> f64 {
    round_to(
        clamp(
            W[11] * d.powf(-W[12]) * ((s + 1.0).powf(W[13]) - 1.0) * ((1.0 - r) * W[14]).exp(),
            S_MIN,
            S_MAX,
        ),
        8,
    )
}

fn next_short_term_stability(s: f64, g: Grade) -> f64 {
    let sinc = s.powf(-W[19]) * (W[17] * (g.as_f64() - 3.0 + W[18])).exp();
    let masked_sinc = if g >= Grade::Hard {
        sinc.max(1.0)
    } else {
        sinc
    };
    round_to(clamp(s * masked_sinc, S_MIN, S_MAX), 8)
}

/// `next_state`: the memory state after one review, as `(difficulty, stability)`.
fn next_state(d: f64, s: f64, t: f64, g: Grade, r: Option<f64>) -> Result<(f64, f64), String> {
    if d == 0.0 && s == 0.0 {
        return Ok((clamp(init_difficulty(g), 1.0, 10.0), init_stability(g)));
    }
    if d < 1.0 || s < S_MIN {
        return Err(format!(
            "Invalid memory state {{ difficulty: {}, stability: {} }}",
            crate::js::number_to_string(d),
            crate::js::number_to_string(s)
        ));
    }
    let r = r.unwrap_or_else(|| forgetting_curve(t, s));
    let new_s = if t == 0.0 {
        next_short_term_stability(s, g)
    } else if g == Grade::Again {
        let s_after_fail = next_forget_stability(d, s, r);
        let next_s_min = s / (W[17] * W[18]).exp();
        clamp(round_to(next_s_min, 8), S_MIN, s_after_fail)
    } else {
        next_recall_stability(d, s, r, g)
    };
    Ok((next_difficulty(d, g), new_s))
}

/* ---- BasicScheduler --------------------------------------------------------- */

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
        match self.last.state {
            NEW => {
                let mut next = self.next_ds(grade, None)?;
                self.apply_learning_steps(&mut next, grade, LEARNING);
                Ok(next)
            }
            LEARNING | RELEARNING => {
                let mut next = self.next_ds(grade, None)?;
                self.apply_learning_steps(&mut next, grade, self.last.state);
                Ok(next)
            }
            REVIEW => self.review_state(grade),
            state => Err(format!("Invalid state:[{state}]")),
        }
    }

    fn next_ds(&self, grade: Grade, r: Option<f64>) -> Result<FsrsCardState, String> {
        let (difficulty, stability) = next_state(
            self.current.difficulty,
            self.current.stability,
            self.elapsed_days as f64,
            grade,
            r,
        )?;
        let mut card = self.current.clone();
        card.difficulty = difficulty;
        card.stability = stability;
        Ok(card)
    }

    fn apply_learning_steps(&self, next: &mut FsrsCardState, grade: Grade, to_state: i64) {
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
                let interval = next_interval(next.stability);
                next.scheduled_days = interval as i64;
                next.due = self.review_time + interval * DAY;
            }
        }
    }

    fn review_state(&self, grade: Grade) -> Result<FsrsCardState, String> {
        let retrievability = forgetting_curve(self.elapsed_days as f64, self.current.stability);
        let mut again = self.next_ds(Grade::Again, Some(retrievability))?;
        let mut hard = self.next_ds(Grade::Hard, Some(retrievability))?;
        let mut good = self.next_ds(Grade::Good, Some(retrievability))?;
        let mut easy = self.next_ds(Grade::Easy, Some(retrievability))?;

        let mut hard_interval = next_interval(hard.stability);
        let mut good_interval = next_interval(good.stability);
        hard_interval = hard_interval.min(good_interval);
        good_interval = good_interval.max(hard_interval + 1.0);
        let easy_interval = next_interval(easy.stability).max(good_interval + 1.0);
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

        self.apply_learning_steps(&mut again, Grade::Again, RELEARNING);
        again.lapses += 1;

        Ok(match grade {
            Grade::Again => again,
            Grade::Hard => hard,
            Grade::Good => good,
            Grade::Easy => easy,
        })
    }
}

/// `reviewCard`: the state after grading `state` at `now` — `fsrs().next(card, now, grade).card`.
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
    fn the_broad_fixture_card_folds_bit_for_bit() {
        // `broad`: item-ni, introduced at T0, Good nine minutes later, then Hard
        // ninety seconds after that — the card `expected.json` records.
        let good = review_card(&new_card_state(T0), Grade::Good, T0 + 540_000.0).unwrap();
        assert_eq!(good.stability, 2.3065);
        assert_eq!(good.difficulty, 2.11810397);
        assert_eq!(good.state, LEARNING);
        assert_eq!(good.learning_steps, 1);
        assert_eq!(good.due, T0 + 540_000.0 + 10.0 * MINUTE);

        let hard = review_card(&good, Grade::Hard, T0 + 630_000.0).unwrap();
        assert_eq!(
            hard,
            FsrsCardState {
                due: 1710062250000.0,
                stability: 2.3065,
                difficulty: 4.75285849,
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
    fn learning_steps_follow_the_defaults() {
        // New → Again: 1 minute. New → Hard: round(5.5) = 6 minutes. New → Easy: graduates.
        let again = review_card(&new_card_state(T0), Grade::Again, T0).unwrap();
        assert_eq!(again.due, T0 + MINUTE);
        let hard = review_card(&new_card_state(T0), Grade::Hard, T0).unwrap();
        assert_eq!(hard.due, T0 + 6.0 * MINUTE);
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
        let again = review_card(&card, Grade::Again, later).unwrap();
        assert_eq!(again.lapses, card.lapses + 1);
        assert_eq!(again.state, RELEARNING);
        assert_eq!(again.due, later + 10.0 * MINUTE);
        assert_eq!(again.elapsed_days, 30);
    }

    #[test]
    fn rejects_a_grade_ts_fsrs_would_throw_on() {
        assert!(Grade::from_f64(0.0).is_err());
        assert!(Grade::from_f64(2.5).is_err());
        assert_eq!(Grade::from_f64(4.0), Ok(Grade::Easy));
    }
}
