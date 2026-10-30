//! The closed loop: a simulated learner practised day by day by a pluggable
//! [`Policy`] — what to write, what to serve, what to learn from — so two
//! policies can be compared on what the learner was actually served, against
//! a truth only the simulation knows. Research only: nothing in the app runs it.
//!
//! The truth has `sim.rs`' shape. Its numbers, the words' arrival, the rows'
//! quirks and every answer's luck come from their own seeded sources, so every
//! policy meets the same learner and the same luck; only its own draws differ.
//! Writing is instant: a refill's rows are in the pool before the next pick.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;

use sapling_srs::{
    current_retrievability, item_srs, new_card_state, review_card, FsrsCardState, Grade,
};

use super::{gaussian, synthetic};
use crate::fits::{fits_fresh, Serving};
use crate::help::HelpLevel;
use crate::kinds::{kind_of, Want, WireType};
use crate::model::{
    chance, length_of, part_key, sigmoid, starting_base, starting_skill, starting_slope, target,
    tuning, window, Evidence, Learner, Observation, MULTI_WORD,
};
use crate::model_v2::{centre, Config, ModelV2};
use crate::policy_v2::{self, Steering};
use crate::pool::PoolRow;
use crate::rng::Rng;
use crate::stream::head;
use crate::topup::{plan_top_up, Scope};
use crate::word::{by_id, Word};
use crate::Challenge;

const DAY: f64 = 86_400_000.0;
const START: f64 = 1_700_000_000_000.0;

pub const DAYS: usize = 60;
pub const PER_DAY: usize = 30;
pub const WORDS: usize = 80;
pub const NEW_PER_DAY: usize = 6;
/// The words ahead a refill writes for: the stream's default low-water mark.
pub const LOW_WATER: usize = 5;

/// The trap: on this day the policy's estimate of every cloze level is made
/// this many logits too pessimistic, as a run of bad luck would.
pub const TRAP_DAY: usize = 10;
pub const TRAP_BY: f64 = 2.5;
/// Growth: every part starting at or above `HARD` eases by `GROWTH` logits
/// over the run, linearly, served or not.
pub const HARD: f64 = 1.5;
pub const GROWTH: f64 = 1.5;
/// The new kind: cue-cloze, writable from this day, truly this much easier
/// than cloze at every step.
pub const NEW_DAY: usize = 30;
pub const NEW_EASIER: f64 = 0.8;
/// An estimate has reached the truth when the mean remembered chance it
/// predicts for the learner's words is this close to the true one.
pub const SETTLED: f64 = 0.1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    Base,
    Trap,
    Growth,
    NewKind,
}

impl Scenario {
    pub const ALL: [Scenario; 4] = [Self::Base, Self::Trap, Self::Growth, Self::NewKind];

    pub fn name(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Trap => "trap",
            Self::Growth => "growth",
            Self::NewKind => "new-kind",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.name() == name)
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Base => "the existing truth",
            Self::Trap => "cloze made to look 2.5 logits harder than believed on day 10",
            Self::Growth => "every hard part eases by 1.5 logits over the run",
            Self::NewKind => "cue-cloze writable from day 30, 0.8 easier than cloze",
        }
    }

    /// The kind an event is about and the day it happens.
    fn event(self) -> Option<(WireType, usize)> {
        match self {
            Self::Trap => Some((WireType::Cloze, TRAP_DAY)),
            Self::NewKind => Some((WireType::CueCloze, NEW_DAY)),
            _ => None,
        }
    }
}

pub use crate::policy_v2::Ask as Cx;

pub struct Pick {
    pub at: usize,
    pub help: HelpLevel,
    /// The head had nothing and was passed for a word further down.
    pub passed: bool,
}

