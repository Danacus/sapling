//! Compile-time registry for challenge-type plugins.

use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_domain::types::Verdict;

use crate::grade::GapVerdict;
use crate::help::{HelpLevel, Step};
use crate::rng::Rng;

pub mod cloze;
pub mod cue_cloze;
pub mod match_pairs;
pub mod multi_cloze;
pub mod multiple_choice;
pub mod spot_error;
#[cfg(test)]
mod tests;
pub mod typed_translation;
pub mod word_order;

pub use cloze::{ClozeAnswer, ClozeChallenge, ClozeScreen, ClozeTag};
pub use cue_cloze::{CueClozeAnswer, CueClozeChallenge, CueClozeScreen, CueClozeTag, CueRef};
pub use match_pairs::{
    MatchPair, MatchPairsAnswer, MatchPairsChallenge, MatchPairsScreen, MatchPairsTag,
};
pub use multi_cloze::{
    MultiClozeAnswer, MultiClozeChallenge, MultiClozeGap, MultiClozeScreen, MultiClozeTag,
};
pub use multiple_choice::{
    MultipleChoiceAnswer, MultipleChoiceChallenge, MultipleChoiceScreen, MultipleChoiceTag,
};
pub use spot_error::{SpotErrorAnswer, SpotErrorChallenge, SpotErrorScreen, SpotErrorTag};
pub use typed_translation::{
    TypedTranslationAnswer, TypedTranslationChallenge, TypedTranslationScreen, TypedTranslationTag,
};
pub use word_order::{WordOrderAnswer, WordOrderChallenge, WordOrderScreen, WordOrderTag};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    ToTarget,
    ToNative,
}

