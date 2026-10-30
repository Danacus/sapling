//! The difficulty model the app served with before ratings: one skill per
//! word and one difficulty per challenge as shown, moved by a fixed rate times
//! the surprise. Kept only so the calibration command and the simulations can
//! still score it beside the prototypes.
//!
//! ```text
//! chance = memory × sigmoid(skill − difficulty)
//! difficulty = base(kind, help level) + slope(kind) × length + correction(row)
//! ```

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

pub use crate::model::{length_of, logit, part_key, sigmoid, words_in, Aim, Evidence, Observation};

use crate::help::{HelpLevel, Step};
use crate::kinds::WireType;
pub use crate::research::sim::{starting_base, starting_slope};

/// How a challenge about several words combines their skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiWord {
    /// The weakest word decides.
    Lowest,
    /// The words' average decides.
    Average,
}

pub const MULTI_WORD: MultiWord = MultiWord::Average;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Aims {
    pub easier: f64,
    pub normal: f64,
    pub harder: f64,
}

/// The band around the aim a remembered chance may sit in, in points either side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub below: f64,
    pub above: f64,
}

/// How fast each kind of learned number moves per unit of surprise.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rates {
    pub word: f64,
    pub shared: f64,
    pub challenge: f64,
}

#[derive(Debug)]
pub struct Tuning {
    pub aims: Aims,
    pub window: Window,
    pub rates: Rates,
    pub new_word_memory: f64,
    /// The chance a brand-new word, remembered, manages the easiest question.
    pub new_word_chance: f64,
    /// What hiding the reading adds to a help level's starting number.
    pub hidden: f64,
    /// What listening adds to a type's `plain` starting number.
    pub listening: f64,
}

const TUNING: Tuning = Tuning {
    aims: Aims {
        easier: 0.97,
        normal: 0.89,
        harder: 0.78,
    },
    window: Window {
        below: 0.17,
        above: 0.04,
    },
    rates: Rates {
        word: 0.2,
        shared: 0.02,
        challenge: 0.1,
    },
    new_word_memory: 0.9,
    new_word_chance: 0.9,
    hidden: 0.6,
    listening: 0.8,
};

pub fn tuning() -> &'static Tuning {
    &TUNING
}

/// The chance an aim asks for *given the word is remembered*.
pub fn target(aim: Aim) -> f64 {
    let aims = &tuning().aims;
    match aim {
        Aim::Easier => aims.easier,
        Aim::Normal => aims.normal,
        Aim::Harder => aims.harder,
    }
}

/// The remembered chances a pick may land on: the aim, less and more.
pub fn window(aim: Aim) -> (f64, f64) {
    let target = target(aim);
    let w = &tuning().window;
    ((target - w.below).max(0.0), (target + w.above).min(1.0))
}

/// A brand-new word's skill: just above the easiest help level of the easiest kind.
pub fn starting_skill() -> f64 {
    let easiest = WireType::ALL
        .into_iter()
        .filter(|kind| kind.is_active())
        .map(|kind| starting_base(kind, HelpLevel::step(Step::Plain)) + starting_slope(kind))
        .fold(f64::INFINITY, f64::min);
    easiest + logit(tuning().new_word_chance)
}

/// The numbers every challenge shares, as learned.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shared {
    /// By [`part_key`]: `cloze/pick-6`.
    pub bases: BTreeMap<String, f64>,
    /// By kind: `cloze`.
    pub slopes: BTreeMap<String, f64>,
}

impl Shared {
    pub fn base(&self, kind: WireType, help: HelpLevel) -> f64 {
        self.bases
            .get(&part_key(kind, help))
            .copied()
            .unwrap_or_else(|| starting_base(kind, help))
    }

    pub fn slope(&self, kind: WireType) -> f64 {
        self.slopes
            .get(kind.as_str())
            .copied()
            .unwrap_or_else(|| starting_slope(kind))
    }

    pub fn difficulty(&self, kind: WireType, help: HelpLevel, length: f64, correction: f64) -> f64 {
        self.base(kind, help) + self.slope(kind) * length + correction
    }
}

/// The product of the words' memories, times how likely the combined skill
/// is to manage this difficulty.
pub fn chance(memories: &[f64], skills: &[f64], difficulty: f64, multi: MultiWord) -> f64 {
    let Some(skill) = combined(skills, multi) else {
        return 0.0;
    };
    let memory: f64 = memories.iter().map(|m| m.clamp(0.0, 1.0)).product();
    memory * sigmoid(skill - difficulty)
}