pub trait Policy {
    fn refill(&mut self, cx: &Cx, rng: &mut Rng) -> Vec<Want>;
    /// Whether a row just written is kept.
    fn keeps(&self, _challenge: &Challenge, _cx: &Cx) -> bool {
        true
    }
    fn pick(&mut self, cx: &Cx, rng: &mut Rng) -> Option<Pick>;
    /// The whole chance, memory included.
    fn predict(&self, o: &Observation) -> f64;
    /// The chance given the words are remembered.
    fn remembered(&self, o: &Observation) -> f64;
    fn learn(&mut self, o: &Observation);
    /// What the host's `Word` and `PoolRow` carry for this policy.
    fn skill(&self, _id: &str) -> Option<f64> {
        None
    }
    fn correction(&self, _id: &str) -> Option<f64> {
        None
    }
    fn mislead(&mut self, kind: WireType, help: HelpLevel, by: f64, at: f64);
}

/// The app as it is: `stream.rs`' head, `topup.rs`' planner, `model.rs`' learner.
#[derive(Default)]
pub struct Current {
    learner: Learner,
}

impl Current {
    fn serving(&self, cx: &Cx) -> Serving {
        Serving {
            parts: self.learner.shared.clone(),
            ..cx.serving.clone()
        }
    }
}

impl Policy for Current {
    fn refill(&mut self, cx: &Cx, rng: &mut Rng) -> Vec<Want> {
        let scope = Scope {
            served: cx.served,
            asked: &[],
            limit: Some(LOW_WATER),
            cued: cx.cued,
        };
        let serving = self.serving(cx);
        plan_top_up(cx.pool, cx.words, cx.now, &serving, scope, &mut || {
            rng.next_f64()
        })
    }

    /// The writer keeps a row about several words only when it fits them.
    fn keeps(&self, challenge: &Challenge, cx: &Cx) -> bool {
        challenge.item_ids().len() < 2 || fits_fresh(challenge, &by_id(cx.words), &self.serving(cx))
    }

    fn pick(&mut self, cx: &Cx, _rng: &mut Rng) -> Option<Pick> {
        let serving = self.serving(cx);
        let h = head(cx.pool, cx.words, cx.now, &serving, cx.served, true)?;
        let next = h.next?;
        Some(Pick {
            at: next.at,
            help: HelpLevel::parse(&next.shown)?,
            passed: h.instead.is_some(),
        })
    }

    fn predict(&self, o: &Observation) -> f64 {
        self.learner.predict(o, MULTI_WORD)
    }

    fn remembered(&self, o: &Observation) -> f64 {
        let skills: Vec<f64> = o
            .words
            .iter()
            .map(|w| self.learner.skill(&w.item_id))
            .collect();
        chance(
            &vec![1.0; skills.len()],
            &skills,
            self.learner.difficulty_of(o),
            MULTI_WORD,
        )
    }

    fn learn(&mut self, o: &Observation) {
        self.learner.learn(o, &tuning().rates, MULTI_WORD);
    }

    fn skill(&self, id: &str) -> Option<f64> {
        self.learner.skills.get(id).copied()
    }

    fn correction(&self, id: &str) -> Option<f64> {
        self.learner.corrections.get(id).copied()
    }

    fn mislead(&mut self, kind: WireType, help: HelpLevel, by: f64, _at: f64) {
        let base = self.learner.shared.base(kind, help) + by;
        self.learner.shared.bases.insert(part_key(kind, help), base);
    }
}

/// `model_v2.rs` steering `policy_v2.rs`.
pub struct V2 {
    pub model: ModelV2,
    pub steering: Steering,
}

impl V2 {
    pub fn new(config: Config, steering: Steering) -> Self {
        V2 {
            model: ModelV2::new(config),
            steering,
        }
    }
}

impl Policy for V2 {
    fn refill(&mut self, cx: &Cx, rng: &mut Rng) -> Vec<Want> {
        policy_v2::refill(cx, LOW_WATER, &self.model, self.steering, rng)
    }

    fn pick(&mut self, cx: &Cx, rng: &mut Rng) -> Option<Pick> {
        let p = policy_v2::pick(cx, &self.model, self.steering, rng)?;
        Some(Pick {
            at: p.at,
            help: p.help,
            passed: p.passed,
        })
    }

    fn predict(&self, o: &Observation) -> f64 {
        self.model.predict(o)
    }

