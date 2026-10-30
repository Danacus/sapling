//! Difficulty by ratings (`docs/challenge-difficulty.md`), a prototype beside
//! `model.rs`: the calibration command scores it and the closed-loop
//! simulation serves with it (`ratings_policy.rs`); the app does not.
//!
//! Every word has a rating (how well the learner can use it) and every
//! challenge type at a help level has one (how hard it is). A right answer's
//! chance is `sigmoid(word − challenge)`, the words' average for a challenge
//! about several. Each rating has a margin, how sure it is: answers shrink it,
//! days without an answer widen it again, never past where it started.
//!
//! After an answer every rating in it moves by Glicko-1's step: by how
//! surprising the answer was, more when its own margin is wide, less when the
//! other side's is (an answer against an unsure opponent says less).

use std::collections::BTreeMap;
use std::f64::consts::PI;

use crate::kinds::WireType;
use crate::research::v1::{part_key, sigmoid, Observation};

const DAY: f64 = 86_400_000.0;

/// Where a word's rating comes from (§5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordSource {
    /// Its own rating, learned from its answers.
    Own,
    /// `scale · ln(1 + stability) + base`: FSRS's stability, with two
    /// numbers shared by every word and none per word.
    Stability,
    /// The same, plus an own rating that starts at zero and corrects it.
    StabilityAndOwn,
}

/// Everything not learned. A new challenge type starts at 0; `word_start` is
/// how far above that a new word starts, so `sigmoid(word_start)` is the chance
/// a new word is given on a new type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    pub word_start: f64,
    pub word_margin: f64,
    pub challenge_margin: f64,
    /// What a margin² widens by per day without an answer.
    pub widen: f64,
    pub words: WordSource,
    /// Off in the bare model; `calibrate` turns them on one at a time.
    pub extras: crate::research::ratings_extras::Extras,
}

