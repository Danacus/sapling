//! A grid of words for the "Check what you know" screen: the learner taps the
//! ones they recognise and those become ordinary fresh cards (`add_words`, the
//! host's call). Deliberately dumb: no frequency ranks, no estimate of a
//! vocabulary size, nothing stored. The model is asked for everyday words a
//! step harder, the same or a step easier than the ones it last listed, and the
//! host decides the step from how many were tapped.
//!
//! The host also filters what comes back against the library and everything
//! already shown, and never trusts `recent` to have done it: the list is only
//! a hint that keeps most of a batch new, bounded so the prompt does not grow
//! with the run.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_domain::types::Level;

use crate::client::{ChatRequest, ErrorKind, Llm, LlmError, Message, Result, Transport};
use crate::json::{fenced, parse_reply, strict_schema};
use crate::reading::MAX_TOPIC_CHARS;
use crate::text::term_key;
use crate::{is_mandarin, level_for, non_blank, truncated, LearnerProfile, MAX_ABOUT_CHARS};

const PROMPT: &str = include_str!("../prompts/word-batch.txt");
const WORDS_ES: &str = include_str!("../fixtures/word-batch-es.json");
const WORDS_ZH: &str = include_str!("../fixtures/word-batch-zh.json");

/// The most words one batch asks for: a grid of twenty, with room for the
/// host's repeat filter to drop some.
pub const MAX_BATCH_WORDS: usize = 40;
/// The most already-shown terms a request carries, the latest ones: enough to
/// steer the model off the last two grids without the prompt growing per batch.
pub const MAX_RECENT_WORDS: usize = 60;
/// What a batch asks for when the host does not say.
const DEFAULT_COUNT: usize = 30;

/// What the grid is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum WordBatchMode {
    /// Everyday words, adapting to what the learner taps.
    Check,
    /// A dozen beginner words around one topic.
    Starter,
}

/// How hard the next check batch is, relative to the recent words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum CheckStep {
    /// The very most common words: the first batch.
    #[default]
    Start,
    Harder,
    Same,
    Easier,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WordBatchArgs {
    pub profile: LearnerProfile,
    /// How many words the learner's library holds ([`level_for`]).
    pub word_count: usize,
    pub mode: WordBatchMode,
    /// Check mode only; absent reads as [`CheckStep::Start`].
    #[serde(default)]
    #[ts(optional)]
    pub step: Option<CheckStep>,
    /// Starter mode only.
    #[serde(default)]
    #[ts(optional)]
    pub topic: Option<String>,
    /// How many words to ask for, clamped to 1..=[`MAX_BATCH_WORDS`].
    #[serde(default)]
    #[ts(optional)]
    pub count: Option<usize>,
    /// Terms already shown this run, oldest first; only the last
    /// [`MAX_RECENT_WORDS`] are sent.
    #[serde(default)]
    pub recent: Vec<String>,
}