    fn remembered(&self, o: &Observation) -> f64 {
        self.model.remembered(o)
    }

    fn learn(&mut self, o: &Observation) {
        self.model.learn(o);
    }

    fn mislead(&mut self, kind: WireType, help: HelpLevel, by: f64, at: f64) {
        self.model.mislead(kind, help, by, at);
    }
}

/* ---- The truth ---------------------------------------------------------- */

struct Truth {
    skills: Vec<f64>,
    bases: HashMap<String, f64>,
    slopes: HashMap<WireType, f64>,
    corrections: HashMap<String, f64>,
    scenario: Scenario,
}

impl Truth {
    fn new(seed: u64, scenario: Scenario) -> Self {
        let mut rng = Rng::seeded(seed ^ 0x5EED_7207);
        let mut truth = Truth {
            skills: Vec::new(),
            bases: HashMap::new(),
            slopes: HashMap::new(),
            corrections: HashMap::new(),
            scenario,
        };
        for kind in WireType::ALL
            .into_iter()
            .filter(|k| k.is_active() && !k.is_local())
        {
            truth
                .slopes
                .insert(kind, starting_slope(kind) * (0.6 + 0.8 * rng.next_f64()));
            for step in kind.written_steps() {
                let help = HelpLevel::step(step);
                truth.bases.insert(
                    part_key(kind, help),
                    starting_base(kind, help) + 0.5 * gaussian(&mut rng),
                );
            }
        }
        let cloze = truth.slopes[&WireType::Cloze];
        truth.slopes.insert(WireType::CueCloze, cloze);
        for step in WireType::CueCloze.written_steps() {
            let help = HelpLevel::step(step);
            let base = truth.bases[&part_key(WireType::Cloze, help)] - NEW_EASIER;
            truth.bases.insert(part_key(WireType::CueCloze, help), base);
        }
        truth.skills = (0..WORDS)
            .map(|_| starting_skill() + 0.5 + 0.8 * gaussian(&mut rng))
            .collect();
        truth
    }

    fn difficulty(&self, kind: WireType, help: HelpLevel, length: f64, row: &str, day: f64) -> f64 {
        let mut base = self.bases[&part_key(kind, help)];
        if self.scenario == Scenario::Growth && starting_base(kind, help) >= HARD {
            base -= GROWTH * day / DAYS as f64;
        }
        base + self.slopes[&kind] * length + self.corrections.get(row).copied().unwrap_or(0.0)
    }
}

/* ---- Metrics ------------------------------------------------------------ */

#[derive(Debug, Clone, Default)]
pub struct Third {
    pub answers: usize,
    pub in_window: usize,
    pub distance: f64,
    pub hard: usize,
    pub kinds: BTreeMap<&'static str, usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Metrics {
    pub answers: usize,
    /// Picks the head had nothing for and was passed.
    pub passed: usize,
    /// Picks with nothing to serve at all.
    pub empty: usize,
    pub written: usize,
    /// Served picks whose true remembered chance sat in the aim's window,
    /// below it and above it.
    pub in_window: usize,
    pub below: usize,
    pub above: usize,
    /// Σ the policy's own mean remembered chance at the pick, before the answer.
    pub believed: f64,
    /// Σ |true remembered chance − aim|.
    pub distance: f64,
    /// Σ true remembered chance.
    pub remembered: f64,
    /// Σ KL(truth ‖ predicted), memory included, before learning.
    pub kl: f64,
    /// The same, for each model folding this policy's answers beside it.
    pub kl_v1: f64,
    pub kl_v2: f64,
    pub kinds: BTreeMap<&'static str, usize>,
    pub levels: BTreeMap<String, usize>,
    pub thirds: [Third; 3],
    /// Days from the event to the event kind's first serve after it.
    pub event_served: Option<f64>,
    /// Days from the event until the estimate of that kind was within [`SETTLED`].
    pub event_settled: Option<f64>,
    pub after_event: usize,
    pub event_answers: usize,
    /// The estimate error of the event's kind at the end.
    pub event_error: f64,
    /// The estimate error averaged over every kind and level, at the end.
    pub final_error: f64,
}

