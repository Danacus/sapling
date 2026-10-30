//! A second difficulty model, a research prototype beside `model.rs` and wired
//! into nothing: the calibration command scores it and the closed-loop
//! simulation steers with it (`policy_v2.rs`), and that is all.
//!
//! Same shape as the first — the chance is `sigmoid(skill − difficulty)`,
//! memory a learned term, difficulty a shared part, a length term and the
//! row's correction — but every learned number is a belief:
//!
//! - **The shared numbers** (parts, slopes, the memory weight: a few dozen)
//!   carry a full covariance, and every word's skill carries its covariance
//!   with them. Skills are independent of each other and row corrections of
//!   everything. That keeps the one correlation that matters: a skill and the
//!   parts it was answered on explain the same answers, and a part's own
//!   uncertainty is what is left once the words are accounted for.
//! - **An answer** is one Kalman step on the likelihood linearised at the
//!   prediction (a Laplace step). With [`Config::joint`] off, the step is
//!   projected back onto independent beliefs, as the prototype's first round.
//! - **Prediction** averages the sigmoid over the predictor's variance
//!   (MacKay's probit approximation).
//! - **Unobserved, a belief drifts back** towards its prior's variance,
//!   linearly in days, so a stale verdict is uncertain again.
//! - **Priors are the same for every kind.** [`Parts::Ordered`] adds structure
//!   that holds for every kind alike — a later step in a kind's list, a hidden
//!   reading and listening are harder — and no per-kind number. [`Prior::Starting`]
//!   reads `type.json`'s, as a comparison only.

use std::collections::BTreeMap;
use std::f64::consts::PI;

use crate::help::HelpLevel;
use crate::kinds::WireType;
use crate::model::{
    logit, part_key, sigmoid, starting_base, starting_skill, starting_slope, tuning, Band,
    Observation,
};
use crate::rng::Rng;
use crate::sim::gaussian;

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
    /// [`Parts::Factored`] with an ordered prior: a step starts [`STEP`]
    /// harder per place in its kind's list, a hidden reading `hidden` and
    /// listening `listening` (`data/model.json`) harder.
    Ordered,
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
    /// Keep the shared numbers' covariance and each skill's with them.
    pub joint: bool,
    /// Prior standard deviations, in logits.
    pub skill_sd: f64,
    pub part_sd: f64,
    pub row_sd: f64,
    /// Days an unobserved belief takes to drift all the way back to its
    /// prior's variance; infinite is no drift.
    pub skill_forget: f64,
    pub part_forget: f64,
}

impl Config {
    /// The prototype's first round: independent beliefs, memory multiplied in.
    pub const FIRST: Config = Config {
        prior: Prior::Global,
        parts: Parts::Flat,
        length: Length::Learned,
        memory: Memory::Product,
        joint: false,
        skill_sd: 1.0,
        part_sd: 2.0,
        row_sd: 0.5,
        skill_forget: 90.0,
        part_forget: 60.0,
    };
}

impl Default for Config {
    fn default() -> Self {
        Config {
            memory: Memory::Feature,
            joint: true,
            part_forget: 180.0,
            parts: Parts::Ordered,
            ..Config::FIRST
        }
    }
}

/// The slope every kind's prior (or fixed slope) shares: `type.json`'s common value.
pub const GLOBAL_SLOPE: f64 = 0.12;
/// What one place further down a kind's step list starts out adding.
pub const STEP: f64 = 0.8;
const SLOPE_SD: f64 = 0.1;
const RESIDUAL_SD: f64 = 0.5;
const ORDERED_SD: f64 = 0.5;
const ORDERED_RESIDUAL_SD: f64 = 0.3;
const MEMORY_SD: f64 = 0.5;
/// FSRS reads 1 within a day of a review (whole days elapsed); as a logit
/// that would be ±14, so a feature reads memory at most this sure.
const MEMORY_CEILING: f64 = 0.99;
const FLOOR: f64 = 1e-6;

/// A length is read from the middle of its kind's range, so a slope and a base
/// are close to independent.
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

impl Key {
    fn shared(&self) -> bool {
        !matches!(self, Key::Skill(_) | Key::Row(_))
    }
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

fn grown(var: f64, rate: f64, cap: f64, days: f64) -> f64 {
    if var >= cap {
        var
    } else {
        (var + rate * days.max(0.0)).min(cap)
    }
}

/// The shared numbers, jointly.
#[derive(Debug, Clone, Default)]
struct Block {
    keys: Vec<Key>,
    index: BTreeMap<Key, usize>,
    mean: Vec<f64>,
    cov: Vec<Vec<f64>>,
    cap: Vec<f64>,
    /// Variance gained per unobserved day.
    rate: Vec<f64>,
    seen: Vec<f64>,
    answers: Vec<u32>,
    /// When drift was last folded into `cov`.
    at: f64,
}

impl Block {
    fn len(&self) -> usize {
        self.keys.len()
    }

