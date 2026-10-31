//! Meanings for a handful of words at once: what "Add words" on a stored text
//! asks for the words the learner ticked, each with the sentence it stands in.
//!
//! One call for many words, where a reader's lookup is one call for one word
//! with an explanation besides (`reading.rs`). Meanings only: **a reading is
//! the frontend's**, derived from the text where the word is shown, so the
//! model is not asked for one.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::client::{ChatRequest, ErrorKind, Llm, LlmError, Message, Result, Transport};
use crate::json::{fenced, fill, parse_reply, strict_schema};
use crate::{non_blank, LearnerProfile};

/// The most words one call asks about; a caller with more makes more calls.
pub const MAX_GLOSS_WORDS: usize = 60;

/// The most of a sentence sent for context.
const MAX_SENTENCE_CHARS: usize = 200;

const GLOSS_PROMPT: &str = include_str!("../prompts/gloss.txt");
const GLOSS_FIXTURE: &str = include_str!("../fixtures/gloss.json");

#[derive(Debug, Clone, Deserialize, TS)]
pub struct GlossTerm {
    /// Exactly as the text spells it.
    pub term: String,
    /// The sentence it stands in, which picks the sense.
    #[serde(default)]
    #[ts(optional)]
    pub sentence: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct GlossWordsArgs {
    pub profile: LearnerProfile,
    pub words: Vec<GlossTerm>,
}

/// A meaning for one asked word. Never stored as such: the page puts it in the
/// word's row and `add_words` files it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct GlossedWord {
    /// Exactly as asked.
    pub term: String,
    pub meaning: String,
}

#[derive(Deserialize, JsonSchema)]
struct GlossReply {
    words: Vec<GlossEntryReply>,
}

#[derive(Deserialize, JsonSchema)]
struct GlossEntryReply {
    term: String,
    meaning: String,
}

#[derive(Serialize)]
struct GlossPayload<'a> {
    native: &'a str,
    target: &'a str,
    words: Vec<Value>,
}

fn bad(message: impl Into<String>) -> LlmError {
    LlmError::new(ErrorKind::BadResponse, message)
}

pub fn gloss_request(args: &GlossWordsArgs) -> ChatRequest {
    let payload = GlossPayload {
        native: &args.profile.native_language,
        target: &args.profile.target_language,
        words: args
            .words
            .iter()
            .take(MAX_GLOSS_WORDS)
            .map(|word| match non_blank(word.sentence.as_deref()) {
                Some(sentence) => serde_json::json!({
                    "term": word.term.trim(),
                    "sentence": crate::truncated(sentence, MAX_SENTENCE_CHARS),
                }),
                None => serde_json::json!({ "term": word.term.trim() }),
            })
            .collect(),
    };
    ChatRequest {
        messages: vec![
            Message::System(GLOSS_PROMPT.trim_end().to_owned()),
            Message::User(serde_json::to_string(&payload).expect("a payload serializes")),
        ],
        schema: Some(("gloss".to_owned(), strict_schema::<GlossReply>())),
        temperature: Some(0.2),
        ..ChatRequest::default()
    }
}

/// The answers matched back to the words asked, by spelling. An answer for a
/// word nobody asked about, or with no meaning, is dropped; so is a second
/// answer for the same word. Only no usable answer at all is an error.
pub fn parse_gloss(raw: &str, asked: &[GlossTerm]) -> Result<Vec<GlossedWord>> {
    let unusable = || bad("The model did not give those words a meaning. Try again.");
    let reply: GlossReply = parse_reply(raw).ok_or_else(unusable)?;
    let key = |term: &str| term.trim().to_lowercase();
    let mut wanted: HashMap<String, &str> = asked
        .iter()
        .take(MAX_GLOSS_WORDS)
        .map(|word| (key(&word.term), word.term.trim()))
        .collect();
    let glossed: Vec<GlossedWord> = reply
        .words
        .into_iter()
        .filter_map(|entry| {
            let meaning = entry.meaning.trim();
            if meaning.is_empty() {
                return None;
            }
            let term = wanted.remove(&key(&entry.term))?;
            Some(GlossedWord {
                term: term.to_owned(),
                meaning: meaning.to_owned(),
            })
        })
        .collect();
    if glossed.is_empty() {
        return Err(unusable());
    }
    Ok(glossed)
}

