//! A second difficulty model, a research prototype beside `model.rs` and wired
//! into nothing: the calibration command scores it and the closed-loop
//! simulation steers with it (`policy_v2.rs`), and that is all.
//!
//! Same shape as the first — `chance = memory × sigmoid(skill − difficulty)`,
//! difficulty a shared part, a length term and the row's correction — but every
//! learned number is a belief, a mean and a variance:
//!
//! - **Prediction** averages the sigmoid over the predictor's variance
//!   (MacKay's probit approximation), so an uncertain number predicts nearer 50%.
//! - **An answer** is one Kalman step on the likelihood linearised at the
//!   prediction (a Laplace step), projected back onto independent beliefs: each
//!   number moves, and gains precision, by its share of the predictor's
//!   variance. With one number it is Glicko's `precision += h`.
//! - **Unobserved, a belief drifts back** towards its prior's variance, linearly
//!   in days, so a verdict nobody has tested for a while is uncertain again and
//!   a sampling policy retests it.
//! - **Priors are the same for every kind**: no per-kind starting number decides
//!   anything unless [`Prior::Starting`] asks for one, as a comparison.

use std::collections::BTreeMap;
use std::f64::consts::PI;

use crate::help::HelpLevel;
use crate::kinds::WireType;
use crate::model::{
    logit, part_key, sigmoid, starting_base, starting_skill, starting_slope, tuning, Band,
    Observation,
};

const DAY: f64 = 86_400_000.0;

/// Where a number no answer has touched starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prior {
    /// One mean for every word, one for every part.
    Global,
    /// The mean of what has been learned so far for that class of number.
    Empirical,
    /// `type.json`'s starting values: the first model's, for comparison only.
    Starting,
}

/// What a kind and help level's difficulty is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parts {
    /// One number per kind and help level.
    Flat,
    /// A number per kind plus one per step id (shared by every kind that
    /// declares that step), per hidden reading and per listening, plus a small
    /// residual per kind and help level.
    Factored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Length {
    /// A slope per kind, learned.
    Learned,
    /// [`GLOBAL_SLOPE`] for every kind, never learned.
    Fixed,
    /// No length term.
    Off,
}

/// How FSRS's retrievability enters a prediction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Memory {
    /// `memory × sigmoid(…)`, as the first model.
    Product,
    /// `sigmoid(… + w·(logit memory − logit 0.9))`, `w` learned.
    Feature,
    /// Left out: skill absorbs it.
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Config {
    pub prior: Prior,
    pub parts: Parts,
    pub length: Length,
    pub memory: Memory,
    /// Prior standard deviations, in logits.
    pub skill_sd: f64,
    pub part_sd: f64,
    pub row_sd: f64,
    /// Days an unobserved belief takes to drift all the way back to its
    /// prior's variance; infinite is no drift.
    pub skill_forget: f64,
    pub part_forget: f64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            prior: Prior::Global,
            parts: Parts::Flat,
            length: Length::Learned,
            memory: Memory::Product,
            skill_sd: 1.0,
            part_sd: 2.0,
            row_sd: 0.5,
            skill_forget: 90.0,
            part_forget: 60.0,
        }
    }
}

/// The slope every kind's prior (or fixed slope) shares: `type.json`'s common value.
pub const GLOBAL_SLOPE: f64 = 0.12;
const SLOPE_SD: f64 = 0.1;
const RESIDUAL_SD: f64 = 0.5;
const MEMORY_SD: f64 = 0.5;