    fn cov_at(&self, i: usize, j: usize, now: f64) -> f64 {
        if i != j {
            return self.cov[i][j];
        }
        grown(
            self.cov[i][i],
            self.rate[i],
            self.cap[i],
            (now - self.at) / DAY,
        )
    }

    fn drift(&mut self, now: f64) {
        let days = (now - self.at) / DAY;
        for i in 0..self.len() {
            self.cov[i][i] = grown(self.cov[i][i], self.rate[i], self.cap[i], days);
        }
        self.at = self.at.max(now);
    }

    fn add(&mut self, key: Key, prior: (f64, f64), rate: f64, now: f64) -> usize {
        if self.keys.is_empty() {
            self.at = now;
        }
        let i = self.len();
        self.index.insert(key.clone(), i);
        self.keys.push(key);
        self.mean.push(prior.0);
        for row in &mut self.cov {
            row.push(0.0);
        }
        let mut row = vec![0.0; i + 1];
        row[i] = prior.1;
        self.cov.push(row);
        self.cap.push(prior.1);
        self.rate.push(rate);
        self.seen.push(now);
        self.answers.push(0);
        i
    }
}

/// A word's skill or a row's correction.
#[derive(Debug, Clone)]
struct Local {
    mean: f64,
    var: f64,
    cap: f64,
    rate: f64,
    at: f64,
    answers: u32,
    /// Covariance with the block, by its index; missing entries are zero.
    cross: Vec<f64>,
}

impl Local {
    fn new(prior: (f64, f64), rate: f64, at: f64) -> Self {
        Local {
            mean: prior.0,
            var: prior.1,
            cap: prior.1,
            rate,
            at,
            answers: 0,
            cross: Vec::new(),
        }
    }

    fn var_at(&self, now: f64) -> f64 {
        grown(self.var, self.rate, self.cap, (now - self.at) / DAY)
    }

    fn cross(&self, i: usize) -> f64 {
        self.cross.get(i).copied().unwrap_or(0.0)
    }

