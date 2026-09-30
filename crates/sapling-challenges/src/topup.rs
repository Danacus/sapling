//! Top-up planning: what the pool is missing, so generation writes exactly
//! that. The walk is the learner's whole vocabulary in urgency order — due
//! words most overdue first, then the rest soonest-due first — and each word
//! wants one fresh challenge per kind-group it is short in: one recognition and
//! one production kind where its rung has both, otherwise two distinct kinds
//! from the side it has. A covered word is stepped over, and the list is capped
//! from the least urgent end, so the next press starts where this one stopped.
//!
//! There is no accuracy dial: FSRS lowers a missed word's strength, which lowers
//! its rung, which shortens what is written about it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::kinds::{kind_of, plannable_kinds, ChallengeKind, Plannable, Want, WantItem, WireType};
use crate::ladder::{by_id, demand_for_level, Word};
use crate::pool::{is_playable, is_rested, known_ids, PoolRow, SESSION_LENGTH};
use crate::text::js_trim;

/// Fresh challenges each word should have waiting.
pub const WANT_PER_WORD: usize = 2;

/// The most wants one top-up writes.
pub const MAX_TOPUP_WANTS: usize = 24;

/// How well the pool covers the words a session is about to serve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TopUpCoverage {
    /// The words the figure is about: every due word, or when none is due the
    /// next `SESSION_LENGTH` soonest-due ones.
    pub upcoming: usize,
    /// Of those, the words with nothing left to write.
    pub covered: usize,
    /// What a top-up would write now, after the cap, over the whole walk.
    pub wants: usize,
    /// Whether `upcoming` is the due words.
    pub due: bool,
}

#[derive(Default)]
struct Coverage {
    /// Kinds with a rested, playable challenge: nothing to write.
    rested: HashSet<WireType>,
    /// Kinds the word has ever had a playable challenge of.
    ever: HashSet<WireType>,
}

