//! Top-up planning: what the pool is missing, so generation writes exactly
//! that. The walk is the learner's whole vocabulary in urgency order — due
//! words most overdue first, then the rest soonest-due first — and a word is
//! **covered** when a rested row about it fits (`fits.rs`): the same check
//! serving picks by, so what counts as coverage is exactly what a session
//! would serve. An uncovered word wants [`WANT_PER_WORD`] rows written, each
//! `{word, kind, length}`; the list is capped from the least urgent end, so
//! the next press starts where this one stopped.
//!
//! **What to write** (`docs/challenge-difficulty.md` §6): the kinds that can
//! reach the word's target — the difficulty that would put it at the aim —
//! at some help level and some length in the kind's range. Among those, a
//! kind the word has never had wins, then one it has fewest fitting rows of,
//! and a draw breaks the tie. The **length** is worked backwards from the
//! difficulty formula at the midpoint of the kind's help levels and clamped to
//! its range: written in the middle, the row still fits if the word weakens
//! (an easier help level) or strengthens (a harder one), so one row covers a
//! wider range of skill.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use crate::fits::WRITE_MEMORY;
use crate::fits::{best_fit, inside, Serving};
use crate::help::HelpLevel;
use crate::kinds::{active_kinds, kind_of, ChallengeKind, Want, WantItem, WireType};
use crate::model::{logit, target};
use crate::pool::{is_playable, is_rested, known_ids, PoolRow, UPCOMING};
use crate::text::js_trim;
use crate::word::{by_id, Word};

/// Fresh challenges an uncovered word gets written.
pub const WANT_PER_WORD: usize = 2;

/// The most wants one top-up writes.
pub const MAX_TOPUP_WANTS: usize = 24;

/// How well the pool covers the words a session is about to serve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TopUpCoverage {
    /// The words the figure is about: every due word, or when none is due the
    /// next `UPCOMING` soonest-due ones.
    pub upcoming: usize,
    /// Of those, the words with a rested row that fits them.
    pub covered: usize,
    /// What a top-up would write now, after the cap, over the whole walk.
    pub wants: usize,
    /// Whether `upcoming` is the due words.
    pub due: bool,
}

#[derive(Default)]
struct Coverage {
    /// Rested rows that fit the word, by kind.
    fitting: HashMap<WireType, usize>,
    /// Kinds the word has ever had a playable row of.
    ever: HashSet<WireType>,
}

/// What every word has, counting only rows serving would consider.
fn coverage_of(
    pool: &[&PoolRow],
    words: &[Word],
    now: f64,
    serving: &Serving,
) -> HashMap<String, Coverage> {
    let known = known_ids(words);
    let index = by_id(words);
    let mut coverage: HashMap<String, Coverage> = HashMap::new();
    for row in pool {
        if !is_playable(row, &known) {
            continue;
        }
        let Some(kind) = kind_of(&row.challenge).filter(|k| k.is_active()) else {
            continue;
        };
        let fits = is_rested(row, now) && best_fit(row, &index, serving).is_some();
        for id in row.challenge.item_ids() {
            let entry = coverage.entry(id.clone()).or_default();
            entry.ever.insert(kind);
            if fits {
                *entry.fitting.entry(kind).or_default() += 1;
            }
        }
    }
    coverage
}

