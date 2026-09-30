//! The difficulty model: one skill per word, one difficulty per challenge as
//! shown, on one scale, learned from answers (`docs/challenge-difficulty.md`).
//!
//! ```text
//! chance = memory × sigmoid(skill − difficulty)
//! difficulty = base(kind, help level) + slope(kind) × length + correction(row)
//! ```
//!
//! Memory is FSRS's retrievability, never tuned here. Every other number
//! starts from a written-down value (`data/model.json`) and moves with each
//! answer by its rate times the **surprise**, `outcome − chance`: a word's
//! skill up, the difficulty parts down. A miss the model expected moves little;
//! a miss on something it called easy moves a lot; a miss that low memory
//! explains leaves skill mostly alone, because the chance was low already.
//!
//! All of it is a function of the answers in log order, so it is derived data:
//! replaying the same answers gives the same numbers on every device, and a new
//! starting value or rate is a rebuild, never a reinterpretation.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::Challenge;
use crate::help::{HelpLevel, Step};
use crate::kinds::WireType;
use crate::text::{is_word_char, uses_inter_word_spaces};

/// How a challenge about several words combines their skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiWord {
    /// The weakest word decides.
    Lowest,
    /// The words' average decides.
    Average,
}

/// The one to use. The calibration command reports both; `lowest` scored
/// better on the simulated learner (see the commit that set it), and a real
/// log can flip it here.
pub const MULTI_WORD: MultiWord = MultiWord::Lowest;

pub use sapling_domain::types::Aim;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Aims {
    pub easier: f64,
    pub normal: f64,
    pub harder: f64,
}

/// The band around the aim a predicted chance may sit in, in points either side.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub aims: Aims,
    pub window: Window,
    pub rates: Rates,
    /// The memory of a word that has never been reviewed: FSRS has no curve
    /// for it, but the learner met it where they added it.
    pub new_word_memory: f64,
    /// What hiding the reading adds to a help level's starting number.
    pub hidden: f64,
    /// What listening adds to a type's `plain` starting number.
    pub listening: f64,
    /// Each kind's starting number per step, in the order `help.rs` lists them.
    pub bases: HashMap<String, BTreeMap<String, f64>>,
    /// Each kind's starting length slope, per word.
    pub slopes: HashMap<String, f64>,
}

pub fn tuning() -> &'static Tuning {
    static TUNING: OnceLock<Tuning> = OnceLock::new();
    TUNING.get_or_init(|| {
        serde_json::from_str(include_str!("../data/model.json")).expect("data/model.json")
    })
}

/// The success rate an aim asks for.
pub fn target(aim: Aim) -> f64 {
    let aims = &tuning().aims;
    match aim {
        Aim::Easier => aims.easier,
        Aim::Normal => aims.normal,
        Aim::Harder => aims.harder,
    }
}

/// The predicted chances a pick may land on: the aim, less and more.
pub fn window(aim: Aim) -> (f64, f64) {
    let target = target(aim);
    let w = &tuning().window;
    ((target - w.below).max(0.0), (target + w.above).min(1.0))
}

pub fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

pub fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-6, 1.0 - 1e-6);
    (p / (1.0 - p)).ln()
}

/* ---- Length -------------------------------------------------------------- */

/// A text's length in words, the same on every host: a spaced word counts
/// one, a character of a script without spaces counts half (a Chinese or
/// Japanese word runs about two). Not the host's segmenter, because the
/// numbers learned from a length are derived data that every device — and
/// the Worker, which has no segmenter — must reproduce exactly.
pub fn words_in(text: &str) -> f64 {
    let mut words = 0.0;
    let mut in_word = false;
    for c in text.chars() {
        if !is_word_char(c) {
            in_word = false;
            continue;
        }
        if !uses_inter_word_spaces(&c.to_string()) {
            words += 0.5;
            in_word = false;
            continue;
        }
        if !in_word {
            words += 1.0;
            in_word = true;
        }
    }
    words
}

/// How long a challenge reads, on the one scale every kind's slope is per.
pub fn length_of(challenge: &Challenge) -> f64 {
    match challenge {
        Challenge::MultipleChoice(c) => words_in(&c.prompt),
        // The blank is a word of its own: the answer that goes there.
        Challenge::Cloze(c) => words_in(&c.sentence.replace("___", " ")) + 1.0,
        Challenge::MultiCloze(c) => words_in(&strip_markers(&c.passage)) + c.gaps.len() as f64,
        Challenge::TypedTranslation(c) => words_in(&c.prompt),
        Challenge::MatchPairs(c) => c.pairs.len() as f64,
        Challenge::WordOrder(c) => c.answer_tokens.len() as f64,
        Challenge::SpotError(c) => c.tokens.len() as f64,
    }
}