impl Default for Settings {
    /// Chosen on the simulated learners (`calibrate --simulated --seeds 10
    /// --model ratings --search`).
    fn default() -> Self {
        Settings {
            word_start: 0.5,
            word_margin: 0.5,
            challenge_margin: 1.5,
            widen: 0.005,
            words: WordSource::Own,
            extras: Default::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    Word(String),
    /// By `part_key`: `cloze/typed`.
    Challenge(String),
    /// The stability scale and base every word shares.
    Scale,
    Base,
    /// A number an extra adds (`ratings_extras.rs`).
    Extra(String),
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

/// One rating's part in a chance: `z = Σ weight · rating`.
#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub key: Key,
    pub weight: f64,
    /// Its value and margin before any answer.
    pub start: (f64, f64),
}

/// Glicko's `g`: how much an unsure match is flattened towards 50%.
fn flatten(margin_squared: f64) -> f64 {
    1.0 / (1.0 + 3.0 * margin_squared / (PI * PI)).sqrt()
}

#[derive(Debug, Clone)]
pub struct Ratings {
    pub settings: Settings,
    ratings: BTreeMap<Key, Rating>,
}

impl Ratings {
    pub fn new(settings: Settings) -> Self {
        Ratings {
            settings,
            ratings: BTreeMap::new(),
        }
    }

    pub fn all(&self) -> &BTreeMap<Key, Rating> {
        &self.ratings
    }

    /// A rating as of `now`: its margin widened by the days since its last
    /// answer, or its start if it has none. Only words and challenge types
    /// change while unanswered; the numbers every word shares, and the
    /// extras, never widen.
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
        if matches!(key, Key::Scale | Key::Base | Key::Extra(_)) {
            return *r;
        }
        let days = ((now - r.at) / DAY).max(0.0);
        let widened = (r.margin.powi(2) + self.settings.widen * days).sqrt();
        Rating {
            margin: widened.min(r.start_margin).max(r.margin),
            ..*r
        }
    }

    /// What the chance of `o` is made of.
    pub fn terms(&self, o: &Observation) -> Vec<Term> {
        let s = &self.settings;
        let mut terms: Vec<Term> = Vec::new();
        let mut add = |key: Key, weight: f64, start: (f64, f64)| match terms
            .iter_mut()
            .find(|t| t.key == key)
        {
            Some(t) => t.weight += weight,
            None => terms.push(Term { key, weight, start }),
        };
        let share = 1.0 / o.words.len().max(1) as f64;
        for w in &o.words {
            let own = Key::Word(w.item_id.clone());
            match s.words {
                WordSource::Own => add(own, share, (s.word_start, s.word_margin)),
                WordSource::Stability | WordSource::StabilityAndOwn => {
                    add(Key::Scale, share * w.stability.ln_1p(), (0.5, 0.5));
                    add(Key::Base, share, (s.word_start, s.word_margin));
                    if s.words == WordSource::StabilityAndOwn {
                        add(own, share, (0.0, s.word_margin));
                    }
                }
            }
        }
        add(
            Key::Challenge(part_key(o.kind, o.help)),
            -1.0,
            (0.0, s.challenge_margin),
        );
        self.add_extras(o, &mut terms);
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
        self.chance_of(&self.terms(o), o.at)
    }

    pub fn chance_of(&self, terms: &[Term], now: f64) -> f64 {
        let (_, z, spread) = self.sum(terms, now);
        sigmoid(flatten(spread) * z)
    }

    /// Moves every rating in the answer; answers the chance it was given.
    pub fn learn(&mut self, o: &Observation) -> f64 {
        let terms = self.terms(o);
        let predicted = self.chance_of(&terms, o.at);
        let (ratings, z, spread) = self.sum(&terms, o.at);
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

    /// Makes every help level of `kind` rate `by` harder than learned, held
    /// as sure as a few dozen answers would: the simulation's trap.
    pub fn mislead(&mut self, kind: WireType, by: f64, at: f64) {
        let margin = self.settings.challenge_margin;
        for step in kind.written_steps() {
            let key = Key::Challenge(part_key(kind, crate::help::HelpLevel::step(step)));
            let r = self.rating(&key, (0.0, margin), at);
            let misled = Rating {
                value: r.value + by,
                margin: r.margin.min(0.3),
                at,
                ..r
            };
            self.ratings.insert(key, misled);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::{HelpLevel, Step};
    use crate::research::v1::Evidence;

    fn answer(word: &str, outcome: f64, at: f64) -> Observation {
        Observation {
            at,
            challenge_id: "c".into(),
            kind: WireType::Cloze,
            help: HelpLevel::step(Step::Typed),
            length: 6.0,
            words: vec![Evidence {
                item_id: word.into(),
                memory: 1.0,
                stability: 3.0,
            }],
            outcome,
        }
    }

    fn get(r: &Ratings, key: Key) -> Rating {
        r.all()[&key]
    }
    fn word(id: &str) -> Key {
        Key::Word(id.into())
    }
    fn typed() -> Key {
        Key::Challenge("cloze/typed".into())
    }

    #[test]
    fn a_new_word_on_a_new_type_gets_the_start_chance_flattened_by_both_margins() {
        let r = Ratings::new(Settings::default());
        let s = r.settings;
        let spread = s.word_margin.powi(2) + s.challenge_margin.powi(2);
        let expected = sigmoid(flatten(spread) * s.word_start);
        assert!((r.chance(&answer("w", 1.0, 0.0)) - expected).abs() < 1e-12);
    }

    #[test]
    fn a_success_raises_the_word_and_lowers_the_challenge_and_a_surprise_moves_more() {
        let mut up = Ratings::new(Settings::default());
        up.learn(&answer("w", 1.0, 0.0));
        let mut down = Ratings::new(Settings::default());
        down.learn(&answer("w", 0.0, 0.0));
        let start = Settings::default().word_start;
        assert!(get(&up, word("w")).value > start && get(&up, typed()).value < 0.0);
        assert!(get(&down, word("w")).value < start && get(&down, typed()).value > 0.0);
        // A new word is expected to succeed, so a miss is the bigger surprise.
        assert!(get(&down, typed()).value.abs() > get(&up, typed()).value.abs());
    }

    #[test]
    fn margins_shrink_with_answers_and_widen_with_days_up_to_the_start() {
        let mut r = Ratings::new(Settings::default());
        let mut last = f64::INFINITY;
        for i in 0..20 {
            r.learn(&answer(&format!("w{i}"), f64::from(i % 3 != 0), 0.0));
            assert!(get(&r, typed()).margin < last);
            last = get(&r, typed()).margin;
        }
        let start = (0.0, Settings::default().challenge_margin);
        let week = r.rating(&typed(), start, 7.0 * DAY).margin;
        let decade = r.rating(&typed(), start, 3650.0 * DAY).margin;
        assert!(last < week && week < decade);
        assert_eq!(decade, Settings::default().challenge_margin);
    }

    /// The wider side moves more: a new word against a well-known type moves
    /// the word, hardly the type.
    #[test]
    fn the_unsure_side_takes_the_move() {
        let mut r = Ratings::new(Settings::default());
        for i in 0..300 {
            r.learn(&answer(&format!("w{i}"), f64::from(i % 5 != 0), 0.0));
        }
        let before = get(&r, typed()).value;
        r.learn(&answer("new", 0.0, 0.0));
        let moved_word = Settings::default().word_start - get(&r, word("new")).value;
        let moved_type = get(&r, typed()).value - before;
        assert!(moved_word > 10.0 * moved_type && moved_type > 0.0);
    }

    #[test]
    fn several_words_are_judged_by_their_average() {
        let mut r = Ratings::new(Settings::default());
        for _ in 0..20 {
            r.learn(&answer("strong", 1.0, 0.0));
            r.learn(&answer("weak", 0.0, 0.0));
        }
        let mut both = answer("strong", 1.0, 0.0);
        both.words.push(Evidence {
            item_id: "weak".into(),
            memory: 1.0,
            stability: 3.0,
        });
        let (strong, weak) = (
            r.chance(&answer("strong", 1.0, 0.0)),
            r.chance(&answer("weak", 1.0, 0.0)),
        );
        let pair = r.chance(&both);
        assert!(weak < pair && pair < strong);
    }

    /// From stability alone, a word reviewed into a long interval reads
    /// stronger than a new one once the scale has learned that it should.
    #[test]
    fn stability_alone_rates_words_with_no_number_per_word() {
        let settings = Settings {
            words: WordSource::Stability,
            ..Settings::default()
        };
        let mut r = Ratings::new(settings);
        for i in 0..400 {
            let mut o = answer(&format!("w{i}"), 0.0, 0.0);
            o.words[0].stability = if i % 2 == 0 { 30.0 } else { 0.0 };
            o.outcome = f64::from(i % 2 == 0 || i % 7 == 0);
            r.learn(&o);
        }
        assert!(!r.all().keys().any(|k| matches!(k, Key::Word(_))));
        let mut sure = answer("x", 0.0, 0.0);
        sure.words[0].stability = 30.0;
        let mut new = answer("y", 0.0, 0.0);
        new.words[0].stability = 0.0;
        assert!(r.chance(&sure) > r.chance(&new) + 0.2);
    }
}
