//! A simulated learner with known skills and difficulties, writing the log a
//! real one would: the calibration command's fixture, and what chose the
//! starting rates (`docs/challenge-difficulty.md` §12.5).
//!
//! The truth has the model's own shape — memory from FSRS, a sigmoid of skill
//! against difficulty — but its numbers are not the starting values: every
//! shared part is off by a random amount, every row carries a hidden quirk,
//! each word's skill is drawn around the start and grows with practice, and a
//! challenge about two words needs *both* managed. Sessions run daily over the
//! words FSRS says are due, and the picks are steered by the model as it
//! learns, as the app's will be, so the log carries the same selection the
//! real one does. The output is an export envelope, so a calibration over it
//! runs exactly the path a real export takes.

use std::collections::HashMap;

use serde_json::{json, Value};

use sapling_srs::{current_retrievability, new_card_state, review_card, FsrsCardState, Grade};

use crate::challenge::Challenge;
use crate::help::{can_listen, steps_of, HelpLevel};
use crate::kinds::{kind_of, WireType};
use crate::model::{
    length_of, sigmoid, starting_base, starting_skill, starting_slope, tuning, Aim, Evidence,
    Learner, Observation, Rates, MULTI_WORD,
};
use crate::rng::Rng;

const DAY: f64 = 86_400_000.0;
const REST: f64 = 3.0 * DAY;
const START: f64 = 1_700_000_000_000.0;

/// The rates the simulation steers its own picks with. Fixed rather than the
/// model's current ones, so the fixture log does not move when the rates it is
/// used to choose do.
const STEERING: Rates = Rates {
    word: 0.2,
    shared: 0.02,
    challenge: 0.1,
};

#[derive(Debug, Clone, Copy)]
pub struct SimOptions {
    pub seed: u64,
    pub words: usize,
    pub days: usize,
    /// Answers per daily session.
    pub per_day: usize,
    /// Words added each day until all are in.
    pub new_per_day: usize,
    /// Challenges written per word when it arrives.
    pub rows_per_word: usize,
}

impl Default for SimOptions {
    fn default() -> Self {
        SimOptions {
            seed: 7,
            words: 80,
            days: 60,
            per_day: 30,
            new_per_day: 6,
            rows_per_word: 5,
        }
    }
}

/// What the simulation knows and the model has to find out.
#[derive(Debug, Clone, Default)]
pub struct Truth {
    pub skills: HashMap<String, f64>,
    pub bases: HashMap<String, f64>,
    pub slopes: HashMap<WireType, f64>,
    pub corrections: HashMap<String, f64>,
}

pub struct Simulation {
    /// The export envelope's events, in log order.
    pub events: Vec<Value>,
    pub truth: Truth,
}

impl Simulation {
    pub fn export_json(&self) -> String {
        json!({ "version": 3, "exportedAt": START, "events": self.events }).to_string()
    }
}

