//! Telling a printed pinyin guide apart from the text it sits over, so a
//! transcribed Chinese textbook page keeps only the text.
//!
//! **Readings are the frontend's.** A textbook prints pinyin above its hanzi,
//! and a model reading the page sometimes copies both into one line, or makes a
//! line of the pinyin alone. Nothing here keeps what it finds: a stored text is
//! only the text, and every reading on screen is derived where it is shown
//! (`$lib/romanize`). This module only recognises pinyin so it can be removed.
//!
//! Recognition is deliberately narrow, so a name or an abbreviation in a
//! Chinese sentence survives: a run of Latin words is pinyin only when **every**
//! word splits into syllables of the table below, and the run either carries a
//! tone mark or has more than one word. "Peter", "A" and "DVD" stay; "Nǐ hǎo"
//! and "jiào shénme" go.
//!
//! `pinyin-syllables.txt` is every toneless syllable `pinyin-pro` gives the CJK
//! Unified Ideographs block, ü written `v`, plus the interjections it lacks.

use std::collections::HashSet;
use std::sync::OnceLock;

fn syllables() -> &'static HashSet<&'static str> {
    static TABLE: OnceLock<HashSet<&'static str>> = OnceLock::new();
    TABLE.get_or_init(|| {
        include_str!("pinyin-syllables.txt")
            .split_whitespace()
            .collect()
    })
}

/// A Han character or kana: what makes a line Chinese or Japanese text.
/// Punctuation does not count.
pub fn is_han_or_kana(c: char) -> bool {
    matches!(
        c as u32,
        0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF
    )
}

pub fn has_han_or_kana(text: &str) -> bool {
    text.chars().any(is_han_or_kana)
}

/// A tone-marked vowel folded to its plain letter, ü to `v`; `None` for any
/// other character, which is returned as it is.
fn fold(c: char) -> Option<char> {
    Some(match c {
        'ā' | 'á' | 'ǎ' | 'à' => 'a',
        'ē' | 'é' | 'ě' | 'è' | 'ê' => 'e',
        'ī' | 'í' | 'ǐ' | 'ì' => 'i',
        'ō' | 'ó' | 'ǒ' | 'ò' => 'o',
        'ū' | 'ú' | 'ǔ' | 'ù' => 'u',
        'ǖ' | 'ǘ' | 'ǚ' | 'ǜ' | 'ü' => 'v',
        _ => return None,
    })
}

fn has_tone_mark(word: &str) -> bool {
    word.chars()
        .flat_map(char::to_lowercase)
        .any(|c| fold(c).is_some() && c != 'ü')
}

/// Whether `word` is one or more pinyin syllables run together ("Hànyǔ",
/// "Xī'ān", "shénme").
fn is_pinyin_word(word: &str) -> bool {
    let plain: Vec<char> = word
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|c| !matches!(c, '\'' | '’'))
        .map(|c| fold(c).unwrap_or(c))
        .collect();
    if plain.is_empty() || !plain.iter().all(char::is_ascii_lowercase) {
        return false;
    }
    let table = syllables();
    // splits[i]: the first i letters split into syllables. The longest is six (zhuang).
    let mut splits = vec![false; plain.len() + 1];
    splits[0] = true;
    for end in 1..=plain.len() {
        splits[end] = (end.saturating_sub(6)..end).any(|start| {
            splits[start] && table.contains(plain[start..end].iter().collect::<String>().as_str())
        });
    }
    splits[plain.len()]
}

/// The words of a Latin run: letters, apostrophes inside them.
fn words(run: &str) -> Vec<&str> {
    run.split(|c: char| !(c.is_alphabetic() || c == '\'' || c == '’'))
        .filter(|w| w.chars().any(char::is_alphabetic))
        .collect()
}

/// Whether a run of Latin text is a pinyin guide: every word pinyin, and
/// either a tone mark or more than one word.
pub fn is_pinyin(run: &str) -> bool {
    let words = words(run);
    !words.is_empty()
        && words.iter().all(|w| is_pinyin_word(w))
        && (words.len() > 1 || words.iter().any(|w| has_tone_mark(w)))
}

