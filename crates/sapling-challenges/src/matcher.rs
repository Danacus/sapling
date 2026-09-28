//! The string matchers: a free-text answer against accepted ones.
//!
//! Learners should not be punished for a missing accent, a stray article or a
//! one-character typo, but they should be told about it — hence `almost`.
//! These know nothing about challenges; which field of which type is graded
//! how is `grade.rs`. The typing components call them directly as well.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use unicode_general_category::{get_general_category, GeneralCategory as G};
use unicode_normalization::UnicodeNormalization;

use sapling_domain::types::Verdict;

use crate::text::{fold_diacritics, is_js_space};

/// A free-text answer, graded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnswerMatch {
    pub verdict: Verdict,
    /// The accepted answer closest (smallest edit distance) to what was given.
    pub closest_accepted: String,
    /// Edit distance to `closestAccepted`, on normalized and diacritic-folded
    /// strings. Absent when there was nothing to compare against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub distance: Option<u32>,
}

fn is_punctuation_or_symbol(c: char) -> bool {
    matches!(
        get_general_category(c),
        G::ConnectorPunctuation
            | G::DashPunctuation
            | G::OpenPunctuation
            | G::ClosePunctuation
            | G::InitialPunctuation
            | G::FinalPunctuation
            | G::OtherPunctuation
            | G::MathSymbol
            | G::CurrencySymbol
            | G::ModifierSymbol
            | G::OtherSymbol
    )
}

fn is_letter_or_digit(c: char) -> bool {
    matches!(
        get_general_category(c),
        G::UppercaseLetter
            | G::LowercaseLetter
            | G::TitlecaseLetter
            | G::ModifierLetter
            | G::OtherLetter
            | G::DecimalNumber
            | G::LetterNumber
            | G::OtherNumber
    )
}

/// Lowercase, trim, collapse whitespace and strip punctuation and symbols —
/// except an apostrophe or hyphen between two letters (`l'eau`, `long-term`),
/// which is doing morphological work. `fold` also drops diacritics.
pub fn normalize(input: &str, fold: bool) -> String {
    let lowered = input.nfc().collect::<String>().to_lowercase();
    let chars: Vec<char> = lowered.chars().collect();
    let spaced: String = chars
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            if !is_punctuation_or_symbol(c) {
                return c;
            }
            let inside = "'’-".contains(c)
                && i > 0
                && chars
                    .get(i + 1)
                    .is_some_and(|&next| is_letter_or_digit(next))
                && is_letter_or_digit(chars[i - 1]);
            if inside {
                c
            } else {
                ' '
            }
        })
        .collect();
    let collapsed = spaced
        .split(is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if fold {
        fold_diacritics(&collapsed)
    } else {
        collapsed
    }
}

