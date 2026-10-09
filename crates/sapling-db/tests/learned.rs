//! The difficulty model's numbers are derived data: however the answers
//! arrive — one by one in order, pulled in reverse, imported whole — a core
//! ends up holding exactly what a pure replay of the log computes.
//!
//! The log is the simulated learner's (`sapling-challenges`' `sim.rs`), which
//! is the calibration fixture too: thousands of answers over dozens of words,
//! with reviews, two-word rows and every help level.

use std::collections::BTreeMap;

use serde_json::Value;

use sapling_challenges::model::fold;
use sapling_challenges::replay::{input_from_events, observations, parse_export};
use sapling_challenges::sim::{simulate, SimOptions};
use sapling_db::Core;
use sapling_domain::events::PROFILE_ID;
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;

const NOW: f64 = 1_800_000_000_000.0;

fn core() -> Core {
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || NOW,
        || "local-1".to_owned(),
        Utc,
    )
    .expect("schema applies")
}

fn log() -> (String, Vec<Value>) {
    let sim = simulate(SimOptions {
        days: 20,
        ..SimOptions::default()
    });
    let events: Vec<Value> = sim
        .events
        .iter()
        .enumerate()
        .map(|(i, event)| {
            let mut event = event.clone();
            event["seq"] = Value::from(i as f64 + 1.0);
            event
        })
        .collect();
    (sim.export_json(), events)
}

/// Every learned number a core holds, keyed so two cores compare.
fn learned(core: &Core) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for item in core.get_all_items(false).unwrap() {
        if let Some(skill) = item.skill {
            out.insert(format!("skill:{}", item.id), skill);
        }
    }
    for row in core.get_pool().unwrap() {
        if let Some(correction) = row["correction"].as_f64() {
            out.insert(
                format!("correction:{}", row["id"].as_str().unwrap()),
                correction,
            );
        }
    }
    let parts = core.get_difficulty_parts().unwrap();
    for (key, value) in parts.bases {
        out.insert(format!("base:{key}"), value);
    }
    for (key, value) in parts.slopes {
        out.insert(format!("slope:{key}"), value);
    }
    out
}

#[test]
fn every_arrival_order_lands_on_the_pure_replay() {
    let (export, events) = log();

    let expected = {
        let parsed = parse_export(&export).unwrap();
        let learner = fold(&observations(&input_from_events(&parsed, PROFILE_ID)));
        let mut out = BTreeMap::new();
        for (id, skill) in learner.skills {
            out.insert(format!("skill:{id}"), skill);
        }
        for (id, correction) in learner.corrections {
            out.insert(format!("correction:{id}"), correction);
        }
        for (key, value) in learner.shared.bases {
            out.insert(format!("base:{key}"), value);
        }
        for (key, value) in learner.shared.slopes {
            out.insert(format!("slope:{key}"), value);
        }
        out
    };
    assert!(expected.len() > 100, "{}", expected.len());

    // One page at a time, in order: every answer is the newest, learned on the spot.
    let in_order = core();
    for page in events.chunks(97) {
        in_order.apply_remote(page).unwrap();
    }
    assert_eq!(learned(&in_order), expected);

    // Newest first: every answer is out of order and the fold replays whole.
    let reversed = core();
    let backwards: Vec<Value> = events.iter().rev().cloned().collect();
    for page in backwards.chunks(211) {
        reversed.apply_remote(page).unwrap();
    }
    assert_eq!(learned(&reversed), expected);

    // An import rebuilds from the log.
    let imported = core();
    imported.import_data(&export).unwrap();
    assert_eq!(learned(&imported), expected);
}

#[test]
fn an_older_review_arriving_late_replays_the_answers_after_it() {
    let (_, events) = log();
    let late = events
        .iter()
        .position(|e| e["type"] == "itemReviewed")
        .unwrap();
    let mut shuffled = events.clone();
    let review = shuffled.remove(late);
    shuffled.push(review);

    let direct = core();
    direct.apply_remote(&events).unwrap();
    let delayed = core();
    for page in shuffled.chunks(150) {
        delayed.apply_remote(page).unwrap();
    }
    assert_eq!(learned(&delayed), learned(&direct));
}