    fn belief(&self, now: f64) -> Belief {
        Belief {
            mean: self.mean,
            var: self.var_at(now),
            cap: self.cap,
            at: self.at,
            answers: self.answers,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelV2 {
    pub config: Config,
    block: Block,
    skills: BTreeMap<String, Local>,
    rows: BTreeMap<String, Local>,
    skill_sum: f64,
    parts_mean: Option<f64>,
    answers: usize,
}

/// Where a term lives.
enum Slot {
    Shared(usize),
    Skill(String),
    Row(String),
    /// Not seen yet: its prior.
    New,
}

impl ModelV2 {
    pub fn new(config: Config) -> Self {
        ModelV2 {
            config,
            block: Block::default(),
            skills: BTreeMap::new(),
            rows: BTreeMap::new(),
            skill_sum: 0.0,
            parts_mean: None,
            answers: 0,
        }
    }

    /// Answers learned from so far.
    pub fn answers(&self) -> usize {
        self.answers
    }

    fn rate(&self, key: &Key, cap: f64) -> f64 {
        let forget = match key {
            Key::Skill(_) => self.config.skill_forget,
            Key::Row(_) | Key::Memory => f64::INFINITY,
            _ => self.config.part_forget,
        };
        cap / forget
    }

    /// Every belief as of `now`.
    pub fn beliefs(&self, now: f64) -> BTreeMap<Key, Belief> {
        let mut out = BTreeMap::new();
        let b = &self.block;
        for (i, key) in b.keys.iter().enumerate() {
            out.insert(
                key.clone(),
                Belief {
                    mean: b.mean[i],
                    var: b.cov_at(i, i, now),
                    cap: b.cap[i],
                    at: b.seen[i],
                    answers: b.answers[i],
                },
            );
        }
        for (id, l) in &self.skills {
            out.insert(Key::Skill(id.clone()), l.belief(now));
        }
        for (id, l) in &self.rows {
            out.insert(Key::Row(id.clone()), l.belief(now));
        }
        out
    }

    fn skill_prior(&self) -> (f64, f64) {
        let global = logit(tuning().new_word_chance);
        let mean = match self.config.prior {
            Prior::Global => global,
            Prior::Empirical if !self.skills.is_empty() => {
                self.skill_sum / self.skills.len() as f64
            }
            Prior::Empirical => global,
            Prior::Starting => starting_skill(),
        };
        (mean, self.config.skill_sd.powi(2))
    }

    /// A part's (or, factored, a kind's) prior mean.
    fn part_mean(&self, kind: WireType, help: HelpLevel) -> f64 {
        match self.config.prior {
            Prior::Global => 0.0,
            Prior::Empirical => self.parts_mean.unwrap_or(0.0),
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
        if c.parts == Parts::Flat {
            push(Key::Part(part_key(o.kind, o.help)), -1.0, part);
        } else {
            let steps = o.kind.written_steps();
            let first = steps.first().copied().unwrap_or(o.help.step);
            let kind_mean = match c.prior {
                Prior::Starting => self.part_mean(o.kind, HelpLevel::step(first)),
                _ => part.0,
            };
            let ordered = c.parts == Parts::Ordered;
            let step = |mean: f64| {
                if ordered {
                    (mean, ORDERED_SD.powi(2))
                } else {
                    (0.0, c.part_sd.powi(2))
                }
            };
            let place = steps.iter().position(|s| *s == o.help.step).unwrap_or(0);
            push(Key::Kind(o.kind.as_str()), -1.0, (kind_mean, part.1));
            push(
                Key::Step(o.help.step.as_str()),
                -1.0,
                step(place as f64 * STEP),
            );
            if o.help.reading_hidden {
                push(Key::Step("hidden"), -1.0, step(tuning().hidden));
            }
            if o.help.listening {
                push(Key::Step("listening"), -1.0, step(tuning().listening));
            }
            let residual = match c.prior {
                Prior::Starting => part.0 - kind_mean,
                _ => 0.0,
            };
            let sd = if ordered {
                ORDERED_RESIDUAL_SD
            } else {
                RESIDUAL_SD
            };
            push(
                Key::Part(part_key(o.kind, o.help)),
                -1.0,
                (residual, sd.powi(2)),
            );
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
        // Without memory is *given the word is remembered*: the product's
        // other factor, or the feature read at the surest memory.
        let recalled = if with_memory { remembered } else { 1.0 };
        let mut memory = 1.0;
        match c.memory {
            Memory::Product => memory = recalled,
            Memory::Feature => push(
                Key::Memory,
                logit(recalled.min(MEMORY_CEILING)) - logit(tuning().new_word_memory),
                (1.0, MEMORY_SD.powi(2)),
            ),
            Memory::Off => {}
        }
        Linear {
            terms,
            offset,
            memory,
        }
    }

    fn slot(&self, key: &Key) -> Slot {
        match key {
            Key::Skill(id) if self.skills.contains_key(id) => Slot::Skill(id.clone()),
            Key::Row(id) if self.rows.contains_key(id) => Slot::Row(id.clone()),
            key if key.shared() => self
                .block
                .index
                .get(key)
                .map_or(Slot::New, |&i| Slot::Shared(i)),
            _ => Slot::New,
        }
    }

    /// The predictor's mean and variance as of `now`.
    fn moments(&self, linear: &Linear, now: f64) -> (f64, f64) {
        let (mut mean, mut var) = (linear.offset, 0.0);
        let mut shared: Vec<(usize, f64)> = Vec::new();
        let mut words: Vec<(&Local, f64)> = Vec::new();
        for t in &linear.terms {
            match self.slot(&t.key) {
                Slot::Shared(i) => {
                    mean += t.coef * self.block.mean[i];
                    shared.push((i, t.coef));
                }
                Slot::Skill(id) => {
                    let l = &self.skills[&id];
                    mean += t.coef * l.mean;
                    var += t.coef * t.coef * l.var_at(now);
                    words.push((l, t.coef));
                }
                Slot::Row(id) => {
                    let l = &self.rows[&id];
                    mean += t.coef * l.mean;
                    var += t.coef * t.coef * l.var_at(now);
                }
                Slot::New => {
                    mean += t.coef * t.prior.0;
                    var += t.coef * t.coef * t.prior.1;
                }
            }
        }
        for &(i, ci) in &shared {
            for &(j, cj) in &shared {
                var += ci * cj * self.block.cov_at(i, j, now);
            }
            for (l, cw) in &words {
                var += 2.0 * cw * ci * l.cross(i);
            }
        }
        (mean, var.max(0.0))
    }

    /// The predictive chance of a correct answer, memory included.
    pub fn predict(&self, o: &Observation) -> f64 {
        let linear = self.linear(o, true);
        let (mean, var) = self.moments(&linear, o.at);
        linear.memory * probit(mean, var)
    }

    /// The predictive chance given the word is remembered.
    pub fn remembered(&self, o: &Observation) -> f64 {
        let linear = self.linear(o, false);
        let (mean, var) = self.moments(&linear, o.at);
        probit(mean, var)
    }

    /// A kind and help level's difficulty at its kind's middle length, as of
    /// `now`: the mean and spread of everything it is made of, jointly.
    pub fn difficulty(&self, kind: WireType, help: HelpLevel, now: f64) -> (f64, f64) {
        let probe = Observation {
            at: now,
            challenge_id: String::new(),
            kind,
            help,
            length: centre(kind),
            words: Vec::new(),
            outcome: 0.0,
        };
        let (mean, var) = self.moments(&self.linear(&probe, false), now);
        (-mean, var.sqrt())
    }

    /// The spread of the remembered chance's predictor for `kind` and `help`
    /// at the middle length, averaged over the words with at least `answers`
    /// answers: the uncertainty a pick actually decides on.
    pub fn decision_sd(&self, kind: WireType, help: HelpLevel, answers: u32, now: f64) -> f64 {
        let sds: Vec<f64> = self
            .skills
            .iter()
            .filter(|(_, l)| l.answers >= answers)
            .map(|(id, _)| {
                let probe = Observation {
                    at: now,
                    challenge_id: String::new(),
                    kind,
                    help,
                    length: centre(kind),
                    words: vec![crate::model::Evidence {
                        item_id: id.clone(),
                        memory: 1.0,
                        stability: 0.0,
                    }],
                    outcome: 0.0,
                };
                self.moments(&self.linear(&probe, false), now).1.sqrt()
            })
            .collect();
        sds.iter().sum::<f64>() / sds.len().max(1) as f64
    }

    /// Folds one answer in; answers the chance it was predicted at.
    pub fn learn(&mut self, o: &Observation) -> f64 {
        let linear = self.linear(o, true);
        let now = o.at;
        self.block.drift(now);
        let mut a_s: Vec<(usize, f64)> = Vec::new();
        let mut words: Vec<(String, f64)> = Vec::new();
        let mut row: Option<(String, f64)> = None;
        for t in &linear.terms {
            match &t.key {
                Key::Skill(id) => {
                    if !self.skills.contains_key(id) {
                        let rate = self.rate(&t.key, t.prior.1);
                        self.skills
                            .insert(id.clone(), Local::new(t.prior, rate, now));
                        self.skill_sum += t.prior.0;
                    }
                    let l = self.skills.get_mut(id).expect("inserted");
                    l.var = l.var_at(now);
                    l.at = now;
                    words.push((id.clone(), t.coef));
                }
                Key::Row(id) => {
                    let rate = self.rate(&t.key, t.prior.1);
                    self.rows
                        .entry(id.clone())
                        .or_insert_with(|| Local::new(t.prior, rate, now));
                    row = Some((id.clone(), t.coef));
                }
                key => {
                    let i = match self.block.index.get(key) {
                        Some(&i) => i,
                        None => {
                            let rate = self.rate(key, t.prior.1);
                            self.block.add(key.clone(), t.prior, rate, now)
                        }
                    };
                    a_s.push((i, t.coef));
                }
            }
        }
        let n = self.block.len();
        let b = &self.block;
        let mut u_s = vec![0.0; n];
        let mut mean = linear.offset;
        for &(i, ci) in &a_s {
            mean += ci * b.mean[i];
            for (k, u) in u_s.iter_mut().enumerate() {
                *u += b.cov[k][i] * ci;
            }
        }
        let mut u_w = Vec::with_capacity(words.len());
        for (id, cw) in &words {
            let l = &self.skills[id];
            mean += cw * l.mean;
            for (k, u) in u_s.iter_mut().enumerate() {
                *u += cw * l.cross(k);
            }
            let dot: f64 = a_s.iter().map(|&(i, ci)| ci * l.cross(i)).sum();
            u_w.push(dot + cw * l.var);
        }
        let mut var: f64 = a_s.iter().map(|&(i, ci)| ci * u_s[i]).sum();
        var += words
            .iter()
            .zip(&u_w)
            .map(|((_, cw), u)| cw * u)
            .sum::<f64>();
        let u_r = row.as_ref().map(|(id, cr)| {
            let l = &self.rows[id];
            mean += cr * l.mean;
            var += cr * cr * l.var;
            cr * l.var
        });
        let var = var.max(0.0);

        let s = probit(mean, var);
        let p = (linear.memory * s).clamp(1e-6, 1.0 - 1e-6);
        // The likelihood's gradient and Fisher information in z: `y − p` and
        // `p(1 − p)` when memory is 1.
        let dp = linear.memory * s * (1.0 - s);
        let g = (o.outcome - p) * dp / (p * (1.0 - p));
        let h = dp * dp / (p * (1.0 - p));
        let d = 1.0 + h * var;
        let joint = self.config.joint;

        let b = &mut self.block;
        for k in 0..n {
            b.mean[k] += u_s[k] * g / d;
            if joint {
                for l in 0..n {
                    b.cov[k][l] -= u_s[k] * u_s[l] * h / d;
                }
            } else {
                b.cov[k][k] -= u_s[k] * u_s[k] * h / d;
            }
            b.cov[k][k] = b.cov[k][k].max(FLOOR);
        }
        for &(i, _) in &a_s {
            b.seen[i] = now;
            b.answers[i] += 1;
        }
        let observed: Vec<&String> = words.iter().map(|(id, _)| id).collect();
        for ((id, _), u) in words.iter().zip(&u_w) {
            let l = self.skills.get_mut(id).expect("inserted");
            l.mean += u * g / d;
            self.skill_sum += u * g / d;
            l.var = (l.var - u * u * h / d).max(FLOOR);
            l.answers += 1;
            if joint {
                l.cross.resize(n, 0.0);
                for (k, c) in l.cross.iter_mut().enumerate() {
                    *c -= u_s[k] * u * h / d;
                }
            }
        }
        if joint {
            // A word whose skill is tied to a part that moved moves with it.
            for (id, l) in self.skills.iter_mut() {
                if l.cross.is_empty() || observed.contains(&id) {
                    continue;
                }
                let k: f64 = a_s.iter().map(|&(i, ci)| ci * l.cross(i)).sum();
                if k == 0.0 {
                    continue;
                }
                l.mean += k * g / d;
                self.skill_sum += k * g / d;
                l.var = (l.var - k * k * h / d).max(FLOOR);
                l.cross.resize(n, 0.0);
                for (j, c) in l.cross.iter_mut().enumerate() {
                    *c -= u_s[j] * k * h / d;
                }
            }
        }
        if let (Some((id, _)), Some(u)) = (row, u_r) {
            let l = self.rows.get_mut(&id).expect("inserted");
            l.mean += u * g / d;
            l.var = (l.var - u * u * h / d).max(FLOOR);
            l.at = now;
            l.answers += 1;
        }
        self.tally_parts();
        self.answers += 1;
        p
    }

    fn tally_parts(&mut self) {
        let counted = |k: &Key| match self.config.parts {
            Parts::Flat => matches!(k, Key::Part(_)),
            _ => matches!(k, Key::Kind(_)),
        };
        let b = &self.block;
        let means: Vec<f64> = (0..b.len())
            .filter(|&i| counted(&b.keys[i]) && b.answers[i] > 0)
            .map(|i| b.mean[i])
            .collect();
        self.parts_mean =
            (!means.is_empty()).then(|| means.iter().sum::<f64>() / means.len() as f64);
    }

    /// Makes every help level of a kind read `by` harder than the model
    /// believes, held with the confidence of a few dozen answers: the
    /// simulation's trap.
    pub fn mislead(&mut self, kind: WireType, by: f64, at: f64) {
        let keys: Vec<Key> = match self.config.parts {
            Parts::Flat => kind
                .written_steps()
                .into_iter()
                .map(|step| Key::Part(part_key(kind, HelpLevel::step(step))))
                .collect(),
            _ => vec![Key::Kind(kind.as_str())],
        };
        self.block.drift(at);
        for (key, step) in keys.into_iter().zip(kind.written_steps()) {
            let probe = Observation {
                at,
                challenge_id: String::new(),
                kind,
                help: HelpLevel::step(step),
                length: centre(kind),
                words: Vec::new(),
                outcome: 0.0,
            };
            let Some(term) = self
                .linear(&probe, false)
                .terms
                .into_iter()
                .find(|t| t.key == key)
            else {
                continue;
            };
            let i = match self.block.index.get(&key) {
                Some(&i) => i,
                None => {
                    let rate = self.rate(&key, term.prior.1);
                    self.block.add(key, term.prior, rate, at)
                }
            };
            let b = &mut self.block;
            b.mean[i] += by;
            // Shrink the variance, keeping every correlation.
            let shrink = (0.1 / b.cov[i][i]).min(1.0).sqrt();
            for k in 0..b.len() {
                b.cov[i][k] *= shrink;
                b.cov[k][i] *= shrink;
            }
            for l in self.skills.values_mut() {
                if let Some(c) = l.cross.get_mut(i) {
                    *c *= shrink;
                }
            }
        }
        self.tally_parts();
    }
}

/// `E[sigmoid(z)]` for `z ~ N(mean, var)`.
pub fn probit(mean: f64, var: f64) -> f64 {
    sigmoid(mean / (1.0 + PI * var / 8.0).sqrt())
}

/* ---- Sampling ----------------------------------------------------------- */

/// The lower Cholesky factor of `a`, jittered until it exists.
fn cholesky(a: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = a.len();
    let mut jitter = 1e-9;
    loop {
        let mut l = vec![vec![0.0; n]; n];
        let mut ok = true;
        'rows: for i in 0..n {
            for j in 0..=i {
                let start = a[i][j] + if i == j { jitter } else { 0.0 };
                let s = l[i][..j]
                    .iter()
                    .zip(&l[j][..j])
                    .fold(start, |s, (x, y)| s - x * y);
                if i == j {
                    if s <= 0.0 {
                        ok = false;
                        break 'rows;
                    }
                    l[i][i] = s.sqrt();
                } else {
                    l[i][j] = s / l[j][j];
                }
            }
        }
        if ok {
            return l;
        }
        jitter *= 100.0;
    }
}

/// One posterior draw for a pick: the shared numbers drawn jointly once, a
/// row's correction (or a number not seen yet) drawn when first read, and a
/// word's skill either drawn from its distribution given the shared draw or
/// left as that distribution, its variance carried into the chance.
pub struct Draw<'a> {
    model: &'a ModelV2,
    now: f64,
    scale: f64,
    sample_skill: bool,
    rng: &'a mut Rng,
    theta: Vec<f64>,
    chol: Vec<Vec<f64>>,
    /// `Σ⁻¹ (θ − μ)`.
    pull: Vec<f64>,
    drawn: BTreeMap<Key, f64>,
}

impl<'a> Draw<'a> {
    /// Draws `scale` standard deviations wide; 1 is Thompson sampling.
    pub fn new(
        model: &'a ModelV2,
        now: f64,
        scale: f64,
        sample_skill: bool,
        rng: &'a mut Rng,
    ) -> Self {
        let b = &model.block;
        let n = b.len();
        let cov: Vec<Vec<f64>> = (0..n)
            .map(|i| (0..n).map(|j| b.cov_at(i, j, now)).collect())
            .collect();
        let chol = cholesky(&cov);
        let z: Vec<f64> = (0..n).map(|_| gaussian(rng)).collect();
        let theta: Vec<f64> = (0..n)
            .map(|i| b.mean[i] + scale * (0..=i).map(|k| chol[i][k] * z[k]).sum::<f64>())
            .collect();
        // Σ⁻¹ (θ − μ) = scale · L⁻ᵀ z.
        let mut pull = vec![0.0; n];
        for i in (0..n).rev() {
            let s: f64 = ((i + 1)..n).map(|k| chol[k][i] * pull[k]).sum();
            pull[i] = (z[i] - s) / chol[i][i];
        }
        for p in &mut pull {
            *p *= scale;
        }
        Draw {
            model,
            now,
            scale,
            sample_skill,
            rng,
            theta,
            chol,
            pull,
            drawn: BTreeMap::new(),
        }
    }

    fn independent(&mut self, key: &Key, mean: f64, var: f64) -> f64 {
        if let Some(v) = self.drawn.get(key) {
            return *v;
        }
        let v = mean + self.scale * var.sqrt() * gaussian(self.rng);
        self.drawn.insert(key.clone(), v);
        v
    }

    /// A skill's distribution given the shared draw.
    fn conditional(&self, l: &Local) -> (f64, f64) {
        if l.cross.is_empty() {
            return (l.mean, l.var_at(self.now));
        }
        let n = self.theta.len();
        let shift: f64 = (0..n).map(|i| l.cross(i) * self.pull[i]).sum();
        // ‖L⁻¹ c‖²: the part of the skill's variance the shared draw explains.
        let mut y = vec![0.0; n];
        for i in 0..n {
            let s: f64 = (0..i).map(|k| self.chol[i][k] * y[k]).sum();
            y[i] = (l.cross(i) - s) / self.chol[i][i];
        }
        let explained: f64 = y.iter().map(|v| v * v).sum();
        (l.mean + shift, (l.var_at(self.now) - explained).max(FLOOR))
    }

    /// The sampled remembered chance of `o`.
    pub fn chance(&mut self, o: &Observation) -> f64 {
        let model = self.model;
        let linear = model.linear(o, false);
        let (mut z, mut var) = (linear.offset, 0.0);
        for t in &linear.terms {
            let value = match model.slot(&t.key) {
                Slot::Shared(i) => self.theta[i],
                Slot::Skill(id) => {
                    let (mean, v) = self.conditional(&model.skills[&id]);
                    if self.sample_skill {
                        self.independent(&t.key, mean, v)
                    } else {
                        var += t.coef * t.coef * v;
                        mean
                    }
                }
                Slot::Row(id) => {
                    let l = &model.rows[&id];
                    self.independent(&t.key, l.mean, l.var_at(self.now))
                }
                Slot::New if matches!(t.key, Key::Skill(_)) && !self.sample_skill => {
                    var += t.coef * t.coef * t.prior.1;
                    t.prior.0
                }
                Slot::New => self.independent(&t.key, t.prior.0, t.prior.1),
            };
            z += t.coef * value;
        }
        probit(z, var)
    }
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
                stability: 0.0,
            }],
            outcome,
        }
    }

