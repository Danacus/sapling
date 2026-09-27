//! The three reading calls: a text written from the learner's vocabulary, one
//! word explained in its sentence, one line translated. Stateless and only the
//! text: a generated text carries no readings, translations or glossary.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_domain::types::{Level, Segment};

use crate::client::{ChatRequest, ErrorKind, Llm, LlmError, Message, Result, Transport};
use crate::json::{fenced, fill, parse_reply, strict_schema};
use crate::{truncated, LearnerProfile, MAX_ABOUT_CHARS};

pub const MAX_VOCABULARY_TERMS: usize = 400;
/// Every focus word must be used; past a dozen a text turns into a bingo card.
pub const MAX_FOCUS_WORDS: usize = 12;
pub const MAX_TOPIC_CHARS: usize = 120;

const GENERATE_PROMPT: &str = include_str!("../prompts/reading-generate.txt");
const LOOKUP_PROMPT: &str = include_str!("../prompts/reading-lookup.txt");
const TRANSLATE_PROMPT: &str = include_str!("../prompts/reading-translate.txt");

const TEXT_ES: &str = include_str!("../fixtures/reading-text-es.json");
const TEXT_ZH: &str = include_str!("../fixtures/reading-text-zh.json");
const LOOKUP_FIXTURE: &str = include_str!("../fixtures/reading-lookup.json");
const TRANSLATE_FIXTURE: &str = include_str!("../fixtures/reading-translate.json");

/// A word the text must use.
#[derive(Debug, Clone, Deserialize, TS)]
pub struct FocusWord {
    pub term: String,
    pub meaning: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct GenerateTextArgs {
    pub profile: LearnerProfile,
    /// Every term the learner can read: what the text is built from.
    pub vocabulary: Vec<String>,
    /// What the schedule owes, most overdue first.
    pub focus: Vec<FocusWord>,
    #[serde(default)]
    #[ts(optional)]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct LookupWordArgs {
    pub profile: LearnerProfile,
    /// Exactly as the text spells it.
    pub term: String,
    /// The sentence it stands in, which picks the sense.
    pub sentence: String,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct TranslateLineArgs {
    pub profile: LearnerProfile,
    /// One segment, verbatim.
    pub text: String,
    #[serde(default)]
    #[ts(optional)]
    pub title: Option<String>,
}

/// A generated text before the caller gives it an id and stores it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct ReadingTextDraft {
    pub title: String,
    /// One untimed segment per paragraph.
    pub segments: Vec<Segment>,
}

/// One word explained. Never stored.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct GlossEntry {
    /// Exactly as the text spells it: the reader matches on it.
    pub term: String,
    /// Latin reading; absent for Latin-script targets.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reading: Option<String>,
    /// The short gloss a card would file, in the native language.
    pub meaning: String,
    /// The word's sense, nuance or grammar in this sentence. Display-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
}

#[derive(Deserialize, Serialize, JsonSchema)]
struct TextReply {
    title: String,
    paragraphs: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
#[allow(dead_code)]
struct LookupReply {
    term: String,
    reading: Option<String>,
    meaning: String,
    explanation: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct TranslateReply {
    translation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratePayload<'a> {
    native: &'a str,
    target: &'a str,
    level: Level,
    sentence_count: u32,
    // Before `interests`: the topic outranks them, and earlier keys weigh more.
    #[serde(skip_serializing_if = "Option::is_none")]
    topic: Option<String>,
    interests: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    about: Option<String>,
    focus: Vec<Value>,
    vocabulary: Vec<&'a str>,
}

#[derive(Serialize)]
struct LookupPayload<'a> {
    native: &'a str,
    target: &'a str,
    level: Level,
    term: &'a str,
    sentence: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

#[derive(Serialize)]
struct TranslatePayload<'a> {
    native: &'a str,
    target: &'a str,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
}

/// Sentences, not words: sentence length already grows with the level.
pub fn sentence_count(level: Level) -> u32 {
    match level {
        Level::Beginner => 6,
        Level::Elementary => 8,
        Level::Intermediate => 10,
        Level::Advanced => 12,
    }
}

fn non_blank(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|text| !text.is_empty())
}

/// Trimmed, blanks dropped, deduplicated case-insensitively, capped — in order.
fn capped_terms(terms: &[String], limit: usize) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    terms
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty() && seen.insert(term.to_lowercase()))
        .take(limit)
        .collect()
}

