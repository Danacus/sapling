//! The difficulty model (`docs/challenge-difficulty.md`): ratings with margins.
//!
//! A right answer's chance is `sigmoid(word − challenge − slope × (length −
//! centre))`. A word's side is `scale · ln(1 + stability) + base`, FSRS's
//! stability with two numbers every word shares; a challenge's side is one
//! rating per kind and help level; each kind has a length slope. Every rating
//! has a margin, how sure it is: answers shrink it, and a challenge rating's
//! widens again with days unanswered, never past where it started. An answer
//! moves every rating in it by Glicko-1's step.
//!
//! All of it is a function of the answers in log order, so it is derived data
//! the core keeps (`sapling-db`'s `learned.rs`).

use std::collections::BTreeMap;
use std::f64::consts::PI;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::kinds::WireType;
use crate::model::{part_key, sigmoid, tuning, Observation};
use crate::rng::Rng;

const DAY: f64 = 86_400_000.0;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    /// By `part_key`: `cloze/typed`.
    Challenge(String),
    /// The stability scale and base every word shares.
    Scale,
    Base,
    /// A kind's length slope, by kind: `cloze`.
    Slope(String),
}

impl Key {
    /// How it is stored: `challenge:cloze/typed`, `scale`, `base`, `slope:cloze`.
    pub fn stored(&self) -> String {
        match self {
            Key::Challenge(k) => format!("challenge:{k}"),
            Key::Scale => "scale".into(),
            Key::Base => "base".into(),
            Key::Slope(k) => format!("slope:{k}"),
        }
    }

    pub fn parse(stored: &str) -> Option<Key> {
        match stored {
            "scale" => Some(Key::Scale),
            "base" => Some(Key::Base),
            _ => {
                if let Some(k) = stored.strip_prefix("challenge:") {
                    Some(Key::Challenge(k.to_owned()))
                } else {
                    stored
                        .strip_prefix("slope:")
                        .map(|k| Key::Slope(k.to_owned()))
                }
            }
        }
    }