/// A passage with its `___N___` markers taken out.
fn strip_markers(passage: &str) -> String {
    let mut out = String::with_capacity(passage.len());
    let mut rest = passage;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("___") {
            let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if digits > 0 && after[digits..].starts_with("___") {
                out.push(' ');
                rest = &after[digits + 3..];
                continue;
            }
        }
        let c = rest.chars().next().expect("not empty");
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

/* ---- Starting values ---------------------------------------------------- */

/// The key a shared difficulty number is stored under: `cloze/pick-6`.
pub fn part_key(kind: WireType, help: HelpLevel) -> String {
    format!("{}/{}", kind.as_str(), help.id())
}

/// Where a kind and help level start before any answer: the kind's number for
/// the step (its first step's, for a step it does not list), plus what hiding
/// the reading or listening adds.
pub fn starting_base(kind: WireType, help: HelpLevel) -> f64 {
    let t = tuning();
    let Some(steps) = t.bases.get(kind.as_str()) else {
        return 0.0;
    };
    let first = steps.values().copied().fold(f64::INFINITY, f64::min);
    let first = if first.is_finite() { first } else { 0.0 };
    if help.listening {
        return steps.get(Step::Plain.as_str()).copied().unwrap_or(first) + t.listening;
    }
    let step = steps.get(help.step.as_str()).copied().unwrap_or(first);
    step + if help.reading_hidden { t.hidden } else { 0.0 }
}

pub fn starting_slope(kind: WireType) -> f64 {
    tuning().slopes.get(kind.as_str()).copied().unwrap_or(0.0)
}

/// A brand-new word's skill: just above the easiest help level of the easiest
/// kind — enough that a one-word recognition question lands on the normal aim.
pub fn starting_skill() -> f64 {
    let easiest = WireType::ALL
        .into_iter()
        .filter(|kind| kind.is_active())
        .map(|kind| starting_base(kind, HelpLevel::step(Step::Plain)) + starting_slope(kind))
        .fold(f64::INFINITY, f64::min);
    easiest + logit(target(Aim::Normal))
}

/* ---- The learned numbers ------------------------------------------------ */

/// The numbers every challenge shares, as learned. A key not here is still at
/// its starting value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
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

    /// How hard one stored row is at one help level.
    pub fn difficulty(&self, kind: WireType, help: HelpLevel, length: f64, correction: f64) -> f64 {
        self.base(kind, help) + self.slope(kind) * length + correction
    }
}

/// The chance of a correct answer: the product of the words' memories, times
/// how likely the combined skill is to manage this difficulty.
pub fn chance(memories: &[f64], skills: &[f64], difficulty: f64, multi: MultiWord) -> f64 {
    if skills.is_empty() {
        return 0.0;
    }
    let memory: f64 = memories.iter().map(|m| m.clamp(0.0, 1.0)).product();
    let skill = match multi {
        MultiWord::Lowest => skills.iter().copied().fold(f64::INFINITY, f64::min),
        MultiWord::Average => skills.iter().sum::<f64>() / skills.len() as f64,
    };
    memory * sigmoid(skill - difficulty)
}

/// One word's part in one answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Evidence {
    pub item_id: String,
    /// FSRS retrievability just before the answer.
    pub memory: f64,
}

/// One answer, ready for the model: everything replay could work out, and
/// nothing that depends on the model itself.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub at: f64,
    pub challenge_id: String,
    pub kind: WireType,
    pub help: HelpLevel,
    pub length: f64,
    pub words: Vec<Evidence>,
    /// 1 correct, 0.5 almost, 0 wrong.
    pub outcome: f64,
}

/// Every learned number: the shared parts, each word's skill, each row's correction.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Learner {
    pub shared: Shared,
    pub skills: HashMap<String, f64>,
    pub corrections: HashMap<String, f64>,
}

/// A learned number never runs off: the scale is logits, and ±12 is certainty.
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
        // A surprising success says the challenge was easier than thought, so
        // every difficulty part moves *down* by what a skill moves up.
        let key = part_key(o.kind, o.help);
        let base = self.shared.base(o.kind, o.help) - rates.shared * surprise;
        self.shared.bases.insert(key, base.clamp(-LIMIT, LIMIT));
        // The slope carries the length's share of the surprise; a length is
        // around ten, so it is read in tens to move at the shared rate.
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

/// Every answer folded in, in order, at the tuned rates: the derived numbers.
pub fn fold(observations: &[Observation]) -> Learner {
    let mut learner = Learner::default();
    let rates = tuning().rates;
    for o in observations {
        learner.learn(o, &rates, MULTI_WORD);
    }
    learner
}

/* ---- Scoring ------------------------------------------------------------ */

/// One band of the calibration table: answers predicted in `[from, to)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Band {
    pub from: f64,
    pub to: f64,
    pub answers: usize,
    /// Mean predicted chance in the band.
    pub predicted: f64,
    /// Mean outcome in the band.
    pub actual: f64,
}