fn gaussian(rng: &mut Rng) -> f64 {
    let u = rng.next_f64().max(1e-12);
    let v = rng.next_f64();
    (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
}

fn words(prefix: &str, n: usize) -> Vec<String> {
    (0..n.max(1)).map(|i| format!("{prefix}{i}")).collect()
}

/// A stored row of `kind` about `items`, `length` words long.
pub fn synthetic(kind: WireType, id: &str, items: &[&str], length: usize) -> Value {
    let body = match kind {
        WireType::RecognizeMc | WireType::ProduceMc | WireType::ContextMc => json!({
            "type": "multiple-choice", "prompt": words("p", length).join(" "),
            "options": ["a", "b", "c", "d"], "correctIndex": 0 }),
        WireType::TranslateToNative | WireType::TranslateToTarget => json!({
            "type": "typed-translation", "prompt": words("p", length).join(" "), "acceptedAnswers": ["a"] }),
        WireType::SpotError => json!({
            "type": "spot-error", "tokens": words("t", length), "correctIndex": 0,
            "intendedWord": "x", "correctedSentence": "x", "meaning": "m" }),
        WireType::WordOrder => {
            let answer = words("t", length);
            let mut tiles = answer.clone();
            tiles.extend(["d0", "d1", "d2"].map(String::from));
            json!({ "type": "word-order", "prompt": "p", "tiles": tiles,
                "answer": answer.join(" "), "answerTokens": answer })
        }
        WireType::Cloze => json!({
            "type": "cloze", "sentence": format!("{} ___", words("s", length.saturating_sub(1)).join(" ")),
            "acceptedAnswers": ["x"], "wordBank": ["x", "b1", "b2", "b3", "b4", "b5"], "translationHint": "h" }),
        WireType::MultiCloze => {
            let plain = words("s", length.saturating_sub(items.len()));
            json!({ "type": "multi-cloze",
                "passage": format!("___1___ {} ___2___", plain.join(" ")),
                "gaps": items.iter().enumerate().map(|(i, item)| json!({ "itemId": item, "acceptedAnswers": [format!("g{i}")] })).collect::<Vec<_>>(),
                "wordBank": ["g0", "g1", "b0", "b1", "b2"] })
        }
    };
    let mut row = body;
    let stored = kind.stored();
    row["id"] = json!(id);
    row["itemIds"] = json!(items);
    row["direction"] = serde_json::to_value(stored.direction).expect("a direction");
    if stored.prompt_is_target {
        row["promptIsTarget"] = json!(true);
    }
    row
}

/// The lengths a simulated row is drawn from, per kind.
fn length_range(kind: WireType) -> (usize, usize) {
    match kind {
        WireType::WordOrder => (3, 8),
        WireType::MultiCloze => (8, 18),
        WireType::RecognizeMc | WireType::ProduceMc => (1, 10),
        _ => (3, 12),
    }
}

struct Word {
    id: String,
    card: FsrsCardState,
    reviewed: bool,
    rows: Vec<usize>,
}

struct Row {
    challenge: Challenge,
    kind: WireType,
    last_served: Option<f64>,
}

pub fn simulate(options: SimOptions) -> Simulation {
    let mut rng = Rng::seeded(options.seed);
    let mut truth = Truth::default();
    for kind in WireType::ALL.into_iter().filter(|k| k.is_active()) {
        truth
            .slopes
            .insert(kind, starting_slope(kind) * (0.6 + 0.8 * rng.next_f64()));
    }
    let true_base = |truth: &mut Truth, rng: &mut Rng, kind: WireType, help: HelpLevel| {
        let key = crate::model::part_key(kind, help);
        *truth
            .bases
            .entry(key)
            .or_insert_with(|| starting_base(kind, help) + 0.5 * gaussian(rng))
    };

    let mut events: Vec<Value> = Vec::new();
    let event = |kind: &str, at: f64, payload: Value, events: &mut Vec<Value>| {
        let id = format!("e{}", events.len() + 1);
        events
            .push(json!({ "id": id, "type": kind, "at": at, "device": "sim", "payload": payload }));
    };

    let mut vocabulary: Vec<Word> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    let mut learner = Learner::default();
    let kinds: Vec<WireType> = WireType::ALL
        .into_iter()
        .filter(|k| k.is_active())
        .collect();
    let target = Aim::Normal.target();

    for day in 0..options.days {
        let morning = START + day as f64 * DAY;
        // New words arrive, each with a few rows already written.
        for _ in 0..options.new_per_day {
            if vocabulary.len() >= options.words {
                break;
            }
            let index = vocabulary.len();
            let id = format!("w{index}");
            truth.skills.insert(
                id.clone(),
                starting_skill() + 0.5 + 0.8 * gaussian(&mut rng),
            );
            event(
                "itemAdded",
                morning,
                json!({ "id": id, "kind": "vocab", "term": id, "meaning": format!("m{index}"), "introducedAt": morning }),
                &mut events,
            );
            let mut word = Word {
                id: id.clone(),
                card: new_card_state(morning),
                reviewed: false,
                rows: Vec::new(),
            };
            for r in 0..options.rows_per_word {
                let kind = kinds[(rng.next_f64() * kinds.len() as f64) as usize % kinds.len()];
                let partner = (kind == WireType::MultiCloze && index > 0)
                    .then(|| format!("w{}", (rng.next_f64() * index as f64) as usize));
                let kind = if kind == WireType::MultiCloze && partner.is_none() {
                    WireType::Cloze
                } else {
                    kind
                };
                let (low, high) = length_range(kind);
                let length = low + (rng.next_f64() * (high - low + 1) as f64) as usize;
                let row_id = format!("c{index}-{r}");
                let items: Vec<&str> = match &partner {
                    Some(partner) => vec![id.as_str(), partner.as_str()],
                    None => vec![id.as_str()],
                };
                let value = synthetic(kind, &row_id, &items, length.min(high));
                event(
                    "challengeAdded",
                    morning,
                    json!({ "challenge": value, "generatedAt": morning }),
                    &mut events,
                );
                truth
                    .corrections
                    .insert(row_id.clone(), 0.35 * gaussian(&mut rng));
                let challenge = Challenge::from_value(value).expect("a synthetic row parses");
                rows.push(Row {
                    kind: kind_of(&challenge).expect("a kind"),
                    challenge,
                    last_served: None,
                });
                word.rows.push(rows.len() - 1);
                if let Some(partner) = partner {
                    let at = partner[1..].parse::<usize>().expect("an index");
                    vocabulary[at].rows.push(rows.len() - 1);
                }
            }
            vocabulary.push(word);
        }

        // The session: due words most overdue first, then the soonest-due.
        let mut order: Vec<usize> = (0..vocabulary.len()).collect();
        order.sort_by(|&a, &b| vocabulary[a].card.due.total_cmp(&vocabulary[b].card.due));
        let mut now = morning + 9.0 * 3_600_000.0;
        for &w in order.iter().take(options.per_day) {
            now += 20_000.0;
            // Every rested row about the word, at every help level it has.
            let mut options_here: Vec<(usize, HelpLevel)> = Vec::new();
            for &r in &vocabulary[w].rows {
                if rows[r].last_served.is_some_and(|at| now - at < REST) {
                    continue;
                }
                for step in steps_of(&rows[r].challenge) {
                    options_here.push((r, HelpLevel::step(step)));
                }
                if can_listen(&rows[r].challenge) {
                    options_here.push((r, HelpLevel::LISTENING));
                }
            }
            if options_here.is_empty() {
                continue;
            }
            let observe = |r: usize, help: HelpLevel, vocabulary: &[Word], at: f64| {
                let row = &rows[r];
                let words = row
                    .challenge
                    .item_ids()
                    .iter()
                    .map(|id| {
                        let word = vocabulary.iter().find(|v| &v.id == id).expect("a word");
                        let memory = if word.reviewed {
                            current_retrievability(&word.card, at)
                        } else {
                            tuning().new_word_memory
                        };
                        Evidence {
                            item_id: id.clone(),
                            memory,
                        }
                    })
                    .collect();
                Observation {
                    at,
                    challenge_id: row.challenge.id().to_owned(),
                    kind: row.kind,
                    help,
                    length: length_of(&row.challenge),
                    words,
                    outcome: 0.0,
                }
            };
            // Mostly the pick the model thinks is nearest the aim; sometimes any.
            let pick = if rng.next_f64() < 0.2 {
                options_here
                    [(rng.next_f64() * options_here.len() as f64) as usize % options_here.len()]
            } else {
                *options_here
                    .iter()
                    .min_by(|a, b| {
                        let pa = learner.predict(&observe(a.0, a.1, &vocabulary, now), MULTI_WORD);
                        let pb = learner.predict(&observe(b.0, b.1, &vocabulary, now), MULTI_WORD);
                        (pa - target).abs().total_cmp(&(pb - target).abs())
                    })
                    .expect("not empty")
            };
            let (r, help) = pick;
            let mut o = observe(r, help, &vocabulary, now);
            let base = true_base(&mut truth, &mut rng, o.kind, help);
            let difficulty = base
                + truth.slopes.get(&o.kind).copied().unwrap_or(0.0) * o.length
                + truth
                    .corrections
                    .get(&o.challenge_id)
                    .copied()
                    .unwrap_or(0.0);
            let memory: f64 = o.words.iter().map(|e| e.memory).product();
            let manage: f64 = o
                .words
                .iter()
                .map(|e| sigmoid(truth.skills[&e.item_id] - difficulty))
                .product();
            let correct = rng.next_f64() < memory * manage;
            o.outcome = if correct { 1.0 } else { 0.0 };
            learner.learn(&o, &STEERING, MULTI_WORD);

            let grade = if correct { Grade::Good } else { Grade::Again };
            for e in &o.words {
                let word = vocabulary
                    .iter_mut()
                    .find(|v| v.id == e.item_id)
                    .expect("a word");
                word.card = review_card(&word.card, grade, now).expect("a review folds");
                word.reviewed = true;
                // Practice: every answer makes the word a little easier to use.
                *truth.skills.get_mut(&e.item_id).expect("a skill") += 0.04;
                event(
                    "itemReviewed",
                    now,
                    json!({ "device": "sim", "at": now, "itemId": e.item_id, "grade": grade as u8 }),
                    &mut events,
                );
            }
            event(
                "resultLogged",
                now,
                json!({ "challengeId": o.challenge_id, "verdict": if correct { "correct" } else { "wrong" },
                    "answerGiven": "x", "at": now, "shown": help.id() }),
                &mut events,
            );
            rows[r].last_served = Some(now);
        }
    }
    Simulation { events, truth }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::{input_from_events, observations, parse_export};
    use sapling_domain::events::PROFILE_ID;

    #[test]
    fn every_synthetic_row_parses_as_its_kind_at_its_length() {
        for kind in WireType::ALL {
            let items: &[&str] = if kind == WireType::MultiCloze {
                &["a", "b"]
            } else {
                &["a"]
            };
            let value = synthetic(kind, "c", items, 6);
            let challenge = Challenge::from_value(value).unwrap();
            assert_eq!(kind_of(&challenge), Some(kind), "{kind:?}");
            assert_eq!(length_of(&challenge), 6.0, "{kind:?}");
        }
    }

    #[test]
    fn a_simulation_is_a_readable_export_and_replays_every_answer() {
        let options = SimOptions {
            days: 12,
            ..SimOptions::default()
        };
        let sim = simulate(options);
        let events = parse_export(&sim.export_json()).unwrap();
        assert_eq!(events.len(), sim.events.len());
        let answers = sim
            .events
            .iter()
            .filter(|e| e["type"] == "resultLogged")
            .count();
        assert!(answers > 100);
        let seen = observations(&input_from_events(&events, PROFILE_ID));
        assert_eq!(seen.len(), answers);
        // The same seed writes the same log.
        assert_eq!(simulate(options).events, sim.events);
    }
}
