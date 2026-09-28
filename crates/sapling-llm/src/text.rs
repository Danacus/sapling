//! The string rules a resolver needs, as `$lib/text` and `$lib/validate` spell
//! them on the TypeScript side, and the one random source.

use unicode_normalization::UnicodeNormalization;

/// Trimmed, lowercased, whitespace collapsed: when two labels collide.
pub fn label_key(value: &str) -> String {
    collapse(&value.to_lowercase())
}

/// A term as the known-word index keys it: [`label_key`] after NFC.
pub fn term_key(value: &str) -> String {
    collapse(&value.nfc().collect::<String>().to_lowercase())
}

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `"nǐ hǎo"` → `"ni hao"`: NFD with the combining diacritics dropped.
pub fn fold_diacritics(value: &str) -> String {
    value
        .nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .nfc()
        .collect()
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

/// SplitMix64: shuffles and challenge ids, seeded from the OS (or a test).
pub struct Rng(u64);

impl Rng {
    pub fn seeded(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn from_entropy() -> Self {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).expect("an entropy source");
        Rng(u64::from_le_bytes(bytes))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Fisher-Yates.
    pub fn shuffle<T>(&mut self, values: &mut [T]) {
        for i in (1..values.len()).rev() {
            let j = (self.next_u64() % (i as u64 + 1)) as usize;
            values.swap(i, j);
        }
    }

    /// A version-4 UUID, as `crypto.randomUUID()` writes one.
    pub fn uuid(&mut self) -> String {
        let hi = self.next_u64();
        let lo = self.next_u64();
        let hi = (hi & !0xF000) | 0x4000;
        let lo = (lo & !(0b11 << 62)) | (0b10 << 62);
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            hi >> 32,
            (hi >> 16) & 0xFFFF,
            hi & 0xFFFF,
            lo >> 48,
            lo & 0xFFFF_FFFF_FFFF
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_fold_case_and_space_and_terms_normalize() {
        assert_eq!(label_key("  La   Cuenta "), "la cuenta");
        assert_eq!(term_key("Cafe\u{0301}"), term_key("café"));
    }

    #[test]
    fn folds_tone_marks_and_accents() {
        assert_eq!(fold_diacritics("nǐ hǎo"), "ni hao");
        assert_eq!(fold_diacritics("el agua está fría"), "el agua esta fria");
        assert_eq!(fold_diacritics("菜单"), "菜单");
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

    #[test]
    fn a_seeded_rng_replays_and_mints_v4_uuids() {
        let (mut a, mut b) = (Rng::seeded(7), Rng::seeded(7));
        assert_eq!(a.next_u64(), b.next_u64());
        let id = a.uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
    }
}
