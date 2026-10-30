//! Top-up planning: what the stream's list is short of, so generation writes
//! exactly that. The list is `stream.rs`' [`upcoming`] — the same words in the
//! same order serving walks, through the same predicate — and a word with
//! fewer than [`STOCK`] available rows wants [`STOCK`] written, each
//! `{word, kind, length}`. The stream's refill reads the first
//! `low_water_mark` words; a press on the learn screen reads them all. The
//! list is capped from the least urgent end, so the next one starts there.
//!
//! **What to write** (`docs/challenge-difficulty.md`) is the pick run over
//! kinds instead of rows: one roll of the ratings, each kind judged by its
//! written help level nearest the target at the middle of its lengths, and
//! the nearest kinds taken.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::fits::written_levels;
use crate::kinds::{active_kinds, ChallengeKind, Want, WantItem, WireType};
use crate::model::target;
use crate::pool::PoolRow;
use crate::ratings::Roll;
use crate::rng::Rng;
use crate::stream::{seen, upcoming, Ahead, Judge};
use crate::text::js_trim;
use crate::word::Word;

/// A word with fewer available rows than this gets this many written.
pub const STOCK: usize = 2;

/// The most wants one top-up writes.
pub const MAX_TOPUP_WANTS: usize = 24;

/// How many of the words ahead the start screen's figure counts when none is due.
pub const UPCOMING: usize = 20;

/// The start screen's figure, read off the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TopUpCoverage {
    /// The words the figure is about: every due word, or when none is due the
    /// next `UPCOMING` soonest-due ones.
    pub upcoming: usize,
    /// Of those, the words with a row available now.
    pub covered: usize,
    /// What a press would write, after the cap.
    pub wants: usize,
    /// Whether `upcoming` is the due words.
    pub due: bool,
}

/// The length a row of `kind` is written at: the middle of its range.
pub fn middle_length(kind: WireType) -> Option<u8> {
    let [short, long] = kind.lengths()?;
    Some(short + (long - short) / 2)
}

/// `kinds` for `word`, nearest the target first as one roll puts them: each
/// at its written help level nearest the target, at its middle length.
fn ranked(
    word: &Word,
    kinds: impl Iterator<Item = WireType>,
    judge: Judge,
    now: f64,
    rng: &mut Rng,
) -> Vec<(WireType, u8)> {
    let aim = target(judge.serving.aim);
    let mut roll = Roll::new(judge.ratings, now, rng);
    let mut ranked: Vec<(WireType, u8, f64)> = kinds
        .filter_map(|kind| {
            let length = middle_length(kind)?;
            let distance = written_levels(kind, judge.serving)
                .into_iter()
                .map(|help| {
                    let o = seen("", kind, help, f64::from(length), &[word], now);
                    (roll.chance(&o) - aim).abs()
                })
                .fold(f64::INFINITY, f64::min);
            Some((kind, length, distance))
        })
        .collect();
    ranked.sort_by(|a, b| a.2.total_cmp(&b.2));
    ranked.into_iter().map(|(k, l, _)| (k, l)).collect()
}

/// What a stream's refill is about: the rows it has shown cover nothing, the
/// words it has already asked for want nothing, and only the first `limit`
/// words of the list count. The default is a press: the whole collection.
/// `cued` are the words with a usable cue: a local kind is a candidate only
/// for them.
#[derive(Debug, Clone, Copy, Default)]
pub struct Scope<'a> {
    pub served: &'a [String],
    pub asked: &'a [String],
    pub limit: Option<usize>,
    pub cued: &'a [String],
}

fn want_item(word: &Word) -> WantItem {
    WantItem {
        id: word.id.clone(),
        term: js_trim(&word.term).to_owned(),
        meaning: js_trim(&word.meaning).to_owned(),
    }
}

fn want(word: &Word, (kind, length): (WireType, u8)) -> Want {
    Want {
        item: want_item(word),
        kind: ChallengeKind { kind },
        length,
    }
}

/// The wants for the words of `list` short of stock, capped.
/// The kinds a row can be written as for a learner with `library` words.
fn writable(library: usize) -> impl Iterator<Item = WireType> {
    active_kinds().filter(move |kind| kind.words() <= library)
}

fn wants_of(
    list: &[Ahead],
    library: usize,
    judge: Judge,
    now: f64,
    scope: Scope,
    rng: &mut Rng,
) -> Vec<Want> {
    let mut wants = Vec::new();
    let wanting = list
        .iter()
        .filter(|a| a.available < STOCK && !scope.asked.contains(&a.word.id));
    for word in wanting.map(|a| a.word) {
        let cued = scope.cued.contains(&word.id);
        let kinds = writable(library).filter(|kind| cued || !kind.is_local());
        for pick in ranked(word, kinds, judge, now, rng).into_iter().take(STOCK) {
            wants.push(want(word, pick));
        }
    }
    wants.truncate(MAX_TOPUP_WANTS);
    wants
}

