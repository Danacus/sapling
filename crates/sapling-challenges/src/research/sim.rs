//! The simulated learner's starting truth, and the synthetic rows the closed
//! loop writes and the planners' tests build pools from.
//!
//! The truth has the model's shape — a sigmoid of a word's skill against a
//! kind and help level's difficulty and a length slope — with memory from
//! FSRS on top, but its numbers are not the model's starting values.

use serde_json::{json, Value};

use crate::help::{HelpLevel, Step};
use crate::kinds::WireType;
use crate::model::logit;

/// What hiding the reading adds to a help level's truth, and what listening
/// adds to a kind's `plain`.
const HIDDEN: f64 = 0.6;
const LISTENING: f64 = 0.8;
/// The chance a brand-new word, remembered, manages the easiest question.
const NEW_WORD_CHANCE: f64 = 0.9;

/// The simulated learner's starting truth per kind: a base per step and a
/// length slope. A kind's unlisted step reads its first listed one.
fn truth_table(kind: WireType) -> (&'static [(Step, f64)], f64) {
    match kind {
        WireType::RecognizeMc => (&[(Step::Plain, 0.0)], 0.12),
        WireType::ProduceMc => (&[(Step::Plain, 0.3)], 0.12),
        WireType::ContextMc => (&[(Step::Plain, 0.7)], 0.12),
        WireType::TranslateToNative => (&[(Step::Plain, 0.9)], 0.12),
        WireType::TranslateToTarget => (&[(Step::Plain, 2.8)], 0.15),
        WireType::SpotError => (&[(Step::Plain, 0.3)], 0.12),
        WireType::WordOrder => (&[(Step::Tiles, 1.3), (Step::Extra2, 2.1)], 0.15),
        WireType::Cloze => (
            &[(Step::Pick4, 1.1), (Step::Pick6, 1.9), (Step::Typed, 3.1)],
            0.12,
        ),
        WireType::MultiCloze => (&[(Step::Answers, 1.9), (Step::Extra2, 2.6)], 0.08),
        WireType::CueCloze => (
            &[(Step::Pick4, 1.3), (Step::Pick6, 2.1), (Step::Typed, 3.4)],
            0.14,
        ),
    }
}

/// Where a kind and help level start in the simulated truth: the step's
/// number, plus what hiding the reading or listening adds.
pub fn starting_base(kind: WireType, help: HelpLevel) -> f64 {
    let (steps, _) = truth_table(kind);
    let of = |step: Step| {
        steps
            .iter()
            .find(|(s, _)| *s == step)
            .or(steps.first())
            .map_or(0.0, |(_, b)| *b)
    };
    if help.listening {
        return of(Step::Plain) + LISTENING;
    }
    of(help.step) + if help.reading_hidden { HIDDEN } else { 0.0 }
}

pub fn starting_slope(kind: WireType) -> f64 {
    truth_table(kind).1
}

/// A brand-new word's skill: just above the easiest help level of the easiest kind.
pub fn starting_skill() -> f64 {
    let easiest = WireType::ALL
        .into_iter()
        .filter(|kind| kind.is_active())
        .map(|kind| starting_base(kind, HelpLevel::step(Step::Plain)) + starting_slope(kind))
        .fold(f64::INFINITY, f64::min);
    easiest + logit(NEW_WORD_CHANCE)
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
        WireType::CueCloze => json!({
            "type": "cue-cloze", "sentence": format!("{} ___", words("s", length.saturating_sub(1)).join(" ")),
            "acceptedAnswers": ["x"], "wordBank": ["x", "b1", "b2", "b3", "b4", "b5"], "meaningHint": "h",
            "cue": { "textId": "t", "start": 0.0, "end": 1000.0 } }),
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

/// A [`synthetic`] row as a language with a reading writes it: the reading
/// beside its target-language text, the shape `help.rs`' `has_readings` reads.
pub fn with_readings(mut row: Value) -> Value {
    let along = |row: &Value, key: &str| {
        Value::Array(vec![json!("r"); row[key].as_array().map_or(0, Vec::len)])
    };
    match row["type"].as_str() {
        Some("multiple-choice" | "typed-translation") => row["promptRomanization"] = json!("r"),
        Some("cloze") => row["sentenceRomanization"] = json!("r ___"),
        // A cue-cloze's reading is the frontend's, so its script is what carries one.
        Some("cue-cloze") => row["sentence"] = json!("字字___"),
        Some("multi-cloze") => row["passageRomanization"] = json!("___1___ r ___2___"),
        Some("word-order") => row["tilesRomanization"] = along(&row, "tiles"),
        Some("spot-error") => row["tokensRomanization"] = along(&row, "tokens"),
        _ => {}
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kinds::kind_of;
    use crate::model::length_of;
    use crate::Challenge;

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
}
