//! The few string rules grading, the local builders and the difficulty model
//! share with the resolvers (`sapling-llm` re-exports them).
//!
//! Nothing here asks the host to count words: a length the difficulty model
//! learns from is derived data every device and the Worker must reproduce, so
//! it is `model.rs`' own `words_in` over these script tests, never a host's
//! segmenter.

use unicode_normalization::UnicodeNormalization;

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
pub fn is_word_char(c: char) -> bool {
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

/// Whether a legacy word-order tile consists only of punctuation.
pub fn is_punctuation_only(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|c| {
            use unicode_general_category::{get_general_category, GeneralCategory as G};
            matches!(
                get_general_category(c),
                G::ConnectorPunctuation
                    | G::DashPunctuation
                    | G::OpenPunctuation
                    | G::ClosePunctuation
                    | G::InitialPunctuation
                    | G::FinalPunctuation
                    | G::OtherPunctuation
            )
        })
}

/// Nothing but punctuation, symbols and whitespace: never a generated tile.
pub fn is_tile_punctuation_only(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| !c.is_alphanumeric())
}

fn clings_left(token: &str) -> bool {
    token
        .chars()
        .next()
        .is_some_and(|c| ")]}»,.;:!?…、。，；：！？」』）】".contains(c))
}

fn clings_right(text: &str) -> bool {
    text.chars()
        .next_back()
        .is_some_and(|c| "([{«¿¡「『（【".contains(c))
}

pub fn join_tokens<S: AsRef<str>>(tokens: &[S]) -> String {
    let parts: Vec<&str> = tokens
        .iter()
        .map(|token| token.as_ref().trim())
        .filter(|token| !token.is_empty())
        .collect();
    if !uses_inter_word_spaces(&parts.concat()) {
        return parts.concat();
    }
    let mut out = String::new();
    for part in parts {
        if !out.is_empty() && !clings_left(part) && !clings_right(&out) {
            out.push(' ');
        }
        out.push_str(part);
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub text: String,
    pub reading: Option<String>,
}

pub fn merge_punctuation(tokens: Vec<Token>) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    let mut lead = String::new();
    for mut token in tokens {
        if is_tile_punctuation_only(&token.text) {
            match out.last_mut() {
                Some(last) => last.text = join_tokens(&[last.text.as_str(), &token.text]),
                None => lead.push_str(token.text.trim()),
            }
            continue;
        }
        if !lead.is_empty() {
            token.text = std::mem::take(&mut lead) + &token.text;
        }
        out.push(token);
    }
    out
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
    fn trims_what_javascript_trims() {
        assert_eq!(js_trim("\u{3000} hola\u{feff}\n"), "hola");
        assert_eq!(label_key("  La   Cuenta "), "la cuenta");
    }
}
