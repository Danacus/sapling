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

pub use client::{
    ChatRequest, Completion, Endpoint, ErrorKind, HttpRequest, HttpResponse, Llm, LlmError,
    Message, ProgressStep, ProgressStepId, Result, TokenUsage, Tool, ToolCall, Transport,
};

/// The most of the learner's self-description any prompt carries.
pub const MAX_ABOUT_CHARS: usize = 500;

/// What every prompt knows about the learner. A full `Profile` reads as one.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LearnerProfile {
    pub native_language: String,
    pub target_language: String,
    pub level: Level,
    pub interests: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub about: Option<String>,
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