pub fn entropy<K>(counts: &BTreeMap<K, usize>) -> f64 {
    let n: usize = counts.values().sum();
    if n == 0 {
        return 0.0;
    }
    -counts
        .values()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / n as f64;
            p * p.log2()
        })
        .sum::<f64>()
}

fn kl(truth: f64, predicted: f64) -> f64 {
    let t = truth.clamp(1e-9, 1.0 - 1e-9);
    let p = predicted.clamp(0.01, 0.99);
    t * (t / p).ln() + (1.0 - t) * ((1.0 - t) / (1.0 - p)).ln()
}

/* ---- The loop ----------------------------------------------------------- */

fn memory_of(card: &FsrsCardState, reviewed: bool, now: f64) -> f64 {
    if reviewed {
        current_retrievability(card, now)
    } else {
        tuning().new_word_memory
    }
}

/// How far a policy's estimate of `kind` is from the truth: per level, the
/// mean remembered chance over the learner's words at the kind's middle
/// length, predicted against true, averaged over levels.
fn estimate_error(
    policy: &dyn Policy,
    truth: &Truth,
    ids: &[String],
    kind: WireType,
    now: f64,
    day: f64,
) -> f64 {
    let steps = kind.written_steps();
    let mut error = 0.0;
    for step in &steps {
        let help = HelpLevel::step(*step);
        let (mut est, mut real) = (0.0, 0.0);
        for (i, id) in ids.iter().enumerate() {
            let o = Observation {
                at: now,
                challenge_id: String::new(),
                kind,
                help,
                length: centre(kind),
                words: vec![Evidence {
                    item_id: id.clone(),
                    memory: 1.0,
                }],
                outcome: 0.0,
            };
            est += policy.remembered(&o);
            real += sigmoid(truth.skills[i] - truth.difficulty(kind, help, centre(kind), "", day));
        }
        error += ((est - real) / ids.len().max(1) as f64).abs();
    }
    error / steps.len().max(1) as f64
}