/// What every word has, by kind, counting only what the session would serve:
/// playable rows of an active kind the word's current rung still takes.
fn coverage_of(pool: &[&PoolRow], words: &[Word], now: f64) -> HashMap<String, Coverage> {
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
        let rested = is_rested(row, now);
        for id in row.challenge.item_ids() {
            let Some(word) = index.get(id.as_str()) else {
                continue;
            };
            if !kind.available_at(word.level()) {
                continue;
            }
            let entry = coverage.entry(id.clone()).or_default();
            entry.ever.insert(kind);
            if rested {
                entry.rested.insert(kind);
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
    draw: &mut dyn FnMut() -> f64,
) -> Walk<'a> {
    let sorted = by_urgency(words.iter().filter(|w| w.is_writable()), now);
    let (owed, ahead): (Vec<&Word>, Vec<&Word>) = sorted.into_iter().partition(|w| w.is_due(now));
    let coverage = coverage_of(pool, words, now);
    let none = Coverage::default();
    let mut wants = Vec::new();

    for word in owed.iter().chain(&ahead) {
        let level = word.level();
        let bearable = demand_for_level(level);
        let allowed: Vec<(WireType, &Plannable)> = plannable_kinds()
            .filter(|(_, p)| p.demand <= bearable && p.levels.contains(&level))
            .collect();
        let recognition: Vec<WireType> = allowed
            .iter()
            .filter(|(_, p)| p.demand == 0)
            .map(|(k, _)| *k)
            .collect();
        let production: Vec<WireType> = allowed
            .iter()
            .filter(|(_, p)| p.demand > 0)
            .map(|(k, _)| *k)
            .collect();
        let have = coverage.get(&word.id).unwrap_or(&none);
        let item = WantItem {
            id: word.id.clone(),
            term: js_trim(&word.term).to_owned(),
            meaning: js_trim(&word.meaning).to_owned(),
        };
        let mut chosen: HashSet<WireType> = HashSet::new();

        let groups: Vec<(Vec<WireType>, usize)> =
            if !recognition.is_empty() && !production.is_empty() {
                vec![(recognition, WANT_PER_WORD - 1), (production, 1)]
            } else {
                vec![(allowed.iter().map(|(k, _)| *k).collect(), WANT_PER_WORD)]
            };
        for (group, need) in groups {
            let covered = group.iter().filter(|k| have.rested.contains(k)).count();
            for _ in covered..need {
                let candidates: Vec<WireType> = group
                    .iter()
                    .copied()
                    .filter(|k| !have.rested.contains(k) && !chosen.contains(k))
                    .collect();
                if candidates.is_empty() {
                    break;
                }
                let fresh: Vec<WireType> = candidates
                    .iter()
                    .copied()
                    .filter(|k| !have.ever.contains(k))
                    .collect();
                let from = if fresh.is_empty() { candidates } else { fresh };
                let at = ((draw() * from.len() as f64).floor() as usize).min(from.len() - 1);
                let kind = from[at];
                chosen.insert(kind);
                wants.push(Want {
                    item: item.clone(),
                    kind: ChallengeKind { kind },
                    difficulty: level,
                });
            }
        }
    }
    Walk { owed, ahead, wants }
}

/// The wants the pool is missing, most urgent word first, capped at [`MAX_TOPUP_WANTS`].
pub fn plan_top_up(
    pool: &[&PoolRow],
    words: &[Word],
    now: f64,
    draw: &mut dyn FnMut() -> f64,
) -> Vec<Want> {
    let mut wants = walk(pool, words, now, draw).wants;
    wants.truncate(MAX_TOPUP_WANTS);
    wants
}

/// Counts, not wants — the same walk, and the same numbers whatever the draws.
pub fn top_up_coverage(pool: &[&PoolRow], words: &[Word], now: f64) -> TopUpCoverage {
    let Walk { owed, ahead, wants } = walk(pool, words, now, &mut || 0.0);
    let short: HashSet<&str> = wants.iter().map(|w| w.item.id.as_str()).collect();
    let due = !owed.is_empty();
    let upcoming: &[&Word] = if due {
        &owed
    } else {
        &ahead[..ahead.len().min(SESSION_LENGTH)]
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
    use crate::pool::RESERVE_GAP;
    use sapling_srs::ItemSrs;
    use serde_json::json;

    pub const NOW: f64 = 1_700_000_000_000.0;
    pub const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

    /// A word due `offset` from now at `strength`.
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
        }
    }

    fn fresh(id: &str) -> Word {
        word(id, -DAY, 0.0)
    }
    fn developing(id: &str) -> Word {
        word(id, -DAY, 0.3)
    }
    fn advanced(id: &str) -> Word {
        word(id, -DAY, 0.6)
    }
    fn strong(id: &str) -> Word {
        word(id, -DAY, 0.9)
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

    fn recognition() -> Vec<WireType> {
        plannable_kinds()
            .filter(|(_, p)| p.demand == 0)
            .map(|(k, _)| k)
            .collect()
    }
    fn constrained() -> Vec<WireType> {
        plannable_kinds()
            .filter(|(_, p)| p.demand == 1)
            .map(|(k, _)| k)
            .collect()
    }
    fn demand(kind: ChallengeKind) -> u8 {
        kind.kind.plannable().map_or(9, |p| p.demand)
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
        plan_top_up(&rows, words, now, draw)
    }
    fn plan_cycling(pool: &[PoolRow], words: &[Word]) -> Vec<Want> {
        plan(pool, words, NOW, &mut cycling())
    }
    fn coverage(pool: &[PoolRow], words: &[Word]) -> TopUpCoverage {
        let rows: Vec<&PoolRow> = pool.iter().collect();
        top_up_coverage(&rows, words, NOW)
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
    fn distinct(values: &[WireType]) -> usize {
        values.iter().collect::<HashSet<_>>().len()
    }
    fn overdue(count: usize) -> Vec<Word> {
        (0..count)
            .map(|i| word(&format!("w{i}"), (i as f64 - count as f64) * DAY, 0.0))
            .collect()
    }
    fn cover_new(id: &str) -> Vec<PoolRow> {
        let r = recognition();
        vec![
            pooled(&format!("{id}-r0"), r[0], &[id], None),
            pooled(&format!("{id}-r1"), r[1], &[id], None),
        ]
    }

    #[test]
    fn a_new_word_wants_two_recognition_kinds() {
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
            assert_eq!(want.difficulty, 1);
            assert_eq!(demand(want.kind), 0);
        }
        assert_eq!(distinct(&kinds(&wants)), WANT_PER_WORD);
    }

    #[test]
    fn the_top_rungs_want_two_distinct_production_kinds() {
        let top = plan_cycling(&[], &[strong("a")]);
        assert_eq!(top.len(), WANT_PER_WORD);
        assert!(top.iter().all(|w| w.difficulty == 5 && demand(w.kind) > 0));
        let set: HashSet<WireType> = kinds(&top).into_iter().collect();
        assert_eq!(set, HashSet::from([WireType::MultiCloze, WireType::Cloze]));

        let four = plan_cycling(&[], &[advanced("a")]);
        assert_eq!(four.len(), WANT_PER_WORD);
        assert!(four.iter().all(|w| w.difficulty == 4 && demand(w.kind) > 0));
        assert_eq!(distinct(&kinds(&four)), WANT_PER_WORD);
    }

    #[test]
    fn a_new_word_is_never_asked_for_what_it_cannot_bear() {
        for seed in [0.0, 0.25, 0.5, 0.75, 0.999] {
            for want in plan(&[], &[fresh("a")], NOW, &mut || seed) {
                assert_eq!(demand(want.kind), 0);
            }
        }
    }

    #[test]
    fn a_covered_word_wants_nothing_and_a_half_covered_one_the_other_half() {
        let pool = [
            pooled("p", WireType::Cloze, &["a"], None),
            pooled("m", WireType::MultiCloze, &["a"], None),
        ];
        assert!(plan_cycling(&pool, &[strong("a")]).is_empty());

        let recognised = plan_cycling(
            &[pooled("r", WireType::SpotError, &["a"], None)],
            &[developing("a")],
        );
        assert_eq!(recognised.len(), 1);
        assert!(demand(recognised[0].kind) > 0);

        let produced = plan_cycling(
            &[pooled("p", constrained()[0], &["a"], None)],
            &[developing("a")],
        );
        assert_eq!(produced.len(), 1);
        assert_eq!(demand(produced[0].kind), 0);
        // Spot-error and context-mc are both open at rung 3; the first draw picks.
        assert_eq!(produced[0].kind.kind, WireType::ContextMc);
    }

    #[test]
    fn a_row_the_word_cannot_bear_is_not_coverage() {
        let wants = plan_cycling(&[pooled("p", WireType::Cloze, &["a"], None)], &[fresh("a")]);
        assert_eq!(wants.len(), WANT_PER_WORD);
    }

    #[test]
    fn a_resting_row_is_not_coverage_but_is_remembered() {
        let r = recognition();
        let resting = [pooled("r", r[0], &["a"], Some(NOW - DAY))];
        let wants = plan_cycling(&resting, &[fresh("a")]);
        assert_eq!(wants.len(), WANT_PER_WORD);
        assert!(!kinds(&wants).contains(&r[0]));

        let rested = [pooled("r", r[0], &["a"], Some(NOW - RESERVE_GAP))];
        let wants = plan_cycling(&rested, &[fresh("a")]);
        assert_eq!(wants.len(), WANT_PER_WORD - 1);
        assert!(!kinds(&wants).contains(&r[0]));
    }

    #[test]
    fn a_kind_never_had_wins_before_one_is_repeated() {
        let r = recognition();
        let pool: Vec<PoolRow> = r[1..]
            .iter()
            .enumerate()
            .map(|(i, kind)| pooled(&format!("r{i}"), *kind, &["a"], Some(NOW - DAY)))
            .collect();
        for seed in [0.0, 0.5, 0.999] {
            let wants = plan(&pool, &[fresh("a")], NOW, &mut || seed);
            assert_eq!(wants[0].kind.kind, r[0]);
            assert_eq!(wants.len(), WANT_PER_WORD);
            assert_eq!(distinct(&kinds(&wants)), WANT_PER_WORD);
        }
    }

    #[test]
    fn reported_and_orphaned_rows_cover_nothing() {
        let r = recognition();
        let mut flagged = pooled("flagged", r[0], &["a"], None);
        flagged.reported = true;
        let pool = [flagged, pooled("orphan", r[1], &["a", "gone"], None)];
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
        let pool: Vec<PoolRow> = first.iter().flat_map(|id| cover_new(id)).collect();
        let second = plan_cycling(&pool, &words);
        assert_eq!(
            words_of(&second),
            (12..20).map(|i| format!("w{i}")).collect::<Vec<_>>()
        );
        assert_eq!(second.len(), 8 * WANT_PER_WORD);

        let three = overdue(3);
        let covered: Vec<PoolRow> = ["w0", "w1", "w2"]
            .iter()
            .flat_map(|id| cover_new(id))
            .collect();
        assert!(plan_cycling(&covered, &three).is_empty());
    }

    #[test]
    fn a_word_never_gets_one_kind_twice_and_the_plan_follows_the_draws() {
        let words = [fresh("a"), strong("b")];
        for seed in [0.0, 0.5, 0.999] {
            let wants = plan(&[], &words, NOW, &mut || seed);
            let pairs: HashSet<(String, WireType)> = wants
                .iter()
                .map(|w| (w.item.id.clone(), w.kind.kind))
                .collect();
            assert_eq!(pairs.len(), wants.len());
        }
        let three = [fresh("a"), strong("b"), fresh("c")];
        assert_eq!(plan_cycling(&[], &three), plan_cycling(&[], &three));
        let variants: HashSet<Vec<WireType>> = [0.0, 0.3, 0.6, 0.9]
            .iter()
            .map(|&seed| kinds(&plan(&[], &three, NOW, &mut || seed)))
            .collect();
        assert!(variants.len() > 1);
    }

    #[test]
    fn the_walk_ignores_store_order_and_follows_the_clock() {
        let words = overdue(6);
        let shuffled = [3, 0, 5, 1, 4, 2].map(|i| words[i].clone());
        assert_eq!(plan_cycling(&[], &shuffled), plan_cycling(&[], &words));

        let pool = [pooled("r", recognition()[0], &["a"], Some(NOW - DAY))];
        assert_eq!(
            plan(&pool, &[fresh("a")], NOW, &mut cycling()).len(),
            WANT_PER_WORD
        );
        assert_eq!(
            plan(&pool, &[fresh("a")], NOW + RESERVE_GAP, &mut cycling()).len(),
            WANT_PER_WORD - 1
        );
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
        let covered = [
            pooled("m", WireType::MultiCloze, &["a"], None),
            pooled("p", WireType::Cloze, &["a"], None),
        ];
        assert_eq!(
            coverage(&covered, &[strong("a")]),
            TopUpCoverage {
                upcoming: 1,
                covered: 1,
                wants: 0,
                due: true
            }
        );
        let half = [pooled("m", WireType::MultiCloze, &["a"], None)];
        assert_eq!(
            coverage(&half, &[strong("a"), fresh("b")]),
            TopUpCoverage {
                upcoming: 2,
                covered: 0,
                wants: 3,
                due: true
            }
        );

        let words = [fresh("a"), strong("b"), fresh("c")];
        let r = recognition();
        let pool = [
            pooled("r", r[0], &["a"], None),
            pooled("r2", r[1], &["a"], None),
        ];
        let counted = coverage(&pool, &words);
        assert_eq!(counted.wants, plan(&pool, &words, NOW, &mut || 0.5).len());
        assert_eq!(counted.covered, 1);
    }

    #[test]
    fn coverage_ignores_the_draws_and_caps_the_wants_but_not_the_words() {
        let words = [fresh("a"), strong("b"), fresh("c")];
        let pool = [pooled("r", recognition()[0], &["a"], None)];
        assert_eq!(coverage(&pool, &words), coverage(&pool, &words));
        let many = coverage(&[], &overdue(20));
        assert_eq!(
            many,
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
        words.push(word("latest", 4.0 * DAY, 0.0));
        let due = coverage(&[], &words);
        assert_eq!((due.upcoming, due.due), (3, true));

        let ahead: Vec<Word> = (0..25)
            .map(|i| word(&format!("w{i}"), (i + 1) as f64 * DAY, 0.0))
            .collect();
        assert_eq!(
            coverage(&[], &ahead),
            TopUpCoverage {
                upcoming: SESSION_LENGTH,
                covered: 0,
                wants: MAX_TOPUP_WANTS,
                due: false
            }
        );
    }

    #[test]
    fn coverage_can_have_wants_once_every_due_word_is_covered() {
        let words = [fresh("due"), word("ahead", 3.0 * DAY, 0.0)];
        assert_eq!(
            coverage(&cover_new("due"), &words),
            TopUpCoverage {
                upcoming: 1,
                covered: 1,
                wants: WANT_PER_WORD,
                due: true
            }
        );
        let mut blank = fresh("a");
        blank.meaning = "  ".into();
        assert_eq!(
            coverage(&[], &[blank, fresh("b")]),
            TopUpCoverage {
                upcoming: 1,
                covered: 0,
                wants: WANT_PER_WORD,
                due: true
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