/// Soonest due first, id breaking the tie so the walk ignores store order.
pub(crate) fn by_urgency<'a>(words: impl IntoIterator<Item = &'a Word>, now: f64) -> Vec<&'a Word> {
    let mut sorted: Vec<&Word> = words.into_iter().collect();
    sorted.sort_by(|a, b| {
        a.due_at(now)
            .partial_cmp(&b.due_at(now))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted
}

/// The length to write a row of `kind` at for this word, or `None` when no
/// help level and no length in the kind's range can put the word inside the
/// window.
pub fn length_for(word: &Word, kind: WireType, serving: &Serving) -> Option<u8> {
    let [shortest, longest] = kind.lengths()?;
    let parts = &serving.parts;
    let skill = word.skill();
    let slope = parts.slope(kind);
    let bases: Vec<f64> = kind
        .written_steps()
        .iter()
        .map(|step| parts.base(kind, HelpLevel::step(*step)))
        .collect();
    let reaches = bases.iter().any(|base| {
        [f64::from(shortest), f64::from(longest)]
            .into_iter()
            .chain(std::iter::once(
                ((skill - logit(target(serving.aim) / WRITE_MEMORY) - base) / slope)
                    .clamp(f64::from(shortest), f64::from(longest)),
            ))
            .filter(|l| l.is_finite())
            .any(|length| {
                let manage = crate::model::sigmoid(skill - base - slope * length);
                inside(WRITE_MEMORY, manage, serving.aim)
            })
    });
    if !reaches {
        return None;
    }
    let goal = skill - logit((target(serving.aim) / WRITE_MEMORY).min(0.99));
    let middle = (bases[0] + bases[bases.len() - 1]) / 2.0;
    let length = if slope.abs() < 1e-6 {
        (f64::from(shortest) + f64::from(longest)) / 2.0
    } else {
        (goal - middle) / slope
    };
    Some(
        length
            .round()
            .clamp(f64::from(shortest), f64::from(longest)) as u8,
    )
}

struct Walk<'a> {
    owed: Vec<&'a Word>,
    ahead: Vec<&'a Word>,
    wants: Vec<Want>,
}

/// The uncapped plan: [`plan_top_up`] cuts it and [`top_up_coverage`] counts
/// it, so the two can never disagree about a word.
fn walk<'a>(
    pool: &[&PoolRow],
    words: &'a [Word],
    now: f64,
    serving: &Serving,
    draw: &mut dyn FnMut() -> f64,
) -> Walk<'a> {
    let sorted = by_urgency(words.iter().filter(|w| w.is_writable()), now);
    let (owed, ahead): (Vec<&Word>, Vec<&Word>) = sorted.into_iter().partition(|w| w.is_due(now));
    let coverage = coverage_of(pool, words, now, serving);
    let none = Coverage::default();
    let mut wants = Vec::new();

    for word in owed.iter().chain(&ahead) {
        let have = coverage.get(&word.id).unwrap_or(&none);
        if have.fitting.values().sum::<usize>() > 0 {
            continue;
        }
        let mut candidates: Vec<(WireType, u8)> = active_kinds()
            .filter_map(|kind| length_for(word, kind, serving).map(|length| (kind, length)))
            .collect();
        let item = WantItem {
            id: word.id.clone(),
            term: js_trim(&word.term).to_owned(),
            meaning: js_trim(&word.meaning).to_owned(),
        };
        for _ in 0..WANT_PER_WORD {
            if candidates.is_empty() {
                break;
            }
            let never: Vec<usize> = (0..candidates.len())
                .filter(|&i| !have.ever.contains(&candidates[i].0))
                .collect();
            let from: Vec<usize> = if never.is_empty() {
                let fewest = candidates
                    .iter()
                    .map(|(k, _)| have.fitting.get(k).copied().unwrap_or(0))
                    .min()
                    .unwrap_or(0);
                (0..candidates.len())
                    .filter(|&i| have.fitting.get(&candidates[i].0).copied().unwrap_or(0) == fewest)
                    .collect()
            } else {
                never
            };
            let at = ((draw() * from.len() as f64).floor() as usize).min(from.len() - 1);
            let (kind, length) = candidates.remove(from[at]);
            wants.push(Want {
                item: item.clone(),
                kind: ChallengeKind { kind },
                length,
            });
        }
    }
    Walk { owed, ahead, wants }
}

