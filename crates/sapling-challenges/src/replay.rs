//! From a log of answers to what the model learns from: each answer's
//! challenge, the help level it was shown at, and each word's memory just
//! before it — FSRS's retrievability, folded from the word's reviews that came
//! strictly earlier, so an answer's own review never explains itself.
//!
//! One implementation for both callers: the materializer hands in its read
//! tables, and the calibration command hands in an export, folded here the way
//! the merge rules fold it. Answers replay in `(at, id)` order rather than
//! arrival order, so every device derives the same numbers from the same log
//! whichever order sync delivered it in.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use sapling_domain::events::{parse_envelope, typed_event, Payload, SyncEvent};
use sapling_domain::types::Verdict;
use sapling_srs::{current_retrievability, new_card_state, review_card, word_strength, Grade};

use crate::challenge::Challenge;
use crate::help::HelpLevel;
use crate::kinds::kind_of;
use crate::legacy::legacy_help_level;
use crate::model::{length_of, tuning, Evidence, Observation};

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayItem {
    pub id: String,
    pub introduced_at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayReview {
    pub item_id: String,
    pub at: f64,
    pub grade: f64,
    pub device: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReplayResult {
    /// The `resultLogged` event's id: the tie-break after `at`.
    pub id: String,
    pub challenge_id: String,
    pub verdict: Verdict,
    pub at: f64,
    pub shown: Option<String>,
}

/// Everything replay reads, as the merge rules left it.
#[derive(Debug, Clone, Default)]
pub struct ReplayInput {
    pub items: Vec<ReplayItem>,
    pub reviews: Vec<ReplayReview>,
    pub challenges: HashMap<String, Challenge>,
    pub results: Vec<ReplayResult>,
}

pub fn outcome_of(verdict: Verdict) -> f64 {
    match verdict {
        Verdict::Correct => 1.0,
        Verdict::Almost => 0.5,
        Verdict::Wrong => 0.0,
    }
}

/// One word's card, folded forward as the answers move through time.
struct Card<'a> {
    card: sapling_srs::FsrsCardState,
    reviews: Vec<&'a ReplayReview>,
    next: usize,
}

impl Card<'_> {
    /// Folds every review strictly before `at`; answers memory and strength then.
    fn at(&mut self, at: f64) -> (f64, f64) {
        while let Some(review) = self.reviews.get(self.next) {
            if review.at >= at {
                break;
            }
            if let Ok(grade) = Grade::from_f64(review.grade) {
                if let Ok(card) = review_card(&self.card, grade, review.at) {
                    self.card = card;
                }
            }
            self.next += 1;
        }
        if self.next == 0 {
            return (tuning().new_word_memory, 0.0);
        }
        (
            current_retrievability(&self.card, at),
            word_strength(&self.card, at),
        )
    }
}

/// The answers the model learns from, in replay order. An answer is passed
/// over when its challenge is unknown or a match round, when a word it names
/// no longer exists, or when it records a help level this build cannot read.
pub fn observations(input: &ReplayInput) -> Vec<Observation> {
    let mut by_item: HashMap<&str, Vec<&ReplayReview>> = HashMap::new();
    for review in &input.reviews {
        by_item.entry(&review.item_id).or_default().push(review);
    }
    let mut cards: HashMap<&str, Card> = input
        .items
        .iter()
        .map(|item| {
            let mut reviews = by_item.remove(item.id.as_str()).unwrap_or_default();
            reviews.sort_by(|a, b| a.at.total_cmp(&b.at).then_with(|| a.device.cmp(&b.device)));
            (
                item.id.as_str(),
                Card {
                    card: new_card_state(item.introduced_at),
                    reviews,
                    next: 0,
                },
            )
        })
        .collect();

    let mut results: Vec<&ReplayResult> = input.results.iter().collect();
    results.sort_by(|a, b| a.at.total_cmp(&b.at).then_with(|| a.id.cmp(&b.id)));

    let mut out = Vec::new();
    for result in results {
        let Some(challenge) = input.challenges.get(&result.challenge_id) else {
            continue;
        };
        let Some(kind) = kind_of(challenge) else {
            continue;
        };
        let ids = challenge.item_ids();
        if ids.is_empty() || !ids.iter().all(|id| cards.contains_key(id.as_str())) {
            continue;
        }
        let mut words = Vec::with_capacity(ids.len());
        let mut weakest = f64::INFINITY;
        for id in ids {
            let card = cards.get_mut(id.as_str()).expect("checked above");
            let (memory, strength) = card.at(result.at);
            weakest = weakest.min(strength);
            words.push(Evidence {
                item_id: id.clone(),
                memory,
            });
        }
        let help = match &result.shown {
            Some(shown) => match HelpLevel::parse(shown) {
                Some(help) => help,
                None => continue,
            },
            None => legacy_help_level(challenge, weakest),
        };
        out.push(Observation {
            at: result.at,
            challenge_id: result.challenge_id.clone(),
            kind,
            help,
            length: length_of(challenge),
            words,
            outcome: outcome_of(result.verdict),
        });
    }
    out
}

