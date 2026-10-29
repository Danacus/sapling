//! Which cues of the learner's imported videos are best to hear a word in.
//!
//! `clipsFor` used to answer the shortest cue containing a word, which in
//! practice was a one-word fragment, the same one every time, and — in a
//! script written without spaces — often the word inside a longer one (行 in
//! 银行). This module is the ranking that replaced it: a pure function of the
//! candidate cues SQL prefiltered, the words asked for, the sentence the
//! challenge served and the learner's own vocabulary. It returns the *best
//! tier* — every candidate close enough to the best that choosing between them
//! is a matter of taste — and leaves that choice to the page, which picks at
//! random so the same word is heard in different places. The ranking itself is
//! deterministic, so the golden fixtures and every host agree on it.
//!
//! The order is lexicographic in two keys and then one score:
//!
//! 1. a cue that *is* the served sentence (normalised: lowercase, letters and
//!    digits only) — a lesson written from a cue plays that exact recording;
//! 2. how many distinct asked words the cue holds as whole words;
//! 3. `OVERLAP_WEIGHT × overlap + fitness`, where overlap is the cue's Jaccard
//!    similarity to the served sentence (word sets for spaced scripts,
//!    character bigrams for unspaced ones; 0 without a sentence) and fitness
//!    is how well its length in words and in seconds sits in a comfortable
//!    band, in (0, 1].
//!
//! The tier is the candidates tied with the best on 1 and 2 whose score is
//! within `TIER_MARGIN` of the best, best first, at most `TIER_CAP`.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use sapling_challenges::model::words_in;
use sapling_challenges::text::{is_word_char, uses_inter_word_spaces};

use crate::core::Clip;

/// At most this many cues come back; the page picks one of them.
pub const TIER_CAP: usize = 5;

/// How far below the best score a cue may sit and still be in the tier. A
/// little under a sixth of the fitness range: a cue a few words outside the
/// band stays in, a fragment does not.
pub const TIER_MARGIN: f64 = 0.15;

/// How much closeness to the served sentence counts against fitness. Over one,
/// so a cue that shares the sentence's words beats a merely well-sized one —
/// the "roughly lexicographic" of the design, without letting a hair of
/// overlap erase every difference in length.
const OVERLAP_WEIGHT: f64 = 2.0;

/// The comfortable length of a cue in words (`words_in`: a character of an
/// unspaced script counts half): enough to be a sentence, short enough to be
/// heard as one.
const WORD_BAND: (f64, f64) = (3.0, 14.0);

/// The comfortable span of a cue in seconds: long enough to survive the
/// player's padding and load, short enough to stay about the word.
const SECOND_BAND: (f64, f64) = (1.0, 8.0);

/// The best tier of `candidates` for `terms`, best first, at most
/// [`TIER_CAP`]; empty when no candidate holds a term as a word. `known` is
/// the learner's vocabulary, which decides what a whole word is in a script
/// without spaces. Ties keep the candidates' own order, so the answer is
/// deterministic.
pub fn best_tier(
    candidates: Vec<Clip>,
    terms: &[String],
    sentence: Option<&str>,
    known: &[String],
) -> Vec<Clip> {
    let terms = normalised_terms(terms);
    let known = normalised_terms(known);
    // For each term, the known terms that could cover one of its occurrences.
    let longer: Vec<Vec<&str>> = terms
        .iter()
        .map(|term| {
            known
                .iter()
                .filter(|k| k.len() > term.len() && k.contains(term.as_str()))
                .map(String::as_str)
                .collect()
        })
        .collect();
    let sentence = sentence.filter(|s| !normalised(s).is_empty());
    let target = sentence.map(normalised);

    let mut scored: Vec<(Scored, Clip)> = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(index, clip)| {
            let text = clip.text.to_lowercase();
            let matched = terms
                .iter()
                .zip(&longer)
                .filter(|(term, longer)| occurs(&text, term, longer))
                .count();
            if matched == 0 {
                return None;
            }
            let exact = target.as_deref() == Some(normalised(&clip.text).as_str());
            let overlap = sentence.map_or(0.0, |s| overlap(&clip.text, s));
            let score = OVERLAP_WEIGHT * overlap + fitness(&clip);
            Some((
                Scored {
                    exact,
                    matched,
                    score,
                    index,
                },
                clip,
            ))
        })
        .collect();
    scored.sort_by(|(a, _), (b, _)| a.rank(b));

    let Some(best) = scored.first().map(|(s, _)| (s.exact, s.matched, s.score)) else {
        return Vec::new();
    };
    scored
        .into_iter()
        .take_while(|(s, _)| {
            s.exact == best.0 && s.matched == best.1 && s.score >= best.2 - TIER_MARGIN
        })
        .take(TIER_CAP)
        .map(|(_, clip)| clip)
        .collect()
}

struct Scored {
    exact: bool,
    matched: usize,
    score: f64,
    index: usize,
}

impl Scored {
    /// Best first.
    fn rank(&self, other: &Self) -> Ordering {
        other
            .exact
            .cmp(&self.exact)
            .then(other.matched.cmp(&self.matched))
            .then(other.score.total_cmp(&self.score))
            .then(self.index.cmp(&other.index))
    }
}

