//! The two textbook calls: one scanned page transcribed into its
//! target-language blocks, and meanings for the vocabulary a book lists
//! without them.
//!
//! **A transcriber, not an author.** The page prompt
//! (`prompts/textbook-page.txt`) asks for what is printed and nothing else; it
//! and the schema were measured on real pages before this was written
//! (`tools/textbook-ocr`). What comes back is tidied by `sapling-import`
//! ([`tidy_page`]) before anyone sees it, so a speaker's "A:" or the spaces
//! between hanzi never depend on the model having followed every rule. The
//! pages of a lesson are assembled there too (`assembleTextbook`), not here:
//! this crate is the model calls and nothing after them.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_import::textbook::{
    tidy_page, BlockKind, LessonStart, PrintedPage, TextbookBlock, TextbookLine, TextbookPage,
    TextbookWord,
};

use crate::client::{ChatRequest, ErrorKind, Llm, LlmError, Message, Result, Transport};
use crate::json::{fenced, fill, parse_reply, strict_schema};
use crate::{is_mandarin, non_blank, LearnerProfile};

/// The most words one gloss call asks about; a caller with more makes more calls.
pub const MAX_GLOSS_WORDS: usize = 60;

/// A transcribed page is a few thousand tokens at most; this leaves room for a
/// model that thinks a little anyway.
const PAGE_MAX_TOKENS: u32 = 12_000;

const PAGE_PROMPT: &str = include_str!("../prompts/textbook-page.txt");
const GLOSS_PROMPT: &str = include_str!("../prompts/textbook-gloss.txt");

const PAGES_ZH: &str = include_str!("../fixtures/textbook-zh.json");
const PAGES_ES: &str = include_str!("../fixtures/textbook-es.json");
const GLOSS_FIXTURE: &str = include_str!("../fixtures/textbook-gloss.json");

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TranscribePageArgs {
    pub profile: LearnerProfile,
    /// The page as an image URL: in practice a `data:image/jpeg;base64,…`.
    pub image: String,
    /// Which page of the run this is, from 1. The model is not told; the mock
    /// answers from its fixture pages in turn.
    pub page: u32,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct GlossTerm {
    pub term: String,
    /// What the book prints beside it (an article, a part of speech), which picks the sense.
    #[serde(default)]
    #[ts(optional)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct GlossWordsArgs {
    pub profile: LearnerProfile,
    pub words: Vec<GlossTerm>,
}

/// A meaning for a listed word. Never stored as such: the review screen puts
/// it in the word's row and `add_words` files it.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct GlossedWord {
    /// Exactly as asked.
    pub term: String,
    pub meaning: String,
    /// Latin reading; absent for Latin-script targets.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reading: Option<String>,
}

/* ---- The page reply: what the model is asked for ------------------------- */

/// One transcribed image of a textbook page.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PageReply {
    /// Every printed page visible in the image, left to right (a scan may hold a two-page spread).
    pages: Vec<PrintedPageReply>,
    /// A lesson whose opening (number and title) is printed in this image.
    lesson_starts: Vec<LessonStartReply>,
    /// The target-language content, in reading order. Everything else on the page is left out.
    blocks: Vec<BlockReply>,
}