/// The wants the pool is missing, most urgent word first, capped at [`MAX_TOPUP_WANTS`].
pub fn plan_top_up(
    pool: &[&PoolRow],
    words: &[Word],
    now: f64,
    serving: &Serving,
    draw: &mut dyn FnMut() -> f64,
) -> Vec<Want> {
    let mut wants = walk(pool, words, now, serving, draw).wants;
    wants.truncate(MAX_TOPUP_WANTS);
    wants
}

/// Counts, not wants — the same walk, and the same numbers whatever the draws.
pub fn top_up_coverage(
    pool: &[&PoolRow],
    words: &[Word],
    now: f64,
    serving: &Serving,
) -> TopUpCoverage {
    let Walk { owed, ahead, wants } = walk(pool, words, now, serving, &mut || 0.0);
    let short: HashSet<&str> = wants.iter().map(|w| w.item.id.as_str()).collect();
    let due = !owed.is_empty();
    let upcoming: &[&Word] = if due {
        &owed
    } else {
        &ahead[..ahead.len().min(UPCOMING)]
    };
    TopUpCoverage {
        upcoming: upcoming.len(),
        covered: upcoming
            .iter()
            .filter(|w| !short.contains(w.id.as_str()))
            .count(),
        wants: wants.len().min(MAX_TOPUP_WANTS),
        due,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::challenge::Challenge;
    use crate::model::Aim;
    use crate::pool::RESERVE_GAP;
    use sapling_srs::ItemSrs;
    use serde_json::json;

    pub const NOW: f64 = 1_700_000_000_000.0;
    pub const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

    /// A word due `offset` from now at `strength`; remembered for certain once
    /// it has any strength, at the new-word memory before.
    pub fn word(id: &str, offset: f64, strength: f64) -> Word {
        Word {
            id: id.into(),
            term: format!("term-{id}"),
            meaning: format!("meaning-{id}"),
            romanization: None,
            srs: Some(ItemSrs {
                due: NOW + offset,
                retrievability: if strength > 0.0 { 1.0 } else { 0.0 },
                strength,
            }),
            skill: None,
        }
    }

    fn fresh(id: &str) -> Word {
        word(id, -DAY, 0.0)
    }
    fn skilled(id: &str, skill: f64) -> Word {
        let mut w = word(id, -DAY, 0.5);
        w.skill = Some(skill);
        w
    }

    /// A pooled row of `kind` about `item_ids`, never served unless `served`.
    pub fn pooled(id: &str, kind: WireType, item_ids: &[&str], served: Option<f64>) -> PoolRow {
        let body = match kind {
            WireType::RecognizeMc | WireType::ProduceMc | WireType::ContextMc => json!({
                "type": "multiple-choice", "prompt": "p", "options": ["a", "b", "c", "d"], "correctIndex": 0 }),
            WireType::TranslateToNative | WireType::TranslateToTarget => json!({
                "type": "typed-translation", "prompt": "p", "acceptedAnswers": ["a"] }),
            WireType::Cloze => {
                json!({ "type": "cloze", "sentence": "a ___ b", "acceptedAnswers": ["x"],
                "wordBank": ["x", "y", "z"] })
            }
            WireType::MultiCloze => {
                json!({ "type": "multi-cloze", "passage": "___1___ lee. ___2___ bebe.",
                "gaps": [{ "itemId": item_ids.first().copied().unwrap_or("i1"), "acceptedAnswers": ["Yo"] },
                         { "itemId": item_ids.get(1).copied().unwrap_or("i2"), "acceptedAnswers": ["Ella"] }],
                "wordBank": ["Yo", "Ella", "Tú", "nosotros", "ellos"] })
            }
            WireType::WordOrder => {
                json!({ "type": "word-order", "prompt": "p", "tiles": ["a", "b"],
                "answerTokens": ["a", "b"], "answer": "a b" })
            }
            WireType::SpotError => {
                json!({ "type": "spot-error", "tokens": ["a", "b"], "correctIndex": 0,
                "intendedWord": "c", "correctedSentence": "c b", "meaning": "m" })
            }
        };
        let mut row = body;
        let stored = kind.stored();
        row["id"] = json!(id);
        row["itemIds"] = json!(item_ids);
        row["direction"] = serde_json::to_value(stored.direction).unwrap();
        if stored.prompt_is_target {
            row["promptIsTarget"] = json!(true);
        }
        PoolRow {
            challenge: Challenge::from_value(row).unwrap(),
            generated_at: NOW - DAY,
            times_served: f64::from(u8::from(served.is_some())),
            last_served_at: served,
            reported: false,
            topic: None,
            correction: None,
        }
    }

    pub fn cycling() -> impl FnMut() -> f64 {
        let values = [0.13, 0.71, 0.42, 0.97, 0.05, 0.6];
        let mut n = 0;
        move || {
            let value = values[n % values.len()];
            n += 1;
            value
        }
    }

    fn plan(
        pool: &[PoolRow],
        words: &[Word],
        now: f64,
        draw: &mut dyn FnMut() -> f64,
    ) -> Vec<Want> {
        let rows: Vec<&PoolRow> = pool.iter().collect();
        plan_top_up(&rows, words, now, &Serving::default(), draw)
    }
    fn plan_cycling(pool: &[PoolRow], words: &[Word]) -> Vec<Want> {
        plan(pool, words, NOW, &mut cycling())
    }
    fn coverage(pool: &[PoolRow], words: &[Word]) -> TopUpCoverage {
        let rows: Vec<&PoolRow> = pool.iter().collect();
        top_up_coverage(&rows, words, NOW, &Serving::default())
    }

    fn kinds(wants: &[Want]) -> Vec<WireType> {
        wants.iter().map(|w| w.kind.kind).collect()
    }
    fn words_of(wants: &[Want]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for want in wants {
            if !out.contains(&want.item.id) {
                out.push(want.item.id.clone());
            }
        }
        out
    }
    fn overdue(count: usize) -> Vec<Word> {
        (0..count)
            .map(|i| word(&format!("w{i}"), (i as f64 - count as f64) * DAY, 0.0))
            .collect()
    }
    fn cover(id: &str) -> Vec<PoolRow> {
        vec![pooled(
            &format!("{id}-r"),
            WireType::RecognizeMc,
            &[id],
            None,
        )]
    }
    const RECOGNITION: [WireType; 2] = [WireType::RecognizeMc, WireType::ProduceMc];

    #[test]
    fn a_new_word_wants_two_kinds_it_can_manage_at_their_lengths() {
        let wants = plan_cycling(&[], &[fresh("a")]);
        assert_eq!(wants.len(), WANT_PER_WORD);
        for want in &wants {
            assert_eq!(
                want.item,
                WantItem {
                    id: "a".into(),
                    term: "term-a".into(),
                    meaning: "meaning-a".into()
                }
            );
            assert_eq!(
                length_for(&fresh("a"), want.kind.kind, &Serving::default()),
                Some(want.length),
                "{:?}",
                want.kind
            );
        }
        assert_ne!(wants[0].kind, wants[1].kind);
    }

    #[test]
    fn a_strong_word_has_outgrown_recognition_and_wants_production() {
        let wants = plan_cycling(&[], &[skilled("a", 5.0)]);
        assert_eq!(wants.len(), WANT_PER_WORD);
        for want in &wants {
            assert!(!RECOGNITION.contains(&want.kind.kind), "{:?}", want.kind);
            let [shortest, longest] = want.kind.kind.lengths().unwrap();
            assert!((shortest..=longest).contains(&want.length));
        }
    }

    #[test]
    fn the_length_grows_with_skill_and_with_a_harder_aim() {
        let normal = Serving::default();
        let at = |skill: f64, serving: &Serving| {
            length_for(&skilled("a", skill), WireType::Cloze, serving).unwrap()
        };
        assert!(at(4.6, &normal) < at(5.2, &normal));
        let harder = Serving {
            aim: Aim::Harder,
            ..Serving::default()
        };
        assert!(at(4.6, &normal) < at(4.6, &harder));
        // Out of reach either way, the kind is not asked for at all.
        assert_eq!(length_for(&fresh("a"), WireType::Cloze, &normal), None);
        assert_eq!(
            length_for(&skilled("a", 20.0), WireType::RecognizeMc, &normal),
            None
        );
        assert_eq!(
            length_for(&fresh("a"), WireType::TranslateToTarget, &normal),
            None
        );
    }

    #[test]
    fn a_word_with_a_fitting_rested_row_wants_nothing() {
        assert!(plan_cycling(&cover("a"), &[fresh("a")]).is_empty());
    }

    #[test]
    fn a_row_that_does_not_fit_is_not_coverage() {
        let pool = [pooled("p", WireType::Cloze, &["a"], None)];
        assert_eq!(plan_cycling(&pool, &[fresh("a")]).len(), WANT_PER_WORD);
        let owned = plan_cycling(&cover("a"), &[skilled("a", 6.0)]);
        assert_eq!(owned.len(), WANT_PER_WORD);
    }

    #[test]
    fn a_resting_row_is_not_coverage_but_is_remembered() {
        let resting = [pooled("r", WireType::RecognizeMc, &["a"], Some(NOW - DAY))];
        for seed in [0.0, 0.5, 0.999] {
            let wants = plan(&resting, &[fresh("a")], NOW, &mut || seed);
            assert_eq!(wants.len(), WANT_PER_WORD);
            // A kind never had goes first, whatever the draw.
            assert!(kinds(&wants).iter().all(|&k| k != WireType::RecognizeMc));
        }
        let rested = [pooled(
            "r",
            WireType::RecognizeMc,
            &["a"],
            Some(NOW - RESERVE_GAP),
        )];
        assert!(plan_cycling(&rested, &[fresh("a")]).is_empty());
    }

    #[test]
    fn reported_and_orphaned_rows_cover_nothing() {
        let mut flagged = pooled("flagged", WireType::RecognizeMc, &["a"], None);
        flagged.reported = true;
        let pool = [
            flagged,
            pooled("orphan", WireType::ProduceMc, &["a", "gone"], None),
        ];
        assert_eq!(plan_cycling(&pool, &[fresh("a")]).len(), WANT_PER_WORD);
    }

    #[test]
    fn the_walk_is_most_overdue_first_and_capped_from_the_least_urgent_end() {
        let wants = plan_cycling(&[], &overdue(20));
        assert_eq!(wants.len(), MAX_TOPUP_WANTS);
        assert_eq!(wants[0].item.id, "w0");
        assert_eq!(wants[1].item.id, "w0");
        assert_eq!(wants[2].item.id, "w1");
        assert_eq!(words_of(&wants).len(), MAX_TOPUP_WANTS / WANT_PER_WORD);
        assert!(!words_of(&wants).contains(&"w19".to_owned()));

        let words = [
            word("ahead", 5.0 * DAY, 0.0),
            word("owed", -DAY, 0.0),
            word("later", 9.0 * DAY, 0.0),
        ];
        assert_eq!(
            words_of(&plan_cycling(&[], &words)),
            ["owed", "ahead", "later"]
        );
    }

    #[test]
    fn a_second_press_reaches_the_words_below_the_first() {
        let words = overdue(20);
        let first = words_of(&plan_cycling(&[], &words));
        assert_eq!(first, (0..12).map(|i| format!("w{i}")).collect::<Vec<_>>());
        let pool: Vec<PoolRow> = first.iter().flat_map(|id| cover(id)).collect();
        let second = plan_cycling(&pool, &words);
        assert_eq!(
            words_of(&second),
            (12..20).map(|i| format!("w{i}")).collect::<Vec<_>>()
        );
        assert_eq!(second.len(), 8 * WANT_PER_WORD);
    }

    #[test]
    fn a_word_never_gets_one_kind_twice_and_the_plan_follows_the_draws() {
        let words = [skilled("a", 3.0), skilled("b", 4.0)];
        for seed in [0.0, 0.5, 0.999] {
            let wants = plan(&[], &words, NOW, &mut || seed);
            let pairs: HashSet<(String, WireType)> = wants
                .iter()
                .map(|w| (w.item.id.clone(), w.kind.kind))
                .collect();
            assert_eq!(pairs.len(), wants.len());
        }
        assert_eq!(plan_cycling(&[], &words), plan_cycling(&[], &words));
        let variants: HashSet<Vec<WireType>> = [0.0, 0.3, 0.6, 0.9]
            .iter()
            .map(|&seed| kinds(&plan(&[], &words, NOW, &mut || seed)))
            .collect();
        assert!(variants.len() > 1);
    }

    #[test]
    fn the_walk_ignores_store_order_and_follows_the_clock() {
        let words = overdue(6);
        let shuffled = [3, 0, 5, 1, 4, 2].map(|i| words[i].clone());
        assert_eq!(plan_cycling(&[], &shuffled), plan_cycling(&[], &words));

        let pool = [pooled("r", WireType::RecognizeMc, &["a"], Some(NOW - DAY))];
        assert_eq!(
            plan(&pool, &[fresh("a")], NOW, &mut cycling()).len(),
            WANT_PER_WORD
        );
        assert!(plan(&pool, &[fresh("a")], NOW + RESERVE_GAP, &mut cycling()).is_empty());
    }

    #[test]
    fn a_word_with_nothing_to_write_about_is_skipped() {
        let mut blank = fresh("a");
        blank.meaning = "  ".into();
        assert!(plan_cycling(&[], &[blank]).is_empty());
        assert!(plan_cycling(&[], &[]).is_empty());
    }

    #[test]
    fn coverage_counts_covered_words_and_the_wants_a_press_would_write() {
        assert_eq!(
            coverage(&cover("a"), &[fresh("a")]),
            TopUpCoverage {
                upcoming: 1,
                covered: 1,
                wants: 0,
                due: true
            }
        );
        assert_eq!(
            coverage(&cover("a"), &[fresh("a"), fresh("b")]),
            TopUpCoverage {
                upcoming: 2,
                covered: 1,
                wants: WANT_PER_WORD,
                due: true
            }
        );
        let words = [fresh("a"), skilled("b", 4.0), fresh("c")];
        let counted = coverage(&cover("a"), &words);
        assert_eq!(
            counted.wants,
            plan(&cover("a"), &words, NOW, &mut || 0.5).len()
        );
    }

    #[test]
    fn coverage_caps_the_wants_but_not_the_words() {
        assert_eq!(
            coverage(&[], &overdue(20)),
            TopUpCoverage {
                upcoming: 20,
                covered: 0,
                wants: MAX_TOPUP_WANTS,
                due: true
            }
        );
    }

    #[test]
    fn coverage_is_the_due_words_else_the_next_session_length() {
        let mut words = overdue(3);
        words.push(word("later", 2.0 * DAY, 0.0));
        let due = coverage(&[], &words);
        assert_eq!((due.upcoming, due.due), (3, true));

        let ahead: Vec<Word> = (0..25)
            .map(|i| word(&format!("w{i}"), (i + 1) as f64 * DAY, 0.0))
            .collect();
        assert_eq!(
            coverage(&[], &ahead),
            TopUpCoverage {
                upcoming: UPCOMING,
                covered: 0,
                wants: MAX_TOPUP_WANTS,
                due: false
            }
        );
        assert_eq!(
            coverage(&[], &[]),
            TopUpCoverage {
                upcoming: 0,
                covered: 0,
                wants: 0,
                due: false
            }
        );
    }
}
