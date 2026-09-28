//! Grading, per type, from the one string the component reports: what the
//! learner typed, the tile sentence they assembled, the token they tapped, an
//! `"a::b"` pair. Typed answers earn `almost` for a near miss; tapped ones were
//! chosen from a closed set and are exact. Type-blind otherwise: nothing here
//! reads demand or difficulty.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_domain::types::Verdict;

use crate::challenge::{Challenge, MultiClozeChallenge};
use crate::matcher::{check_answer, normalize};
use crate::text::{is_js_space, js_trim};

/// The numbered marker for one zero-based gap.
pub fn multi_cloze_marker(index: usize) -> String {
    format!("___{}___", index + 1)
}

/// One gap's verdict, which is what its own word is reviewed with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GapVerdict {
    pub item_id: String,
    pub verdict: Verdict,
}

/// A passage graded gap by gap; the overall verdict is the worst of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeGrade {
    pub verdict: Verdict,
    pub item_verdicts: Vec<GapVerdict>,
}

pub fn grade_multi_cloze(challenge: &MultiClozeChallenge, answers: &[String]) -> MultiClozeGrade {
    let item_verdicts: Vec<GapVerdict> = challenge
        .gaps
        .iter()
        .enumerate()
        .map(|(index, gap)| GapVerdict {
            item_id: gap.item_id.clone(),
            verdict: check_answer(
                answers.get(index).map_or("", String::as_str),
                &gap.accepted_answers,
            ),
        })
        .collect();
    let any = |verdict| item_verdicts.iter().any(|g| g.verdict == verdict);
    let verdict = if any(Verdict::Wrong) {
        Verdict::Wrong
    } else if any(Verdict::Almost) {
        Verdict::Almost
    } else {
        Verdict::Correct
    };
    MultiClozeGrade {
        verdict,
        item_verdicts,
    }
}

/// The answers back out of the logged form, `"1: Yo · 2: bebo"`, which the
/// multi-cloze component writes.
fn serialized_answers(answer: &str) -> Vec<String> {
    answer
        .split(" · ")
        .map(|entry| {
            let digits = entry.len() - entry.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            let rest = match entry[digits..].strip_prefix(':') {
                Some(rest) if digits > 0 => rest.trim_start_matches(is_js_space),
                _ => entry,
            };
            js_trim(rest).to_owned()
        })
        .collect()
}

fn same(a: &str, b: &str) -> bool {
    normalize(a, false) == normalize(b, false)
}