#[derive(Deserialize, JsonSchema)]
struct PrintedPageReply {
    /// The printed page number, or null.
    number: Option<String>,
    /// The lesson label in the running header or footer, as printed ("LES 2", "3"), or null.
    lesson: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct LessonStartReply {
    lesson: String,
    title: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum KindReply {
    Dialogue,
    Sentences,
    Words,
}

#[derive(Deserialize, JsonSchema)]
struct BlockReply {
    /// dialogue: speakers taking turns, or one speaker's numbered passage. sentences: standalone
    /// target-language sentences or phrases (grammar examples, captions, phrase boxes, exercise
    /// questions). words: a vocabulary list.
    kind: KindReply,
    /// The lesson this block belongs to, as labelled on its page, or null.
    lesson: Option<String>,
    /// The block's heading as printed, or null.
    heading: Option<String>,
    /// The block's number as printed ("2", "3A"), or null.
    number: Option<String>,
    /// True when this block is the continuation of one cut off at the end of the previous page.
    continues: bool,
    /// For dialogue and sentences: one entry per printed line. Empty for words.
    lines: Vec<LineReply>,
    /// For words: one entry per listed word. Empty otherwise.
    words: Vec<WordReply>,
}

#[derive(Deserialize, JsonSchema)]
struct LineReply {
    /// The speaker's name or label as printed ("A", "Els", "Peter en Els"); null when the line
    /// continues the previous speaker or has none.
    speaker: Option<String>,
    /// The target-language text, copied exactly.
    text: String,
    /// A printed pronunciation guide for this line (pinyin, furigana), or null.
    reading: Option<String>,
    /// A printed translation of this line, or null.
    translation: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct WordReply {
    /// The headword as a learner would file it: without a leading article, without conjugations.
    term: String,
    /// Printed notes on the word: article, part of speech, conjugated forms ("de", "v.",
    /// "ik kom, je komt, hij komt"), or null.
    notes: Option<String>,
    /// A printed pronunciation guide, or null.
    reading: Option<String>,
    /// A printed meaning or translation, or null when the list gives none.
    meaning: Option<String>,
    /// True for a proper noun (a name, a place).
    proper: bool,
}

impl From<PageReply> for TextbookPage {
    fn from(reply: PageReply) -> Self {
        TextbookPage {
            pages: reply
                .pages
                .into_iter()
                .map(|p| PrintedPage {
                    number: p.number,
                    lesson: p.lesson,
                })
                .collect(),
            lesson_starts: reply
                .lesson_starts
                .into_iter()
                .map(|s| LessonStart {
                    lesson: s.lesson,
                    title: s.title,
                })
                .collect(),
            blocks: reply
                .blocks
                .into_iter()
                .map(|b| TextbookBlock {
                    kind: match b.kind {
                        KindReply::Dialogue => BlockKind::Dialogue,
                        KindReply::Sentences => BlockKind::Sentences,
                        KindReply::Words => BlockKind::Words,
                    },
                    lesson: b.lesson,
                    heading: b.heading,
                    number: b.number,
                    continues: b.continues,
                    lines: b
                        .lines
                        .into_iter()
                        .map(|l| TextbookLine {
                            speaker: l.speaker,
                            text: l.text,
                            reading: l.reading,
                            translation: l.translation,
                        })
                        .collect(),
                    words: b
                        .words
                        .into_iter()
                        .map(|w| TextbookWord {
                            term: w.term,
                            notes: w.notes,
                            reading: w.reading,
                            meaning: w.meaning,
                            proper: w.proper,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

/* ---- The gloss reply ------------------------------------------------------ */

#[derive(Deserialize, JsonSchema)]
struct GlossReply {
    words: Vec<GlossEntryReply>,
}

#[derive(Deserialize, JsonSchema)]
struct GlossEntryReply {
    term: String,
    meaning: String,
    reading: Option<String>,
}

#[derive(Serialize)]
struct PagePayload<'a> {
    native: &'a str,
    target: &'a str,
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

pub fn page_request(args: &TranscribePageArgs) -> ChatRequest {
    let payload = PagePayload {
        native: &args.profile.native_language,
        target: &args.profile.target_language,
    };
    ChatRequest {
        messages: vec![
            Message::System(PAGE_PROMPT.trim_end().to_owned()),
            Message::UserImages {
                text: serde_json::to_string(&payload).expect("a payload serializes"),
                images: vec![args.image.clone()],
            },
        ],
        schema: Some(("textbook_page".to_owned(), strict_schema::<PageReply>())),
        temperature: Some(0.0),
        max_tokens: Some(PAGE_MAX_TOKENS),
        reasoning_off: true,
        ..ChatRequest::default()
    }
}

/// The page as `sapling-import` keeps it, tidied.
pub fn parse_page(raw: &str) -> Option<TextbookPage> {
    parse_reply::<PageReply>(raw).map(|reply| tidy_page(reply.into()))
}

fn mock_page(args: &TranscribePageArgs) -> String {
    let source = if is_mandarin(&args.profile.target_language) {
        PAGES_ZH
    } else {
        PAGES_ES
    };
    let pages: Vec<Value> = serde_json::from_str(source).expect("a fixture is JSON");
    let at = (args.page.max(1) as usize - 1) % pages.len();
    fenced(&pages[at])
}

/// One page, transcribed and tidied. A reply that does not parse is asked for
/// once more — measured, a model that loops on whitespace inside strict JSON
/// mostly does not the second time — and then fails the page.
pub async fn transcribe_page<T: Transport>(
    llm: &Llm<T>,
    args: &TranscribePageArgs,
) -> Result<TextbookPage> {
    let request = page_request(args);
    for _ in 0..2 {
        let completion = llm.complete_or_mock(&request, || mock_page(args)).await?;
        if let Some(page) = parse_page(&completion.content) {
            return Ok(page);
        }
    }
    Err(bad(format!(
        "The model could not read page {}. Try again, or another model.",
        args.page
    )))
}

pub fn gloss_request(args: &GlossWordsArgs) -> ChatRequest {
    let payload = GlossPayload {
        native: &args.profile.native_language,
        target: &args.profile.target_language,
        words: args
            .words
            .iter()
            .take(MAX_GLOSS_WORDS)
            .map(|word| match non_blank(word.notes.as_deref()) {
                Some(notes) => serde_json::json!({ "term": word.term.trim(), "notes": notes }),
                None => serde_json::json!({ "term": word.term.trim() }),
            })
            .collect(),
    };
    ChatRequest {
        messages: vec![
            Message::System(GLOSS_PROMPT.trim_end().to_owned()),
            Message::User(serde_json::to_string(&payload).expect("a payload serializes")),
        ],
        schema: Some(("textbook_gloss".to_owned(), strict_schema::<GlossReply>())),
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
                reading: non_blank(entry.reading.as_deref()).map(str::to_owned),
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

/// Meanings for listed words that print none. No words, no call.
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
    use crate::client::fake::{live, ok, Fake};
    use pollster::block_on;
    use serde_json::json;

    fn profile(target: &str) -> LearnerProfile {
        LearnerProfile {
            native_language: "English".into(),
            target_language: target.into(),
            about: None,
        }
    }

    fn page_args(target: &str, page: u32) -> TranscribePageArgs {
        TranscribePageArgs {
            profile: profile(target),
            image: "data:image/jpeg;base64,AA==".into(),
            page,
        }
    }

    #[test]
    fn the_page_request_shows_the_image_and_asks_for_the_schema_without_reasoning() {
        let request = page_request(&page_args("Chinese", 1));
        let Message::UserImages { text, images } = &request.messages[1] else {
            panic!("expected an image turn");
        };
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            json!({ "native": "English", "target": "Chinese" })
        );
        assert_eq!(images, &["data:image/jpeg;base64,AA=="]);
        assert!(request.reasoning_off);
        assert_eq!(request.temperature, Some(0.0));
        let (name, schema) = request.schema.unwrap();
        assert_eq!(name, "textbook_page");
        // Strict: every key required, down to a word's.
        let word = &schema["properties"]["blocks"]["items"]["properties"]["words"]["items"];
        assert_eq!(
            word["required"],
            json!(["term", "notes", "reading", "meaning", "proper"])
        );
    }

    #[test]
    fn the_mock_reads_its_pages_in_turn_through_the_tidy() {
        let fake = Fake::default();
        let llm = Llm::new(&fake, None);
        let first = block_on(transcribe_page(&llm, &page_args("Chinese", 1))).unwrap();
        let second = block_on(transcribe_page(&llm, &page_args("Chinese", 2))).unwrap();
        let line = &first.blocks[0].lines[0];
        assert_eq!(line.speaker.as_deref(), Some("A"));
        assert_eq!(line.text, "你好！");
        assert_eq!(line.translation.as_deref(), Some("Hello!"));
        assert!(second.blocks[0].continues);
        assert_eq!(second.blocks[1].lines[0].text, "他是老师吗？");
        // Page three wraps back to the first fixture page.
        let third = block_on(transcribe_page(&llm, &page_args("Chinese", 3))).unwrap();
        assert_eq!(third, first);

        let spanish = block_on(transcribe_page(&llm, &page_args("Spanish", 1))).unwrap();
        let speakers: Vec<Option<&str>> = spanish.blocks[0]
            .lines
            .iter()
            .map(|l| l.speaker.as_deref())
            .collect();
        // "1. Camarero" loses its number; "(...)" is gone.
        assert_eq!(
            speakers,
            [Some("Camarero"), Some("Ana"), Some("Camarero"), Some("Ana")]
        );
    }

    #[test]
    fn an_unreadable_reply_is_asked_for_once_more_then_fails_the_page() {
        let reply = |content: &str| {
            Ok(ok(
                json!({ "choices": [{ "message": { "content": content } }] }),
            ))
        };
        let page = json!({ "pages": [], "lessonStarts": [], "blocks": [] }).to_string();
        let fake = Fake::new(vec![reply("{\"pages\": [   "), reply(&page)]);
        assert!(block_on(transcribe_page(&live(&fake), &page_args("Dutch", 4))).is_ok());

        let fake = Fake::new(vec![reply("nope"), reply("still nope")]);
        let error = block_on(transcribe_page(&live(&fake), &page_args("Dutch", 4))).unwrap_err();
        assert_eq!(error.kind, ErrorKind::BadResponse);
        assert!(error.message.contains("page 4"));
    }

    #[test]
    fn glosses_match_back_by_spelling_and_drop_strays() {
        let asked = vec![
            GlossTerm {
                term: "café".into(),
                notes: Some("el".into()),
            },
            GlossTerm {
                term: "Leche".into(),
                notes: None,
            },
        ];
        let raw = json!({ "words": [
            { "term": "leche", "meaning": " milk ", "reading": null },
            { "term": "café", "meaning": "coffee", "reading": " " },
            { "term": "café", "meaning": "again", "reading": null },
            { "term": "té", "meaning": "tea", "reading": null },
        ] })
        .to_string();
        assert_eq!(
            parse_gloss(&raw, &asked).unwrap(),
            [
                GlossedWord {
                    term: "Leche".into(),
                    meaning: "milk".into(),
                    reading: None,
                },
                GlossedWord {
                    term: "café".into(),
                    meaning: "coffee".into(),
                    reading: None,
                },
            ]
        );
        assert!(parse_gloss(r#"{"words":[]}"#, &asked).is_err());
    }

    #[test]
    fn the_gloss_payload_carries_notes_where_there_are_some() {
        let args = GlossWordsArgs {
            profile: profile("Dutch"),
            words: vec![
                GlossTerm {
                    term: " collega ".into(),
                    notes: Some("de".into()),
                },
                GlossTerm {
                    term: "goed".into(),
                    notes: Some(" ".into()),
                },
            ],
        };
        let request = gloss_request(&args);
        let Message::User(text) = &request.messages[1] else {
            panic!("expected a user turn");
        };
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            json!({ "native": "English", "target": "Dutch", "words": [
                { "term": "collega", "notes": "de" },
                { "term": "goed" },
            ] })
        );
        let fake = Fake::default();
        let glossed = block_on(gloss_words(&Llm::new(&fake, None), &args)).unwrap();
        assert_eq!(glossed[0].term, "collega");
        assert_eq!(glossed[0].meaning, "(meaning of \"collega\")");
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