/// One learner, one policy, one seed.
pub fn run(scenario: Scenario, policy: &mut dyn Policy, seed: u64) -> Metrics {
    let mut truth = Truth::new(seed, scenario);
    let mut world = Rng::seeded(seed.wrapping_mul(31).wrapping_add(1));
    let mut luck = Rng::seeded(seed.wrapping_mul(31).wrapping_add(2));
    let mut own = Rng::seeded(seed.wrapping_mul(31).wrapping_add(3));
    let serving = Serving::default();
    let aim = target(serving.aim);
    let (low, high) = window(serving.aim);
    let mut ids: Vec<String> = Vec::new();
    let mut cards: Vec<FsrsCardState> = Vec::new();
    let mut reviewed: Vec<bool> = Vec::new();
    let mut pool: Vec<Option<PoolRow>> = Vec::new();
    let mut m = Metrics::default();
    let mut shadow_v1 = Learner::default();
    let mut shadow_v2 = ModelV2::new(Config::default());
    let event = scenario.event();
    let total = (DAYS * PER_DAY) as f64;

    for day in 0..DAYS {
        let morning = START + day as f64 * DAY;
        for _ in 0..NEW_PER_DAY {
            if ids.len() < WORDS {
                ids.push(format!("w{}", ids.len()));
                cards.push(new_card_state(morning));
                reviewed.push(false);
            }
        }
        if scenario == Scenario::Trap && day == TRAP_DAY {
            for step in WireType::Cloze.written_steps() {
                policy.mislead(WireType::Cloze, HelpLevel::step(step), TRAP_BY, morning);
            }
        }
        let cued: Vec<String> = if scenario == Scenario::NewKind && day >= NEW_DAY {
            ids.clone()
        } else {
            Vec::new()
        };
        let mut served: Vec<String> = Vec::new();
        let mut now = morning + 9.0 * 3_600_000.0;
        for _ in 0..PER_DAY {
            now += 20_000.0;
            let words: Vec<Word> = ids
                .iter()
                .zip(&cards)
                .map(|(id, card)| Word {
                    id: id.clone(),
                    term: id.clone(),
                    meaning: format!("m-{id}"),
                    romanization: None,
                    srs: Some(item_srs(card, now)),
                    skill: policy.skill(id),
                })
                .collect();
            let cx = Cx {
                pool: &pool,
                words: &words,
                now,
                served: &served,
                cued: &cued,
                serving: &serving,
            };
            let mut written: Vec<PoolRow> = Vec::new();
            for want in policy.refill(&cx, &mut own) {
                let kind = want.kind.kind;
                let mut items = vec![want.item.id.clone()];
                if kind == WireType::MultiCloze {
                    if ids.len() < 2 {
                        continue;
                    }
                    let i = ids.iter().position(|id| *id == want.item.id).unwrap_or(0);
                    let mut j = (world.next_f64() * (ids.len() - 1) as f64) as usize;
                    if j >= i {
                        j += 1;
                    }
                    items.push(ids[j.min(ids.len() - 1)].clone());
                }
                let row_id = format!("r{}", pool.len() + written.len());
                let refs: Vec<&str> = items.iter().map(String::as_str).collect();
                let value = synthetic(kind, &row_id, &refs, usize::from(want.length));
                let mut challenge = Challenge::from_value(value).expect("a synthetic row");
                challenge.set_asked_length(f64::from(want.length));
                let quirk = 0.35 * gaussian(&mut world);
                if !policy.keeps(&challenge, &cx) {
                    continue;
                }
                truth.corrections.insert(row_id, quirk);
                written.push(PoolRow {
                    challenge,
                    generated_at: now,
                    times_served: 0.0,
                    last_served_at: None,
                    reported: false,
                    topic: None,
                    correction: None,
                });
            }
            m.written += written.len();
            pool.extend(written.into_iter().map(Some));
            let cx = Cx {
                pool: &pool,
                words: &words,
                now,
                served: &served,
                cued: &cued,
                serving: &serving,
            };
            let Some(pick) = policy.pick(&cx, &mut own) else {
                m.empty += 1;
                continue;
            };
            m.passed += usize::from(pick.passed);
            let row = pool[pick.at].as_ref().expect("a picked row");
            let kind = kind_of(&row.challenge).expect("a kind");
            let length = length_of(&row.challenge);
            let row_id = row.challenge.id().to_owned();
            let at: Vec<usize> = row
                .challenge
                .item_ids()
                .iter()
                .map(|id| ids.iter().position(|w| w == id).expect("a word"))
                .collect();
            let mut o = Observation {
                at: now,
                challenge_id: row_id.clone(),
                kind,
                help: pick.help,
                length,
                words: at
                    .iter()
                    .map(|&i| Evidence {
                        item_id: ids[i].clone(),
                        memory: memory_of(&cards[i], reviewed[i], now),
                    })
                    .collect(),
                outcome: 0.0,
            };
            let d = truth.difficulty(kind, pick.help, length, &row_id, day as f64);
            let memory: f64 = o.words.iter().map(|e| e.memory).product();
            let remembered: f64 = at.iter().map(|&i| sigmoid(truth.skills[i] - d)).product();
            let whole = memory * remembered;
            m.kl += kl(whole, policy.predict(&o));
            m.kl_v1 += kl(whole, shadow_v1.predict(&o, MULTI_WORD));
            m.kl_v2 += kl(whole, shadow_v2.predict(&o));
            m.believed += policy.remembered(&o);
            let correct = luck.next_f64() < whole;
            o.outcome = f64::from(u8::from(correct));
            policy.learn(&o);
            shadow_v1.learn(&o, &tuning().rates, MULTI_WORD);
            shadow_v2.learn(&o);

            let third = ((m.answers as f64 / total * 3.0) as usize).min(2);
            let inside = remembered >= low && remembered <= high;
            let hard = starting_base(kind, pick.help) >= HARD;
            m.answers += 1;
            m.in_window += usize::from(inside);
            m.below += usize::from(remembered < low);
            m.above += usize::from(remembered > high);
            m.distance += (remembered - aim).abs();
            m.remembered += remembered;
            *m.kinds.entry(kind.as_str()).or_default() += 1;
            *m.levels.entry(part_key(kind, pick.help)).or_default() += 1;
            let t = &mut m.thirds[third];
            t.answers += 1;
            t.in_window += usize::from(inside);
            t.distance += (remembered - aim).abs();
            t.hard += usize::from(hard);
            *t.kinds.entry(kind.as_str()).or_default() += 1;
            if let Some((event_kind, event_day)) = event.filter(|(_, d)| day >= *d) {
                m.after_event += 1;
                if kind == event_kind {
                    m.event_answers += 1;
                    let since = (now - (START + event_day as f64 * DAY)) / DAY;
                    m.event_served.get_or_insert(since);
                }
            }

            let row = pool[pick.at].as_mut().expect("a picked row");
            row.times_served += 1.0;
            row.last_served_at = Some(now);
            row.correction = policy.correction(&row_id);
            let grade = if correct { Grade::Good } else { Grade::Again };
            for &i in &at {
                cards[i] = review_card(&cards[i], grade, now).expect("a review folds");
                reviewed[i] = true;
                truth.skills[i] += 0.04;
            }
            served.push(row_id);
        }
        if let Some((kind, event_day)) = event.filter(|(_, d)| day >= *d) {
            if m.event_settled.is_none()
                && estimate_error(&*policy, &truth, &ids, kind, now, day as f64) < SETTLED
            {
                m.event_settled = Some((day + 1 - event_day) as f64);
            }
        }
    }
    let end = START + DAYS as f64 * DAY;
    let kinds: Vec<WireType> = WireType::ALL
        .into_iter()
        .filter(|k| k.is_active() && (!k.is_local() || scenario == Scenario::NewKind))
        .collect();
    if let Some((kind, _)) = event {
        m.event_error = estimate_error(&*policy, &truth, &ids, kind, end, DAYS as f64);
    }
    m.final_error = kinds
        .iter()
        .map(|&k| estimate_error(&*policy, &truth, &ids, k, end, DAYS as f64))
        .sum::<f64>()
        / kinds.len() as f64;
    m
}

