//! Registry conformance: every plugin is exercised through the generated union.

use sapling_domain::types::Verdict;
use serde_json::{json, Value};

use super::*;

fn examples() -> Vec<(Value, Value, &'static str)> {
    vec![
        (
            json!({"type":"multiple-choice","id":"m","direction":"toTarget","prompt":"menu","options":["menú","mesa","casa","pan"],"correctIndex":0,"itemIds":["i"]}),
            json!({"type":"multiple-choice","answer":{"index":1}}),
            "menú",
        ),
        (
            json!({"type":"cloze","id":"c","direction":"toTarget","sentence":"El ___.","acceptedAnswers":["menú"],"wordBank":["menú","mesa","casa","pan","agua","café"],"translationHint":"The menu.","itemIds":["i"]}),
            json!({"type":"cloze","answer":{"text":"completamente incorrecto","picked":false}}),
            "menú",
        ),
        (
            json!({"type":"typed-translation","id":"t","direction":"toTarget","prompt":"the menu","acceptedAnswers":["el menú"],"itemIds":["i"]}),
            json!({"type":"typed-translation","answer":{"text":"completamente incorrecto"}}),
            "el menú",
        ),
        (
            json!({"type":"match-pairs","id":"p","direction":"toNative","pairs":[{"a":"menú","b":"menu"},{"a":"mesa","b":"table"}],"itemIds":[]}),
            json!({"type":"match-pairs","answer":{"mistakes":1}}),
            "2 pairs, 0 mistakes",
        ),
        (
            json!({"type":"multi-cloze","id":"m2","direction":"toTarget","passage":"___1___ y ___2___","gaps":[{"itemId":"i","acceptedAnswers":["uno"]},{"itemId":"j","acceptedAnswers":["dos"]}],"wordBank":["uno","dos","tres","cuatro"],"itemIds":["i","j"]}),
            json!({"type":"multi-cloze","answer":{"positions":[2,3]}}),
            "1: uno · 2: dos",
        ),
        (
            json!({"type":"word-order","id":"w","direction":"toTarget","prompt":"the menu","tiles":["el","menú","mesa"],"answerTokens":["el","menú"],"answer":"el menú","itemIds":["i"]}),
            json!({"type":"word-order","answer":{"positions":[1,0]}}),
            "el menú",
        ),
        (
            json!({"type":"spot-error","id":"s","direction":"toNative","tokens":["El","mesa","llega"],"correctIndex":1,"intendedWord":"menú","correctedSentence":"El menú llega","meaning":"The menu arrives","itemIds":["i"]}),
            json!({"type":"spot-error","answer":{"index":0}}),
            "mesa",
        ),
    ]
}

#[test]
fn every_registered_type_round_trips_serves_grades_and_logs() {
    let examples = examples();
    assert_eq!(examples.len(), ChallengeType::ALL.len());
    for (row, wrong, correct_log) in examples {
        let challenge = Challenge::from_value(row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&challenge).unwrap(), row);
        challenge.check_shape().unwrap();
        let wrong: ChallengeAnswer = serde_json::from_value(wrong).unwrap();
        for step in challenge.steps() {
            for level in [HelpLevel::step(step), HelpLevel::hidden(step)] {
                assert_eq!(HelpLevel::parse(&level.id()), Some(level));
                let served = challenge.serve(level);
                assert_eq!(served.shown, level.id());
                let correct = challenge.correct_answer(level);
                let graded = challenge.grade(level, &correct).unwrap();
                assert_eq!(
                    graded.verdict,
                    Verdict::Correct,
                    "{}",
                    challenge.kind().as_str()
                );
                assert_eq!(graded.logged, correct_log, "{}", challenge.kind().as_str());
                assert!(!graded.logged.is_empty());
                assert_ne!(
                    challenge.grade(level, &wrong).unwrap().verdict,
                    Verdict::Correct
                );
            }
        }
    }
}

#[test]
fn registry_tags_and_type_data_are_total() {
    let mut tags = STORED_TYPES.to_vec();
    tags.sort_unstable();
    tags.dedup();
    assert_eq!(tags.len(), ChallengeType::ALL.len());
    for source in TYPE_SOURCES {
        let value: Value = serde_json::from_str(source).unwrap();
        assert!(value["steps"]
            .as_array()
            .is_some_and(|steps| !steps.is_empty()));
    }
}
