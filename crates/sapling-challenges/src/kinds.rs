//! Rank-ordered generic view over every plugin's `type.json` kinds.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::help::Step;
use crate::types::TYPE_SOURCES;
use crate::{Challenge, Direction};

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
    TranslateToTarget,
    CueCloze,
}

impl WireType {
    pub const ALL: [WireType; 10] = [
        Self::RecognizeMc,
        Self::ProduceMc,
        Self::ContextMc,
        Self::TranslateToNative,
        Self::SpotError,
        Self::WordOrder,
        Self::Cloze,
        Self::MultiCloze,
        Self::TranslateToTarget,
        Self::CueCloze,
    ];
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RecognizeMc => "recognize-mc",
            Self::ProduceMc => "produce-mc",
            Self::ContextMc => "context-mc",
            Self::TranslateToNative => "translate-to-native",
            Self::SpotError => "spot-error",
            Self::WordOrder => "word-order",
            Self::Cloze => "cloze",
            Self::MultiCloze => "multi-cloze",
            Self::TranslateToTarget => "translate-to-target",
            Self::CueCloze => "cue-cloze",
        }
    }
    pub fn kind_spec(self) -> &'static KindSpec {
        specs()
            .iter()
            .find(|spec| spec.kind == self)
            .expect("every wire type is registered")
    }
    pub fn stored(self) -> &'static StoredShape {
        &self.kind_spec().stored
    }
    pub fn lengths(self) -> Option<[u8; 2]> {
        self.kind_spec().lengths
    }
    pub fn is_active(self) -> bool {
        self.lengths().is_some()
    }
    /// Built on this device from the learner's own material (`local.rs`): no
    /// lesson file, never sent to the model, and never assumed writable.
    pub fn is_local(self) -> bool {
        self.kind_spec().local
    }
    pub fn written_steps(self) -> Vec<Step> {
        self.kind_spec()
            .written_steps
            .iter()
            .map(|step| Step::parse(step).expect("a declared step"))
            .collect()
    }
    pub fn can_listen(self) -> bool {
        self.kind_spec().can_listen
    }
    pub fn base(self, step: Step) -> Option<f64> {
        self.kind_spec().bases.get(step.as_str()).copied()
    }
    pub fn slope(self) -> f64 {
        self.kind_spec().slope
    }
    /// The kind whose learned numbers this one starts from until its own
    /// answers move them.
    pub fn starts_from(self) -> Option<WireType> {
        self.kind_spec().starts_from
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredShape {
    pub kind: String,
    pub direction: Direction,
    pub prompt_is_target: bool,
}

#[derive(Debug)]
pub struct KindSpec {
    pub kind: WireType,
    pub rank: u8,
    pub stored: StoredShape,
    pub lengths: Option<[u8; 2]>,
    pub written_steps: Vec<String>,
    pub can_listen: bool,
    pub bases: BTreeMap<String, f64>,
    pub slope: f64,
    pub local: bool,
    pub starts_from: Option<WireType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeData {
    steps: Vec<String>,
    kinds: Vec<KindData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KindData {
    id: WireType,
    rank: u8,
    direction: Direction,
    #[serde(default)]
    prompt_is_target: bool,
    #[serde(default)]
    lengths: Option<[u8; 2]>,
    written_steps: Vec<String>,
    can_listen: bool,
    bases: BTreeMap<String, f64>,
    slope: f64,
    #[serde(default)]
    local: bool,
    #[serde(default)]
    starts_from: Option<WireType>,
}

fn specs() -> &'static [KindSpec] {
    static SPECS: OnceLock<Vec<KindSpec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let mut all = Vec::new();
        for (source, challenge_type) in TYPE_SOURCES.iter().zip(crate::ChallengeType::ALL) {
            let data: TypeData = serde_json::from_str(source).expect("a plugin type.json");
            for kind in data.kinds {
                assert!(
                    kind.written_steps
                        .iter()
                        .all(|step| data.steps.contains(step)),
                    "a kind may list only declared steps"
                );
                all.push(KindSpec {
                    kind: kind.id,
                    rank: kind.rank,
                    stored: StoredShape {
                        kind: challenge_type.as_str().to_owned(),
                        direction: kind.direction,
                        prompt_is_target: kind.prompt_is_target,
                    },
                    lengths: kind.lengths,
                    written_steps: kind.written_steps,
                    can_listen: kind.can_listen,
                    bases: kind.bases,
                    slope: kind.slope,
                    local: kind.local,
                    starts_from: kind.starts_from,
                });
            }
        }
        all.sort_by_key(|kind| kind.rank);
        for (index, kind) in all.iter().enumerate() {
            assert_eq!(
                kind.rank as usize,
                index + 1,
                "kind ranks must be unique and contiguous"
            );
        }
        assert_eq!(
            all.iter().map(|kind| kind.kind).collect::<Vec<_>>(),
            WireType::ALL
        );
        all
    })
}

pub fn active_kinds() -> impl Iterator<Item = WireType> {
    WireType::ALL.into_iter().filter(|kind| kind.is_active())
}

/// The kinds the model writes: every kind with a lesson file.
pub fn llm_kinds() -> impl Iterator<Item = WireType> {
    WireType::ALL.into_iter().filter(|kind| !kind.is_local())
}

pub fn kind_of(challenge: &Challenge) -> Option<WireType> {
    WireType::ALL.into_iter().find(|kind| {
        let stored = kind.stored();
        stored.kind == challenge.kind().as_str()
            && stored.direction == challenge.direction()
            && stored.prompt_is_target == challenge.prompt_is_target()
    })
}

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Want {
    pub item: WantItem,
    pub kind: ChallengeKind,
    pub length: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_data_has_every_kind_in_rank_order() {
        assert_eq!(
            specs().iter().map(|spec| spec.kind).collect::<Vec<_>>(),
            WireType::ALL
        );
        assert_eq!(
            WireType::ALL
                .into_iter()
                .filter(|kind| !kind.is_active())
                .collect::<Vec<_>>(),
            [WireType::TranslateToTarget]
        );
        assert_eq!(
            WireType::ALL
                .into_iter()
                .filter(|kind| kind.is_local())
                .collect::<Vec<_>>(),
            [WireType::CueCloze]
        );
        for kind in active_kinds() {
            let [shortest, longest] = kind.lengths().unwrap();
            assert!(shortest > 0 && shortest <= longest);
            assert!(!kind.written_steps().is_empty());
        }
    }
}