/* ---- Comparing policies ------------------------------------------------- */

/// A policy by name, made fresh for each run.
#[derive(Debug, Clone, Copy)]
pub enum Named {
    Current,
    V2(&'static str, Config, Steering),
}

impl Named {
    pub fn name(&self) -> &'static str {
        match self {
            Named::Current => "current",
            Named::V2(name, _, _) => name,
        }
    }

    pub fn make(&self) -> Box<dyn Policy> {
        match self {
            Named::Current => Box::<Current>::default(),
            Named::V2(_, config, steering) => Box::new(V2::new(*config, *steering)),
        }
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

fn timing(values: &[Option<f64>]) -> String {
    let hit: Vec<f64> = values.iter().flatten().copied().collect();
    if hit.is_empty() {
        return format!("never (0/{})", values.len());
    }
    format!("{:.1} d ({}/{})", mean(&hit), hit.len(), values.len())
}

/// Every policy over `seeds` learners of one scenario, as a table.
pub fn compare(scenario: Scenario, policies: &[Named], seeds: u64) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "scenario {} — {} · {seeds} seeds · {DAYS} days × {PER_DAY} answers · aim {:.2}, window {:.2}–{:.2}",
        scenario.name(),
        scenario.describe(),
        target(Serving::default().aim),
        window(Serving::default().aim).0,
        window(Serving::default().aim).1,
    );
    let _ = writeln!(
        out,
        "{:<8} {:>6} {:>6} {:>6} {:>9} {:>6} {:>7} {:>7} {:>7} {:>7} {:>6} {:>6} {:>8} {:>6} {:>6} {:>14} {:>7}",
        "policy",
        "below",
        "window",
        "above",
        "|rem−aim|",
        "rem",
        "believed",
        "KL",
        "KL v1",
        "KL v2",
        "passed",
        "empty",
        "rows/ans",
        "kindH",
        "partH",
        "hard% by third",
        "est.err"
    );
    let mut shares = String::new();
    let mut events = String::new();
    for policy in policies {
        let runs: Vec<Metrics> = (1..=seeds)
            .map(|seed| run(scenario, &mut *policy.make(), seed))
            .collect();
        let per = |f: &dyn Fn(&Metrics) -> f64| mean(&runs.iter().map(f).collect::<Vec<_>>());
        let n = |m: &Metrics| m.answers.max(1) as f64;
        let hard: Vec<String> = (0..3)
            .map(|t| {
                format!(
                    "{:.0}",
                    100.0 * per(&|m| m.thirds[t].hard as f64 / m.thirds[t].answers.max(1) as f64)
                )
            })
            .collect();
        let _ = writeln!(
            out,
            "{:<8} {:>6.3} {:>6.3} {:>6.3} {:>9.3} {:>6.3} {:>7.3} {:>7.4} {:>7.4} {:>7.4} {:>6.1} {:>6.1} {:>8.2} {:>6.2} {:>6.2} {:>14} {:>7.3}",
            policy.name(),
            per(&|m| m.below as f64 / n(m)),
            per(&|m| m.in_window as f64 / n(m)),
            per(&|m| m.above as f64 / n(m)),
            per(&|m| m.distance / n(m)),
            per(&|m| m.remembered / n(m)),
            per(&|m| m.believed / n(m)),
            per(&|m| m.kl / n(m)),
            per(&|m| m.kl_v1 / n(m)),
            per(&|m| m.kl_v2 / n(m)),
            per(&|m| m.passed as f64),
            per(&|m| m.empty as f64),
            per(&|m| m.written as f64 / n(m)),
            per(&|m| entropy(&m.kinds)),
            per(&|m| entropy(&m.levels)),
            hard.join("/"),
            per(&|m| m.final_error),
        );
        let mut kinds: BTreeMap<&str, f64> = BTreeMap::new();
        for r in &runs {
            for (k, c) in &r.kinds {
                *kinds.entry(k).or_default() += *c as f64 / n(r) / runs.len() as f64;
            }
        }
        let by_third: Vec<String> = (0..3)
            .map(|t| {
                let third = |m: &Metrics| m.thirds[t].answers.max(1) as f64;
                let window = per(&|m| m.thirds[t].in_window as f64 / third(m));
                let distance = per(&|m| m.thirds[t].distance / third(m));
                format!("{window:.2}/{distance:.3}")
            })
            .collect();
        let _ = writeln!(
            shares,
            "  {:<10} window/|rem−aim| by third {} · {}",
            policy.name(),
            by_third.join("/"),
            kinds
                .iter()
                .map(|(k, s)| format!("{k} {:.0}%", 100.0 * s))
                .collect::<Vec<_>>()
                .join(", ")
        );
        if let Some((kind, _)) = scenario.event() {
            let _ = writeln!(
                events,
                "  {:<10} {} first served after {} · estimate within {SETTLED} after {} · error at the end {:.3} · share after the event {:.1}%",
                policy.name(),
                kind.as_str(),
                timing(&runs.iter().map(|m| m.event_served).collect::<Vec<_>>()),
                timing(&runs.iter().map(|m| m.event_settled).collect::<Vec<_>>()),
                per(&|m| m.event_error),
                100.0 * per(&|m| m.event_answers as f64 / m.after_event.max(1) as f64),
            );
        }
    }
    out.push_str(&shares);
    out.push_str(&events);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_replays_under_its_seed_and_serves_every_day() {
        for named in [
            Named::Current,
            Named::V2("v2", Config::default(), Steering::default()),
        ] {
            let a = run(Scenario::Trap, &mut *named.make(), 3);
            let b = run(Scenario::Trap, &mut *named.make(), 3);
            assert_eq!(a.answers, b.answers, "{}", named.name());
            assert_eq!(a.kinds, b.kinds);
            assert_eq!(a.kl, b.kl);
            assert!(a.answers > DAYS * PER_DAY * 9 / 10, "{}", a.answers);
        }
    }
}