fn request(system: &str, payload: &impl Serialize, schema: (&'static str, Value)) -> ChatRequest {
    ChatRequest {
        messages: vec![
            Message::System(system.trim_end().to_owned()),
            Message::User(serde_json::to_string(payload).expect("a payload serializes")),
        ],
        schema: Some(schema),
        ..ChatRequest::default()
    }
}

pub fn generate_request(args: &GenerateTextArgs) -> ChatRequest {
    let profile = &args.profile;
    let payload = GeneratePayload {
        native: &profile.native_language,
        target: &profile.target_language,
        level: profile.level,
        sentence_count: sentence_count(profile.level),
        topic: non_blank(args.topic.as_deref()).map(|topic| truncated(topic, MAX_TOPIC_CHARS)),
        interests: &profile.interests,
        about: non_blank(profile.about.as_deref()).map(|about| truncated(about, MAX_ABOUT_CHARS)),
        focus: args
            .focus
            .iter()
            .take(MAX_FOCUS_WORDS)
            .map(|word| serde_json::json!({ "t": word.term, "m": word.meaning }))
            .collect(),
        vocabulary: capped_terms(&args.vocabulary, MAX_VOCABULARY_TERMS),
    };
    ChatRequest {
        temperature: Some(0.9),
        ..request(
            GENERATE_PROMPT,
            &payload,
            ("reading_text", strict_schema::<TextReply>()),
        )
    }
}

pub fn lookup_request(args: &LookupWordArgs) -> ChatRequest {
    let profile = &args.profile;
    let payload = LookupPayload {
        native: &profile.native_language,
        target: &profile.target_language,
        level: profile.level,
        term: args.term.trim(),
        sentence: args.sentence.trim(),
        title: non_blank(args.title.as_deref()),
    };
    ChatRequest {
        temperature: Some(0.3),
        ..request(
            LOOKUP_PROMPT,
            &payload,
            ("reading_lookup", strict_schema::<LookupReply>()),
        )
    }
}

pub fn translate_request(args: &TranslateLineArgs) -> ChatRequest {
    let profile = &args.profile;
    let payload = TranslatePayload {
        native: &profile.native_language,
        target: &profile.target_language,
        text: args.text.trim(),
        title: non_blank(args.title.as_deref()),
    };
    ChatRequest {
        temperature: Some(0.3),
        ..request(
            TRANSLATE_PROMPT,
            &payload,
            ("reading_translation", strict_schema::<TranslateReply>()),
        )
    }
}

fn bad(message: &str) -> LlmError {
    LlmError::new(ErrorKind::BadResponse, message)
}

/// Blank paragraphs are dropped; a text with none left is an error.
pub fn parse_text(raw: &str) -> Result<ReadingTextDraft> {
    let reply: TextReply = parse_reply(raw)
        .ok_or_else(|| bad("The model returned a text in an unexpected shape. Try again."))?;
    let segments: Vec<Segment> = reply
        .paragraphs
        .iter()
        .map(|paragraph| paragraph.trim())
        .filter(|paragraph| !paragraph.is_empty())
        .map(|text| Segment {
            text: text.to_owned(),
            start: None,
            end: None,
        })
        .collect();
    let title = reply.title.trim();
    if title.is_empty() || segments.is_empty() {
        return Err(bad("The model returned an empty text. Try again."));
    }
    Ok(ReadingTextDraft {
        title: title.to_owned(),
        segments,
    })
}

/// `term` comes from the request, not the reply: the reader matches it
/// character for character, and a model may answer with the dictionary form.
pub fn parse_lookup(raw: &str, term: &str) -> Result<GlossEntry> {
    let unusable = || bad("The model did not explain that word. Try again.");
    let reply: LookupReply = parse_reply(raw).ok_or_else(unusable)?;
    let term = term.trim();
    let meaning = reply.meaning.trim();
    if term.is_empty() || meaning.is_empty() {
        return Err(unusable());
    }
    Ok(GlossEntry {
        term: term.to_owned(),
        reading: non_blank(reply.reading.as_deref()).map(str::to_owned),
        meaning: meaning.to_owned(),
        explanation: non_blank(reply.explanation.as_deref()).map(str::to_owned),
    })
}

pub fn parse_translation(raw: &str) -> Result<String> {
    parse_reply::<TranslateReply>(raw)
        .map(|reply| reply.translation.trim().to_owned())
        .filter(|translation| !translation.is_empty())
        .ok_or_else(|| bad("The model did not translate that line. Try again."))
}

/// Whether the mock writes the Mandarin text rather than the Spanish one.
fn is_mandarin(language: &str) -> bool {
    let language = language.trim().to_lowercase();
    language == "zh"
        || language.starts_with("zh-")
        || language.contains("chinese")
        || language.contains("mandarin")
        || language.contains("中文")
}

fn fixture(source: &str, vars: &[(&str, &str)]) -> String {
    let mut value: Value = serde_json::from_str(source).expect("a fixture is JSON");
    fill(&mut value, vars);
    fenced(&value)
}

fn mock_text(args: &GenerateTextArgs) -> String {
    let source = if is_mandarin(&args.profile.target_language) {
        TEXT_ZH
    } else {
        TEXT_ES
    };
    let mut text: TextReply = serde_json::from_str(source).expect("a fixture is JSON");
    if let Some(topic) = non_blank(args.topic.as_deref()) {
        text.title = format!("{} ({topic})", text.title);
    }
    fenced(&serde_json::to_value(text).expect("a fixture serializes"))
}

pub async fn generate_text<T: Transport>(
    llm: &Llm<T>,
    args: &GenerateTextArgs,
) -> Result<ReadingTextDraft> {
    let completion = llm
        .complete_or_mock(&generate_request(args), || mock_text(args))
        .await?;
    parse_text(&completion.content)
}

pub async fn look_up_word<T: Transport>(llm: &Llm<T>, args: &LookupWordArgs) -> Result<GlossEntry> {
    let term = args.term.trim();
    let completion = llm
        .complete_or_mock(&lookup_request(args), || {
            fixture(LOOKUP_FIXTURE, &[("term", term)])
        })
        .await?;
    parse_lookup(&completion.content, term)
}

pub async fn translate_line<T: Transport>(
    llm: &Llm<T>,
    args: &TranslateLineArgs,
) -> Result<String> {
    let completion = llm
        .complete_or_mock(&translate_request(args), || {
            fixture(TRANSLATE_FIXTURE, &[("text", args.text.trim())])
        })
        .await?;
    parse_translation(&completion.content)
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
            level: Level::Elementary,
            interests: vec!["cooking".into()],
            about: None,
        }
    }

    fn user_payload(request: &ChatRequest) -> Value {
        match &request.messages[1] {
            Message::User(content) => serde_json::from_str(content).unwrap(),
            other => panic!("expected the user message, got {other:?}"),
        }
    }

    fn generate_args() -> GenerateTextArgs {
        GenerateTextArgs {
            profile: profile("Spanish"),
            vocabulary: vec![],
            focus: vec![],
            topic: None,
        }
    }

    #[test]
    fn the_generate_payload_is_capped_and_ordered() {
        let mut args = generate_args();
        args.profile.about = Some(format!("  {}  ", "a".repeat(600)));
        args.topic = Some(format!(" {} ", "t".repeat(200)));
        args.vocabulary = vec![" gato ".into(), "Gato".into(), "".into(), "perro".into()];
        args.focus = (0..20)
            .map(|i| FocusWord {
                term: format!("w{i}"),
                meaning: "m".into(),
            })
            .collect();

        let request = generate_request(&args);
        let payload = user_payload(&request);
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "native",
                "target",
                "level",
                "sentenceCount",
                "topic",
                "interests",
                "about",
                "focus",
                "vocabulary"
            ]
        );
        assert_eq!(payload["level"], "elementary");
        assert_eq!(payload["sentenceCount"], 8);
        assert_eq!(payload["topic"].as_str().unwrap().len(), MAX_TOPIC_CHARS);
        assert_eq!(payload["about"].as_str().unwrap().len(), MAX_ABOUT_CHARS);
        assert_eq!(payload["vocabulary"], json!(["gato", "perro"]));
        assert_eq!(payload["focus"].as_array().unwrap().len(), MAX_FOCUS_WORDS);
        assert_eq!(payload["focus"][0], json!({ "t": "w0", "m": "m" }));
        assert_eq!(request.temperature, Some(0.9));
    }

    #[test]
    fn blank_optionals_stay_out_of_the_payload() {
        let mut args = generate_args();
        args.topic = Some("  ".into());
        args.profile.about = Some("".into());
        let payload = user_payload(&generate_request(&args));
        assert!(payload.get("topic").is_none());
        assert!(payload.get("about").is_none());

        let lookup = user_payload(&lookup_request(&LookupWordArgs {
            profile: profile("Spanish"),
            term: " gato ".into(),
            sentence: " El gato duerme. ".into(),
            title: Some(" ".into()),
        }));
        assert_eq!(
            lookup,
            json!({ "native": "English", "target": "Spanish", "level": "elementary", "term": "gato", "sentence": "El gato duerme." })
        );
    }

    #[test]
    fn the_system_prompts_are_static() {
        let a = generate_request(&generate_args());
        let mut other = generate_args();
        other.profile = profile("Mandarin");
        other.topic = Some("trains".into());
        assert_eq!(a.messages[0], generate_request(&other).messages[0]);
    }

    #[test]
    fn a_text_drops_blank_paragraphs_and_needs_one() {
        let draft =
            parse_text(r#"{"title":" T ","paragraphs":[" Uno. ","","  ","Dos."]}"#).unwrap();
        assert_eq!(draft.title, "T");
        let texts: Vec<&str> = draft.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["Uno.", "Dos."]);
        assert!(draft.segments.iter().all(|s| s.start.is_none()));

        assert!(parse_text(r#"{"title":"T","paragraphs":[" "]}"#).is_err());
        assert!(parse_text(r#"{"title":"T"}"#).is_err());
        assert_eq!(
            parse_text("no json").unwrap_err().kind,
            ErrorKind::BadResponse
        );
    }

    #[test]
    fn a_lookup_keeps_the_asked_term_and_drops_blanks() {
        let entry = parse_lookup(
            r#"{"term":"comer","reading":null,"meaning":" to eat ","explanation":"  "}"#,
            " comí ",
        )
        .unwrap();
        assert_eq!(
            entry,
            GlossEntry {
                term: "comí".into(),
                reading: None,
                meaning: "to eat".into(),
                explanation: None
            }
        );
        let entry = parse_lookup(
            r#"{"term":"吃","reading":"chī","meaning":"eat","explanation":"Here: a meal."}"#,
            "吃",
        )
        .unwrap();
        assert_eq!(entry.reading.as_deref(), Some("chī"));
        assert_eq!(entry.explanation.as_deref(), Some("Here: a meal."));
        assert!(parse_lookup(r#"{"term":"x","meaning":" "}"#, "x").is_err());
    }

    #[test]
    fn a_translation_is_trimmed_and_never_blank() {
        assert_eq!(
            parse_translation(r#"{"translation":" Hi. "}"#).unwrap(),
            "Hi."
        );
        assert!(parse_translation(r#"{"translation":""}"#).is_err());
        assert!(parse_translation("{}").is_err());
    }

    #[test]
    fn the_mock_goes_through_the_parsers() {
        let fake = Fake::default();
        let mock = Llm::new(&fake, None);

        let text = block_on(generate_text(&mock, &generate_args())).unwrap();
        assert_eq!(text.title, "Una mesa para dos");
        assert_eq!(text.segments.len(), 4);

        let mut args = generate_args();
        args.profile = profile("Chinese (Mandarin)");
        args.topic = Some("food".into());
        let text = block_on(generate_text(&mock, &args)).unwrap();
        assert_eq!(text.title, "一张两个人的桌子 (food)");

        let entry = block_on(look_up_word(
            &mock,
            &LookupWordArgs {
                profile: profile("Spanish"),
                term: " \"mesa\" ".into(),
                sentence: "Una mesa.".into(),
                title: None,
            },
        ))
        .unwrap();
        assert_eq!(entry.term, "\"mesa\"");
        assert_eq!(entry.meaning, "(meaning of \"\"mesa\"\")");
        assert_eq!(
            entry.explanation.as_deref(),
            Some("(how \"\"mesa\"\" is used in this sentence)")
        );

        let line = block_on(translate_line(
            &mock,
            &TranslateLineArgs {
                profile: profile("Spanish"),
                text: " Hola. ".into(),
                title: None,
            },
        ))
        .unwrap();
        assert_eq!(line, "(translation of \"Hola.\")");
    }

    #[test]
    fn a_live_call_sends_the_prompt_and_parses_the_reply() {
        let fake = Fake::replying("```json\n{\"translation\":\"Hello.\"}\n```");
        let llm = live(&fake);
        let line = block_on(translate_line(
            &llm,
            &TranslateLineArgs {
                profile: profile("Spanish"),
                text: "Hola.".into(),
                title: Some("Saludos".into()),
            },
        ))
        .unwrap();
        assert_eq!(line, "Hello.");

        let body = fake.body(0);
        assert_eq!(body["messages"][0]["content"], TRANSLATE_PROMPT.trim_end());
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            "reading_translation"
        );
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["required"],
            json!(["translation"])
        );
        assert_eq!(llm.usage().requests, 1);
    }
}
