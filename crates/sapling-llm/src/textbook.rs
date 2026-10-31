//! A scanned textbook page, transcribed into its target-language lines.
//!
//! **A transcriber, not an author.** The prompt (`prompts/textbook-page.txt`)
//! asks for what is printed and nothing else; it and the schema were measured
//! on real pages first (`tools/textbook-ocr`). The reply also has a place for
//! what is *not* the text — a speaker, a printed pronunciation guide, a
//! translation, a vocabulary list — because a model given nowhere to put the
//! pinyin above a line puts it in the line. None of those leave this module:
//! readings are the frontend's, a stored text is only the text, and words are
//! added from a stored text afterwards. What does leave is tidied by
//! `sapling-import` ([`tidy_page`]) first, so pinyin in a Chinese line or an
//! "A:" never rests on the model having followed a rule; the pages of a lesson
//! are assembled there too (`assembleTextbook`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_import::textbook::{
    tidy_page, BlockKind, LessonStart, PrintedPage, TextbookBlock, TextbookPage,
};

use crate::client::{ChatRequest, ErrorKind, Llm, LlmError, Message, Result, Transport};
use crate::json::{fenced, parse_reply, strict_schema};
use crate::{is_mandarin, writes_in_han, LearnerProfile};

/// A transcribed page is a few thousand tokens at most; this leaves room for a
/// model that thinks a little anyway.
const PAGE_MAX_TOKENS: u32 = 12_000;

const PAGE_PROMPT: &str = include_str!("../prompts/textbook-page.txt");

const PAGES_ZH: &str = include_str!("../fixtures/textbook-zh.json");
const PAGES_ES: &str = include_str!("../fixtures/textbook-es.json");

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

/* ---- The reply: what the model is asked for ------------------------------ */

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
    /// The lesson's title in the target language, without any pronunciation guide, or null.
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
#[allow(dead_code)]
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
#[allow(dead_code)]
struct LineReply {
    /// The speaker's name or label as printed ("A", "Els", "Peter en Els"); null when the line
    /// continues the previous speaker or has none.
    speaker: Option<String>,
    /// The target-language text, copied exactly, in the target language's own script only:
    /// never a pronunciation guide (pinyin, romanization, furigana), never a translation.
    text: String,
    /// A pronunciation guide printed above or beside this line (pinyin, furigana), or null.
    /// It belongs here, never in `text`.
    reading: Option<String>,
    /// A printed translation of this line, or null.
    translation: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[allow(dead_code)]
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

/// What leaves the module: the lines' text, the lesson openings and the page
/// labels. Speakers, readings, translations and word lists stay behind.
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
                .filter_map(|b| {
                    let kind = match b.kind {
                        KindReply::Dialogue => BlockKind::Dialogue,
                        KindReply::Sentences => BlockKind::Sentences,
                        KindReply::Words => return None,
                    };
                    Some(TextbookBlock {
                        kind,
                        lines: b.lines.into_iter().map(|l| l.text).collect(),
                    })
                })
                .collect(),
        }
    }
}

#[derive(Serialize)]
struct PagePayload<'a> {
    native: &'a str,
    target: &'a str,
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

/// The page as `sapling-import` keeps it, tidied for the target's script:
/// `han_target` makes every page of a Chinese or Japanese book keep only its
/// characters, a page of pinyin drills included.
pub fn parse_page(raw: &str, han_target: bool) -> Option<TextbookPage> {
    parse_reply::<PageReply>(raw).map(|reply| tidy_page(reply.into(), han_target))
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
    let han_target = writes_in_han(&args.profile.target_language);
    for _ in 0..2 {
        let completion = llm.complete_or_mock(&request, || mock_page(args)).await?;
        if let Some(page) = parse_page(&completion.content, han_target) {
            return Ok(page);
        }
    }
    Err(bad(format!(
        "The model could not read page {}. Try again, or another model.",
        args.page
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, ok, Fake};
    use pollster::block_on;
    use serde_json::json;

    fn page_args(target: &str, page: u32) -> TranscribePageArgs {
        TranscribePageArgs {
            profile: LearnerProfile {
                native_language: "English".into(),
                target_language: target.into(),
                about: None,
            },
            image: "data:image/jpeg;base64,AA==".into(),
            page,
        }
    }

    fn lines(page: &TextbookPage) -> Vec<&str> {
        page.blocks
            .iter()
            .flat_map(|b| &b.lines)
            .map(String::as_str)
            .collect()
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
        // Strict, and the line keeps its place for a reading, so pinyin has
        // somewhere to go that is not the text.
        let line = &schema["properties"]["blocks"]["items"]["properties"]["lines"]["items"];
        assert_eq!(
            line["required"],
            json!(["speaker", "text", "reading", "translation"])
        );
    }

    #[test]
    fn only_the_text_leaves_and_the_pinyin_does_not() {
        let fake = Fake::default();
        let llm = Llm::new(&fake, None);
        let first = block_on(transcribe_page(&llm, &page_args("Chinese", 1))).unwrap();
        // The fixture carries a pinyin line, pinyin inside lines, an "A:" and
        // a vocabulary list; none of them reach the page.
        assert_eq!(
            lines(&first),
            ["你好！", "你好！我叫王明。", "我叫安娜。你是学生吗？"]
        );
        assert_eq!(first.lesson_starts[0].title.as_deref(), Some("你好"));
        let second = block_on(transcribe_page(&llm, &page_args("Chinese", 2))).unwrap();
        assert_eq!(
            lines(&second),
            ["是，我是学生。", "他是老师吗？", "你是中国人吗？"]
        );
        // Page three wraps back to the first fixture page.
        let third = block_on(transcribe_page(&llm, &page_args("Chinese", 3))).unwrap();
        assert_eq!(third, first);

        let spanish = block_on(transcribe_page(&llm, &page_args("Spanish", 1))).unwrap();
        assert_eq!(
            lines(&spanish),
            [
                "Buenos días. ¿Qué desea?",
                "Un café con leche, por favor.",
                "¿Algo más?",
                "No, gracias."
            ]
        );
    }

    #[test]
    fn a_page_of_pinyin_drills_in_a_chinese_book_leaves_nothing() {
        let reply = json!({
            "pages": [{ "number": "3", "lesson": null }],
            "lessonStarts": [{ "lesson": "1", "title": "Hello" }],
            "blocks": [{
                "kind": "sentences", "lesson": null, "heading": "Pronunciation", "number": null,
                "continues": false, "words": [],
                "lines": [
                    { "speaker": null, "text": "ā á ǎ à", "reading": null, "translation": null },
                    { "speaker": null, "text": "xuéxiào", "reading": null, "translation": null },
                    { "speaker": null, "text": "bāng máng", "reading": null, "translation": null }
                ]
            }]
        })
        .to_string();
        let page = parse_page(&reply, true).unwrap();
        assert!(lines(&page).is_empty());
        assert_eq!(page.lesson_starts[0].title, None);
        // A Dutch book's lines are its lines.
        assert_eq!(lines(&parse_page(&reply, false).unwrap()).len(), 3);
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
}
