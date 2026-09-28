//! The kinds a challenge is planned and written as: each wire type's stored
//! `{type, direction}` and, while it is still generated, its demand tier and
//! the rungs it is written at (`data/kinds.json`). What the model is told about
//! a kind is `sapling-llm`'s.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::challenge::{Challenge, Direction};
use crate::difficulty::Demand;

/// One kind of challenge the model can be asked to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum WireType {
    RecognizeMc,
    ProduceMc,
    ContextMc,
    TranslateToNative,
    SpotError,
    WordOrder,
    Cloze,
    MultiCloze,
    /// Retired: still parsed and resolved, never planned.
    TranslateToTarget,
}

// A variant left out of `WireType::ALL` fails here, as long as the last one stays last.
const _: () = assert!(WireType::ALL.len() == WireType::TranslateToTarget as usize + 1);

/// The stored shape a kind resolves to. `promptIsTarget` tells `context-mc`
/// from `produce-mc`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredShape {
    #[serde(rename = "type")]
    pub kind: String,
    pub direction: Direction,
    #[serde(default)]
    pub prompt_is_target: bool,
}

/// A kind's demand tier and the rungs it is generated at.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Plannable {
    pub demand: Demand,
    pub levels: Vec<u8>,
}

#[derive(Debug, Deserialize)]
pub struct KindSpec {
    #[serde(rename = "type")]
    pub kind: WireType,
    pub stored: StoredShape,
    #[serde(default)]
    pub plannable: Option<Plannable>,
}

impl WireType {
    /// Registry order: the planner's tie-break order and the escalation gloss order.
    pub const ALL: [WireType; 9] = [
        WireType::RecognizeMc,
        WireType::ProduceMc,
        WireType::ContextMc,
        WireType::TranslateToNative,
        WireType::SpotError,
        WireType::WordOrder,
        WireType::Cloze,
        WireType::MultiCloze,
        WireType::TranslateToTarget,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            WireType::RecognizeMc => "recognize-mc",
            WireType::ProduceMc => "produce-mc",
            WireType::ContextMc => "context-mc",
            WireType::TranslateToNative => "translate-to-native",
            WireType::SpotError => "spot-error",
            WireType::WordOrder => "word-order",
            WireType::Cloze => "cloze",
            WireType::MultiCloze => "multi-cloze",
            WireType::TranslateToTarget => "translate-to-target",
        }
    }

    fn specs() -> &'static [KindSpec] {
        static SPECS: OnceLock<Vec<KindSpec>> = OnceLock::new();
        SPECS.get_or_init(|| {
            serde_json::from_str(include_str!("../data/kinds.json")).expect("data/kinds.json")
        })
    }

    pub fn kind_spec(self) -> &'static KindSpec {
        WireType::specs()
            .iter()
            .find(|spec| spec.kind == self)
            .expect("every wire type is in data/kinds.json")
    }

    pub fn stored(self) -> &'static StoredShape {
        &self.kind_spec().stored
    }

    /// `None` once retired: a retired kind is neither written nor coverage.
    pub fn plannable(self) -> Option<&'static Plannable> {
        self.kind_spec().plannable.as_ref()
    }

    pub fn is_active(self) -> bool {
        self.plannable().is_some()
    }

    pub fn available_at(self, level: u8) -> bool {
        self.plannable().is_some_and(|p| p.levels.contains(&level))
    }
}

/// Every kind still generated, in registry order (a seeded pick depends on it).
pub fn plannable_kinds() -> impl Iterator<Item = (WireType, &'static Plannable)> {
    WireType::ALL
        .into_iter()
        .filter_map(|kind| kind.plannable().map(|p| (kind, p)))
}

/// The kind a stored challenge was written as; `None` for a match-pairs round.
pub fn kind_of(challenge: &Challenge) -> Option<WireType> {
    WireType::ALL.into_iter().find(|kind| {
        let stored = kind.stored();
        stored.kind == challenge.kind().as_str()
            && stored.direction == challenge.direction()
            && stored.prompt_is_target == challenge.prompt_is_target()
    })
}

/// The word a want is about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct WantItem {
    pub id: String,
    pub term: String,
    pub meaning: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ChallengeKind {
    #[serde(rename = "type")]
    pub kind: WireType,
}

/// One challenge to write: a word, a kind, and the word's rung (1..=5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Want {
    pub item: WantItem,
    pub kind: ChallengeKind,
    pub difficulty: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::challenge::ChallengeType;
    use serde_json::json;

    #[test]
    fn the_data_lists_every_kind_in_registry_order() {
        let listed: Vec<WireType> = WireType::specs().iter().map(|spec| spec.kind).collect();
        assert_eq!(listed, WireType::ALL);
        for kind in WireType::ALL {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
            assert!(
                ChallengeType::parse(&kind.stored().kind).is_some(),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn only_the_retired_kind_is_unplannable_and_nothing_plans_above_constrained_production() {
        let unplanned: Vec<WireType> = WireType::ALL
            .into_iter()
            .filter(|k| !k.is_active())
            .collect();
        assert_eq!(unplanned, [WireType::TranslateToTarget]);
        for (kind, plannable) in plannable_kinds() {
            assert!(plannable.demand <= 1, "{kind:?}");
            assert!(
                !plannable.levels.is_empty()
                    && plannable.levels.iter().all(|l| (1..=5).contains(l))
            );
        }
    }

    #[test]
    fn a_stored_row_reads_back_as_its_kind() {
        let mc = |direction: &str, target: Option<bool>| {
            let mut row = json!({ "id": "m", "type": "multiple-choice", "direction": direction, "prompt": "p",
                "options": ["a", "b", "c", "d"], "correctIndex": 0, "itemIds": [] });
            if let Some(target) = target {
                row["promptIsTarget"] = json!(target);
            }
            kind_of(&Challenge::from_value(row).unwrap())
        };
        assert_eq!(mc("toNative", None), Some(WireType::RecognizeMc));
        assert_eq!(mc("toTarget", None), Some(WireType::ProduceMc));
        assert_eq!(mc("toTarget", Some(true)), Some(WireType::ContextMc));
        let typed = Challenge::from_value(
            json!({ "id": "t", "type": "typed-translation", "direction": "toTarget",
            "prompt": "p", "acceptedAnswers": ["a"], "itemIds": [] }),
        )
        .unwrap();
        assert_eq!(kind_of(&typed), Some(WireType::TranslateToTarget));
        let round = Challenge::from_value(
            json!({ "id": "p", "type": "match-pairs", "direction": "toNative",
            "pairs": [], "itemIds": [] }),
        )
        .unwrap();
        assert_eq!(kind_of(&round), None);
    }
}
