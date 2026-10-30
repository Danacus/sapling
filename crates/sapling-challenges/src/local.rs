//! Local kinds: rows built on this device from the learner's own material,
//! with no model call. The top-up planner asks for them like any other kind;
//! [`write_local`] builds those wants and hands the rest — and, for a local
//! want nothing could be built for, a model-written kind instead — on to
//! `getBatch`.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::fits::{fits_fresh, Serving};
use crate::kinds::{Want, WireType};
use crate::pool::PoolRow;
use crate::rng::{shuffled, Rng};
use crate::text::{find_word, js_trim, label_key};
use crate::topup::instead_of_local;
use crate::types::cue_cloze::measured;
use crate::types::{CueClozeChallenge, CueClozeTag, CueRef, Direction};
use crate::word::{by_id, ById, Word};
use crate::Challenge;

/// A cloze's bank: the answer and enough distractors for its largest step.
pub const BANK_SIZE: usize = 6;

/// One timed cue of an imported text holding a word (`cuesFor`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueCandidate {
    pub item_id: String,
    pub text_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub video_id: Option<String>,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// What [`write_local`] built, and the wants left for the model.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct LocalWrite {
    pub challenges: Vec<Challenge>,
    pub wants: Vec<Want>,
}

pub fn write_local(
    wants: &[Want],
    cues: &[CueCandidate],
    pool: &[Option<PoolRow>],
    words: &[Word],
    serving: &Serving,
    rng: &mut Rng,
) -> LocalWrite {
    let index = by_id(words);
    let mut out = LocalWrite::default();
    for want in wants {
        let kind = want.kind.kind;
        if !kind.is_local() {
            out.wants.push(want.clone());
            continue;
        }
        let built = match kind {
            WireType::CueCloze => cue_cloze(want, cues, pool, words, &index, serving, rng),
            _ => unreachable!("{kind:?} is not a local kind"),
        };
        if let Some(challenge) = built {
            out.challenges.push(challenge);
            continue;
        }
        let Some(word) = index.get(want.item.id.as_str()) else {
            continue;
        };
        let taken: Vec<WireType> = wants
            .iter()
            .filter(|w| w.item.id == want.item.id)
            .map(|w| w.kind.kind)
            .collect();
        out.wants.extend(instead_of_local(
            pool,
            words,
            word,
            serving,
            &taken,
            &mut || rng.next_f64(),
        ));
    }
    out
}

/// The word's cues not yet in the pool, blanked where it occurs as a word;
/// among the rows that fit it, the one nearest the asked length.
fn cue_cloze(
    want: &Want,
    cues: &[CueCandidate],
    pool: &[Option<PoolRow>],
    words: &[Word],
    index: &ById,
    serving: &Serving,
    rng: &mut Rng,
) -> Option<Challenge> {
    let word = *index.get(want.item.id.as_str())?;
    let [shortest, longest] = WireType::CueCloze.lengths()?;
    let term = js_trim(&word.term).to_lowercase();
    let known: Vec<String> = words
        .iter()
        .map(|w| js_trim(&w.term).to_lowercase())
        .filter(|k| k.len() > term.len() && k.contains(&term))
        .collect();
    let longer: Vec<&str> = known.iter().map(String::as_str).collect();
    let used: HashSet<(&str, u64)> = pool
        .iter()
        .flatten()
        .filter_map(|row| match &row.challenge {
            Challenge::CueCloze(c) if c.item_ids.contains(&word.id) => {
                Some((c.cue.text_id.as_str(), c.cue.start.to_bits()))
            }
            _ => None,
        })
        .collect();

    let mut fitting: Vec<(f64, Challenge)> = Vec::new();
    for cue in cues.iter().filter(|c| c.item_id == word.id) {
        if used.contains(&(cue.text_id.as_str(), cue.start.to_bits())) {
            continue;
        }
        let Some((at, end)) = find_word(&cue.text, &term, &longer) else {
            continue;
        };
        let sentence = format!("{}___{}", &cue.text[..at], &cue.text[end..]);
        let length = measured(&sentence);
        if length < f64::from(shortest) || length > f64::from(longest) {
            continue;
        }
        let answer = cue.text[at..end].to_owned();
        let row = Challenge::CueCloze(CueClozeChallenge {
            kind: CueClozeTag::Tag,
            id: rng.uuid(),
            direction: Direction::ToTarget,
            sentence,
            word_bank: Some(bank(&answer, &cue.text, word, words, rng)),
            accepted_answers: vec![answer],
            meaning_hint: Some(js_trim(&word.meaning).to_owned()).filter(|m| !m.is_empty()),
            cue: CueRef {
                text_id: cue.text_id.clone(),
                video_id: cue.video_id.clone(),
                start: cue.start,
                end: cue.end,
            },
            explanation: None,
            length: Some(length),
            item_ids: vec![word.id.clone()],
        });
        if fits_fresh(&row, index, serving) {
            fitting.push(((length - f64::from(want.length)).abs(), row));
        }
    }
    let nearest = fitting
        .iter()
        .map(|(d, _)| *d)
        .fold(f64::INFINITY, f64::min);
    let mut best: Vec<Challenge> = fitting
        .into_iter()
        .filter(|(d, _)| *d <= nearest + 1e-9)
        .map(|(_, row)| row)
        .collect();
    if best.is_empty() {
        return None;
    }
    let at = ((rng.next_f64() * best.len() as f64) as usize).min(best.len() - 1);
    Some(best.swap_remove(at))
}