    /// Only a challenge rating widens with time: the numbers every word or
    /// every row of a kind shares are moved by every answer.
    fn widens(&self) -> bool {
        matches!(self, Key::Challenge(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rating {
    pub value: f64,
    pub margin: f64,
    /// The margin it started at: as wide as it ever gets again.
    pub start_margin: f64,
    /// When it was last in an answer.
    pub at: f64,
    pub answers: u32,
}

/// One rating as stored and as it crosses to the planners.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StoredRating {
    pub key: String,
    pub value: f64,
    pub margin: f64,
    pub start_margin: f64,
    pub at: f64,
    pub answers: u32,
}

/// One rating's part in a chance: `z = Σ weight · rating`.
#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub key: Key,
    pub weight: f64,
    /// Its value and margin before any answer.
    pub start: (f64, f64),
}

/// A length is read from the middle of its kind's range, so a slope and a
/// challenge rating are close to independent.
pub fn centre(kind: WireType) -> f64 {
    kind.lengths()
        .map_or(6.0, |[a, b]| (f64::from(a) + f64::from(b)) / 2.0)
}

/// Glicko's `g`: how much an unsure match is flattened towards 50%.
fn flatten(margin_squared: f64) -> f64 {
    1.0 / (1.0 + 3.0 * margin_squared / (PI * PI)).sqrt()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ratings {
    ratings: BTreeMap<Key, Rating>,
}

impl Ratings {
    /// The stored rows; a key this build does not know is left out.
    pub fn from_stored(rows: &[StoredRating]) -> Self {
        let ratings = rows
            .iter()
            .filter_map(|r| {
                let rating = Rating {
                    value: r.value,
                    margin: r.margin,
                    start_margin: r.start_margin,
                    at: r.at,
                    answers: r.answers,
                };
                Some((Key::parse(&r.key)?, rating))
            })
            .collect();
        Ratings { ratings }
    }

    pub fn stored(&self) -> Vec<StoredRating> {
        self.ratings
            .iter()
            .map(|(key, r)| StoredRating {
                key: key.stored(),
                value: r.value,
                margin: r.margin,
                start_margin: r.start_margin,
                at: r.at,
                answers: r.answers,
            })
            .collect()
    }

    pub fn all(&self) -> &BTreeMap<Key, Rating> {
        &self.ratings
    }

    pub fn insert(&mut self, key: Key, rating: Rating) {
        self.ratings.insert(key, rating);
    }

    /// A rating as of `now`: a challenge rating's margin widened by the days
    /// since its last answer, or its start if it has none.
    pub fn rating(&self, key: &Key, start: (f64, f64), now: f64) -> Rating {
        let Some(r) = self.ratings.get(key) else {
            return Rating {
                value: start.0,
                margin: start.1,
                start_margin: start.1,
                at: now,
                answers: 0,
            };
        };
        if !key.widens() {
            return *r;
        }
        let days = ((now - r.at) / DAY).max(0.0);
        let widened = (r.margin.powi(2) + tuning().widen * days).sqrt();
        Rating {
            margin: widened.min(r.start_margin).max(r.margin),
            ..*r
        }
    }

    /// What the chance of `o` is made of.
    pub fn terms(&self, o: &Observation) -> Vec<Term> {
        let t = tuning();
        let mut terms: Vec<Term> = Vec::new();
        let mut add = |key: Key, weight: f64, start: (f64, f64)| match terms
            .iter_mut()
            .find(|t| t.key == key)
        {
            Some(t) => t.weight += weight,
            None => terms.push(Term { key, weight, start }),
        };
        let share = 1.0 / o.words.len().max(1) as f64;
        let scale = (t.scale_start[0], t.scale_start[1]);
        for w in &o.words {
            add(Key::Scale, share * w.stability.max(0.0).ln_1p(), scale);
            add(Key::Base, share, (t.word_start, t.word_margin));
        }
        add(
            Key::Challenge(part_key(o.kind, o.help)),
            -1.0,
            (0.0, t.challenge_margin),
        );
        add(
            Key::Slope(o.kind.as_str().to_owned()),
            -(o.length - centre(o.kind)),
            (t.slope_start[0], t.slope_start[1]),
        );
        terms
    }

    /// The match's difference `z` and its summed squared margin.
    fn sum(&self, terms: &[Term], now: f64) -> (Vec<Rating>, f64, f64) {
        let ratings: Vec<Rating> = terms
            .iter()
            .map(|t| self.rating(&t.key, t.start, now))
            .collect();
        let z = terms
            .iter()
            .zip(&ratings)
            .map(|(t, r)| t.weight * r.value)
            .sum();
        let spread = terms
            .iter()
            .zip(&ratings)
            .map(|(t, r)| (t.weight * r.margin).powi(2))
            .sum();
        (ratings, z, spread)
    }

    /// The chance of a right answer, flattened by how unsure the match is.
    pub fn chance(&self, o: &Observation) -> f64 {
        let (_, z, spread) = self.sum(&self.terms(o), o.at);
        sigmoid(flatten(spread) * z)
    }

    /// Moves every rating in the answer; answers the chance it was given.
    pub fn learn(&mut self, o: &Observation) -> f64 {
        let terms = self.terms(o);
        let (ratings, z, spread) = self.sum(&terms, o.at);
        let predicted = sigmoid(flatten(spread) * z);
        for (t, r) in terms.iter().zip(ratings) {
            // Glicko-1: the rest of the match is the opponent.
            let g = flatten(spread - (t.weight * r.margin).powi(2));
            let expected = sigmoid(g * z);
            let information = (t.weight * g).powi(2) * expected * (1.0 - expected);
            let margin_squared = 1.0 / (1.0 / r.margin.powi(2) + information);
            let rating = Rating {
                value: r.value + margin_squared * t.weight * g * (o.outcome - expected),
                margin: margin_squared.sqrt(),
                at: o.at,
                answers: r.answers + 1,
                ..r
            };
            self.ratings.insert(t.key.clone(), rating);
        }
        predicted
    }
}

/// One pick's roll: each challenge rating drawn once within its margin, the
/// rest at their values. Something well known rolls close to itself; something
/// unsure rolls wide and now and then into reach, which is the only exploration.
pub struct Roll<'a> {
    ratings: &'a Ratings,
    now: f64,
    rng: &'a mut Rng,
    rolled: BTreeMap<Key, f64>,
}

impl<'a> Roll<'a> {
    pub fn new(ratings: &'a Ratings, now: f64, rng: &'a mut Rng) -> Self {
        Roll {
            ratings,
            now,
            rng,
            rolled: BTreeMap::new(),
        }
    }

    pub fn chance(&mut self, o: &Observation) -> f64 {
        let mut z = 0.0;
        for t in self.ratings.terms(o) {
            let r = self.ratings.rating(&t.key, t.start, self.now);
            let value = if t.key.widens() {
                let rng = &mut *self.rng;
                *self
                    .rolled
                    .entry(t.key)
                    .or_insert_with(|| r.value + r.margin * rng.gaussian())
            } else {
                r.value
            };
            z += t.weight * value;
        }
        sigmoid(z)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::help::{HelpLevel, Step};
    use crate::model::Evidence;

    pub(crate) fn answer(kind: WireType, help: HelpLevel, outcome: f64, at: f64) -> Observation {
        Observation {
            at,
            challenge_id: "c".into(),
            kind,
            help,
            length: centre(kind),
            words: vec![Evidence {
                item_id: "w".into(),
                memory: 1.0,
                stability: 3.0,
            }],
            outcome,
        }
    }

    fn typed(outcome: f64, at: f64) -> Observation {
        answer(WireType::Cloze, HelpLevel::step(Step::Typed), outcome, at)
    }
    fn key() -> Key {
        Key::Challenge("cloze/typed".into())
    }

    #[test]
    fn a_success_lowers_the_challenge_and_raises_the_shared_word_numbers() {
        let mut r = Ratings::default();
        r.learn(&typed(1.0, 0.0));
        assert!(r.all()[&key()].value < 0.0);
        assert!(r.all()[&Key::Base].value > tuning().word_start);
        assert!(r.all()[&Key::Scale].value > tuning().scale_start[0]);
        assert!(!r
            .all()
            .keys()
            .any(|k| matches!(k, Key::Challenge(c) if c != "cloze/typed")));
    }

    #[test]
    fn margins_shrink_with_answers_and_a_challenges_widens_with_days_up_to_the_start() {
        let mut r = Ratings::default();
        let mut last = f64::INFINITY;
        for i in 0..20 {
            r.learn(&typed(f64::from(i % 3 != 0), 0.0));
            assert!(r.all()[&key()].margin < last);
            last = r.all()[&key()].margin;
        }
        let start = (0.0, tuning().challenge_margin);
        let week = r.rating(&key(), start, 7.0 * DAY).margin;
        let decade = r.rating(&key(), start, 3650.0 * DAY).margin;
        assert!(last < week && week < decade);
        assert_eq!(decade, tuning().challenge_margin);
        let base = r.all()[&Key::Base];
        assert_eq!(r.rating(&Key::Base, (0.0, 1.0), 3650.0 * DAY), base);
    }

    #[test]
    fn a_longer_row_reads_harder_once_the_slope_has_learned_it() {
        let mut r = Ratings::default();
        for i in 0..200 {
            let mut o = typed(0.0, 0.0);
            o.length = if i % 2 == 0 { 4.0 } else { 10.0 };
            o.outcome = f64::from(o.length < 5.0 || i % 7 == 0);
            r.learn(&o);
        }
        let at = |length: f64| {
            let mut o = typed(0.0, 0.0);
            o.length = length;
            r.chance(&o)
        };
        assert!(at(4.0) > at(10.0) + 0.2);
    }

    #[test]
    fn a_word_with_a_long_interval_reads_stronger_once_the_scale_has_learned_it() {
        let mut r = Ratings::default();
        for i in 0..400 {
            let mut o = typed(0.0, 0.0);
            o.words[0].stability = if i % 2 == 0 { 30.0 } else { 0.0 };
            o.outcome = f64::from(i % 2 == 0 || i % 7 == 0);
            r.learn(&o);
        }
        let with = |stability: f64| {
            let mut o = typed(0.0, 0.0);
            o.words[0].stability = stability;
            r.chance(&o)
        };
        assert!(with(30.0) > with(0.0) + 0.2);
    }

    #[test]
    fn stored_ratings_read_back_and_an_unknown_key_is_left_out() {
        let mut r = Ratings::default();
        r.learn(&typed(1.0, 5.0));
        let mut rows = r.stored();
        assert_eq!(Ratings::from_stored(&rows), r);
        rows.push(StoredRating {
            key: "row:x".into(),
            value: 1.0,
            margin: 1.0,
            start_margin: 1.0,
            at: 0.0,
            answers: 1,
        });
        assert_eq!(Ratings::from_stored(&rows), r);
        for key in [Key::Scale, Key::Base, key(), Key::Slope("cloze".into())] {
            assert_eq!(Key::parse(&key.stored()), Some(key));
        }
    }

    #[test]
    fn a_roll_replays_under_its_seed_and_rolls_one_key_once() {
        let r = Ratings::default();
        let o = typed(0.0, 0.0);
        let roll = |seed| {
            let mut rng = Rng::seeded(seed);
            let mut roll = Roll::new(&r, 0.0, &mut rng);
            (roll.chance(&o), roll.chance(&o))
        };
        let (a, b) = roll(9);
        assert_eq!(a, b);
        assert_eq!(roll(9), (a, b));
        assert_ne!(roll(10).0, a);
    }
}
