//! Sapling's model calls. Rust owns the prompts (data files under `prompts/`),
//! the reply schemas, parsing and mock mode (fixtures under `fixtures/`, sent
//! through the same parsers); the HTTP POST is a [`Transport`] the host injects.

#![forbid(unsafe_code)]

use serde::Deserialize;
use ts_rs::TS;

use sapling_domain::types::Level;

pub mod client;
pub mod json;
pub mod reading;

pub use client::{
    ChatRequest, Completion, Endpoint, ErrorKind, HttpRequest, HttpResponse, Llm, LlmError,
    Message, Result, TokenUsage, Tool, ToolCall, Transport,
};

pub const MAX_ABOUT_CHARS: usize = 500;

/// What every prompt knows about the learner. A full `Profile` reads as one.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LearnerProfile {
    pub native_language: String,
    pub target_language: String,
    pub level: Level,
    pub interests: Vec<String>,
    #[serde(default)]
    #[ts(optional)]
    pub about: Option<String>,
}

/// At most `max` characters.
pub(crate) fn truncated(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