/// The answer and random other words of the learner's — none the answer
/// itself, none already in the cue — in a random order.
fn bank(answer: &str, cue: &str, word: &Word, words: &[Word], rng: &mut Rng) -> Vec<String> {
    let mut seen = vec![label_key(answer), label_key(&word.term)];
    let mut others: Vec<String> = Vec::new();
    for other in shuffled(words, &mut || rng.next_f64()) {
        let term = js_trim(&other.term);
        let key = label_key(term);
        if other.id == word.id
            || !other.is_writable()
            || seen.contains(&key)
            || find_word(cue, term, &[]).is_some()
        {
            continue;
        }
        seen.push(key);
        others.push(term.to_owned());
        if others.len() + 1 == BANK_SIZE {
            break;
        }
    }
    others.push(answer.to_owned());
    shuffled(&others, &mut || rng.next_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kinds::{ChallengeKind, WantItem};
    use crate::topup::tests::{word, DAY};

    fn learner() -> Vec<Word> {
        let mut words: Vec<Word> = ["perro", "gato", "casa", "pan", "agua", "mesa", "sol"]
            .iter()
            .enumerate()
            .map(|(i, term)| {
                let mut w = word(&format!("w{i}"), -DAY, 0.5);
                w.term = (*term).into();
                w.meaning = format!("meaning of {term}");
                w.skill = Some(4.0);
                w
            })
            .collect();
        words[0].meaning = "dog".into();
        words
    }

    fn cue(item: &str, text: &str, start: f64) -> CueCandidate {
        CueCandidate {
            item_id: item.into(),
            text_id: "t".into(),
            video_id: Some("v".into()),
            start,
            end: start + 2000.0,
            text: text.into(),
        }
    }

    fn want(id: &str, kind: WireType, length: u8) -> Want {
        Want {
            item: WantItem {
                id: id.into(),
                term: "perro".into(),
                meaning: "dog".into(),
            },
            kind: ChallengeKind { kind },
            length,
        }
    }

    fn write(wants: &[Want], cues: &[CueCandidate], pool: &[Option<PoolRow>]) -> LocalWrite {
        write_local(
            wants,
            cues,
            pool,
            &learner(),
            &Serving::default(),
            &mut Rng::seeded(3),
        )
    }

    #[test]
    fn a_cue_becomes_a_cloze_on_the_word_with_the_learners_words_as_distractors() {
        let cues = [cue("w0", "Mi Perro come mucho por la tarde.", 1000.0)];
        let out = write(&[want("w0", WireType::CueCloze, 6)], &cues, &[]);
        assert!(out.wants.is_empty());
        let [Challenge::CueCloze(row)] = out.challenges.as_slice() else {
            panic!("{out:?}")
        };
        assert_eq!(row.sentence, "Mi ___ come mucho por la tarde.");
        assert_eq!(row.accepted_answers, ["Perro"]);
        assert_eq!(row.meaning_hint.as_deref(), Some("dog"));
        assert_eq!((row.cue.start, row.cue.end), (1000.0, 3000.0));
        assert_eq!(row.cue.video_id.as_deref(), Some("v"));
        assert_eq!(row.length, Some(7.0));
        let bank = row.word_bank.as_ref().unwrap();
        assert_eq!(bank.len(), BANK_SIZE);
        assert!(bank.contains(&"Perro".to_owned()));
        assert!(!bank.contains(&"perro".to_owned()));
        Challenge::CueCloze(row.clone()).check_shape().unwrap();
    }

    #[test]
    fn the_nearest_fitting_length_wins_and_a_cue_already_pooled_is_skipped() {
        let cues = [
            cue("w0", "el perro duerme", 0.0),
            cue(
                "w0",
                "ayer el perro de mi vecino ladró toda la noche",
                5000.0,
            ),
            cue("w0", "los perros", 9000.0),
        ];
        let out = write(&[want("w0", WireType::CueCloze, 9)], &cues, &[]);
        let Challenge::CueCloze(row) = &out.challenges[0] else {
            unreachable!()
        };
        assert_eq!(row.cue.start, 5000.0);
        let pooled = PoolRow {
            challenge: out.challenges[0].clone(),
            generated_at: 0.0,
            times_served: 0.0,
            last_served_at: None,
            reported: false,
            topic: None,
            correction: None,
        };
        let again = write(&[want("w0", WireType::CueCloze, 9)], &cues, &[Some(pooled)]);
        let Challenge::CueCloze(row) = &again.challenges[0] else {
            unreachable!()
        };
        assert_eq!(row.cue.start, 0.0);
    }

    #[test]
    fn a_local_want_with_nothing_to_build_from_falls_back_to_a_model_kind() {
        let wants = [
            want("w0", WireType::CueCloze, 6),
            want("w0", WireType::Cloze, 6),
        ];
        // "perros" is not "perro" as a word.
        let out = write(&wants, &[cue("w0", "los perros", 0.0)], &[]);
        assert!(out.challenges.is_empty());
        assert_eq!(out.wants.len(), 2);
        assert_eq!(out.wants[1].kind.kind, WireType::Cloze);
        let instead = out.wants[0].kind.kind;
        assert!(
            !instead.is_local() && instead != WireType::Cloze,
            "{instead:?}"
        );
    }
}