/* ---- From an export --------------------------------------------------- */

/// The typed events of an export file (`ExportEnvelope`), in its order. A row
/// this build cannot read is passed over, as the materializer passes it over.
pub fn parse_export(json: &str) -> Result<Vec<SyncEvent>, String> {
    let parsed: Value = serde_json::from_str(json).map_err(|e| format!("not JSON: {e}"))?;
    let events = parsed
        .get("events")
        .and_then(Value::as_array)
        .ok_or("not an export: no `events` list")?;
    Ok(events
        .iter()
        .filter_map(parse_envelope)
        .filter_map(|raw| typed_event(&raw))
        .collect())
}

/// The profile with the most answers: whose history a calibration reads
/// unless told otherwise.
pub fn busiest_profile(events: &[SyncEvent]) -> Option<String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for event in events {
        if matches!(event.payload, Payload::ResultLogged(_)) {
            *counts.entry(&event.profile_id).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(id, _)| id.to_owned())
}

/// One profile's log folded the way the merge rules fold it: the first add of
/// an item or challenge wins, a delete wins over everything, a review is one
/// per `(item, at, device)` and an amendment replaces the one it names.
pub fn input_from_events(events: &[SyncEvent], profile: &str) -> ReplayInput {
    let mut items: Vec<ReplayItem> = Vec::new();
    let mut seen_items: HashSet<String> = HashSet::new();
    let mut deleted: HashSet<String> = HashSet::new();
    let mut reviews: HashMap<(String, u64, String), ReplayReview> = HashMap::new();
    let mut challenges: HashMap<String, Challenge> = HashMap::new();
    let mut results: Vec<ReplayResult> = Vec::new();
    let mut seen_results: HashSet<String> = HashSet::new();
    let key =
        |item: &str, at: f64, device: &str| (item.to_owned(), at.to_bits(), device.to_owned());

    for event in events.iter().filter(|e| e.profile_id == profile) {
        match &event.payload {
            Payload::ItemAdded(p) => {
                if seen_items.insert(p.id.clone()) {
                    items.push(ReplayItem {
                        id: p.id.clone(),
                        introduced_at: p.introduced_at,
                    });
                }
            }
            Payload::ItemDeleted(p) => {
                deleted.insert(p.item_id.clone());
            }
            Payload::ItemReviewed(p) => {
                reviews
                    .entry(key(&p.item_id, p.at, &p.device))
                    .or_insert(ReplayReview {
                        item_id: p.item_id.clone(),
                        at: p.at,
                        grade: p.grade,
                        device: p.device.clone(),
                    });
            }
            Payload::ReviewAmended(p) => {
                if let Some(replaces) = p.replaces {
                    reviews.remove(&key(&p.item_id, replaces, &p.device));
                }
                reviews.insert(
                    key(&p.item_id, p.at, &p.device),
                    ReplayReview {
                        item_id: p.item_id.clone(),
                        at: p.at,
                        grade: p.grade,
                        device: p.device.clone(),
                    },
                );
            }
            Payload::ChallengeAdded(p) => {
                let Some(value) = p.challenge.clone() else {
                    continue;
                };
                if let Ok(challenge) = Challenge::from_value(value) {
                    challenges
                        .entry(challenge.id().to_owned())
                        .or_insert(challenge);
                }
            }
            Payload::ResultLogged(p) if seen_results.insert(event.id.clone()) => {
                results.push(ReplayResult {
                    id: event.id.clone(),
                    challenge_id: p.challenge_id.clone(),
                    verdict: p.verdict,
                    at: p.at,
                    shown: p.shown.clone(),
                });
            }
            _ => {}
        }
    }
    items.retain(|item| !deleted.contains(&item.id));
    ReplayInput {
        items,
        reviews: reviews
            .into_values()
            .filter(|review| !deleted.contains(&review.item_id))
            .collect(),
        challenges,
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::kinds::WireType;
    use serde_json::json;

    const DAY: f64 = 86_400_000.0;

    fn cloze(id: &str, item: &str) -> Challenge {
        Challenge::from_value(json!({ "id": id, "type": "cloze", "direction": "toTarget",
            "sentence": "Yo ___ un libro.", "acceptedAnswers": ["leo"],
            "wordBank": ["leo", "a", "b", "c", "d", "e"], "itemIds": [item] }))
        .unwrap()
    }

    fn result(id: &str, challenge: &str, at: f64, shown: Option<&str>) -> ReplayResult {
        ReplayResult {
            id: id.into(),
            challenge_id: challenge.into(),
            verdict: Verdict::Correct,
            at,
            shown: shown.map(str::to_owned),
        }
    }

    fn input() -> ReplayInput {
        ReplayInput {
            items: vec![ReplayItem {
                id: "w".into(),
                introduced_at: 0.0,
            }],
            reviews: vec![
                ReplayReview {
                    item_id: "w".into(),
                    at: DAY,
                    grade: 3.0,
                    device: "d".into(),
                },
                ReplayReview {
                    item_id: "w".into(),
                    at: 5.0 * DAY,
                    grade: 3.0,
                    device: "d".into(),
                },
            ],
            challenges: [("c".to_owned(), cloze("c", "w"))].into(),
            results: vec![
                result("r2", "c", 5.0 * DAY, Some("pick-6")),
                result("r1", "c", DAY, None),
                result("r3", "gone", 6.0 * DAY, Some("typed")),
                result("r4", "c", 7.0 * DAY, Some("a-step-from-the-future")),
            ],
        }
    }

    #[test]
    fn answers_replay_in_time_order_with_the_memory_before_each() {
        let seen = observations(&input());
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].at, DAY);
        // Never reviewed before its first answer: the new-word memory.
        assert_eq!(seen[0].words[0].memory, tuning().new_word_memory);
        // Unrecorded, and the word brand new: the frozen ladder's first rung.
        assert_eq!(seen[0].help, HelpLevel::step(Step::Pick4));
        // Four days after one Good review, recall has decayed below certainty.
        let memory = seen[1].words[0].memory;
        assert!(memory > 0.3 && memory < 1.0, "{memory}");
        assert_eq!(seen[1].help, HelpLevel::step(Step::Pick6));
        assert_eq!(seen[1].kind, WireType::Cloze);
        assert_eq!(seen[1].length, 4.0);
    }

    #[test]
    fn replay_order_does_not_depend_on_the_input_order() {
        let mut shuffled = input();
        shuffled.results.reverse();
        shuffled.reviews.reverse();
        assert_eq!(observations(&shuffled), observations(&input()));
    }

    #[test]
    fn a_deleted_word_takes_its_answers_with_it() {
        let mut gone = input();
        gone.items.clear();
        assert!(observations(&gone).is_empty());
    }

    #[test]
    fn an_export_folds_like_the_merge_rules() {
        let envelope = |id: &str, kind: &str, payload: Value| json!({ "id": id, "type": kind, "at": 1, "device": "d", "payload": payload });
        let export = json!({ "version": 3, "exportedAt": 0, "events": [
            envelope("e1", "itemAdded", json!({ "id": "w", "kind": "vocab", "term": "leer", "meaning": "read", "introducedAt": 0 })),
            envelope("e2", "challengeAdded", json!({ "challenge": serde_json::to_value(cloze("c", "w")).unwrap(), "generatedAt": 0 })),
            envelope("e3", "itemReviewed", json!({ "device": "d", "at": DAY, "itemId": "w", "grade": 1 })),
            envelope("e4", "reviewAmended", json!({ "device": "d", "at": DAY + 5.0, "itemId": "w", "grade": 3, "replaces": DAY })),
            envelope("e5", "resultLogged", json!({ "challengeId": "c", "verdict": "wrong", "answerGiven": "x", "at": 2.0 * DAY, "shown": "typed" })),
            envelope("e6", "itemAdded", json!({ "id": "x", "kind": "vocab", "term": "x", "meaning": "x", "introducedAt": 0 })),
            envelope("e7", "itemDeleted", json!({ "itemId": "x" })),
            { "not": "an envelope" }
        ] });
        let events = parse_export(&export.to_string()).unwrap();
        assert_eq!(events.len(), 7);
        let profile = busiest_profile(&events).unwrap();
        let folded = input_from_events(&events, &profile);
        assert_eq!(folded.items.len(), 1);
        assert_eq!(folded.reviews.len(), 1);
        assert_eq!(folded.reviews[0].grade, 3.0);
        let seen = observations(&folded);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].outcome, 0.0);
        assert_eq!(seen[0].help, HelpLevel::step(Step::Typed));
        assert!(parse_export("[]").is_err());
    }
}