/// Whether `c` belongs to the Chinese side of a line: Han, kana, or the
/// fullwidth and ideographic punctuation that goes with them.
fn is_cjk_side(c: char) -> bool {
    is_han_or_kana(c) || matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

/// `text` with every pinyin run between its Chinese characters removed:
/// "Nǐ hǎo! 你好！" and "你nǐ好hǎo" are both "你好！"/"你好". A run that is not
/// pinyin — a name, an abbreviation — is left where it is.
///
/// Two passes, because a neutral-tone syllable on its own ("ma", "de") is not
/// pinyin by [`is_pinyin`]'s rule — one toneless word could be anything — but
/// in a line that carried pinyin elsewhere it is: the second pass, only then,
/// takes any run whose words all split into syllables.
pub fn strip_pinyin(text: &str) -> String {
    let (first, found) = strip_runs(text, is_pinyin);
    if !found {
        return first;
    }
    strip_runs(text, |run| {
        let words = words(run);
        !words.is_empty() && words.iter().all(|w| is_pinyin_word(w))
    })
    .0
}

/// `text` without the Latin runs `drop` picks, and whether it picked any.
fn strip_runs(text: &str, drop: impl Fn(&str) -> bool) -> (String, bool) {
    let mut out = String::new();
    let mut run = String::new();
    let mut found = false;
    let mut flush = |run: &mut String, out: &mut String| {
        if !drop(run) {
            out.push_str(run);
        } else {
            found = true;
            // A space where the run was, which the caller's whitespace tidy
            // then drops between Chinese characters.
            if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                out.push(' ');
            }
        }
        run.clear();
    };
    for c in text.chars() {
        if is_cjk_side(c) {
            flush(&mut run, &mut out);
            out.push(c);
        } else {
            run.push(c);
        }
    }
    flush(&mut run, &mut out);
    (out, found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_holds_the_syllables_and_their_edges() {
        let table = syllables();
        assert_eq!(table.len(), 416);
        for syllable in ["a", "zhuang", "lv", "er", "ng", "shei"] {
            assert!(table.contains(syllable), "{syllable}");
        }
        assert!(!table.contains("pe"));
    }

    #[test]
    fn a_word_is_pinyin_when_it_splits_into_syllables() {
        for word in [
            "Nǐ",
            "hǎo",
            "shénme",
            "Hànyǔ",
            "Xī'ān",
            "Zhōngguó",
            "lǜ",
            "LǏ",
            "ma",
        ] {
            assert!(is_pinyin_word(word), "{word}");
        }
        for word in ["Peter", "DVD", "hello", "OK", "ni3", "Goedemorgen", ""] {
            assert!(!is_pinyin_word(word), "{word}");
        }
    }

    #[test]
    fn a_run_is_pinyin_only_with_a_tone_mark_or_more_than_one_word() {
        assert!(is_pinyin("Nǐ jiào shénme míngzi?"));
        assert!(is_pinyin("xuésheng"));
        assert!(is_pinyin("ni hao"));
        // One toneless syllable could be anything: a name, a speaker, a letter.
        assert!(!is_pinyin("A"));
        assert!(!is_pinyin("Ben"));
        assert!(!is_pinyin("Peter"));
        assert!(!is_pinyin("What's your name?"));
        assert!(!is_pinyin(" ? "));
    }

    #[test]
    fn pinyin_runs_leave_a_line_and_everything_else_stays() {
        assert_eq!(
            strip_pinyin("Nǐ jiào shénme míngzi? 你叫什么名字？"),
            "你叫什么名字？"
        );
        assert_eq!(
            strip_pinyin("你叫什么名字？Nǐ jiào shénme míngzi?"),
            "你叫什么名字？ "
        );
        assert_eq!(strip_pinyin("你 nǐ 叫 jiào 李月 Lǐ Yuè。"), "你 叫 李月 。");
        assert_eq!(strip_pinyin("我是 Peter 的朋友。"), "我是 Peter 的朋友。");
        assert_eq!(strip_pinyin("A：你好！"), "A：你好！");
        assert_eq!(strip_pinyin("我有一个DVD。"), "我有一个DVD。");
        // A toneless syllable goes only from a line that carried pinyin.
        assert_eq!(strip_pinyin("你 nǐ 是 shì 吗 ma？"), "你 是 吗 ？");
        assert_eq!(strip_pinyin("我叫 Ben。"), "我叫 Ben。");
    }

    #[test]
    fn han_and_kana_are_text_and_punctuation_is_not() {
        assert!(has_han_or_kana("Dit is 你"));
        assert!(has_han_or_kana("ひらがな"));
        assert!(!has_han_or_kana("。？！"));
        assert!(!has_han_or_kana("Nǐ hǎo"));
    }
}