/// One word in the grid. Never stored as such: a tapped one is handed to
/// `add_words` as it is.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct SuggestedWord {
    /// Dictionary form.
    pub term: String,
    /// In the native language.
    pub meaning: String,
    /// Latin reading; absent for Latin-script targets.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub romanization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct WordBatch {
    /// In the model's order, malformed entries and repeats within the reply
    /// dropped. The host's repeat filter is still the one that counts.
    pub words: Vec<SuggestedWord>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct ReplyWord {
    term: String,
    reading: Option<String>,
    meaning: String,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Reply {
    words: Vec<ReplyWord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    native: &'a str,
    target: &'a str,
    level: Level,
    mode: WordBatchMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<CheckStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    about: Option<String>,
    count: usize,
    // Last: it is what differs from one batch to the next.
    recent: Vec<&'a str>,
}

fn count_of(args: &WordBatchArgs) -> usize {
    args.count
        .unwrap_or(DEFAULT_COUNT)
        .clamp(1, MAX_BATCH_WORDS)
}

/// The last [`MAX_RECENT_WORDS`] non-blank terms, trimmed, in order.
fn recent_of(args: &WordBatchArgs) -> Vec<&str> {
    let terms: Vec<&str> = args
        .recent
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .collect();
    let skip = terms.len().saturating_sub(MAX_RECENT_WORDS);
    terms[skip..].to_vec()
}

pub fn word_batch_request(args: &WordBatchArgs) -> ChatRequest {
    let profile = &args.profile;
    let check = args.mode == WordBatchMode::Check;
    let payload = Payload {
        native: &profile.native_language,
        target: &profile.target_language,
        level: level_for(args.word_count),
        mode: args.mode,
        step: check.then(|| args.step.unwrap_or_default()),
        topic: (!check)
            .then(|| non_blank(args.topic.as_deref()))
            .flatten()
            .map(|topic| truncated(topic, MAX_TOPIC_CHARS)),
        about: non_blank(profile.about.as_deref()).map(|about| truncated(about, MAX_ABOUT_CHARS)),
        count: count_of(args),
        recent: recent_of(args),
    };
    ChatRequest {
        messages: vec![
            Message::System(PROMPT.trim_end().to_owned()),
            Message::User(serde_json::to_string(&payload).expect("a payload serializes")),
        ],
        schema: Some(("word_batch".to_owned(), strict_schema::<Reply>())),
        temperature: Some(0.7),
        ..ChatRequest::default()
    }
}

/// Leniently: an entry that is not a word with a meaning is dropped, not the
/// batch; only a reply with no usable word at all is an error.
pub fn parse_word_batch(raw: &str) -> Result<WordBatch> {
    let unusable = || {
        LlmError::new(
            ErrorKind::BadResponse,
            "The model did not list any words. Try again.",
        )
    };
    let reply: Value = parse_reply(raw).ok_or_else(unusable)?;
    let entries = reply
        .get("words")
        .and_then(Value::as_array)
        .ok_or_else(unusable)?;
    let mut seen = std::collections::HashSet::new();
    let words: Vec<SuggestedWord> = entries
        .iter()
        .filter_map(|entry| {
            let text = |key: &str| non_blank(entry.get(key).and_then(Value::as_str));
            let term = text("term")?;
            let meaning = text("meaning")?;
            seen.insert(term_key(term)).then(|| SuggestedWord {
                term: term.to_owned(),
                meaning: meaning.to_owned(),
                romanization: text("reading").map(str::to_owned),
            })
        })
        .collect();
    if words.is_empty() {
        return Err(unusable());
    }
    Ok(WordBatch { words })
}

/// A window onto a fixed list, easiest first, that moves the way a live batch
/// would: it starts after the last recent word it finds, a step harder skips a
/// few ahead and a step easier backs up a few — into words already shown, which
/// is what exercises the host's repeat filter. A starter batch starts at a
/// place the topic picks. Deterministic, so a test can name what comes back.
fn mock_words(args: &WordBatchArgs) -> String {
    let source = if is_mandarin(&args.profile.target_language) {
        WORDS_ZH
    } else {
        WORDS_ES
    };
    let pool: Reply = serde_json::from_str(source).expect("a fixture is JSON");
    let len = pool.words.len();
    let recent = recent_of(args);
    let start = match args.mode {
        WordBatchMode::Starter => non_blank(args.topic.as_deref())
            .map(|topic| topic.bytes().map(usize::from).sum::<usize>())
            .unwrap_or(0),
        WordBatchMode::Check => {
            let after = recent
                .last()
                .and_then(|last| {
                    pool.words
                        .iter()
                        .position(|word| term_key(&word.term) == term_key(last))
                })
                .map_or(0, |at| at + 1);
            match args.step.unwrap_or_default() {
                CheckStep::Start | CheckStep::Same => after,
                CheckStep::Harder => after + 5,
                CheckStep::Easier => after + len - 5,
            }
        }
    };
    let words: Vec<&ReplyWord> = (0..count_of(args).min(len))
        .map(|i| &pool.words[(start + i) % len])
        .collect();
    fenced(&serde_json::json!({ "words": words }))
}

pub async fn word_batch<T: Transport>(llm: &Llm<T>, args: &WordBatchArgs) -> Result<WordBatch> {
    let completion = llm
        .complete_or_mock(&word_batch_request(args), || mock_words(args))
        .await?;
    parse_word_batch(&completion.content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, Fake};
    use pollster::block_on;
    use serde_json::json;

    fn args(target: &str, mode: WordBatchMode) -> WordBatchArgs {
        WordBatchArgs {
            profile: LearnerProfile {
                native_language: "English".into(),
                target_language: target.into(),
                about: None,
            },
            word_count: 0,
            mode,
            step: None,
            topic: None,
            count: None,
            recent: vec![],
        }
    }

    fn payload(request: &ChatRequest) -> Value {
        match &request.messages[1] {
            Message::User(content) => serde_json::from_str(content).unwrap(),
            other => panic!("expected the user message, got {other:?}"),
        }
    }

    fn terms(batch: &WordBatch) -> Vec<&str> {
        batch.words.iter().map(|word| word.term.as_str()).collect()
    }

    #[test]
    fn a_check_payload_is_ordered_capped_and_carries_the_step() {
        let mut check = args("Spanish", WordBatchMode::Check);
        check.profile.about = Some(format!(" {} ", "a".repeat(600)));
        check.word_count = crate::INTERMEDIATE_WORDS;
        check.step = Some(CheckStep::Harder);
        check.topic = Some("ignored in check mode".into());
        check.count = Some(500);
        check.recent = (0..80)
            .map(|i| format!("w{i}"))
            .chain([" ".into()])
            .collect();

        let request = word_batch_request(&check);
        let payload = payload(&request);
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["native", "target", "level", "mode", "step", "about", "count", "recent"]
        );
        assert_eq!(payload["level"], "intermediate");
        assert_eq!(payload["mode"], "check");
        assert_eq!(payload["step"], "harder");
        assert_eq!(payload["about"].as_str().unwrap().len(), MAX_ABOUT_CHARS);
        assert_eq!(payload["count"], MAX_BATCH_WORDS);
        let recent = payload["recent"].as_array().unwrap();
        assert_eq!(recent.len(), MAX_RECENT_WORDS);
        assert_eq!(recent[0], "w20");
        assert_eq!(recent[MAX_RECENT_WORDS - 1], "w79");
        assert_eq!(request.temperature, Some(0.7));
    }

    #[test]
    fn a_first_check_starts_and_a_starter_names_its_topic() {
        let payload_of = |a: &WordBatchArgs| payload(&word_batch_request(a));
        assert_eq!(
            payload_of(&args("Spanish", WordBatchMode::Check)),
            json!({ "native": "English", "target": "Spanish", "level": "beginner", "mode": "check", "step": "start", "count": DEFAULT_COUNT, "recent": [] })
        );

        let mut starter = args("Spanish", WordBatchMode::Starter);
        starter.step = Some(CheckStep::Easier);
        starter.topic = Some(format!(" {} ", "t".repeat(200)));
        starter.count = Some(12);
        let payload = payload_of(&starter);
        assert!(payload.get("step").is_none());
        assert_eq!(payload["mode"], "starter");
        assert_eq!(payload["topic"].as_str().unwrap().len(), MAX_TOPIC_CHARS);
        assert_eq!(payload["count"], 12);
    }

    #[test]
    fn the_system_prompt_is_static_and_the_schema_strict() {
        let a = word_batch_request(&args("Spanish", WordBatchMode::Check));
        let mut other = args("Mandarin", WordBatchMode::Starter);
        other.topic = Some("food".into());
        let b = word_batch_request(&other);
        assert_eq!(a.messages[0], b.messages[0]);
        let (name, schema) = a.schema.unwrap();
        assert_eq!(name, "word_batch");
        assert_eq!(
            schema["properties"]["words"]["items"]["required"],
            json!(["term", "reading", "meaning"])
        );
    }

    #[test]
    fn a_reply_drops_malformed_and_repeated_entries_not_the_batch() {
        let batch = parse_word_batch(
            r#"Here: {"words":[
                {"term":" casa ","reading":null,"meaning":" house "},
                {"term":"","meaning":"blank"},
                {"term":"perro"},
                {"term":"gato","meaning":"  "},
                "nope",
                {"term":"Casa","reading":null,"meaning":"home"},
                {"term":"吃","reading":" chī ","meaning":"to eat"},
                {"term":"喝","reading":"","meaning":"to drink"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(
            batch.words,
            [
                SuggestedWord {
                    term: "casa".into(),
                    meaning: "house".into(),
                    romanization: None
                },
                SuggestedWord {
                    term: "吃".into(),
                    meaning: "to eat".into(),
                    romanization: Some("chī".into())
                },
                SuggestedWord {
                    term: "喝".into(),
                    meaning: "to drink".into(),
                    romanization: None
                },
            ]
        );
        assert!(parse_word_batch(r#"{"words":[{"term":"x"}]}"#).is_err());
        assert!(parse_word_batch(r#"{"words":"casa"}"#).is_err());
        assert_eq!(
            parse_word_batch("no json").unwrap_err().kind,
            ErrorKind::BadResponse
        );
    }

    #[test]
    fn the_mock_walks_its_list_through_the_parser() {
        let fake = Fake::default();
        let mock = Llm::new(&fake, None);
        let run = |a: &WordBatchArgs| block_on(word_batch(&mock, a)).unwrap();

        let mut check = args("Spanish", WordBatchMode::Check);
        check.count = Some(4);
        assert_eq!(terms(&run(&check)), ["casa", "agua", "comer", "bueno"]);

        // The next batch starts after the last word shown, so a same-step run
        // moves on; a harder one skips ahead, an easier one backs into words
        // already shown, which the host has to filter.
        check.recent = vec!["casa".into(), "agua".into()];
        check.step = Some(CheckStep::Same);
        assert_eq!(terms(&run(&check)), ["comer", "bueno", "día", "hablar"]);
        check.step = Some(CheckStep::Harder);
        assert_eq!(terms(&run(&check))[0], "amigo");
        check.step = Some(CheckStep::Easier);
        let easier = run(&check);
        assert_eq!(easier.words.len(), 4);
        assert!(terms(&easier).contains(&"casa"));

        let mut zh = args("Chinese (Mandarin)", WordBatchMode::Check);
        zh.count = Some(1);
        assert_eq!(
            run(&zh).words[0],
            SuggestedWord {
                term: "家".into(),
                meaning: "home".into(),
                romanization: Some("jiā".into())
            }
        );

        let mut starter = args("Spanish", WordBatchMode::Starter);
        starter.count = Some(12);
        starter.topic = Some("food".into());
        let food = run(&starter);
        assert_eq!(food.words.len(), 12);
        starter.topic = Some("travel".into());
        assert_ne!(run(&starter), food);
    }

    #[test]
    fn a_live_call_sends_the_prompt_and_parses_the_reply() {
        let fake = Fake::replying(
            "```json\n{\"words\":[{\"term\":\"hola\",\"reading\":null,\"meaning\":\"hello\"}]}\n```",
        );
        let llm = live(&fake);
        let batch = block_on(word_batch(&llm, &args("Spanish", WordBatchMode::Check))).unwrap();
        assert_eq!(terms(&batch), ["hola"]);
        let body = fake.body(0);
        assert_eq!(body["messages"][0]["content"], PROMPT.trim_end());
        assert_eq!(body["response_format"]["json_schema"]["name"], "word_batch");
        assert_eq!(llm.usage().requests, 1);
    }
}