    /// Memory multiplied in: with every memory at 1, a learned memory
    /// weight could not be told from the parts' common level.
    fn flat(joint: bool) -> Config {
        Config {
            parts: Parts::Flat,
            memory: Memory::Product,
            joint,
            ..Config::default()
        }
    }

    const PART: &str = "cloze/pick-6";

    fn part(model: &ModelV2, at: f64) -> Belief {
        model.beliefs(at)[&Key::Part(PART.into())]
    }
    fn skill(model: &ModelV2, id: &str) -> Belief {
        model.beliefs(0.0)[&Key::Skill(id.into())]
    }

    #[test]
    fn a_success_raises_skill_and_lowers_difficulty_and_a_miss_the_reverse() {
        for joint in [false, true] {
            let mut up = ModelV2::new(flat(joint));
            let before = up.remembered(&observation(1.0, 0.0));
            up.learn(&observation(1.0, 0.0));
            assert!(skill(&up, "w").mean > up.skill_prior().0);
            assert!(part(&up, 0.0).mean < 0.0);
            assert!(up.remembered(&observation(1.0, 0.0)) > before);
            let mut down = ModelV2::new(flat(joint));
            down.learn(&observation(0.0, 0.0));
            assert!(skill(&down, "w").mean < down.skill_prior().0);
            assert!(part(&down, 0.0).mean > 0.0);
            // A miss on a likely success moves further than a success did.
            assert!(part(&down, 0.0).mean.abs() > part(&up, 0.0).mean.abs());
        }
    }