pub fn check(challenge: &Challenge, answer: &str) -> Verdict {
    let exact = |hit: bool| {
        if hit {
            Verdict::Correct
        } else {
            Verdict::Wrong
        }
    };
    match challenge {
        Challenge::MultipleChoice(c) => match c.options.get(c.correct_index) {
            Some(option) => check_answer(answer, std::slice::from_ref(option)),
            None => Verdict::Wrong,
        },
        Challenge::Cloze(c) => check_answer(answer, &c.accepted_answers),
        Challenge::TypedTranslation(c) => check_answer(answer, &c.accepted_answers),
        Challenge::MultiCloze(c) => grade_multi_cloze(c, &serialized_answers(answer)).verdict,
        // Graded a tap at a time in the component; one resolved pair as `a::b` or `a|b`.
        Challenge::MatchPairs(c) => {
            let parts: Vec<&str> = answer
                .split("::")
                .flat_map(|p| p.split('|'))
                .map(js_trim)
                .collect();
            let [a, b] = parts[..] else {
                return Verdict::Wrong;
            };
            exact(
                c.pairs
                    .iter()
                    .any(|pair| same(a, &pair.a) && same(b, &pair.b)),
            )
        }
        Challenge::WordOrder(c) => exact(same(answer, &c.answer)),
        // The answer is the *wrong* word, the one the learner has to tap.
        Challenge::SpotError(c) => exact(
            c.tokens
                .get(c.correct_index)
                .is_some_and(|token| same(answer, token)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use Verdict::{Almost, Correct, Wrong};

    fn challenge(row: Value) -> Challenge {
        Challenge::from_value(row).unwrap()
    }

    #[test]
    fn a_cloze_grades_against_its_accepted_answers() {
        let cloze = challenge(
            json!({ "id": "c1", "type": "cloze", "direction": "toTarget",
            "sentence": "Ich ___ nach Hause.", "acceptedAnswers": ["gehe"], "translationHint": "I am going home.", "itemIds": ["i"] }),
        );
        assert_eq!(check(&cloze, "gehe"), Correct);
        assert_eq!(check(&cloze, "gehee"), Almost);
        assert_eq!(check(&cloze, "komme"), Wrong);
    }

    #[test]
    fn a_typed_translation_takes_the_best_of_its_answers() {
        let typed = challenge(
            json!({ "id": "t1", "type": "typed-translation", "direction": "toTarget",
            "prompt": "good morning", "acceptedAnswers": ["buenos días", "buenos dias"], "itemIds": ["i"] }),
        );
        assert_eq!(check(&typed, "Buenos Días"), Correct);
        assert_eq!(check(&typed, "buenos dias"), Correct);
        assert_eq!(check(&typed, "buenos dia"), Almost);
    }

    #[test]
    fn multiple_choice_grades_against_the_correct_option_text() {
        let mc = challenge(
            json!({ "id": "m1", "type": "multiple-choice", "direction": "toNative",
            "prompt": "casa", "options": ["house", "car", "tree", "dog"], "correctIndex": 0, "itemIds": ["i"] }),
        );
        assert_eq!(check(&mc, "house"), Correct);
        assert_eq!(check(&mc, "House"), Correct);
        assert_eq!(check(&mc, "car"), Wrong);
    }

    #[test]
    fn match_pairs_grades_one_resolved_pair() {
        let pairs = challenge(
            json!({ "id": "p1", "type": "match-pairs", "direction": "toTarget",
            "pairs": [{ "a": "hola", "b": "hello" }, { "a": "adiós", "b": "goodbye" }], "itemIds": ["i"] }),
        );
        assert_eq!(check(&pairs, "hola::hello"), Correct);
        assert_eq!(check(&pairs, "adiós|goodbye"), Correct);
        assert_eq!(check(&pairs, "hola::goodbye"), Wrong);
        assert_eq!(check(&pairs, "not a pair"), Wrong);
        assert_eq!(check(&pairs, "hola::hello|x"), Wrong);
    }

    #[test]
    fn word_order_is_exact_one_tile_out_is_wrong() {
        let wo = challenge(
            json!({ "id": "w1", "type": "word-order", "direction": "toTarget", "prompt": "I am going home.",
            "tiles": ["Hause.", "Ich", "nach", "gehe", "komme"], "answerTokens": ["Ich", "gehe", "nach", "Hause."],
            "answer": "Ich gehe nach Hause.", "itemIds": ["i"] }),
        );
        assert_eq!(check(&wo, "Ich gehe nach Hause."), Correct);
        assert_eq!(check(&wo, "Ich nach gehe Hause."), Wrong);
        assert_eq!(check(&wo, "Ich gehe nach Hausee."), Wrong);
    }

    #[test]
    fn spot_error_is_answered_by_the_wrong_word() {
        let spot = challenge(
            json!({ "id": "s1", "type": "spot-error", "direction": "toNative",
            "tokens": ["Ich", "komme", "nach", "Hause."], "correctIndex": 1, "intendedWord": "gehe",
            "correctedSentence": "Ich gehe nach Hause.", "meaning": "I am going home.", "itemIds": ["i"] }),
        );
        assert_eq!(check(&spot, "komme"), Correct);
        assert_eq!(check(&spot, "gehe"), Wrong);
        assert_eq!(check(&spot, "Hause."), Wrong);
    }

    fn passage() -> MultiClozeChallenge {
        serde_json::from_value(json!({ "id": "mc1", "type": "multi-cloze", "direction": "toTarget",
            "passage": "___1___ leo un libro. Luego ___2___ café.",
            "gaps": [{ "itemId": "i1", "acceptedAnswers": ["Yo"] }, { "itemId": "i2", "acceptedAnswers": ["bebo"] }],
            "wordBank": ["Yo", "bebo", "como", "libro", "café"], "itemIds": ["i1", "i2"] }))
        .unwrap()
    }

    #[test]
    fn a_passage_is_as_wrong_as_its_worst_gap_and_each_gap_keeps_its_verdict() {
        let graded = grade_multi_cloze(&passage(), &["Yo".into(), "como".into()]);
        assert_eq!(graded.verdict, Wrong);
        assert_eq!(
            graded.item_verdicts,
            [
                GapVerdict {
                    item_id: "i1".into(),
                    verdict: Correct
                },
                GapVerdict {
                    item_id: "i2".into(),
                    verdict: Wrong
                },
            ]
        );
        let near = grade_multi_cloze(&passage(), &["Yo".into(), "bebbo".into()]);
        assert_eq!(near.verdict, Almost);
        assert_eq!(grade_multi_cloze(&passage(), &["Yo".into()]).verdict, Wrong);
    }

    #[test]
    fn a_logged_passage_answer_grades_as_it_was_given() {
        let multi = Challenge::MultiCloze(passage());
        assert_eq!(check(&multi, "1: Yo · 2: bebo"), Correct);
        assert_eq!(check(&multi, "1: Yo · 2: —"), Wrong);
        assert_eq!(
            serialized_answers("1:  Yo · 2:bebo · como"),
            ["Yo", "bebo", "como"]
        );
    }
}