/// How well predictions matched outcomes over a replay, each answer predicted
/// before it was learned from.
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
            }],
            outcome,
        }
    }

    #[test]
    fn the_aims_and_windows_are_the_profile_settings() {
        assert_eq!(Aim::default(), Aim::Normal);
        assert_eq!(target(Aim::Normal), 0.8);
        assert_eq!(target(Aim::Easier), 0.88);
        assert_eq!(target(Aim::Harder), 0.7);
        let (low, high) = window(Aim::Normal);
        assert!((low - 0.65).abs() < 1e-9 && (high - 0.92).abs() < 1e-9);
        let (_, high) = window(Aim::Easier);
        assert!(high <= 1.0);
    }

    #[test]
    fn a_new_word_manages_the_easiest_question_at_the_normal_aim() {
        let shared = Shared::default();
        let d = shared.difficulty(
            WireType::RecognizeMc,
            HelpLevel::step(Step::Plain),
            1.0,
            0.0,
        );
        let p = chance(&[1.0], &[starting_skill()], d, MULTI_WORD);
        assert!((p - target(Aim::Normal)).abs() < 1e-9);
    }

    #[test]
    fn every_listed_step_starts_harder_than_the_one_before() {
        for (kind, steps) in &tuning().bases {
            let kind = WireType::ALL
                .into_iter()
                .find(|k| k.as_str() == kind)
                .expect("a kind");
            let order = [
                Step::Plain,
                Step::Pick4,
                Step::Tiles,
                Step::Answers,
                Step::Pick6,
                Step::Extra2,
                Step::Typed,
            ];
            let listed: Vec<f64> = order
                .iter()
                .filter(|s| steps.contains_key(s.as_str()))
                .map(|s| starting_base(kind, HelpLevel::step(*s)))
                .collect();
            assert!(listed.windows(2).all(|w| w[0] < w[1]), "{kind:?}");
            for step in steps.keys() {
                assert!(Step::parse(step).is_some(), "{step}");
                let step = Step::parse(step).unwrap();
                assert!(
                    starting_base(kind, HelpLevel::hidden(step))
                        > starting_base(kind, HelpLevel::step(step))
                );
            }
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
        let dropped_sure = before - sure.skill("w");
        let dropped_forgot = before - forgot.skill("w");
        assert!(dropped_sure > 0.0 && dropped_forgot > 0.0);
        assert!(dropped_sure > 5.0 * dropped_forgot);
        // …and the challenge reads harder after an unexpected miss.
        let o = observation(0.0, 1.0);
        assert!(sure.difficulty_of(&o) > Learner::default().difficulty_of(&o));
    }

    #[test]
    fn a_success_raises_skill_and_lowers_difficulty() {
        let mut learner = Learner::default();
        let o = observation(1.0, 1.0);
        let before = learner.clone();
        learner.learn(&o, &tuning().rates, MULTI_WORD);
        assert!(learner.skill("w") > before.skill("w"));
        assert!(learner.difficulty_of(&o) < before.difficulty_of(&o));
    }

    #[test]
    fn several_words_multiply_their_memories_and_combine_their_skills() {
        let low = chance(&[0.9, 0.5], &[1.0, 3.0], 0.0, MultiWord::Lowest);
        assert!((low - 0.45 * sigmoid(1.0)).abs() < 1e-12);
        let avg = chance(&[1.0, 1.0], &[1.0, 3.0], 0.0, MultiWord::Average);
        assert!((avg - sigmoid(2.0)).abs() < 1e-12);
        assert_eq!(chance(&[], &[], 0.0, MULTI_WORD), 0.0);
    }

    #[test]
    fn length_counts_spaced_words_and_half_a_character_without_spaces() {
        assert_eq!(words_in("Yo leo un libro."), 4.0);
        assert_eq!(words_in("我们想买单"), 2.5);
        assert_eq!(words_in("买单 please"), 2.0);
        assert_eq!(words_in(""), 0.0);
        let cloze = Challenge::from_value(
            serde_json::json!({ "id": "c", "type": "cloze", "direction": "toTarget",
            "sentence": "Yo ___ un libro.", "acceptedAnswers": ["leo"], "itemIds": ["i"] }),
        )
        .unwrap();
        assert_eq!(length_of(&cloze), 4.0);
        let multi = Challenge::from_value(serde_json::json!({ "id": "m", "type": "multi-cloze", "direction": "toTarget",
            "passage": "___1___ leo. ___2___ bebe.", "gaps": [
                { "itemId": "a", "acceptedAnswers": ["Yo"] }, { "itemId": "b", "acceptedAnswers": ["Ella"] }],
            "wordBank": ["Yo", "Ella"], "itemIds": ["a", "b"] }))
        .unwrap();
        assert_eq!(length_of(&multi), 4.0);
    }

    #[test]
    fn evaluation_scores_a_perfect_guess_better_than_a_bad_one() {
        let easy: Vec<Observation> = (0..50).map(|_| observation(1.0, 1.0)).collect();
        let (_, score) = evaluate(&easy, &tuning().rates, MULTI_WORD);
        assert_eq!(score.answers, 50);
        let hard: Vec<Observation> = (0..50).map(|_| observation(0.0, 1.0)).collect();
        let (_, worse) = evaluate(
            &hard,
            &Rates {
                word: 0.0,
                shared: 0.0,
                challenge: 0.0,
            },
            MULTI_WORD,
        );
        let (_, better) = evaluate(&hard, &tuning().rates, MULTI_WORD);
        assert!(better.log_loss < worse.log_loss);
        assert_eq!(score.bands.iter().map(|b| b.answers).sum::<usize>(), 50);
    }
}
