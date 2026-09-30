//! What the model is told about each wire type — its field list, rules, the
//! key its length travels under, retry line, escalation gloss — and the mock's
//! examples, in `lessons/<type>.json`. The kinds themselves (stored shape,
//! length range) are `sapling-challenges`'.

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
    /// The key a want's length travels under in the item: `words`, or `tiles`.
    pub length: String,
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
    /// The sizes one challenge is written at: its length under the type's
    /// key, and for a multi-cloze the gaps that length carries.
    fn params(self, length: u8) -> Map<String, Value>;
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

    fn params(self, length: u8) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert(self.spec().length.clone(), Value::from(length));
        if self == WireType::MultiCloze {
            params.insert("gaps".into(), Value::from(gaps_for(length)));
        }
        params
    }
}

/// A multi-cloze passage's gaps for its length: two up to eleven words, three
/// up to fifteen, four beyond — a gap every four or five words, as the old
/// rung table paired them (8–10 words with two, 14 with three, 18 with four).
pub fn gaps_for(length: u8) -> u8 {
    match length {
        0..=11 => 2,
        12..=15 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_spec_parses_and_names_its_length_key() {
        for kind in WireType::ALL {
            let spec = kind.spec();
            assert!(
                spec.params_spec.contains(&format!("{}:", spec.length)),
                "{kind:?}"
            );
            assert!(!spec.fixtures.spanish.is_empty() && !spec.fixtures.mandarin.is_empty());
        }
    }

    #[test]
    fn params_carry_the_length_and_a_multi_clozes_gaps() {
        assert_eq!(
            WireType::MultiCloze.params(14),
            json!({ "words": 14, "gaps": 3 })
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(WireType::Cloze.params(9)["words"], 9);
        assert_eq!(WireType::WordOrder.params(5)["tiles"], 5);
        assert_eq!((gaps_for(8), gaps_for(18)), (2, 4));
        // Every gap count a multi-cloze's length range can ask for is one the
        // resolver accepts (2 to 4).
        let [shortest, longest] = WireType::MultiCloze.lengths().unwrap();
        for length in shortest..=longest {
            assert!((2..=4).contains(&gaps_for(length)));
        }
    }
}