    #[test]
    fn variance_shrinks_with_answers_and_grows_back_with_time() {
        let mut model = ModelV2::new(flat(true));
        let mut last = f64::INFINITY;
        for i in 0..20 {
            model.learn(&observation(f64::from(i % 2), 0.0));
            assert!(part(&model, 0.0).var < last);
            last = part(&model, 0.0).var;
        }
        let (now, month, year) = (
            part(&model, 0.0),
            part(&model, 30.0 * DAY),
            part(&model, 365.0 * DAY),
        );
        assert!(month.var > now.var && year.var > month.var);
        assert!((year.var - Config::default().part_sd.powi(2)).abs() < 1e-9);
        assert_eq!(month.mean, now.mean);
        // Uncertainty pulls a prediction towards even.
        let o = observation(1.0, 0.0);
        let mut later = o.clone();
        later.at = 365.0 * DAY;
        let (sure, unsure) = (model.remembered(&o), model.remembered(&later));
        assert!((unsure - 0.5).abs() < (sure - 0.5).abs());
    }

    /// Answers only tell a part from its words' skills, so the part's own
    /// spread is what the words' priors pin it to: independent beliefs claim
    /// more than that, the joint ones do not, and both settle it.
    #[test]
    fn a_part_answered_by_many_words_settles_without_overclaiming() {
        let settle = |joint: bool| {
            let mut model = ModelV2::new(flat(joint));
            for i in 0..400 {
                let mut o = observation(f64::from(i % 5 != 0), 0.0);
                o.words[0].item_id = format!("w{}", i % 40);
                o.challenge_id = format!("c{i}");
                model.learn(&o);
            }
            part(&model, 0.0).var.sqrt()
        };
        let (apart, joint) = (settle(false), settle(true));
        assert!(apart < joint && joint < 0.3, "{joint} vs {apart}");
    }

