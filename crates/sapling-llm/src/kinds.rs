//! What the model is told about each wire type — its field list, rules, sizes,
//! retry line, escalation gloss — and the mock's examples, in
//! `lessons/<type>.json`. The kinds themselves (stored shape, demand, rungs)
//! are `sapling-challenges`'.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value};

pub use sapling_challenges::kinds::{kind_of, WireType};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub prompt_spec: String,
    #[serde(default)]
    pub rules_spec: Option<String>,
    pub params_spec: String,
    /// Each size key and its value at rungs 1..5.
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

fn source(kind: WireType) -> &'static str {
    match kind {
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

/// A wire type's lesson spec.
pub trait Lesson {
    fn spec(self) -> &'static Spec;
    /// The sizes one challenge is written at, for a rung clamped to 1..=5.
    fn params(self, rung: u8) -> Map<String, Value>;
}

impl Lesson for WireType {
    fn spec(self) -> &'static Spec {
        static SPECS: OnceLock<Vec<Spec>> = OnceLock::new();
        let specs = SPECS.get_or_init(|| {
            WireType::ALL
                .iter()
                .map(|kind| serde_json::from_str(source(*kind)).expect("a lesson spec"))
                .collect()
        });
        &specs[WireType::ALL
            .iter()
            .position(|k| *k == self)
            .expect("listed")]
    }

    fn params(self, rung: u8) -> Map<String, Value> {
        let at = usize::from(rung.clamp(1, 5) - 1);
        self.spec()
            .params
            .iter()
            .map(|(key, ladder)| (key.clone(), ladder[at].clone()))
            .collect()
    }
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
        }
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