fn mock_gloss(args: &GlossWordsArgs) -> String {
    let template: Value = serde_json::from_str(GLOSS_FIXTURE).expect("a fixture is JSON");
    let words: Vec<Value> = args
        .words
        .iter()
        .take(MAX_GLOSS_WORDS)
        .map(|word| {
            let mut entry = template.clone();
            fill(&mut entry, &[("term", word.term.trim())]);
            entry
        })
        .collect();
    fenced(&serde_json::json!({ "words": words }))
}

/// Meanings for the words given. No words, no call.
pub async fn gloss_words<T: Transport>(
    llm: &Llm<T>,
    args: &GlossWordsArgs,
) -> Result<Vec<GlossedWord>> {
    if args.words.iter().all(|word| word.term.trim().is_empty()) {
        return Ok(Vec::new());
    }
    let completion = llm
        .complete_or_mock(&gloss_request(args), || mock_gloss(args))
        .await?;
    parse_gloss(&completion.content, &args.words)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, Fake};
    use pollster::block_on;
    use serde_json::json;

    fn profile(target: &str) -> LearnerProfile {
        LearnerProfile {
            native_language: "English".into(),
            target_language: target.into(),
            about: None,
        }
    }

    fn term(term: &str, sentence: Option<&str>) -> GlossTerm {
        GlossTerm {
            term: term.into(),
            sentence: sentence.map(str::to_owned),
        }
    }

    #[test]
    fn glosses_match_back_by_spelling_and_drop_strays() {
        let asked = vec![term("café", None), term("Leche", None)];
        let raw = json!({ "words": [
            { "term": "leche", "meaning": " milk " },
            { "term": "café", "meaning": "coffee" },
            { "term": "café", "meaning": "again" },
            { "term": "té", "meaning": "tea" },
            { "term": "agua", "meaning": " " },
        ] })
        .to_string();
        assert_eq!(
            parse_gloss(&raw, &asked).unwrap(),
            [
                GlossedWord {
                    term: "Leche".into(),
                    meaning: "milk".into(),
                },
                GlossedWord {
                    term: "café".into(),
                    meaning: "coffee".into(),
                },
            ]
        );
        assert!(parse_gloss(r#"{"words":[]}"#, &asked).is_err());
    }

    #[test]
    fn the_payload_carries_each_sentence_capped_and_asks_for_no_reading() {
        let long = "长".repeat(300);
        let args = GlossWordsArgs {
            profile: profile("Chinese"),
            words: vec![term(" 长 ", Some(&long)), term("学生", Some(" "))],
        };
        let request = gloss_request(&args);
        let Message::User(text) = &request.messages[1] else {
            panic!("expected a user turn");
        };
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["words"][0]["term"], "长");
        assert_eq!(
            payload["words"][0]["sentence"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_SENTENCE_CHARS
        );
        assert_eq!(payload["words"][1], json!({ "term": "学生" }));
        let (_, schema) = request.schema.unwrap();
        assert_eq!(
            schema["properties"]["words"]["items"]["required"],
            json!(["term", "meaning"])
        );

        let fake = Fake::default();
        let glossed = block_on(gloss_words(&Llm::new(&fake, None), &args)).unwrap();
        assert_eq!(glossed[0].term, "长");
        assert_eq!(glossed[0].meaning, "(meaning of \"长\")");
    }

    #[test]
    fn no_words_is_no_call() {
        let fake = Fake::default();
        let args = GlossWordsArgs {
            profile: profile("Dutch"),
            words: vec![],
        };
        assert!(block_on(gloss_words(&live(&fake), &args))
            .unwrap()
            .is_empty());
    }
}