    #[test]
    fn a_shared_answer_moves_the_uncertain_number_most() {
        let mut model = ModelV2::new(flat(true));
        for i in 0..200 {
            let mut o = observation(1.0, 0.0);
            o.words[0].item_id = format!("w{i}");
            o.challenge_id = format!("c{i}");
            model.learn(&o);
        }
        let settled = part(&model, 0.0);
        let mut o = observation(0.0, 0.0);
        o.words[0].item_id = "new".into();
        o.challenge_id = "fresh".into();
        model.learn(&o);
        let moved_part = part(&model, 0.0).mean - settled.mean;
        let moved_skill = skill(&model, "new").mean - model.skill_prior().0;
        assert!(moved_part > 0.0 && moved_skill < 0.0);
        assert!(
            moved_skill.abs() > 3.0 * moved_part.abs(),
            "{moved_skill} {moved_part}"
        );
    }

    /// A word answered on a part that later proves harder is read as having
    /// been stronger than it looked.
    #[test]
    fn a_part_that_moves_carries_its_words_with_it() {
        let mut model = ModelV2::new(flat(true));
        model.learn(&observation(0.0, 0.0));
        let before = skill(&model, "w").mean;
        for i in 0..30 {
            let mut o = observation(0.0, 0.0);
            o.words[0].item_id = format!("other{i}");
            o.challenge_id = format!("c{i}");
            model.learn(&o);
        }
        assert!(skill(&model, "w").mean > before);
    }

