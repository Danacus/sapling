//! Sapling's model calls. Rust owns the prompts (data files under `prompts/`
//! and `lessons/`), the reply schemas, parsing and mock mode (fixtures sent
//! through the same parsers); the HTTP POST is a [`Transport`] the host injects.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_domain::types::Level;

pub mod chat;
pub mod client;
pub mod conversation;
pub mod escalation;
pub mod json;
pub mod kinds;
pub mod lesson;
pub mod reading;
pub mod text;
pub mod tools;
pub mod wire;
pub mod word_batch;

pub use client::{
    ChatRequest, Completion, Endpoint, ErrorKind, HttpRequest, HttpResponse, Llm, LlmError,
    Message, ProgressStep, ProgressStepId, Result, TokenUsage, Tool, ToolCall, Transport,
};

/// The most of the learner's self-description any prompt carries.
pub const MAX_ABOUT_CHARS: usize = 500;

/// What every prompt knows about the learner. A full `Profile` reads as one.
///
/// No level and no interests: a stored profile still carries both for old
/// builds, but neither reaches a prompt. The level a prompt is pitched at is
/// [`level_for`] the learner's library, and `about` personalises better than a
/// list of topics ever did.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LearnerProfile {
    pub native_language: String,
    pub target_language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub about: Option<String>,
}

/// Below this many words in the library, a learner is a beginner.
pub const ELEMENTARY_WORDS: usize = 150;
/// Below this many, elementary.
pub const INTERMEDIATE_WORDS: usize = 600;
/// Below this many, intermediate; from here on, advanced.
pub const ADVANCED_WORDS: usize = 2000;

/// The level a prompt is pitched at, read off how many words the learner's
/// library holds rather than asked for: a self-assessed level was a guess made
/// once on day one, while the library grows with the learner and every device
/// derives the same answer from it. Sentence length, register and reply length
/// follow it; the length a challenge is written at never does (that is the
/// difficulty model's, from answers).
pub fn level_for(word_count: usize) -> Level {
    match word_count {
        n if n < ELEMENTARY_WORDS => Level::Beginner,
        n if n < INTERMEDIATE_WORDS => Level::Elementary,
        n if n < ADVANCED_WORDS => Level::Intermediate,
        _ => Level::Advanced,
    }
}

/// At most `max` characters.
pub(crate) fn truncated(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub(crate) fn non_blank(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

/// Whether the mock writes its Mandarin fixtures rather than its Spanish ones.
pub(crate) fn is_mandarin(language: &str) -> bool {
    let language = language.trim().to_lowercase();
    language == "zh"
        || language.starts_with("zh-")
        || language.contains("chinese")
        || language.contains("mandarin")
        || language.contains("中文")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_level_is_read_off_the_library_at_each_threshold() {
        assert_eq!(level_for(0), Level::Beginner);
        assert_eq!(level_for(ELEMENTARY_WORDS - 1), Level::Beginner);
        assert_eq!(level_for(ELEMENTARY_WORDS), Level::Elementary);
        assert_eq!(level_for(INTERMEDIATE_WORDS - 1), Level::Elementary);
        assert_eq!(level_for(INTERMEDIATE_WORDS), Level::Intermediate);
        assert_eq!(level_for(ADVANCED_WORDS - 1), Level::Intermediate);
        assert_eq!(level_for(ADVANCED_WORDS), Level::Advanced);
        assert_eq!(level_for(usize::MAX), Level::Advanced);
    }

    #[test]
    fn a_full_profile_reads_as_a_learner_profile_without_its_level_or_interests() {
        let profile: LearnerProfile = serde_json::from_str(
            r#"{"nativeLanguage":"English","targetLanguage":"Spanish","level":"advanced","interests":["food"],"model":"m","createdAt":1}"#,
        )
        .unwrap();
        let back = serde_json::to_value(&profile).unwrap();
        assert_eq!(
            back,
            serde_json::json!({ "nativeLanguage": "English", "targetLanguage": "Spanish" })
        );
    }
}