pub fn combined(skills: &[f64], multi: MultiWord) -> Option<f64> {
    if skills.is_empty() {
        return None;
    }
    Some(match multi {
        MultiWord::Lowest => skills.iter().copied().fold(f64::INFINITY, f64::min),
        MultiWord::Average => skills.iter().sum::<f64>() / skills.len() as f64,
    })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Learner {
    pub shared: Shared,
    pub skills: HashMap<String, f64>,
    pub corrections: HashMap<String, f64>,
}

const LIMIT: f64 = 12.0;

impl Learner {
    pub fn skill(&self, item_id: &str) -> f64 {
        self.skills
            .get(item_id)
            .copied()
            .unwrap_or_else(starting_skill)
    }

    pub fn correction(&self, challenge_id: &str) -> f64 {
        self.corrections.get(challenge_id).copied().unwrap_or(0.0)
    }

    pub fn difficulty_of(&self, o: &Observation) -> f64 {
        self.shared
            .difficulty(o.kind, o.help, o.length, self.correction(&o.challenge_id))
    }

    pub fn predict(&self, o: &Observation, multi: MultiWord) -> f64 {
        let memories: Vec<f64> = o.words.iter().map(|w| w.memory).collect();
        let skills: Vec<f64> = o.words.iter().map(|w| self.skill(&w.item_id)).collect();
        chance(&memories, &skills, self.difficulty_of(o), multi)
    }

    /// Folds one answer in; answers the chance it was predicted at.
    pub fn learn(&mut self, o: &Observation, rates: &Rates, multi: MultiWord) -> f64 {
        let predicted = self.predict(o, multi);
        let surprise = o.outcome - predicted;
        for word in &o.words {
            let skill = self.skill(&word.item_id) + rates.word * surprise;
            self.skills
                .insert(word.item_id.clone(), skill.clamp(-LIMIT, LIMIT));
        }
        let key = part_key(o.kind, o.help);
        let base = self.shared.base(o.kind, o.help) - rates.shared * surprise;
        self.shared.bases.insert(key, base.clamp(-LIMIT, LIMIT));
        let slope = self.shared.slope(o.kind) - rates.shared * surprise * o.length / 10.0;
        self.shared
            .slopes
            .insert(o.kind.as_str().to_owned(), slope.clamp(-1.0, 1.0));
        let correction = self.correction(&o.challenge_id) - rates.challenge * surprise;
        self.corrections
            .insert(o.challenge_id.clone(), correction.clamp(-LIMIT, LIMIT));
        predicted
    }
}

pub fn fold(observations: &[Observation]) -> Learner {
    let mut learner = Learner::default();
    let rates = tuning().rates;
    for o in observations {
        learner.learn(o, &rates, MULTI_WORD);
    }
    learner
}

/// One band of the calibration table: answers predicted in `[from, to)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Band {
    pub from: f64,
    pub to: f64,
    pub answers: usize,
    pub predicted: f64,
    pub actual: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Score {
    pub answers: usize,
    /// Mean log loss: lower is better; always guessing 50% scores 0.693.
    pub log_loss: f64,
    pub bands: Vec<Band>,
}

/// Replays the answers in order, predicting each before learning from it.
pub fn evaluate(observations: &[Observation], rates: &Rates, multi: MultiWord) -> (Learner, Score) {
    let mut learner = Learner::default();
    let mut loss = 0.0;
    let mut sums = [(0usize, 0.0f64, 0.0f64); 10];
    for o in observations {
        let p = learner.learn(o, rates, multi).clamp(0.01, 0.99);
        loss -= o.outcome * p.ln() + (1.0 - o.outcome) * (1.0 - p).ln();
        let band = ((p * 10.0) as usize).min(9);
        sums[band].0 += 1;
        sums[band].1 += p;
        sums[band].2 += o.outcome;
    }
    let answers = observations.len();
    let bands = sums
        .iter()
        .enumerate()
        .filter(|(_, (n, _, _))| *n > 0)
        .map(|(i, (n, p, y))| Band {
            from: i as f64 / 10.0,
            to: (i + 1) as f64 / 10.0,
            answers: *n,
            predicted: p / *n as f64,
            actual: y / *n as f64,
        })
        .collect();
    let log_loss = if answers == 0 {
        0.0
    } else {
        loss / answers as f64
    };
    (
        learner,
        Score {
            answers,
            log_loss,
            bands,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(outcome: f64, memory: f64) -> Observation {
        Observation {
            at: 0.0,
            challenge_id: "c".into(),
            kind: WireType::Cloze,
            help: HelpLevel::step(Step::Pick6),
            length: 6.0,
            words: vec![Evidence {
                item_id: "w".into(),
                memory,
                stability: 0.0,
            }],
            outcome,
        }
    }

    #[test]
    fn a_surprising_miss_moves_more_than_an_expected_one() {
        let rates = tuning().rates;
        let mut sure = Learner::default();
        let before = sure.skill("w");
        sure.learn(&observation(0.0, 1.0), &rates, MULTI_WORD);
        let mut forgot = Learner::default();
        forgot.learn(&observation(0.0, 0.05), &rates, MULTI_WORD);
        assert!(before - sure.skill("w") > 5.0 * (before - forgot.skill("w")));
    }

    #[test]
    fn evaluation_scores_a_perfect_guess_better_than_a_bad_one() {
        let hard: Vec<Observation> = (0..50).map(|_| observation(0.0, 1.0)).collect();
        let frozen = Rates {
            word: 0.0,
            shared: 0.0,
            challenge: 0.0,
        };
        let (_, worse) = evaluate(&hard, &frozen, MULTI_WORD);
        let (_, better) = evaluate(&hard, &tuning().rates, MULTI_WORD);
        assert!(better.log_loss < worse.log_loss);
    }
}