#[test]
fn deleting_a_word_forgets_its_answers() {
    let (_, events) = log();
    let full = core();
    full.apply_remote(&events).unwrap();
    let before = learned(&full);
    full.delete_item("w0").unwrap();
    let after = learned(&full);
    assert!(!after.contains_key("skill:w0"));
    assert_ne!(before, after);
    // Exactly what a log that never had the word's answers would learn.
    let rebuilt = core();
    rebuilt.import_data(&full.export_data().unwrap()).unwrap();
    assert_eq!(learned(&rebuilt), after);
}

/// Every word's card, keyed by id.
fn cards(core: &Core) -> BTreeMap<String, Value> {
    core.get_all_items(false)
        .unwrap()
        .into_iter()
        .map(|item| (item.id, item.fsrs_card))
        .collect()
}

/// An overturn is an answer accepted on the spot: each wrong word's `Again`
/// is superseded by a `Good` at the answer's own instant, and the answer
/// replays as `correct`. So a core lands — however the log arrives — exactly
/// where a log that answered correctly in the first place does, cards and
/// learned numbers alike.
#[test]
fn an_overturned_answer_counts_as_answered_correctly_right_away() {
    let (_, events) = log();
    let wrong: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| e["type"] == "resultLogged" && e["payload"]["verdict"] == "wrong")
        .map(|(i, _)| i)
        .collect();
    let at = wrong[wrong.len() / 2];
    let answered = events[at]["payload"]["at"].as_f64().unwrap();
    let challenge = events[at]["payload"]["challengeId"].clone();
    let reviews: Vec<usize> = (0..at)
        .filter(|&j| {
            events[j]["type"] == "itemReviewed"
                && events[j]["payload"]["at"].as_f64() == Some(answered)
        })
        .collect();
    assert!(!reviews.is_empty());

    // The log as the app writes an overturn: amendments, then the overturn.
    let mut overturned = events.clone();
    let mut append = |kind: &str, payload: Value| {
        let n = overturned.len() + 1;
        overturned.push(serde_json::json!({ "id": format!("o{n}"), "type": kind,
            "at": answered + 5_000.0, "device": "sim", "payload": payload, "seq": n as f64 }));
    };
    for &j in &reviews {
        append(
            "reviewAmended",
            serde_json::json!({ "device": "sim", "at": answered, "itemId": events[j]["payload"]["itemId"],
                "grade": 3, "replaces": answered }),
        );
    }
    append(
        "resultOverturned",
        serde_json::json!({ "challengeId": challenge, "answeredAt": answered, "verdict": "correct" }),
    );

    // The log of a learner who was accepted in the first place.
    let mut right = events.clone();
    right[at]["payload"]["verdict"] = Value::from("correct");
    for &j in &reviews {
        right[j]["payload"]["grade"] = Value::from(3);
    }
    let expected = core();
    expected.apply_remote(&right).unwrap();
    let (numbers, schedule) = (learned(&expected), cards(&expected));
    assert_ne!(numbers, {
        let plain = core();
        plain.apply_remote(&events).unwrap();
        learned(&plain)
    });

    let in_order = core();
    for page in overturned.chunks(97) {
        in_order.apply_remote(page).unwrap();
    }
    assert_eq!(learned(&in_order), numbers);
    assert_eq!(cards(&in_order), schedule);

    let reversed = core();
    let backwards: Vec<Value> = overturned.iter().rev().cloned().collect();
    for page in backwards.chunks(211) {
        reversed.apply_remote(page).unwrap();
    }
    assert_eq!(learned(&reversed), numbers);
    assert_eq!(cards(&reversed), schedule);

    let imported = core();
    imported
        .import_data(&in_order.export_data().unwrap())
        .unwrap();
    assert_eq!(learned(&imported), numbers);
    assert_eq!(cards(&imported), schedule);
}
