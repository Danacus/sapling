//! How much a challenge asks, in two layers: the demand tier (0 recognition,
//! 1 constrained production, 2 free production) and, within it, how hard this
//! row reads from its own fields. The tiers are spans of the strength axis
//! (`ladder.rs`), so a lower-demand challenge never outranks a higher-demand one.
//!
//! The within-tier number is compared *across* types for one word, so every
//! prose-length knob is read on one shared scale and each format starts from
//! its own base. Structural only: never the learner's history, never `now`,
//! and never consulted by grading.

use crate::challenge::{Challenge, Direction};
use crate::ladder::level_band;
use crate::text::WordCount;
use crate::tuning::scales;

/// An ordinal: `0 < 1 < 2` is the only arithmetic to do with it.
pub type Demand = u8;

pub fn demand_of(challenge: &Challenge) -> Demand {
    match challenge {
        // The answer is on screen and picked out of a closed set, either way round.
        Challenge::MultipleChoice(_) => 0,
        // With a bank the word is chosen; without one it is recalled and spelled.
        Challenge::Cloze(c) => {
            if c.word_bank.as_ref().is_some_and(|bank| !bank.is_empty()) {
                1
            } else {
                2
            }
        }
        Challenge::MultiCloze(_) => 1,
        // Typing in your own language demands nothing of target-language recall.
        Challenge::TypedTranslation(c) => {
            if c.direction == Direction::ToTarget {
                2
            } else {
                0
            }
        }
        Challenge::MatchPairs(_) => 0,
        Challenge::WordOrder(_) => 1,
        Challenge::SpotError(_) => 0,
    }
}

pub fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Where a word count sits on the shared prose-length scale.
pub fn length_knob(words: usize) -> f64 {
    let [shortest, longest] = scales().prompt_words;
    clamp01((words as f64 - shortest) / (longest - shortest))
}

/// A format's base within its tier, with its knobs over the remainder.
pub fn with_base(base: f64, knob: f64) -> f64 {
    let floor = clamp01(base);
    clamp01(floor + (1.0 - floor) * clamp01(knob))
}

fn base(challenge: &Challenge) -> f64 {
    scales()
        .bases
        .get(challenge.kind().as_str())
        .copied()
        .unwrap_or(0.0)
}