/// A length is read from the middle of its kind's range, so a slope and a base
/// are close to independent and the diagonal posterior loses little.
pub fn centre(kind: WireType) -> f64 {
    kind.lengths()
        .map_or(6.0, |[a, b]| (f64::from(a) + f64::from(b)) / 2.0)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    Skill(String),
    /// By `part_key`: `cloze/pick-6`.
    Part(String),
    Kind(&'static str),
    /// A step id, `hidden` or `listening`.
    Step(&'static str),
    Slope(&'static str),
    Row(String),
    Memory,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Belief {
    pub mean: f64,
    pub var: f64,
    /// The prior's variance: what drift is bounded by.
    pub cap: f64,
    /// When last observed.
    pub at: f64,
    pub answers: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct Term {
    pub key: Key,
    pub coef: f64,
    /// Mean and variance when nothing is known.
    pub prior: (f64, f64),
}

/// `z = offset + Σ coef·θ`; the chance is `memory × sigmoid(z)`.
#[derive(Debug, Clone)]
pub(crate) struct Linear {
    pub terms: Vec<Term>,
    pub offset: f64,
    pub memory: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct Tally {
    sum: f64,
    count: usize,
}

impl Tally {
    fn mean(&self) -> Option<f64> {
        (self.count > 0).then(|| self.sum / self.count as f64)
    }
}

#[derive(Debug, Clone)]
pub struct ModelV2 {
    pub config: Config,
    beliefs: BTreeMap<Key, Belief>,
    skills: Tally,
    parts: Tally,
}

impl ModelV2 {
    pub fn new(config: Config) -> Self {
        ModelV2 {
            config,
            beliefs: BTreeMap::new(),
            skills: Tally::default(),
            parts: Tally::default(),
        }
    }

    pub fn beliefs(&self) -> &BTreeMap<Key, Belief> {
        &self.beliefs
    }

    fn forget(&self, key: &Key) -> f64 {
        match key {
            Key::Skill(_) => self.config.skill_forget,
            Key::Part(_) | Key::Kind(_) | Key::Step(_) | Key::Slope(_) => self.config.part_forget,
            Key::Row(_) | Key::Memory => f64::INFINITY,
        }
    }

    /// The belief as of `now`: stored and drifted, or the prior.
    pub(crate) fn belief(&self, key: &Key, prior: (f64, f64), now: f64) -> Belief {
        match self.beliefs.get(key) {
            Some(b) => {
                let days = ((now - b.at) / DAY).max(0.0);
                let grown = b.var + b.cap * days / self.forget(key);
                Belief {
                    var: grown.min(b.cap).max(b.var),
                    ..*b
                }
            }
            None => Belief {
                mean: prior.0,
                var: prior.1,
                cap: prior.1,
                at: now,
                answers: 0,
            },
        }
    }

    fn tally(&mut self, key: &Key) -> Option<&mut Tally> {
        match (key, self.config.parts) {
            (Key::Skill(_), _) => Some(&mut self.skills),
            (Key::Part(_), Parts::Flat) | (Key::Kind(_), Parts::Factored) => Some(&mut self.parts),
            _ => None,
        }
    }

    fn set(&mut self, key: Key, belief: Belief) {
        let old = self.beliefs.get(&key).map(|b| b.mean);
        if let Some(tally) = self.tally(&key) {
            match old {
                Some(old) => tally.sum += belief.mean - old,
                None => {
                    tally.count += 1;
                    tally.sum += belief.mean;
                }
            }
        }
        self.beliefs.insert(key, belief);
    }

    fn skill_prior(&self) -> (f64, f64) {
        let global = logit(tuning().new_word_chance);
        let mean = match self.config.prior {
            Prior::Global => global,
            Prior::Empirical => self.skills.mean().unwrap_or(global),
            Prior::Starting => starting_skill(),
        };
        (mean, self.config.skill_sd.powi(2))
    }

    /// A part's (or, factored, a kind's) prior mean.
    fn part_mean(&self, kind: WireType, help: HelpLevel) -> f64 {
        match self.config.prior {
            Prior::Global => 0.0,
            Prior::Empirical => self.parts.mean().unwrap_or(0.0),
            Prior::Starting => starting_base(kind, help) + starting_slope(kind) * centre(kind),
        }
    }

    fn slope_mean(&self, kind: WireType) -> f64 {
        match self.config.prior {
            Prior::Starting => starting_slope(kind),
            _ => GLOBAL_SLOPE,
        }
    }

    /// The linear predictor of `o`. Without memory it is the chance *given the
    /// word is remembered*, what a pick is judged by. A row with an empty id
    /// is one not written yet: no correction.
    pub(crate) fn linear(&self, o: &Observation, with_memory: bool) -> Linear {
        let c = &self.config;
        let mut terms: Vec<Term> = Vec::with_capacity(o.words.len() + 6);
        let mut push = |key: Key, coef: f64, prior: (f64, f64)| match terms
            .iter_mut()
            .find(|t| t.key == key)
        {
            Some(t) => t.coef += coef,
            None => terms.push(Term { key, coef, prior }),
        };
        let n = o.words.len().max(1) as f64;
        let skill = self.skill_prior();
        for w in &o.words {
            push(Key::Skill(w.item_id.clone()), 1.0 / n, skill);
        }
        let part = (self.part_mean(o.kind, o.help), c.part_sd.powi(2));
        match c.parts {
            Parts::Flat => push(Key::Part(part_key(o.kind, o.help)), -1.0, part),
            Parts::Factored => {
                let first = o
                    .kind
                    .written_steps()
                    .first()
                    .copied()
                    .unwrap_or(o.help.step);
                let kind_mean = match c.prior {
                    Prior::Starting => self.part_mean(o.kind, HelpLevel::step(first)),
                    _ => part.0,
                };
                let wide = (0.0, c.part_sd.powi(2));
                push(Key::Kind(o.kind.as_str()), -1.0, (kind_mean, part.1));
                push(Key::Step(o.help.step.as_str()), -1.0, wide);
                if o.help.reading_hidden {
                    push(Key::Step("hidden"), -1.0, wide);
                }
                if o.help.listening {
                    push(Key::Step("listening"), -1.0, wide);
                }
                let residual = match c.prior {
                    Prior::Starting => part.0 - kind_mean,
                    _ => 0.0,
                };
                push(
                    Key::Part(part_key(o.kind, o.help)),
                    -1.0,
                    (residual, RESIDUAL_SD.powi(2)),
                );
            }
        }
        let from_centre = o.length - centre(o.kind);
        let mut offset = 0.0;
        match c.length {
            Length::Learned => push(
                Key::Slope(o.kind.as_str()),
                -from_centre,
                (self.slope_mean(o.kind), SLOPE_SD.powi(2)),
            ),
            Length::Fixed => offset -= self.slope_mean(o.kind) * from_centre,
            Length::Off => {}
        }
        if !o.challenge_id.is_empty() {
            push(
                Key::Row(o.challenge_id.clone()),
                -1.0,
                (0.0, c.row_sd.powi(2)),
            );
        }
        let remembered: f64 = o.words.iter().map(|w| w.memory.clamp(1e-3, 1.0)).product();
        let mut memory = 1.0;
        if with_memory {
            match c.memory {
                Memory::Product => memory = remembered,
                Memory::Feature => push(
                    Key::Memory,
                    logit(remembered) - logit(tuning().new_word_memory),
                    (1.0, MEMORY_SD.powi(2)),
                ),
                Memory::Off => {}
            }
        }
        Linear {
            terms,
            offset,
            memory,
        }
    }

    fn moments(&self, linear: &Linear, at: f64) -> (Vec<Belief>, f64, f64) {
        let beliefs: Vec<Belief> = linear
            .terms
            .iter()
            .map(|t| self.belief(&t.key, t.prior, at))
            .collect();
        let mean = linear.offset
            + linear
                .terms
                .iter()
                .zip(&beliefs)
                .map(|(t, b)| t.coef * b.mean)
                .sum::<f64>();
        let var = linear
            .terms
            .iter()
            .zip(&beliefs)
            .map(|(t, b)| t.coef * t.coef * b.var)
            .sum::<f64>();
        (beliefs, mean, var)
    }

    /// The predictive chance of a correct answer, memory included.
    pub fn predict(&self, o: &Observation) -> f64 {
        let linear = self.linear(o, true);
        let (_, mean, var) = self.moments(&linear, o.at);
        linear.memory * probit(mean, var)
    }

    /// The predictive chance given the word is remembered.
    pub fn remembered(&self, o: &Observation) -> f64 {
        let linear = self.linear(o, false);
        let (_, mean, var) = self.moments(&linear, o.at);
        probit(mean, var)
    }

    /// Folds one answer in; answers the chance it was predicted at.
    pub fn learn(&mut self, o: &Observation) -> f64 {
        let linear = self.linear(o, true);
        let (beliefs, mean, var) = self.moments(&linear, o.at);
        let s = probit(mean, var);
        let p = (linear.memory * s).clamp(1e-6, 1.0 - 1e-6);
        // The likelihood's gradient and Fisher information in z: `y − p` and
        // `p(1 − p)` when memory is 1.
        let dp = linear.memory * s * (1.0 - s);
        let g = (o.outcome - p) * dp / (p * (1.0 - p));
        let h = dp * dp / (p * (1.0 - p));
        let denominator = 1.0 + h * var;
        for (term, b) in linear.terms.into_iter().zip(beliefs) {
            let k = b.var * term.coef;
            let belief = Belief {
                mean: b.mean + k * g / denominator,
                var: (b.var - k * k * h / denominator).max(1e-6),
                at: o.at,
                answers: b.answers + 1,
                ..b
            };
            self.set(term.key, belief);
        }
        p
    }

    /// Makes a kind and help level read `by` harder than the model believes,
    /// held with the confidence of a few dozen answers: the simulation's trap.
    pub fn mislead(&mut self, kind: WireType, help: HelpLevel, by: f64, at: f64) {
        let probe = Observation {
            at,
            challenge_id: String::new(),
            kind,
            help,
            length: centre(kind),
            words: Vec::new(),
            outcome: 0.0,
        };
        let wanted = match self.config.parts {
            Parts::Flat => Key::Part(part_key(kind, help)),
            Parts::Factored => Key::Kind(kind.as_str()),
        };
        for term in self.linear(&probe, false).terms {
            if term.key != wanted {
                continue;
            }
            let b = self.belief(&term.key, term.prior, at);
            let belief = Belief {
                mean: b.mean + by,
                var: b.var.min(0.1),
                at,
                ..b
            };
            self.set(term.key, belief);
        }
    }
}

/// `E[sigmoid(z)]` for `z ~ N(mean, var)`.
pub fn probit(mean: f64, var: f64) -> f64 {
    sigmoid(mean / (1.0 + PI * var / 8.0).sqrt())
}

/* ---- Scoring ------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq)]
pub struct ScoreV2 {
    pub answers: usize,
    pub log_loss: f64,
    pub brier: f64,
    pub bands: Vec<Band>,
}

/// Log loss, Brier and the calibration bands of `(predicted, outcome)` pairs,
/// each prediction clamped to 1–99% as `model.rs`' evaluation clamps it.
pub fn score(pairs: &[(f64, f64)]) -> ScoreV2 {
    let mut loss = 0.0;
    let mut brier = 0.0;
    let mut sums = [(0usize, 0.0f64, 0.0f64); 10];
    for &(p, y) in pairs {
        let p = p.clamp(0.01, 0.99);
        loss -= y * p.ln() + (1.0 - y) * (1.0 - p).ln();
        brier += (p - y).powi(2);
        let band = ((p * 10.0) as usize).min(9);
        sums[band].0 += 1;
        sums[band].1 += p;
        sums[band].2 += y;
    }
    let n = pairs.len().max(1) as f64;
    ScoreV2 {
        answers: pairs.len(),
        log_loss: loss / n,
        brier: brier / n,
        bands: sums
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
            .collect(),
    }
}

/// Replays the answers in order, predicting each before learning from it.
pub fn evaluate(observations: &[Observation], config: Config) -> (ModelV2, ScoreV2) {
    let mut model = ModelV2::new(config);
    let pairs: Vec<(f64, f64)> = observations
        .iter()
        .map(|o| (model.learn(o), o.outcome))
        .collect();
    (model, score(&pairs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::model::Evidence;

    fn observation(outcome: f64, at: f64) -> Observation {
        Observation {
            at,
            challenge_id: "c".into(),
            kind: WireType::Cloze,
            help: HelpLevel::step(Step::Pick6),
            length: 7.0,
            words: vec![Evidence {
                item_id: "w".into(),
                memory: 1.0,
            }],
            outcome,
        }
    }

    fn part(model: &ModelV2) -> Belief {
        model.beliefs()[&Key::Part("cloze/pick-6".into())]
    }
    fn skill(model: &ModelV2) -> Belief {
        model.beliefs()[&Key::Skill("w".into())]
    }

    #[test]
    fn a_success_raises_skill_and_lowers_difficulty_and_a_miss_the_reverse() {
        let mut up = ModelV2::new(Config::default());
        let before = up.remembered(&observation(1.0, 0.0));
        up.learn(&observation(1.0, 0.0));
        assert!(skill(&up).mean > up.skill_prior().0);
        assert!(part(&up).mean < 0.0);
        assert!(up.remembered(&observation(1.0, 0.0)) > before);
        let mut down = ModelV2::new(Config::default());
        down.learn(&observation(0.0, 0.0));
        assert!(skill(&down).mean < down.skill_prior().0);
        assert!(part(&down).mean > 0.0);
        // A miss on a likely success moves further than a success did.
        assert!(part(&down).mean.abs() > part(&up).mean.abs());
    }

    #[test]
    fn variance_shrinks_with_answers_and_grows_back_with_time() {
        let mut model = ModelV2::new(Config::default());
        let mut last = f64::INFINITY;
        for i in 0..20 {
            model.learn(&observation(f64::from(i % 2), 0.0));
            assert!(part(&model).var < last);
            last = part(&model).var;
        }
        let o = observation(1.0, 0.0);
        let now = model.belief(&Key::Part("cloze/pick-6".into()), (0.0, 0.0), 0.0);
        let month = model.belief(&Key::Part("cloze/pick-6".into()), (0.0, 0.0), 30.0 * DAY);
        let year = model.belief(&Key::Part("cloze/pick-6".into()), (0.0, 0.0), 365.0 * DAY);
        assert!(month.var > now.var && year.var > month.var);
        assert!((year.var - Config::default().part_sd.powi(2)).abs() < 1e-9);
        assert_eq!(month.mean, now.mean);
        // Uncertainty pulls a prediction towards even.
        let mut later = o.clone();
        later.at = 365.0 * DAY;
        let (sure, unsure) = (model.remembered(&o), model.remembered(&later));
        assert!((unsure - 0.5).abs() < (sure - 0.5).abs());
    }

    #[test]
    fn a_shared_answer_moves_the_uncertain_number_most() {
        let mut model = ModelV2::new(Config::default());
        // Settle the part with many words, then meet a new word on it.
        for i in 0..200 {
            let mut o = observation(1.0, 0.0);
            o.words[0].item_id = format!("w{i}");
            o.challenge_id = format!("c{i}");
            model.learn(&o);
        }
        let settled = part(&model);
        let mut o = observation(0.0, 0.0);
        o.words[0].item_id = "new".into();
        o.challenge_id = "fresh".into();
        model.learn(&o);
        let moved_part = part(&model).mean - settled.mean;
        let moved_skill = model.beliefs()[&Key::Skill("new".into())].mean - model.skill_prior().0;
        assert!(moved_part > 0.0 && moved_skill < 0.0);
        assert!(
            moved_skill.abs() > 3.0 * moved_part.abs(),
            "{moved_skill} {moved_part}"
        );
    }

    #[test]
    fn a_miss_low_memory_explains_moves_skill_little() {
        let mut sure = ModelV2::new(Config::default());
        sure.learn(&observation(0.0, 0.0));
        let mut forgot = ModelV2::new(Config::default());
        let mut o = observation(0.0, 0.0);
        o.words[0].memory = 0.05;
        forgot.learn(&o);
        let prior = sure.skill_prior().0;
        assert!(prior - skill(&sure).mean > 5.0 * (prior - skill(&forgot).mean));
    }

    #[test]
    fn the_empirical_prior_follows_what_was_learned() {
        let config = Config {
            prior: Prior::Empirical,
            ..Config::default()
        };
        let mut model = ModelV2::new(config);
        for _ in 0..30 {
            model.learn(&observation(0.0, 0.0));
        }
        // A kind never seen starts where the learned parts sit, not at zero.
        let mut other = observation(0.0, 0.0);
        other.kind = WireType::WordOrder;
        other.help = HelpLevel::step(Step::Tiles);
        let terms = model.linear(&other, false).terms;
        let prior = terms
            .iter()
            .find(|t| matches!(t.key, Key::Part(_)))
            .unwrap()
            .prior;
        assert!(prior.0 > 0.5, "{prior:?}");
    }

    #[test]
    fn every_ablation_learns_and_scores() {
        let log: Vec<Observation> = (0..300)
            .map(|i| {
                let mut o = observation(f64::from(i % 5 != 0), f64::from(i) * DAY / 10.0);
                o.words[0].memory = 0.7 + 0.3 * f64::from(i % 3) / 2.0;
                o.challenge_id = format!("c{}", i % 40);
                o
            })
            .collect();
        for parts in [Parts::Flat, Parts::Factored] {
            for length in [Length::Learned, Length::Fixed, Length::Off] {
                for memory in [Memory::Product, Memory::Feature, Memory::Off] {
                    for prior in [Prior::Global, Prior::Empirical, Prior::Starting] {
                        let config = Config {
                            prior,
                            parts,
                            length,
                            memory,
                            ..Config::default()
                        };
                        let (_, s) = evaluate(&log, config);
                        assert!(s.log_loss < 0.693 && s.brier < 0.25, "{config:?}: {s:?}");
                    }
                }
            }
        }
    }
}
