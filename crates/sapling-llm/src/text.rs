//! The string rules a resolver needs, as `$lib/text` spells them on the
//! TypeScript side. Diacritic folding, label keys, the script test and the
//! random source are `sapling-challenges`', shared with grading.

use unicode_normalization::UnicodeNormalization;

pub use sapling_challenges::rng::Rng;
pub use sapling_challenges::text::{fold_diacritics, label_key, uses_inter_word_spaces};

/// A term as the known-word index keys it: [`label_key`] after NFC.
pub fn term_key(value: &str) -> String {
    collapse(&value.nfc().collect::<String>().to_lowercase())
}

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `{name}` placeholders in a prompt, filled.
pub fn template(text: &str, vars: &[(&str, &str)]) -> String {
    let mut out = text.trim_end().to_owned();
    for (name, with) in vars {
        out = out.replace(&format!("{{{name}}}"), with);
    }
    out
}

/// A reading as a card key: NFC, lowercased, every space dropped. Tone marks stay.
pub fn reading_key(value: &str) -> String {
    value
        .nfc()
        .flat_map(char::to_lowercase)
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// Two cards that may not both exist: one spelling, and readings that do not
/// tell them apart. A missing reading tells nothing apart.
pub fn same_card(a: (&str, Option<&str>), b: (&str, Option<&str>)) -> bool {
    if term_key(a.0) != term_key(b.0) {
        return false;
    }
    match (a.1, b.1) {
        (Some(x), Some(y)) => reading_key(x) == reading_key(y),
        _ => true,
    }
}

/// How forgiving to be about a typed romanization: case, tone marks,
/// apostrophes, hyphens and all spacing ignored.
pub fn same_romanization(a: &str, b: &str) -> bool {
    let loose = |text: &str| -> String {
        fold_diacritics(&text.to_lowercase())
            .chars()
            .filter(|c| !c.is_whitespace() && !"'’ʼ-".contains(*c))
            .collect()
    };
    loose(a) == loose(b)
}

/// Nothing but punctuation, symbols and whitespace: never a word.
pub fn is_punctuation_only(text: &str) -> bool {
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

/// Tokens back into a sentence: no spaces in a no-space script, and punctuation
/// hugs its neighbour in a spaced one.
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

/// One segmented word and the reading that travels with it.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub text: String,
    pub reading: Option<String>,
}

/// Punctuation-only tokens merged into the word they belong to: trailing into
/// the one before, leading into the one after.
pub fn merge_punctuation(tokens: Vec<Token>) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    let mut lead = String::new();
    for mut token in tokens {
        if is_punctuation_only(&token.text) {
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
    fn terms_normalize() {
        assert_eq!(term_key("Cafe\u{0301}"), term_key("café"));
    }

    #[test]
    fn two_readings_are_two_cards_and_a_bare_spelling_is_every_card() {
        assert!(same_card(
            ("长", Some("cháng")),
            (" 长", Some("cha\u{0301}ng"))
        ));
        assert!(!same_card(("长", Some("cháng")), ("长", Some("zhǎng"))));
        assert!(same_card(("长", None), ("长", Some("zhǎng"))));
        assert!(same_card(("Hola", None), ("hola", None)));
        assert!(!same_card(("hola", None), ("adiós", None)));
        assert_eq!(reading_key(" Zì xíng chē "), "zìxíngchē");
    }

    #[test]
    fn a_romanization_is_the_same_whatever_its_spacing_case_and_tones() {
        assert!(same_romanization("ni hao ma", "Nǐ hǎo ma"));
        assert!(same_romanization("kafei", "kā fēi"));
        assert!(same_romanization("xi'an", "Xī’ān"));
        assert!(!same_romanization("ni hao", "ni men hao"));
    }

    #[test]
    fn joins_by_script_and_lets_punctuation_cling() {
        assert_eq!(join_tokens(&["我们", "想", "买单"]), "我们想买单");
        assert_eq!(join_tokens(&["¿", "Nos", "trae", "?"]), "¿Nos trae?");
        assert_eq!(join_tokens(&["por", "favor", "?"]), "por favor?");
        assert!(uses_inter_word_spaces("，"));
    }

    #[test]
    fn merges_punctuation_tiles_into_their_words() {
        let token = |text: &str| Token {
            text: text.into(),
            reading: Some("r".into()),
        };
        let merged = merge_punctuation(vec![token("¿"), token("Nos"), token("trae"), token("?")]);
        let texts: Vec<&str> = merged.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["¿Nos", "trae?"]);
        assert!(merge_punctuation(vec![token("？")]).is_empty());
    }
}
