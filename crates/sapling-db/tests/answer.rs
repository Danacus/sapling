//! `recordAnswer` files an answered challenge in one transaction, and what it
//! files is exactly what the three calls it replaced wrote — a review per word
//! (`reviewItem`), the result (`addResult`) and the serve stamp
//! (`recordServe`) — so the log format does not move: the same events, the
//! same payloads, the same order, the same read tables after.

use std::cell::Cell;
use std::rc::Rc;

use sapling_challenges::grade::GapVerdict;
use sapling_db::core::grade_of;
use sapling_db::{AnswerRecord, Core};
use sapling_domain::events::{ItemAdded, Payload};
use sapling_domain::types::{ChallengeResult, ItemKind, Verdict};
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::{json, Value};

const NOW: f64 = 1_710_000_000_000.0;
const ANSWERED: f64 = NOW + 5_000.0;

fn core() -> Core {
    let next = Rc::new(Cell::new(0));
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || NOW,
        move || {
            next.set(next.get() + 1);
            format!("e{}", next.get())
        },
        Utc,
    )
    .expect("schema applies")
}

/// Two words and a pooled passage about both.
fn seeded() -> Core {
    let core = core();
    for (id, term) in [("i1", "yo"), ("i2", "bebo")] {
        core.commit(Payload::ItemAdded(ItemAdded {
            id: id.to_owned(),
            kind: ItemKind::Vocab,
            term: term.to_owned(),
            meaning: term.to_owned(),
            romanization: None,
            notes: None,
            introduced_at: NOW,
        }))
        .expect("item");
    }
    let challenge = json!({ "id": "c1", "type": "multi-cloze", "direction": "toTarget",
        "passage": "___1___ ___2___ café.",
        "gaps": [{ "itemId": "i1", "acceptedAnswers": ["Yo"] }, { "itemId": "i2", "acceptedAnswers": ["bebo"] }],
        "wordBank": ["Yo", "bebo", "como", "leo"], "itemIds": ["i1", "i2"] });
    core.add_to_pool(&[challenge], Some(NOW), None)
        .expect("pool");
    core
}

fn result(challenge: &str, verdict: Verdict) -> ChallengeResult {
    ChallengeResult {
        challenge_id: challenge.to_owned(),
        verdict,
        answer_given: "1: Yo · 2: como".to_owned(),
        at: ANSWERED,
        shown: Some("answers".to_owned()),
    }
}

/// The log after the seed, as `(type, payload)` — ids and envelope times are
/// minted per call and are not the format.
fn written(core: &Core, skip: usize) -> Vec<(String, Value)> {
    let export: Value = serde_json::from_str(&core.export_data().expect("export")).expect("json");
    export["events"]
        .as_array()
        .expect("rows")
        .iter()
        .skip(skip)
        .map(|event| {
            let kind = event["type"].as_str().expect("type").to_owned();
            (kind, event["payload"].clone())
        })
        .collect()
}

const SEED_EVENTS: usize = 3;

#[test]
fn an_answer_is_the_events_the_three_calls_wrote() {
    let one = seeded();
    let filed = one
        .record_answer(&AnswerRecord {
            result: result("c1", Verdict::Wrong),
            item_ids: vec!["i1".into(), "i2".into()],
            item_verdicts: Some(vec![
                GapVerdict {
                    item_id: "i1".into(),
                    verdict: Verdict::Correct,
                },
                GapVerdict {
                    item_id: "i2".into(),
                    verdict: Verdict::Wrong,
                },
            ]),
        })
        .expect("filed");
    assert_eq!(filed.reviewed, ["i1", "i2"]);

    let three = seeded();
    three
        .review_item("i1", ANSWERED, grade_of(Verdict::Correct), false)
        .expect("review");
    three
        .review_item("i2", ANSWERED, grade_of(Verdict::Wrong), false)
        .expect("review");
    three
        .add_result(&result("c1", Verdict::Wrong))
        .expect("result");
    three.record_serve("c1", Some(ANSWERED)).expect("serve");

    assert_eq!(written(&one, SEED_EVENTS), written(&three, SEED_EVENTS));
    let kinds: Vec<String> = written(&one, SEED_EVENTS)
        .into_iter()
        .map(|(kind, _)| kind)
        .collect();
    assert_eq!(
        kinds,
        [
            "itemReviewed",
            "itemReviewed",
            "resultLogged",
            "challengeServed"
        ]
    );
    // And the read tables agree: the cards, the result, the stamp, the
    // ratings the answer taught.
    for id in ["i1", "i2"] {
        let (a, b) = (
            one.get_item(id).unwrap().unwrap(),
            three.get_item(id).unwrap().unwrap(),
        );
        assert_eq!(a.fsrs_card, b.fsrs_card);
    }
    assert_eq!(one.get_ratings().unwrap(), three.get_ratings().unwrap());
    assert_eq!(
        one.recent_results(5).unwrap(),
        three.recent_results(5).unwrap()
    );
    assert_eq!(one.get_pool().unwrap(), three.get_pool().unwrap());
}

#[test]
fn every_verdict_files_its_grade_and_none_files_easy() {
    assert_eq!(grade_of(Verdict::Wrong), 1.0);
    assert_eq!(grade_of(Verdict::Almost), 2.0);
    assert_eq!(grade_of(Verdict::Correct), 3.0);
}

#[test]
fn a_word_without_its_own_verdict_takes_the_answers() {
    let core = seeded();
    core.record_answer(&AnswerRecord {
        result: result("c1", Verdict::Almost),
        item_ids: vec!["i1".into(), "i2".into()],
        item_verdicts: None,
    })
    .expect("filed");
    let grades: Vec<Value> = written(&core, SEED_EVENTS)
        .into_iter()
        .filter(|(kind, _)| kind == "itemReviewed")
        .map(|(_, payload)| payload["grade"].clone())
        .collect();
    assert_eq!(grades, [json!(2.0), json!(2.0)]);
}

#[test]
fn a_gone_word_and_an_unpooled_round_are_skipped_not_failed() {
    let core = seeded();
    core.delete_item("i2").expect("delete");
    let filed = core
        .record_answer(&AnswerRecord {
            result: result("round-1", Verdict::Correct),
            item_ids: vec!["i1".into(), "i2".into()],
            item_verdicts: None,
        })
        .expect("filed");
    assert_eq!(filed.reviewed, ["i1"]);
    let kinds: Vec<String> = written(&core, SEED_EVENTS + 1)
        .into_iter()
        .map(|(kind, _)| kind)
        .collect();
    assert_eq!(kinds, ["itemReviewed", "resultLogged"]);
}

#[test]
fn a_match_round_reviews_nothing_and_is_still_logged() {
    let core = seeded();
    let filed = core
        .record_answer(&AnswerRecord {
            result: result("round-2", Verdict::Correct),
            item_ids: Vec::new(),
            item_verdicts: None,
        })
        .expect("filed");
    assert!(filed.reviewed.is_empty());
    let kinds: Vec<String> = written(&core, SEED_EVENTS)
        .into_iter()
        .map(|(kind, _)| kind)
        .collect();
    assert_eq!(kinds, ["resultLogged"]);
}