/// `___N___` markers replaced, as the passage is read for its length.
fn without_markers(passage: &str, with: &str) -> String {
    let mut out = String::with_capacity(passage.len());
    let mut rest = passage;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("___") {
            let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if digits > 0 && after[digits..].starts_with("___") {
                out.push_str(with);
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

/// How hard this row reads within its tier, 0..1.
pub fn within_tier(challenge: &Challenge, words: WordCount) -> f64 {
    let base = base(challenge);
    match challenge {
        Challenge::MultipleChoice(c) => with_base(base, length_knob(words(&c.prompt))),
        // The gap is split out first: a segmenter reads a lone `___` as a word
        // and glues a mid-word one to its neighbours.
        Challenge::Cloze(c) => with_base(
            base,
            length_knob(words(
                &c.sentence.split("___").collect::<Vec<_>>().join(" "),
            )),
        ),
        // Several gaps share one bank, so placements grow as gaps! does.
        Challenge::MultiCloze(c) => {
            let scale = &scales().multi_cloze;
            let factorial = |n: usize| (2..=n).map(|v| v as f64).product::<f64>();
            let placements = clamp01(factorial(c.gaps.len()).ln() / factorial(scale.max_gaps).ln());
            let [shortest, longest] = scale.passage_words;
            let count = words(&without_markers(&c.passage, " ")) as f64;
            let passage = clamp01((count - shortest) / (longest - shortest));
            let weight = scale.placement_weight;
            with_base(base, placements * weight + passage * (1.0 - weight))
        }
        Challenge::TypedTranslation(c) => with_base(base, length_knob(words(&c.prompt))),
        Challenge::MatchPairs(c) => {
            let [fewest, most] = scales().match_pairs;
            clamp01((c.pairs.len() as f64 - fewest) / (most - fewest))
        }
        // One tile per word, so the answer's own tiles are its length.
        Challenge::WordOrder(c) => with_base(base, length_knob(c.answer_tokens.len())),
        Challenge::SpotError(c) => with_base(base, length_knob(c.tokens.len())),
    }
}

/// The strength span a demand tier owns: band 1, bands 2-3, bands 4-5.
pub fn tier_span(demand: Demand) -> (f64, f64) {
    match demand {
        0 => level_band(1),
        1 => (level_band(2).0, level_band(3).1),
        _ => (level_band(4).0, level_band(5).1),
    }
}

/// How hard a challenge is on the strength axis: its tier's span, scaled by
/// how hard it reads within it.
pub fn difficulty_of(challenge: &Challenge, words: WordCount) -> f64 {
    let (start, end) = tier_span(demand_of(challenge));
    start + clamp01(within_tier(challenge, words)) * (end - start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::challenge::ChallengeType;
    use crate::text::fallback_word_count;
    use serde_json::{json, Value};

    fn of(sample: Value) -> f64 {
        let mut row = sample;
        row["id"] = json!("c1");
        row["itemIds"] = json!(["i1"]);
        difficulty_of(&Challenge::from_value(row).unwrap(), &fallback_word_count)
    }

    fn within(value: f64, (start, end): (f64, f64)) -> bool {
        value >= start - 1e-9 && value <= end + 1e-9
    }

    const SHORT: &str = "hola";
    const LONG: &str = "perdona, ¿me podrías decir dónde está la estación de tren más cercana?";
    const FIVE_WORDS: &str = "quiero pedir la cuenta ahora";

    fn mc(prompt: &str) -> Value {
        json!({ "type": "multiple-choice", "direction": "toTarget", "prompt": prompt,
            "options": ["a", "b", "c", "d"], "correctIndex": 0 })
    }
    fn banked(sentence: &str, bank: usize) -> Value {
        json!({ "type": "cloze", "direction": "toTarget", "sentence": sentence, "acceptedAnswers": ["a"],
            "wordBank": (0..bank).map(|i| format!("w{i}")).collect::<Vec<_>>(), "translationHint": "x" })
    }
    fn multi(gaps: usize, words: usize) -> Value {
        let passage: Vec<String> = (0..words)
            .map(|i| {
                if i < gaps {
                    format!("___{}___", i + 1)
                } else {
                    format!("w{i}")
                }
            })
            .collect();
        json!({ "type": "multi-cloze", "direction": "toTarget", "passage": passage.join(" "),
            "gaps": (0..gaps).map(|i| json!({ "itemId": format!("i{i}"), "acceptedAnswers": [format!("a{i}")] })).collect::<Vec<_>>(),
            "wordBank": (0..6).map(|i| format!("a{i}")).collect::<Vec<_>>() })
    }
    fn word_order(tiles: usize, distractors: usize) -> Value {
        let answer: Vec<String> = (0..tiles).map(|i| format!("w{i}")).collect();
        let mut tray = answer.clone();
        tray.extend((0..distractors).map(|i| format!("d{i}")));
        json!({ "type": "word-order", "direction": "toTarget", "prompt": "x", "tiles": tray,
            "answerTokens": answer, "answer": "x" })
    }
    fn typed(direction: &str, prompt: &str) -> Value {
        json!({ "type": "typed-translation", "direction": direction, "prompt": prompt, "acceptedAnswers": ["a"] })
    }
    fn spot(tokens: usize) -> Value {
        json!({ "type": "spot-error", "direction": "toNative",
            "tokens": (0..tokens).map(|i| format!("w{i}")).collect::<Vec<_>>(),
            "correctIndex": 0, "intendedWord": "w0", "correctedSentence": "x", "meaning": "x" })
    }
    fn pairs(count: usize) -> Value {
        json!({ "type": "match-pairs", "direction": "toNative",
            "pairs": (0..count).map(|i| json!({ "a": format!("a{i}"), "b": format!("b{i}") })).collect::<Vec<_>>() })
    }

    #[test]
    fn demand_reads_the_row_where_a_type_straddles_a_tier() {
        let d = |sample: Value| {
            let mut row = sample;
            row["id"] = json!("c");
            row["itemIds"] = json!([]);
            demand_of(&Challenge::from_value(row).unwrap())
        };
        assert_eq!(d(mc("p")), 0);
        let mut native = mc("p");
        native["direction"] = json!("toNative");
        assert_eq!(d(native), 0);
        assert_eq!(d(spot(3)), 0);
        assert_eq!(d(pairs(2)), 0);
        assert_eq!(d(word_order(2, 0)), 1);
        assert_eq!(d(banked("Yo ___.", 2)), 1);
        assert_eq!(d(banked("Yo ___.", 0)), 2);
        let mut bankless = banked("Yo ___.", 2);
        bankless.as_object_mut().unwrap().remove("wordBank");
        assert_eq!(d(bankless), 2);
        assert_eq!(d(multi(2, 8)), 1);
        assert_eq!(d(typed("toTarget", "p")), 2);
        assert_eq!(d(typed("toNative", "p")), 0);
    }

    #[test]
    fn multiple_choice_grows_with_its_prompt_and_stays_recognition() {
        assert!(of(mc(SHORT)) < of(mc(LONG)));
        for prompt in [SHORT, LONG] {
            assert!(within(of(mc(prompt)), tier_span(0)));
        }
    }

    #[test]
    fn cloze_grows_with_its_sentence_not_its_bank_and_reads_the_blank_out() {
        assert!(
            of(banked("Yo ___ un libro.", 4))
                < of(banked(
                    "Yo, después de comer, siempre ___ un libro antes de dormir.",
                    4
                ))
        );
        assert!(
            (of(banked("I want the ___ please.", 4)) - of(banked("I want the please.", 4))).abs()
                < 1e-10
        );
        assert!((of(banked("ho___la que tal", 4)) - of(banked("ho la que tal", 4))).abs() < 1e-10);
        assert_eq!(
            of(banked("Yo ___ un libro.", 3)),
            of(banked("Yo ___ un libro.", 6))
        );
        for bank in 3..=6 {
            assert!(within(of(banked("Yo ___ un libro.", bank)), tier_span(1)));
        }
        assert!(within(of(banked("Yo ___ un libro.", 0)), tier_span(2)));
    }

    #[test]
    fn multi_cloze_grows_with_the_factorial_of_its_gaps_and_its_passage() {
        let (two, three, four) = (of(multi(2, 10)), of(multi(3, 10)), of(multi(4, 10)));
        assert!(two < three && three < four);
        assert!(three - two < four - three);
        let (short, long) = (of(multi(2, 8)), of(multi(2, 18)));
        assert!(short < long);
        assert!(within(short, tier_span(1)) && within(long, tier_span(1)));
    }

    #[test]
    fn word_order_grows_with_its_tiles_not_its_distractors() {
        assert!(of(word_order(3, 0)) < of(word_order(8, 0)));
        assert_eq!(of(word_order(5, 0)), of(word_order(5, 3)));
        for (tiles, distractors) in [(3, 0), (8, 3)] {
            assert!(within(of(word_order(tiles, distractors)), tier_span(1)));
        }
    }

    #[test]
    fn typed_translation_is_free_production_one_way_and_recognition_the_other() {
        let (short, long) = (of(typed("toTarget", SHORT)), of(typed("toTarget", LONG)));
        assert!(short < long);
        assert!(within(short, tier_span(2)) && within(long, tier_span(2)));
        assert!(within(of(typed("toNative", LONG)), tier_span(0)));
    }

    #[test]
    fn spot_error_and_match_pairs_grow_inside_recognition() {
        assert!(of(spot(3)) < of(spot(14)));
        assert!(within(of(spot(3)), tier_span(0)) && within(of(spot(14)), tier_span(0)));
        assert!(of(pairs(2)) < of(pairs(6)));
        assert!(within(of(pairs(6)), tier_span(0)));
    }

    #[test]
    fn the_recognition_tier_is_ordered_by_format_at_one_length() {
        let mc = of(mc(FIVE_WORDS));
        let typed = of(typed("toNative", FIVE_WORDS));
        let mut spot = spot(5);
        spot["tokens"] = json!(FIVE_WORDS.split(' ').collect::<Vec<_>>());
        let spot = of(spot);
        assert!(mc < typed && typed < spot);
        assert!(within(spot, tier_span(0)));
    }

    #[test]
    fn a_banked_cloze_and_a_tile_tray_are_level_at_one_length() {
        let cloze = of(
            json!({ "type": "cloze", "direction": "toTarget", "sentence": "quiero pedir la cuenta ___",
            "acceptedAnswers": ["ahora"], "wordBank": ["ahora", "luego", "nunca", "siempre"], "translationHint": "x" }),
        );
        let tiles: Vec<&str> = FIVE_WORDS.split(' ').collect();
        let mut tray = tiles.clone();
        tray.push("d0");
        let word_order = of(
            json!({ "type": "word-order", "direction": "toTarget", "prompt": "x",
            "tiles": tray, "answerTokens": tiles, "answer": FIVE_WORDS }),
        );
        assert!((cloze - word_order).abs() < 0.05);
    }

    #[test]
    fn every_type_answers_in_range() {
        let samples = [
            mc("hola"),
            banked("Yo ___ un libro.", 3),
            multi(2, 8),
            typed("toTarget", "hola"),
            pairs(1),
            word_order(2, 0),
            spot(3),
        ];
        let mut seen: Vec<ChallengeType> = Vec::new();
        for sample in samples {
            let mut row = sample;
            row["id"] = json!("c");
            row["itemIds"] = json!(["i"]);
            let challenge = Challenge::from_value(row).unwrap();
            seen.push(challenge.kind());
            let value = difficulty_of(&challenge, &fallback_word_count);
            assert!((0.0..=1.0).contains(&value), "{:?}", challenge.kind());
        }
        for kind in ChallengeType::ALL {
            assert!(seen.contains(&kind), "{kind:?}");
        }
    }

    #[test]
    fn markers_come_out_of_a_passage() {
        assert_eq!(
            without_markers("___1___ leo. ___12___ bebe.", " "),
            "  leo.   bebe."
        );
        assert_eq!(without_markers("____1___ x ___a___", "…"), "_… x ___a___");
    }
}