/// The common view generic challenge code is allowed to use.
#[derive(Debug, Clone, Copy)]
pub struct Common<'a> {
    pub id: &'a str,
    pub direction: Direction,
    pub item_ids: &'a [String],
    pub explanation: Option<&'a str>,
    pub asked_length: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Feedback {
    pub correct_answer_text: String,
    pub answer_is_target_language: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_reading: Option<String>,
    pub spoken_answer: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Graded {
    pub verdict: Verdict,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub closest_accepted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item_verdicts: Option<Vec<GapVerdict>>,
    pub feedback: Feedback,
    pub logged: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Served {
    pub screen: ChallengeScreen,
    pub audio: Vec<String>,
    pub shown: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeTypeInfo {
    #[serde(rename = "type")]
    pub tag: String,
    pub reviews: bool,
    pub pooled: bool,
}

pub trait ChallengePlugin: 'static {
    const TAG: &'static str;
    const REVIEWS: bool;
    const POOLED: bool;

    type Stored: Serialize + DeserializeOwned + TS + Clone;
    type Screen: Serialize + TS + Clone;
    type Answer: Serialize + DeserializeOwned + TS + Clone;

    fn common(row: &Self::Stored) -> Common<'_>;
    fn set_asked_length(row: &mut Self::Stored, length: f64);
    fn check_shape(row: &Self::Stored) -> Result<(), String>;
    fn steps(row: &Self::Stored) -> Vec<Step>;
    fn has_readings(row: &Self::Stored) -> bool;
    fn can_listen(_row: &Self::Stored) -> bool {
        false
    }
    fn screen(row: &Self::Stored, at: HelpLevel) -> Self::Screen;
    fn audio_texts(row: &Self::Stored) -> Vec<String>;
    fn grade(row: &Self::Stored, at: HelpLevel, answer: &Self::Answer) -> Graded;
    fn correct_answer(row: &Self::Stored, at: HelpLevel) -> Self::Answer;
    fn measure(row: &Self::Stored) -> f64;
    fn example(
        _kind: &crate::kinds::ChallengeKind,
        _items: &[&str],
        _length: u8,
        _rng: &mut Rng,
    ) -> Option<Self::Stored> {
        None
    }
}

macro_rules! challenge_types {
    ($(($module:ident, $plugin:ident, $variant:ident, $stored:ident, $screen:ident, $answer:ident, $tag:literal)),+ $(,)?) => {
        #[derive(Debug, Clone, PartialEq, Serialize, TS)]
        #[serde(untagged)]
        pub enum Challenge { $( $variant($stored), )+ }

        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
        #[serde(tag = "type", content = "screen")]
        pub enum ChallengeScreen { $( #[serde(rename = $tag)] $variant($screen), )+ }

        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
        #[serde(tag = "type", content = "answer")]
        pub enum ChallengeAnswer { $( #[serde(rename = $tag)] $variant($answer), )+ }

        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum ChallengeType { $( $variant, )+ }

        impl ChallengeType {
            pub const ALL: &'static [ChallengeType] = &[$(ChallengeType::$variant),+];
            pub const fn as_str(self) -> &'static str { match self { $(Self::$variant => $tag),+ } }
            pub fn parse(name: &str) -> Option<Self> { Self::ALL.iter().copied().find(|kind| kind.as_str() == name) }
            pub fn info(self) -> ChallengeTypeInfo {
                match self { $(Self::$variant => ChallengeTypeInfo { tag: $tag.to_owned(), reviews: $module::$plugin::REVIEWS, pooled: $module::$plugin::POOLED }),+ }
            }
        }

        pub const STORED_TYPES: &[&str] = &[$($tag),+];

        impl Challenge {
            pub fn from_value(value: Value) -> Result<Self, String> {
                let name = value.get("type").and_then(Value::as_str)
                    .ok_or("a challenge needs a string `type`")?.to_owned();
                match name.as_str() {
                    $($tag => serde_json::from_value(value).map(Self::$variant).map_err(|e| format!("{name}: {e}")),)+
                    _ => Err(format!("unknown challenge type {name}")),
                }
            }
            pub fn kind(&self) -> ChallengeType { match self { $(Self::$variant(_) => ChallengeType::$variant),+ } }
            pub fn common(&self) -> Common<'_> { match self { $(Self::$variant(row) => $module::$plugin::common(row)),+ } }
            pub fn id(&self) -> &str { self.common().id }
            pub fn direction(&self) -> Direction { self.common().direction }
            pub fn item_ids(&self) -> &[String] { self.common().item_ids }
            pub fn explanation(&self) -> Option<&str> { self.common().explanation }
            pub fn asked_length(&self) -> Option<f64> { self.common().asked_length }
            pub fn set_asked_length(&mut self, length: f64) { match self { $(Self::$variant(row) => $module::$plugin::set_asked_length(row, length)),+ } }
            pub fn check_shape(&self) -> Result<(), String> { match self { $(Self::$variant(row) => $module::$plugin::check_shape(row)),+ } }
            pub fn steps(&self) -> Vec<Step> { match self { $(Self::$variant(row) => $module::$plugin::steps(row)),+ } }
            pub fn has_readings(&self) -> bool { match self { $(Self::$variant(row) => $module::$plugin::has_readings(row)),+ } }
            pub fn can_listen(&self) -> bool { match self { $(Self::$variant(row) => $module::$plugin::can_listen(row)),+ } }
            pub fn screen(&self, at: HelpLevel) -> ChallengeScreen { match self { $(Self::$variant(row) => ChallengeScreen::$variant($module::$plugin::screen(row, at))),+ } }
            pub fn audio_texts(&self) -> Vec<String> { match self { $(Self::$variant(row) => $module::$plugin::audio_texts(row)),+ } }
            pub fn correct_answer(&self, at: HelpLevel) -> ChallengeAnswer { match self { $(Self::$variant(row) => ChallengeAnswer::$variant($module::$plugin::correct_answer(row, at))),+ } }
            pub fn grade(&self, at: HelpLevel, answer: &ChallengeAnswer) -> Result<Graded, String> {
                match (self, answer) {
                    $((Self::$variant(row), ChallengeAnswer::$variant(answer)) => Ok($module::$plugin::grade(row, at, answer)),)+
                    _ => Err(format!("answer type does not match {}", self.kind().as_str())),
                }
            }
            pub fn measure(&self) -> f64 { match self { $(Self::$variant(row) => $module::$plugin::measure(row)),+ } }
            pub fn reviews(&self) -> bool { match self { $(Self::$variant(_) => $module::$plugin::REVIEWS),+ } }
            pub fn pooled(&self) -> bool { match self { $(Self::$variant(_) => $module::$plugin::POOLED),+ } }
            pub fn serve(&self, at: HelpLevel) -> Served {
                Served { screen: self.screen(at), audio: self.audio_texts(), shown: at.id() }
            }
            pub fn prompt_is_target(&self) -> bool {
                match self { Self::MultipleChoice(row) => row.prompt_is_target == Some(true), _ => false }
            }
        }

        impl<'de> Deserialize<'de> for Challenge {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
            }
        }
    };
}

challenge_types! {
    (multiple_choice, MultipleChoice, MultipleChoice, MultipleChoiceChallenge, MultipleChoiceScreen, MultipleChoiceAnswer, "multiple-choice"),
    (cloze, Cloze, Cloze, ClozeChallenge, ClozeScreen, ClozeAnswer, "cloze"),
    (typed_translation, TypedTranslation, TypedTranslation, TypedTranslationChallenge, TypedTranslationScreen, TypedTranslationAnswer, "typed-translation"),
    (match_pairs, MatchPairs, MatchPairs, MatchPairsChallenge, MatchPairsScreen, MatchPairsAnswer, "match-pairs"),
    (multi_cloze, MultiCloze, MultiCloze, MultiClozeChallenge, MultiClozeScreen, MultiClozeAnswer, "multi-cloze"),
    (word_order, WordOrder, WordOrder, WordOrderChallenge, WordOrderScreen, WordOrderAnswer, "word-order"),
    (spot_error, SpotError, SpotError, SpotErrorChallenge, SpotErrorScreen, SpotErrorAnswer, "spot-error"),
    (cue_cloze, CueCloze, CueCloze, CueClozeChallenge, CueClozeScreen, CueClozeAnswer, "cue-cloze"),
}

pub(crate) fn filled_common(common: Common<'_>, tag: &str) -> Result<(), String> {
    if common.id.is_empty() || common.item_ids.iter().any(String::is_empty) {
        Err(format!("{tag}: an id and every item id must be filled in"))
    } else {
        Ok(())
    }
}

pub(crate) fn some(value: &Option<String>) -> bool {
    value
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
}

pub(crate) fn any(value: &Option<Vec<String>>) -> bool {
    value
        .as_deref()
        .is_some_and(|values| values.iter().any(|value| !value.trim().is_empty()))
}

pub(crate) fn exact(hit: bool) -> Verdict {
    if hit {
        Verdict::Correct
    } else {
        Verdict::Wrong
    }
}

pub(crate) fn unique_nonempty(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

/// Per-plugin data sources, in registry order.
pub(crate) const TYPE_SOURCES: &[&str] = &[
    multiple_choice::TYPE_JSON,
    cloze::TYPE_JSON,
    typed_translation::TYPE_JSON,
    match_pairs::TYPE_JSON,
    multi_cloze::TYPE_JSON,
    word_order::TYPE_JSON,
    spot_error::TYPE_JSON,
    cue_cloze::TYPE_JSON,
];

pub fn lesson_source(id: &str) -> Option<&'static str> {
    multiple_choice::LESSONS
        .iter()
        .chain(cloze::LESSONS)
        .chain(typed_translation::LESSONS)
        .chain(match_pairs::LESSONS)
        .chain(multi_cloze::LESSONS)
        .chain(word_order::LESSONS)
        .chain(spot_error::LESSONS)
        .chain(cue_cloze::LESSONS)
        .find_map(|(kind, source)| (*kind == id).then_some(*source))
}