/// Damerau-Levenshtein (optimal string alignment) over code points.
pub fn edit_distance(a: &str, b: &str) -> u32 {
    let s: Vec<char> = a.chars().collect();
    let t: Vec<char> = b.chars().collect();
    let (m, n) = (s.len(), t.len());
    if m == 0 || n == 0 {
        return (m + n) as u32;
    }
    let mut d = vec![vec![0u32; n + 1]; m + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i as u32;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j as u32;
    }
    for i in 1..=m {
        for j in 1..=n {
            let cost = u32::from(s[i - 1] != t[j - 1]);
            let mut best = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && s[i - 1] == t[j - 2] && s[i - 2] == t[j - 1] {
                best = best.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = best;
        }
    }
    d[m][n]
}

/// How many edits still count as a typo, by the accepted answer's length (in
/// UTF-16 units, as the TypeScript matcher measured it).
fn threshold(length: usize) -> u32 {
    match length {
        0..=3 => 0,
        4..=7 => 1,
        8..=12 => 2,
        _ => 3,
    }
}

fn rank(verdict: Verdict) -> u8 {
    match verdict {
        Verdict::Correct => 2,
        Verdict::Almost => 1,
        Verdict::Wrong => 0,
    }
}

/// The best verdict against any accepted answer: an exact normalized match is
/// `correct`; a diacritic-folded match or a typo within [`threshold`] is
/// `almost` (unless `fuzzy` is off); anything else `wrong`. `closestAccepted`
/// is the nearest by edit distance whatever decided the verdict.
pub fn validate_answer(given: &str, accepted: &[String], fuzzy: bool) -> AnswerMatch {
    let Some(first) = accepted.first() else {
        return AnswerMatch {
            verdict: Verdict::Wrong,
            closest_accepted: String::new(),
            distance: None,
        };
    };
    let norm_given = normalize(given, false);
    let fold_given = normalize(given, true);
    let mut best = Verdict::Wrong;
    let mut closest = first;
    let mut closest_distance = u32::MAX;
    for candidate in accepted {
        let fold_candidate = normalize(candidate, true);
        let distance = edit_distance(&fold_given, &fold_candidate);
        if distance < closest_distance {
            closest_distance = distance;
            closest = candidate;
        }
        let verdict = if !norm_given.is_empty() && norm_given == normalize(candidate, false) {
            Verdict::Correct
        } else if fuzzy && distance <= threshold(fold_candidate.encode_utf16().count()) {
            Verdict::Almost
        } else {
            Verdict::Wrong
        };
        if rank(verdict) > rank(best) {
            best = verdict;
        }
    }
    AnswerMatch {
        verdict: best,
        closest_accepted: closest.clone(),
        distance: Some(closest_distance),
    }
}

pub fn check_answer(given: &str, accepted: &[String]) -> Verdict {
    validate_answer(given, accepted, true).verdict
}

#[cfg(test)]
mod tests {
    use super::*;
    use Verdict::{Almost, Correct, Wrong};

    fn list(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    fn validate(given: &str, accepted: &[&str]) -> AnswerMatch {
        validate_answer(given, &list(accepted), true)
    }

    fn check(given: &str, accepted: &[&str]) -> Verdict {
        check_answer(given, &list(accepted))
    }

    #[test]
    fn normalize_lowercases_trims_and_collapses() {
        assert_eq!(normalize("  Hello   World  ", false), "hello world");
        assert_eq!(normalize("", false), "");
        assert_eq!(normalize("   ", false), "");
        assert_eq!(normalize("\t\n  \t", false), "");
    }

    #[test]
    fn normalize_strips_separating_punctuation_and_keeps_it_inside_words() {
        assert_eq!(normalize("¿Qué tal?", false), "qué tal");
        assert_eq!(normalize("'hello'", false), "hello");
        assert_eq!(normalize("Hi, there!", false), "hi there");
        assert_eq!(normalize("l'eau", false), "l'eau");
        assert_eq!(normalize("long-term", false), "long-term");
        assert_eq!(normalize("well - known", false), "well known");
    }

    #[test]
    fn normalize_folds_diacritics_only_when_asked() {
        assert_eq!(normalize("café", false), "café");
        assert_eq!(normalize("café", true), "cafe");
        assert_eq!(normalize("Über", true), "uber");
        assert_eq!(normalize("naïve", true), "naive");
    }

    #[test]
    fn normalize_leaves_other_scripts_alone_but_their_punctuation() {
        assert_eq!(normalize("你好，世界！", false), "你好 世界");
        assert_eq!(normalize("こんにちは", false), "こんにちは");
        assert_eq!(normalize("请给我一份菜单。", false), "请给我一份菜单");
    }

    #[test]
    fn edit_distance_is_damerau_over_code_points() {
        assert_eq!(edit_distance("same", "same"), 0);
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("abc", ""), 3);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("sitting", "kitten"), 3);
        assert_eq!(edit_distance("hte", "the"), 1);
        assert_eq!(edit_distance("ac", "ca"), 1);
        assert_eq!(edit_distance("shcool", "school"), 1);
        assert_eq!(edit_distance("你好", "你号"), 1);
        assert_eq!(edit_distance("你好", "你們"), 1);
        assert_eq!(edit_distance("こんにちは", "こんにちわ"), 1);
    }

    #[test]
    fn the_correct_tier_is_an_exact_normalized_match() {
        let exact = validate("hello", &["hello"]);
        assert_eq!(
            (
                exact.verdict,
                exact.closest_accepted.as_str(),
                exact.distance
            ),
            (Correct, "hello", Some(0))
        );
        assert_eq!(check("HELLO", &["hello"]), Correct);
        assert_eq!(check("hello", &["HELLO"]), Correct);
        assert_eq!(check("  hello world  ", &["hello world"]), Correct);
        assert_eq!(check("hello    world", &["hello world"]), Correct);
        assert_eq!(check("Good Morning", &["good morning"]), Correct);
        assert_eq!(check("¿Qué tal?", &["¿Qué tal?"]), Correct);
        assert_eq!(check("don't stop", &["don't stop"]), Correct);
        assert_eq!(check("café", &["café"]), Correct);
        let second = validate("hello", &["goodbye", "hello"]);
        assert_eq!(
            (second.verdict, second.closest_accepted.as_str()),
            (Correct, "hello")
        );
    }

    #[test]
    fn a_missing_or_extra_accent_is_almost() {
        let cafe = validate("cafe", &["café"]);
        assert_eq!(
            (cafe.verdict, cafe.closest_accepted.as_str(), cafe.distance),
            (Almost, "café", Some(0))
        );
        assert_eq!(validate("uber", &["über"]).closest_accepted, "über");
        assert_eq!(check("übér", &["uber"]), Almost);
    }

    #[test]
    fn a_typo_within_the_threshold_is_almost() {
        let helo = validate("helo", &["hello"]);
        assert_eq!((helo.verdict, helo.distance), (Almost, Some(1)));
        assert_eq!(validate("shcool", &["school"]).verdict, Almost);
        assert_eq!(check("hu", &["hi"]), Wrong);
        let hte = validate("hte", &["the"]);
        assert_eq!((hte.verdict, hte.distance), (Wrong, Some(1)));
        let que = validate("que tal", &["¿Qué tal?"]);
        assert_eq!((que.verdict, que.distance), (Almost, Some(0)));
    }

    #[test]
    fn the_threshold_steps_with_length() {
        for (len, threshold) in [(3, 0), (4, 1), (7, 1), (8, 2), (12, 2), (13, 3)] {
            let accepted = "a".repeat(len);
            if threshold > 0 {
                let at = validate(&(accepted.clone() + &"b".repeat(threshold)), &[&accepted]);
                assert_eq!(
                    (at.verdict, at.distance),
                    (Almost, Some(threshold as u32)),
                    "{len}"
                );
            }
            let over = validate(
                &(accepted.clone() + &"b".repeat(threshold + 1)),
                &[&accepted],
            );
            assert_eq!(
                (over.verdict, over.distance),
                (Wrong, Some(threshold as u32 + 1)),
                "{len}"
            );
        }
    }

    #[test]
    fn closest_accepted_is_the_nearest_whatever_the_verdict() {
        let far = validate("ho", &["hi", "banana"]);
        assert_eq!(
            (far.verdict, far.closest_accepted.as_str(), far.distance),
            (Wrong, "hi", Some(1))
        );
        let appel = validate("appel", &["apple", "banana"]);
        assert_eq!(
            (appel.verdict, appel.closest_accepted.as_str()),
            (Almost, "apple")
        );
        assert_eq!(validate("cet", &["cat", "cot"]).closest_accepted, "cat");
        assert_eq!(check("banana", &["apple"]), Wrong);
    }

    #[test]
    fn edge_cases() {
        let empty = validate("", &["hello"]);
        assert_eq!(
            (
                empty.verdict,
                empty.closest_accepted.as_str(),
                empty.distance
            ),
            (Wrong, "hello", Some(5))
        );
        assert_eq!(check("   ", &["hi"]), Wrong);
        let none = validate("anything", &[]);
        assert_eq!(
            (none.verdict, none.closest_accepted.as_str(), none.distance),
            (Wrong, "", None)
        );
        assert_eq!(check("l'eau", &["l'eau"]), Correct);
        assert_eq!(check("leau", &["l'eau"]), Almost);
        assert_eq!(check("你好", &["你好"]), Correct);
        assert_eq!(check("你号", &["你好"]), Wrong);
        let long = validate("こんにちわ", &["こんにちは"]);
        assert_eq!((long.verdict, long.distance), (Almost, Some(1)));
        let strict = validate_answer("helo", &list(&["hello"]), false);
        assert_eq!((strict.verdict, strict.distance), (Wrong, Some(1)));
    }

    #[test]
    fn romanized_answers_grade_through_the_listed_variants() {
        let ni_hao = ["你好", "nǐ hǎo", "ni hao"];
        assert_eq!(check("ni hao", &ni_hao), Correct);
        assert_eq!(check("nǐ hǎo", &ni_hao), Correct);
        assert_eq!(check("你好", &ni_hao), Correct);
        assert_eq!(check("Ni Hao", &ni_hao), Correct);
        assert_eq!(check("ni hao", &["你好", "nǐ hǎo"]), Almost);
        assert_eq!(check("你們", &["你好"]), Wrong);
        assert_eq!(check("ni hoa", &ni_hao), Almost);
    }
}
