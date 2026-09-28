//! The wire types a lesson is written in. Everything the model is told about
//! one — its field list, rules, sizes, retry line, escalation gloss — and the
//! mock's examples live in `lessons/<type>.json`.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

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

/// The stored `{type, direction}` a wire type resolves to, plus the one fact
/// that tells `context-mc` from `produce-mc`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StoredShape {
    #[serde(rename = "type")]
    pub kind: String,
    pub direction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_is_target: Option<bool>,
}

/// The demand tier a kind's stored challenge reports, and the rungs it is
/// generated at. What the session's planner reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Plannable {
    pub demand: u8,
    pub levels: Vec<u8>,
}

/// One wire type as the planner sees it (`CHALLENGE_KINDS` in `llm.ts`).
#[derive(Debug, Clone, Serialize, TS)]
pub struct KindInfo {
    #[serde(rename = "type")]
    pub kind: WireType,
    pub stored: StoredShape,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plannable: Option<Plannable>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub stored: StoredShape,
    #[serde(default)]
    pub plannable: Option<Plannable>,
    pub prompt_spec: String,
    #[serde(default)]
    pub rules_spec: Option<String>,
    pub params_spec: String,
    /// Each size key and its value at rungs 1..=5.
    pub params: Map<String, Value>,
    pub corrective_spec: String,
    #[serde(default)]
    pub escalation_spec: Option<String>,
    pub fixtures: Fixtures,
}

/// The mock's examples, per scenario. `{item}` is the word a want is about,
/// `{other}` a second word for a type that needs two.
#[derive(Debug, Deserialize)]
pub struct Fixtures {
    pub spanish: Vec<Value>,
    pub mandarin: Vec<Value>,
}

impl WireType {
    /// Registry order: the planner's tie-break order, and the escalation gloss order.
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

    fn source(self) -> &'static str {
        match self {
            WireType::RecognizeMc => include_str!("../lessons/recognize-mc.json"),
            WireType::ProduceMc => include_str!("../lessons/produce-mc.json"),
            WireType::ContextMc => include_str!("../lessons/context-mc.json"),
            WireType::TranslateToNative => include_str!("../lessons/translate-to-native.json"),
            WireType::SpotError => include_str!("../lessons/spot-error.json"),
            WireType::WordOrder => include_str!("../lessons/word-order.json"),
            WireType::Cloze => include_str!("../lessons/cloze.json"),
            WireType::MultiCloze => include_str!("../lessons/multi-cloze.json"),
            WireType::TranslateToTarget => include_str!("../lessons/translate-to-target.json"),
        }
    }

    pub fn spec(self) -> &'static Spec {
        static SPECS: OnceLock<Vec<Spec>> = OnceLock::new();
        let specs = SPECS.get_or_init(|| {
            WireType::ALL
                .iter()
                .map(|kind| serde_json::from_str(kind.source()).expect("a lesson spec"))
                .collect()
        });
        &specs[WireType::ALL
            .iter()
            .position(|k| *k == self)
            .expect("listed")]
    }

    /// The sizes one challenge is written at, for a rung clamped to 1..=5.
    pub fn params(self, rung: u8) -> Map<String, Value> {
        let at = usize::from(rung.clamp(1, 5) - 1);
        self.spec()
            .params
            .iter()
            .map(|(key, ladder)| (key.clone(), ladder[at].clone()))
            .collect()
    }

    pub fn info(self) -> KindInfo {
        let spec = self.spec();
        KindInfo {
            kind: self,
            stored: spec.stored.clone(),
            plannable: spec.plannable.clone(),
        }
    }
}

/// The wire type a stored challenge was written as; `None` for a match-pairs round.
pub fn kind_of(challenge: &Value) -> Option<WireType> {
    let prompt_is_target = challenge["promptIsTarget"].as_bool().unwrap_or(false);
    WireType::ALL.into_iter().find(|kind| {
        let stored = &kind.spec().stored;
        challenge["type"] == stored.kind.as_str()
            && challenge["direction"] == stored.direction.as_str()
            && stored.prompt_is_target.unwrap_or(false) == prompt_is_target
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_spec_parses_with_five_rungs_that_never_fall() {
        for kind in WireType::ALL {
            let spec = kind.spec();
            assert!(!spec.params.is_empty(), "{kind:?}");
            for (key, ladder) in &spec.params {
                let ladder: Vec<u64> = ladder
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap())
                    .collect();
                assert_eq!(ladder.len(), 5, "{kind:?} {key}");
                assert!(ladder.windows(2).all(|w| w[0] <= w[1]), "{kind:?} {key}");
                assert!(
                    spec.params_spec.contains(&format!("{key}:")),
                    "{kind:?} {key}"
                );
            }
            assert!(!spec.fixtures.spanish.is_empty() && !spec.fixtures.mandarin.is_empty());
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                json!(kind.as_str()),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn only_the_retired_type_is_unplannable() {
        let unplanned: Vec<WireType> = WireType::ALL
            .into_iter()
            .filter(|kind| kind.spec().plannable.is_none())
            .collect();
        assert_eq!(unplanned, [WireType::TranslateToTarget]);
    }

    #[test]
    fn a_stored_row_reads_back_as_its_kind() {
        let mc = |direction: &str, target: Option<bool>| {
            let mut row = json!({ "type": "multiple-choice", "direction": direction });
            if let Some(target) = target {
                row["promptIsTarget"] = json!(target);
            }
            kind_of(&row)
        };
        assert_eq!(mc("toNative", None), Some(WireType::RecognizeMc));
        assert_eq!(mc("toTarget", None), Some(WireType::ProduceMc));
        assert_eq!(mc("toTarget", Some(true)), Some(WireType::ContextMc));
        assert_eq!(
            kind_of(&json!({ "type": "typed-translation", "direction": "toTarget" })),
            Some(WireType::TranslateToTarget)
        );
        assert_eq!(
            kind_of(&json!({ "type": "match-pairs", "direction": "toTarget" })),
            None
        );
    }

    #[test]
    fn params_pick_the_rung() {
        assert_eq!(
            WireType::MultiCloze.params(4),
            json!({ "words": 14, "gaps": 3 })
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(WireType::Cloze.params(9)["words"], 11);
    }
}