/// Trimmed, lowercased, empty ones and repeats dropped.
fn normalised_terms(terms: &[String]) -> Vec<String> {
    let set: BTreeSet<String> = terms
        .iter()
        .map(|term| term.trim().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    set.into_iter().collect()
}

/// Lowercase letters and digits only: what "the same sentence" compares.
fn normalised(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| is_word_char(*c))
        .collect()
}

/// Whether `term` occurs in `text` (both lowercase) as a word. In a spaced
/// script no letter may directly join it on either side, so "car" is not in
/// "cart". A term written without spaces has no such boundary to check, so an
/// occurrence counts unless a longer word the learner knows covers it: 行 is
/// not heard in 银行 when 银行 is one of their words.
pub fn occurs(text: &str, term: &str, longer: &[&str]) -> bool {
    let joins = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() && !unspaced(c));
    let first = term.chars().next();
    let last = term.chars().next_back();
    let covers: Vec<(usize, usize)> = if term.chars().any(unspaced) {
        longer
            .iter()
            .flat_map(|k| text.match_indices(k).map(|(at, k)| (at, at + k.len())))
            .collect()
    } else {
        Vec::new()
    };
    text.match_indices(term).any(|(at, _)| {
        let end = at + term.len();
        let before = text[..at].chars().next_back();
        let after = text[end..].chars().next();
        !(joins(before) && joins(first))
            && !(joins(after) && joins(last))
            && !covers.iter().any(|&(s, e)| s <= at && end <= e)
    })
}

/// Han, kana, Hangul, and the Southeast Asian scripts written without spaces
/// between words (Hangul's particles attach to the word, so it counts too).
fn unspaced(c: char) -> bool {
    matches!(c as u32,
        0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1100..=0x11FF | 0x1780..=0x17FF
        | 0x3040..=0x30FF | 0x3130..=0x318F | 0x31F0..=0x31FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x2FFFF)
}

/// Jaccard similarity of a cue and the served sentence, in [0, 1]: over word
/// sets when both are written with spaces, over character bigrams otherwise
/// (a script without spaces has no words to split on).
fn overlap(cue: &str, sentence: &str) -> f64 {
    let (a, b) = if uses_inter_word_spaces(cue) && uses_inter_word_spaces(sentence) {
        (words(cue), words(sentence))
    } else {
        (bigrams(cue), bigrams(sentence))
    };
    let union = a.union(&b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(&b).count() as f64 / union as f64
}

fn words(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !is_word_char(c))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Adjacent pairs of letters, punctuation and spaces dropped; a one-letter
/// text is its letter.
fn bigrams(text: &str) -> BTreeSet<String> {
    let chars: Vec<char> = normalised(text).chars().collect();
    if chars.len() == 1 {
        return chars.iter().map(|c| c.to_string()).collect();
    }
    chars.windows(2).map(|w| w.iter().collect()).collect()
}

/// How well a cue's length sits in the comfortable bands, in (0, 1]: one
/// inside both, falling off in proportion outside either, so a one-word
/// fragment scores a third and a run-on of twice the band a half.
fn fitness(clip: &Clip) -> f64 {
    let seconds = ((clip.end - clip.start) / 1000.0).max(0.0);
    band(words_in(&clip.text), WORD_BAND) * band(seconds, SECOND_BAND)
}

fn band(x: f64, (low, high): (f64, f64)) -> f64 {
    if x < low {
        x / low
    } else if x > high {
        high / x
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(text: &str, start: f64, end: f64) -> Clip {
        Clip {
            text_id: "t".into(),
            title: "T".into(),
            video_id: "v".into(),
            start,
            end,
            text: text.into(),
        }
    }

    fn texts(found: &[Clip]) -> Vec<&str> {
        found.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn closeness_to_the_sentence_outranks_size() {
        let found = best_tier(
            vec![
                cue("my dog likes the park in spring", 0.0, 3000.0),
                cue("the dog sleeps on the old sofa", 0.0, 3000.0),
            ],
            &["dog".into()],
            Some("The dog sleeps on the sofa."),
            &[],
        );
        assert_eq!(texts(&found), vec!["the dog sleeps on the old sofa"]);
    }

    #[test]
    fn unspaced_overlap_reads_bigrams() {
        let found = best_tier(
            vec![
                cue("今天天气很好我们出去走走", 0.0, 3000.0),
                cue("我们明天去公园散步好不好", 0.0, 3000.0),
            ],
            &["我们".into()],
            Some("我们明天去公园吧"),
            &[],
        );
        assert_eq!(texts(&found), vec!["我们明天去公园散步好不好"]);
    }

    #[test]
    fn a_term_counts_once_however_often_it_is_asked() {
        let found = best_tier(
            vec![cue("the car and the car park", 0.0, 2000.0)],
            &["Car".into(), " car ".into()],
            None,
            &[],
        );
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn bands_fall_off_in_proportion() {
        assert_eq!(band(1.0, WORD_BAND), 1.0 / 3.0);
        assert_eq!(band(7.0, WORD_BAND), 1.0);
        assert_eq!(band(28.0, WORD_BAND), 0.5);
    }
}
