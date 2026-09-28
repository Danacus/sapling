//! The few string rules grading and the local builders share with the
//! resolvers (`sapling-llm` re-exports them), and word counting.
//!
//! A word count is the host's to give: Chinese and Japanese write no spaces,
//! so counting words is a dictionary lookup, and the browser has one
//! (`Intl.Segmenter`, behind `$lib/text`'s `segmentWords`). The wasm host lends
//! it as a callback; [`fallback_word_count`] is what `segmentWords` falls back
//! to without one, and what native callers get.

use unicode_normalization::UnicodeNormalization;

/// How many word-like segments a text holds.
pub type WordCount<'a> = &'a dyn Fn(&str) -> usize;

/// `"nǐ hǎo"` → `"ni hao"`: NFD with the combining diacritics dropped.
pub fn fold_diacritics(value: &str) -> String {
    value
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .nfc()
        .collect()
}

/// Trimmed, lowercased, whitespace collapsed: when two labels collide.
pub fn label_key(value: &str) -> String {
    value
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// JavaScript's `\s`, which is what the TypeScript side trims and splits on.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// Han, kana, Thai, Lao, Khmer and Myanmar write words without spaces between them.
fn is_no_space_script(c: char) -> bool {
    matches!(c as u32,
        0x0E00..=0x0EFF // Thai, Lao
        | 0x1000..=0x109F | 0xA9E0..=0xA9FF | 0xAA60..=0xAA7F // Myanmar
        | 0x1780..=0x17FF | 0x19E0..=0x19FF // Khmer
        | 0x2E80..=0x2FDF | 0x3005 | 0x3007 | 0x3021..=0x3029 | 0x3038..=0x303B // Han radicals and marks
        | 0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9D // kana
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF // Han
    )
}

pub fn uses_inter_word_spaces(text: &str) -> bool {
    !text.chars().any(is_no_space_script)
}

/// Letters, marks and digits: what a word is made of.
fn is_word_char(c: char) -> bool {
    use unicode_general_category::{get_general_category, GeneralCategory as G};
    matches!(
        get_general_category(c),
        G::UppercaseLetter
            | G::LowercaseLetter
            | G::TitlecaseLetter
            | G::ModifierLetter
            | G::OtherLetter
            | G::NonspacingMark
            | G::SpacingMark
            | G::EnclosingMark
            | G::DecimalNumber
            | G::LetterNumber
            | G::OtherNumber
    )
}

/// `segmentWords`' own fallback, counted: word runs where the script spaces its
/// words, one word per character where it does not.
pub fn fallback_word_count(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut words = 0;
    let mut i = 0;
    while i < chars.len() {
        if !is_word_char(chars[i]) {
            i += 1;
            continue;
        }
        words += 1;
        if !uses_inter_word_spaces(&chars[i].to_string()) {
            i += 1;
            continue;
        }
        i += 1;
        while i < chars.len() && is_word_char(chars[i]) && !is_no_space_script(chars[i]) {
            i += 1;
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_tone_marks_and_accents() {
        assert_eq!(fold_diacritics("nǐ hǎo"), "ni hao");
        assert_eq!(fold_diacritics("el agua está fría"), "el agua esta fria");
        assert_eq!(fold_diacritics("菜单"), "菜单");
    }

    #[test]
    fn the_fallback_counts_spaced_words_and_single_characters() {
        assert_eq!(fallback_word_count("Yo leo un libro."), 4);
        assert_eq!(fallback_word_count("  ¿Qué tal?  "), 2);
        assert_eq!(fallback_word_count("我们想买单"), 5);
        assert_eq!(fallback_word_count("买单 please"), 3);
        assert_eq!(fallback_word_count(""), 0);
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(js_trim("\u{3000} hola\u{feff}\n"), "hola");
        assert_eq!(label_key("  La   Cuenta "), "la cuenta");
    }
}