    #[test]
    fn a_miss_low_memory_explains_moves_skill_little() {
        for memory in [Memory::Product, Memory::Feature] {
            let config = Config {
                memory,
                ..Config::default()
            };
            let mut sure = ModelV2::new(config);
            sure.learn(&observation(0.0, 0.0));
            let mut forgot = ModelV2::new(config);
            let mut o = observation(0.0, 0.0);
            o.words[0].memory = 0.05;
            forgot.learn(&o);
            let prior = sure.skill_prior().0;
            assert!(
                prior - skill(&sure, "w").mean > 3.0 * (prior - skill(&forgot, "w").mean),
                "{memory:?}"
            );
        }
    }

    #[test]
    fn the_empirical_prior_follows_what_was_learned() {
        let config = Config {
            prior: Prior::Empirical,
            ..flat(true)
        };
        let mut model = ModelV2::new(config);
        for _ in 0..30 {
            model.learn(&observation(0.0, 0.0));
        }
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

    /// With no answers at all, the ordered prior already reads a later step,
    /// a hidden reading and listening as harder — for every kind alike.
    #[test]
    fn the_ordered_prior_ranks_help_levels_before_any_answer() {
        let model = ModelV2::new(Config::default());
        let chance = |kind: WireType, help: HelpLevel| {
            let mut o = observation(0.0, 0.0);
            o.kind = kind;
            o.help = help;
            o.length = centre(kind);
            model.remembered(&o)
        };
        for kind in crate::kinds::active_kinds() {
            let steps = kind.written_steps();
            for pair in steps.windows(2) {
                assert!(
                    chance(kind, HelpLevel::step(pair[0])) > chance(kind, HelpLevel::step(pair[1]))
                );
            }
            let first = HelpLevel::step(steps[0]);
            assert!(chance(kind, first) > chance(kind, HelpLevel::hidden(steps[0])));
        }
        assert!(
            chance(WireType::RecognizeMc, HelpLevel::step(Step::Plain))
                > chance(WireType::RecognizeMc, HelpLevel::LISTENING)
        );
    }

    #[test]
    fn a_joint_draw_replays_under_a_seed_and_centres_on_the_mean() {
        let mut model = ModelV2::new(flat(true));
        for i in 0..50 {
            model.learn(&observation(f64::from(i % 4 != 0), 0.0));
        }
        let o = observation(0.0, 0.0);
        let draw = |seed| {
            let mut rng = Rng::seeded(seed);
            Draw::new(&model, 0.0, 1.0, false, &mut rng).chance(&o)
        };
        assert_eq!(draw(3), draw(3));
        let mean: f64 = (0..400).map(draw).sum::<f64>() / 400.0;
        assert!((mean - model.remembered(&o)).abs() < 0.05);
        // Scale 0 draws the mean itself.
        let mut rng = Rng::seeded(1);
        let exact = Draw::new(&model, 0.0, 0.0, false, &mut rng).chance(&o);
        let linear = model.linear(&o, false);
        let (m, _) = model.moments(&linear, 0.0);
        assert!(
            exact > sigmoid(m) - 0.2 && exact <= sigmoid(m) + 1e-9,
            "{exact} {m}"
        );
    }

    #[test]
    fn every_ablation_learns_and_scores() {
        let log: Vec<Observation> = (0..300)
            .map(|i| {
                let mut o = observation(f64::from(i % 5 != 0), f64::from(i) * DAY / 10.0);
                o.words[0].memory = 0.7 + 0.3 * f64::from(i % 3) / 2.0;
                o.words[0].item_id = format!("w{}", i % 7);
                o.challenge_id = format!("c{}", i % 40);
                o
            })
            .collect();
        for joint in [false, true] {
            for parts in [Parts::Flat, Parts::Factored, Parts::Ordered] {
                for length in [Length::Learned, Length::Fixed, Length::Off] {
                    for memory in [Memory::Product, Memory::Feature, Memory::Off] {
                        for prior in [Prior::Global, Prior::Empirical, Prior::Starting] {
                            let config = Config {
                                prior,
                                parts,
                                length,
                                memory,
                                joint,
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
}