/// A want the model writes for `word`, in place of a local one that found
/// nothing to build from: the kind the same roll puts nearest, among those the
/// model writes less those in `taken`.
pub fn instead_of_local(
    word: &Word,
    library: usize,
    judge: Judge,
    now: f64,
    taken: &[WireType],
    rng: &mut Rng,
) -> Option<Want> {
    let kinds = writable(library).filter(|kind| !kind.is_local() && !taken.contains(kind));
    let first = ranked(word, kinds, judge, now, rng).into_iter().next()?;
    Some(want(word, first))
}

/// The wants for the words in `scope`, most urgent first, capped at [`MAX_TOPUP_WANTS`].
pub fn plan_top_up(
    pool: &[Option<PoolRow>],
    words: &[Word],
    now: f64,
    judge: Judge,
    scope: Scope,
    rng: &mut Rng,
) -> Vec<Want> {
    let n = scope.limit.unwrap_or(usize::MAX);
    let list = upcoming(pool, words, now, scope.served, n);
    wants_of(&list, words.len(), judge, now, scope, rng)
}

/// The start screen's figure and the press's count, off one list.
pub fn coverage(pool: &[Option<PoolRow>], words: &[Word], now: f64, judge: Judge) -> TopUpCoverage {
    let list = upcoming(pool, words, now, &[], usize::MAX);
    let due = list.iter().take_while(|a| a.word.is_due(now)).count();
    let figure = &list[..if due > 0 {
        due
    } else {
        list.len().min(UPCOMING)
    }];
    TopUpCoverage {
        upcoming: figure.len(),
        covered: figure.iter().filter(|a| a.available > 0).count(),
        wants: wants_of(
            &list,
            words.len(),
            judge,
            now,
            Scope::default(),
            &mut Rng::seeded(0),
        )
        .len(),
        due: due > 0,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fits::Serving;
    use crate::model::Aim;
    use crate::pool::RESERVE_GAP;
    use crate::ratings::Ratings;
    use crate::Challenge;
    use sapling_srs::ItemSrs;
    use serde_json::json;
    use std::collections::HashSet;

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
                stability: None,
            }),
        }
    }

    fn fresh(id: &str) -> Word {
        word(id, -DAY, 0.0)
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
            WireType::CueCloze => {
                json!({ "type": "cue-cloze", "sentence": "a ___ b", "acceptedAnswers": ["x"],
                "wordBank": ["x", "y", "z"], "cue": { "textId": "t", "start": 0.0, "end": 1.0 } })
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
        }
    }

    fn plan_with(
        pool: &[PoolRow],
        words: &[Word],
        now: f64,
        ratings: &Ratings,
        serving: &Serving,
        scope: Scope,
        seed: u64,
    ) -> Vec<Want> {
        let rows = crate::stream::tests::rows(pool);
        let judge = Judge { serving, ratings };
        plan_top_up(&rows, words, now, judge, scope, &mut Rng::seeded(seed))
    }
    fn plan(pool: &[PoolRow], words: &[Word]) -> Vec<Want> {
        plan_at(pool, words, NOW)
    }
    fn plan_at(pool: &[PoolRow], words: &[Word], now: f64) -> Vec<Want> {
        let serving = Serving::default();
        plan_with(
            pool,
            words,
            now,
            &Ratings::default(),
            &serving,
            Scope::default(),
            3,
        )
    }
    fn scoped(words: &[Word], scope: Scope) -> Vec<Want> {
        let serving = Serving::default();
        plan_with(&[], words, NOW, &Ratings::default(), &serving, scope, 3)
    }
    fn figure(pool: &[PoolRow], words: &[Word]) -> TopUpCoverage {
        let (serving, ratings) = (Serving::default(), Ratings::default());
        let judge = Judge {
            serving: &serving,
            ratings: &ratings,
        };
        coverage(&crate::stream::tests::rows(pool), words, NOW, judge)
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
    /// A stock of rows for `id`, rested and never served.
    fn cover(id: &str) -> Vec<PoolRow> {
        (0..STOCK)
            .map(|i| pooled(&format!("{id}-r{i}"), WireType::RecognizeMc, &[id], None))
            .collect()
    }

    #[test]
    fn a_new_word_wants_two_kinds_at_the_middle_of_their_lengths() {
        let wants = plan(&[], &[fresh("a")]);
        assert_eq!(wants.len(), STOCK);
        for want in &wants {
            assert_eq!(
                want.item,
                WantItem {
                    id: "a".into(),
                    term: "term-a".into(),
                    meaning: "meaning-a".into()
                }
            );
            assert_eq!(Some(want.length), middle_length(want.kind.kind));
            assert!(!want.kind.kind.is_local());
        }
        assert_ne!(wants[0].kind, wants[1].kind);
    }

    #[test]
    fn a_word_short_of_stock_gets_two_wants_and_a_stocked_one_none() {
        let one = [pooled("r", WireType::Cloze, &["a"], None)];
        let wants = plan(&one, &[fresh("a")]);
        assert_eq!(wants.len(), STOCK);
        assert!(wants.iter().all(|w| w.item.id == "a"));
        assert!(plan(&cover("a"), &[fresh("a")]).is_empty());
    }

    /// The kinds follow the roll: one rated far too hard on many answers is
    /// almost never asked for, and a seed replays the plan.
    #[test]
    fn the_kinds_follow_the_roll_and_a_seed_replays_them() {
        let serving = Serving::default();
        let words = [fresh("a"), fresh("b")];
        let r = Ratings::default();
        let run = |seed| plan_with(&[], &words, NOW, &r, &serving, Scope::default(), seed);
        assert_eq!(run(5), run(5));
        let variants: HashSet<Vec<WireType>> = (0..20).map(|seed| kinds(&run(seed))).collect();
        assert!(variants.len() > 1);

        let mut hard = Ratings::default();
        crate::stream::tests::settle(&mut hard, WireType::SpotError, 0, 300);
        let asked = (0..200)
            .flat_map(|seed| plan_with(&[], &words, NOW, &hard, &serving, Scope::default(), seed))
            .filter(|w| w.kind.kind == WireType::SpotError)
            .count();
        assert!(asked < 4, "{asked}");
    }

    #[test]
    fn a_harder_aim_asks_for_harder_kinds() {
        let words = overdue(12);
        let mut r = Ratings::default();
        crate::stream::tests::settle(&mut r, WireType::RecognizeMc, 10, 200);
        crate::stream::tests::settle(&mut r, WireType::TranslateToNative, 4, 200);
        let count = |aim: Aim| {
            let serving = Serving {
                aim,
                ..Serving::default()
            };
            plan_with(&[], &words, NOW, &r, &serving, Scope::default(), 1)
                .iter()
                .filter(|w| w.kind.kind == WireType::RecognizeMc)
                .count()
        };
        assert!(count(Aim::Easier) > count(Aim::Harder));
    }

    #[test]
    fn a_resting_row_counts_only_for_a_due_word() {
        let ahead = word("a", 5.0 * DAY, 0.0);
        let resting: Vec<PoolRow> = (0..STOCK)
            .map(|i| {
                pooled(
                    &format!("r{i}"),
                    WireType::RecognizeMc,
                    &["a"],
                    Some(NOW - DAY),
                )
            })
            .collect();
        assert_eq!(plan(&resting, std::slice::from_ref(&ahead)).len(), STOCK);
        assert!(plan(&resting, &[fresh("a")]).is_empty());
        assert!(plan_at(&resting, &[ahead], NOW - DAY + RESERVE_GAP).is_empty());
    }

    #[test]
    fn reported_and_orphaned_rows_cover_nothing() {
        let mut flagged = pooled("flagged", WireType::RecognizeMc, &["a"], None);
        flagged.reported = true;
        let pool = [
            flagged,
            pooled("orphan", WireType::ProduceMc, &["a", "gone"], None),
        ];
        assert_eq!(plan(&pool, &[fresh("a")]).len(), STOCK);
    }

    #[test]
    fn the_walk_is_most_overdue_first_and_capped_from_the_least_urgent_end() {
        let wants = plan(&[], &overdue(20));
        assert_eq!(wants.len(), MAX_TOPUP_WANTS);
        assert_eq!(wants[0].item.id, "w0");
        assert_eq!(wants[1].item.id, "w0");
        assert_eq!(wants[2].item.id, "w1");
        assert_eq!(words_of(&wants).len(), MAX_TOPUP_WANTS / STOCK);

        let words = [
            word("ahead", 5.0 * DAY, 0.0),
            word("owed", -DAY, 0.0),
            word("later", 9.0 * DAY, 0.0),
        ];
        assert_eq!(words_of(&plan(&[], &words)), ["owed", "ahead", "later"]);
        let shuffled = [2, 0, 1].map(|i| words[i].clone());
        assert_eq!(plan(&[], &shuffled), plan(&[], &words));
    }

    #[test]
    fn a_second_press_reaches_the_words_below_the_first() {
        let words = overdue(20);
        let first = words_of(&plan(&[], &words));
        assert_eq!(first, (0..12).map(|i| format!("w{i}")).collect::<Vec<_>>());
        let pool: Vec<PoolRow> = first.iter().flat_map(|id| cover(id)).collect();
        let second = plan(&pool, &words);
        assert_eq!(
            words_of(&second),
            (12..20).map(|i| format!("w{i}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_limit_reads_only_the_first_words_and_an_asked_word_wants_nothing() {
        let scope = Scope {
            limit: Some(3),
            ..Scope::default()
        };
        assert_eq!(words_of(&scoped(&overdue(10), scope)), ["w0", "w1", "w2"]);
        let asked = ["w1".to_owned()];
        let scope = Scope {
            asked: &asked,
            ..scope
        };
        assert_eq!(words_of(&scoped(&overdue(10), scope)), ["w0", "w2"]);
    }

    #[test]
    fn a_local_kind_is_a_candidate_only_for_a_word_with_a_cue() {
        let words = [fresh("a"), fresh("b")];
        let cued = ["a".to_owned()];
        let serving = Serving::default();
        let r = Ratings::default();
        let mut local = HashSet::new();
        for seed in 0..60 {
            let scope = Scope {
                cued: &cued,
                ..Scope::default()
            };
            let wants = plan_with(&[], &words, NOW, &r, &serving, scope, seed);
            for want in wants.iter().filter(|w| w.kind.kind.is_local()) {
                local.insert(want.item.id.clone());
            }
            let uncued = plan_with(&[], &words, NOW, &r, &serving, Scope::default(), seed);
            assert!(uncued.iter().all(|w| !w.kind.kind.is_local()));
        }
        assert_eq!(local, HashSet::from(["a".to_owned()]));
    }

    #[test]
    fn instead_of_a_local_kind_the_nearest_model_kind_not_taken() {
        let (serving, r) = (Serving::default(), Ratings::default());
        let judge = Judge {
            serving: &serving,
            ratings: &r,
        };
        let taken = [WireType::CueCloze, WireType::Cloze];
        for seed in 0..20 {
            let want = instead_of_local(&fresh("a"), 2, judge, NOW, &taken, &mut Rng::seeded(seed))
                .unwrap();
            assert!(!want.kind.kind.is_local() && !taken.contains(&want.kind.kind));
        }
    }

    /// A multi-cloze needs a second word to gap: a learner with one never
    /// gets it asked for, one with two sometimes does.
    #[test]
    fn a_kind_about_two_words_waits_for_a_second_word() {
        let serving = Serving::default();
        let r = Ratings::default();
        let kinds = |words: &[Word]| -> HashSet<WireType> {
            (0..200)
                .flat_map(|seed| plan_with(&[], words, NOW, &r, &serving, Scope::default(), seed))
                .map(|w| w.kind.kind)
                .collect()
        };
        assert!(!kinds(&[fresh("a")]).contains(&WireType::MultiCloze));
        assert!(kinds(&[fresh("a"), fresh("b")]).contains(&WireType::MultiCloze));
    }

    #[test]
    fn a_word_with_nothing_to_write_about_is_skipped() {
        let mut blank = fresh("a");
        blank.meaning = "  ".into();
        assert!(plan(&[], &[blank]).is_empty());
        assert!(plan(&[], &[]).is_empty());
    }

    #[test]
    fn coverage_counts_covered_words_and_the_wants_a_press_would_write() {
        assert_eq!(
            figure(&cover("a"), &[fresh("a")]),
            TopUpCoverage {
                upcoming: 1,
                covered: 1,
                wants: 0,
                due: true
            }
        );
        let one = [pooled("r", WireType::Cloze, &["b"], None)];
        let mut pool = cover("a");
        pool.extend(one);
        assert_eq!(
            figure(&pool, &[fresh("a"), fresh("b"), fresh("c")]),
            TopUpCoverage {
                upcoming: 3,
                covered: 2,
                wants: 2 * STOCK,
                due: true
            }
        );
        assert_eq!(
            figure(&[], &overdue(20)),
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
        let due = figure(&[], &words);
        assert_eq!((due.upcoming, due.due), (3, true));

        let ahead: Vec<Word> = (0..25)
            .map(|i| word(&format!("w{i}"), (i + 1) as f64 * DAY, 0.0))
            .collect();
        assert_eq!(
            figure(&[], &ahead),
            TopUpCoverage {
                upcoming: UPCOMING,
                covered: 0,
                wants: MAX_TOPUP_WANTS,
                due: false
            }
        );
        assert_eq!(
            figure(&[], &[]),
            TopUpCoverage {
                upcoming: 0,
                covered: 0,
                wants: 0,
                due: false
            }
        );
    }
}
