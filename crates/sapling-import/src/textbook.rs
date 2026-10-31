//! A textbook's pages, transcribed, and the one lesson they become.
//!
//! A page arrives from the model (`sapling-llm`'s `textbook.rs`) as a
//! [`TextbookPage`]: its target-language blocks in reading order — dialogues,
//! standalone sentences, vocabulary lists — and nothing else on it. This
//! module holds the two steps after that, both pure:
//!
//! - [`tidy_page`]: the deterministic clean-up a reply gets whatever the model
//!   did — a speaker's dialogue number and colon, a translation that repeats
//!   the speaker, a sentence's "(1)" numbering, the spaces a Chinese or
//!   Japanese textbook prints between words, blank and elided lines;
//! - [`assemble_textbook`]: the pages of one lesson, in order, into what the
//!   import stores and offers — a title, one untimed segment per dialogue line
//!   or sentence, and the vocabulary list, one entry per term.
//!
//! Speakers, headings, readings and translations are kept on the page for the
//! review screen but are not stored: a stored text is only the text
//! (`reading.md`), and every reading and translation in the reader is derived.

use std::collections::HashMap;

use sapling_domain::types::Segment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One transcribed image: possibly a two-page spread.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextbookPage {
    /// Every printed page in the image, left to right.
    #[serde(default)]
    pub pages: Vec<PrintedPage>,
    /// A lesson whose opening is printed in the image.
    #[serde(default)]
    pub lesson_starts: Vec<LessonStart>,
    /// The target-language content, in reading order.
    #[serde(default)]
    pub blocks: Vec<TextbookBlock>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct PrintedPage {
    /// The printed page number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<String>,
    /// The lesson label in the running header or footer, as printed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lesson: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct LessonStart {
    pub lesson: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    /// Speakers taking turns, or one speaker's numbered passage.
    #[default]
    Dialogue,
    /// Standalone sentences: grammar examples, captions, phrase boxes, exercise questions.
    Sentences,
    /// A vocabulary list.
    Words,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct TextbookBlock {
    pub kind: BlockKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lesson: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub heading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub number: Option<String>,
    /// Cut off at the end of the previous page and carried on here.
    #[serde(default)]
    pub continues: bool,
    #[serde(default)]
    pub lines: Vec<TextbookLine>,
    #[serde(default)]
    pub words: Vec<TextbookWord>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct TextbookLine {
    /// Absent where the line continues the previous speaker, or has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speaker: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub translation: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct TextbookWord {
    /// The bare headword: no article, no conjugations.
    pub term: String,
    /// The article, part of speech or forms the book prints with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reading: Option<String>,
    /// Absent where the list prints none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meaning: Option<String>,
    /// A name or a place.
    #[serde(default)]
    pub proper: bool,
}

/// One lesson's pages, ready to review and store.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
pub struct TextbookDraft {
    /// The lesson's title as printed, with its label; absent when no page opens one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// One untimed segment per dialogue line or sentence, in reading order.
    pub segments: Vec<Segment>,
    /// The vocabulary lists, one entry per term, in the order first listed.
    pub words: Vec<TextbookWord>,
}

/// Han, kana and CJK punctuation: the scripts a textbook may print with spaces
/// between words that the text itself does not have. Not Hangul, which spaces
/// its words, and not `subtitles.rs`' `is_cjk`, which includes it.
fn unspaced(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x2FDF
            | 0x3001..=0x303F
            | 0x3040..=0x30FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0xFF00..=0xFFEF
            | 0x20000..=0x3FFFF
    )
}

/// Whitespace collapsed to one space, and none left between two characters of
/// a script written without spaces.
pub fn tidy_text(text: &str) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut out = String::new();
    for word in words {
        let joins = match (out.chars().last(), word.chars().next()) {
            (Some(before), Some(after)) => unspaced(before) && unspaced(after),
            _ => true,
        };
        if !out.is_empty() && !joins {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn non_blank(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// A dialogue's number ("1. Paolo", "3A. An") and a trailing colon ("A:") are
/// not the speaker.
fn tidy_speaker(speaker: Option<&str>) -> Option<String> {
    let mut speaker = speaker?.trim();
    let digits = speaker.find(|c: char| !c.is_ascii_digit()).unwrap_or(0);
    if digits > 0 {
        let rest = &speaker[digits..];
        let rest = rest
            .strip_prefix(|c: char| c.is_ascii_alphabetic())
            .filter(|r| r.starts_with('.'))
            .unwrap_or(rest);
        if let Some(rest) = rest.strip_prefix('.') {
            speaker = rest.trim_start();
        }
    }
    let speaker = speaker.trim_end_matches([':', '：']).trim_end();
    non_blank(Some(speaker))
}

/// "A: What's your name?" under speaker "A" is "What's your name?".
fn tidy_translation(translation: Option<&str>, speaker: Option<&str>) -> Option<String> {
    let translation = translation?.trim();
    let unlabelled = speaker
        .and_then(|speaker| translation.strip_prefix(speaker))
        .and_then(|rest| rest.trim_start().strip_prefix([':', '：']))
        .map(str::trim_start)
        .unwrap_or(translation);
    non_blank(Some(unlabelled))
}

/// A sentence's list number, "(1)" or "（1）", is the book's, not the sentence's.
fn strip_numbering(text: &str) -> &str {
    let trimmed = text.trim_start();
    let Some(rest) = trimmed.strip_prefix(['(', '（']) else {
        return text;
    };
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(0);
    if digits == 0 {
        return text;
    }
    rest[digits..]
        .strip_prefix([')', '）'])
        .map(str::trim_start)
        .unwrap_or(text)
}

/// A line that holds no word at all — "(...)", "……" — is an elision.
fn has_words(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// The clean-up every transcribed page gets, whatever the model did.
pub fn tidy_page(page: TextbookPage) -> TextbookPage {
    let blocks = page
        .blocks
        .into_iter()
        .map(|block| {
            let lines = block
                .lines
                .into_iter()
                .filter_map(|line| {
                    let text = tidy_text(strip_numbering(&line.text));
                    if !has_words(&text) {
                        return None;
                    }
                    let speaker = match block.kind {
                        BlockKind::Dialogue => tidy_speaker(line.speaker.as_deref()),
                        _ => None,
                    };
                    let translation =
                        tidy_translation(line.translation.as_deref(), line.speaker.as_deref())
                            .and_then(|t| tidy_translation(Some(&t), speaker.as_deref()));
                    Some(TextbookLine {
                        speaker,
                        text,
                        reading: non_blank(line.reading.as_deref()),
                        translation,
                    })
                })
                .collect();
            let words = block
                .words
                .into_iter()
                .filter_map(|word| {
                    let term = tidy_text(&word.term);
                    has_words(&term).then(|| TextbookWord {
                        term,
                        notes: non_blank(word.notes.as_deref()),
                        reading: non_blank(word.reading.as_deref()),
                        meaning: non_blank(word.meaning.as_deref()),
                        proper: word.proper,
                    })
                })
                .collect();
            TextbookBlock {
                lesson: non_blank(block.lesson.as_deref()),
                heading: non_blank(block.heading.as_deref()),
                number: non_blank(block.number.as_deref()),
                lines,
                words,
                ..block
            }
        })
        .filter(|block| !block.lines.is_empty() || !block.words.is_empty())
        .collect();
    let lesson_starts = page
        .lesson_starts
        .into_iter()
        .filter_map(|start| {
            Some(LessonStart {
                lesson: non_blank(Some(&start.lesson))?,
                title: non_blank(start.title.as_deref()),
            })
        })
        .collect();
    let pages = page
        .pages
        .into_iter()
        .map(|printed| PrintedPage {
            number: non_blank(printed.number.as_deref()),
            lesson: non_blank(printed.lesson.as_deref()),
        })
        .collect();
    TextbookPage {
        pages,
        lesson_starts,
        blocks,
    }
}

/// A word's identity in the list: its spelling, trimmed and lower-cased.
fn word_key(term: &str) -> String {
    term.trim().to_lowercase()
}

/// The pages of one lesson, in order, into its title, its segments and its
/// vocabulary.
///
/// - The title is the first lesson opening's title, prefixed with its label
///   where the title does not already say it ("3 · 你叫什么名字"), else the
///   label alone; absent when no page opens a lesson.
/// - Every dialogue line and sentence becomes one untimed segment, in page
///   order. A block that continues one from the previous page needs no
///   joining: segments carry no headings, so it simply follows on.
/// - A term listed twice — the same word on two pages, or in a list and again
///   as a proper noun — is one entry, the first, with any field it lacked
///   taken from the later one.
pub fn assemble_textbook(pages: &[TextbookPage]) -> TextbookDraft {
    let title = pages
        .iter()
        .flat_map(|page| &page.lesson_starts)
        .next()
        .map(|start| match &start.title {
            Some(title) if title.contains(&start.lesson) => title.clone(),
            Some(title) => format!("{} · {title}", start.lesson),
            None => start.lesson.clone(),
        });

    let mut segments = Vec::new();
    let mut words: Vec<TextbookWord> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for block in pages.iter().flat_map(|page| &page.blocks) {
        match block.kind {
            BlockKind::Words => {
                for word in &block.words {
                    let key = word_key(&word.term);
                    match index.get(&key) {
                        Some(&at) => {
                            let kept = &mut words[at];
                            kept.notes = kept.notes.take().or_else(|| word.notes.clone());
                            kept.reading = kept.reading.take().or_else(|| word.reading.clone());
                            kept.meaning = kept.meaning.take().or_else(|| word.meaning.clone());
                            kept.proper |= word.proper;
                        }
                        None => {
                            index.insert(key, words.len());
                            words.push(word.clone());
                        }
                    }
                }
            }
            BlockKind::Dialogue | BlockKind::Sentences => {
                segments.extend(block.lines.iter().map(|line| Segment {
                    text: line.text.clone(),
                    start: None,
                    end: None,
                }));
            }
        }
    }
    TextbookDraft {
        title,
        segments,
        words,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: Option<&str>, text: &str) -> TextbookLine {
        TextbookLine {
            speaker: speaker.map(str::to_owned),
            text: text.into(),
            ..TextbookLine::default()
        }
    }

    fn word(term: &str) -> TextbookWord {
        TextbookWord {
            term: term.into(),
            ..TextbookWord::default()
        }
    }

    fn dialogue(lines: Vec<TextbookLine>) -> TextbookBlock {
        TextbookBlock {
            kind: BlockKind::Dialogue,
            lines,
            ..TextbookBlock::default()
        }
    }

    fn words(words: Vec<TextbookWord>) -> TextbookBlock {
        TextbookBlock {
            kind: BlockKind::Words,
            words,
            ..TextbookBlock::default()
        }
    }

    fn page(blocks: Vec<TextbookBlock>) -> TextbookPage {
        TextbookPage {
            blocks,
            ..TextbookPage::default()
        }
    }

    #[test]
    fn spaces_go_only_between_characters_of_an_unspaced_script() {
        assert_eq!(tidy_text("你叫 什么 名字？"), "你叫什么名字？");
        assert_eq!(tidy_text(" 我 叫 李月。 "), "我叫李月。");
        assert_eq!(
            tidy_text("Dag  Els.\n Goedemorgen."),
            "Dag Els. Goedemorgen."
        );
        assert_eq!(tidy_text("我是 Peter 的朋友"), "我是 Peter 的朋友");
        // Korean spaces its words; Hangul is left alone.
        assert_eq!(tidy_text("저는 학생입니다"), "저는 학생입니다");
    }

    #[test]
    fn a_speaker_loses_its_dialogue_number_and_colon() {
        assert_eq!(tidy_speaker(Some("A:")).as_deref(), Some("A"));
        assert_eq!(tidy_speaker(Some("1. Paolo")).as_deref(), Some("Paolo"));
        assert_eq!(tidy_speaker(Some("3A. An")).as_deref(), Some("An"));
        assert_eq!(
            tidy_speaker(Some("prof. Deman")).as_deref(),
            Some("prof. Deman")
        );
        assert_eq!(
            tidy_speaker(Some("Anja, Barbara：")).as_deref(),
            Some("Anja, Barbara")
        );
        assert_eq!(tidy_speaker(Some(" : ")), None);
        assert_eq!(tidy_speaker(None), None);
    }

    #[test]
    fn a_translation_does_not_repeat_its_speaker() {
        assert_eq!(
            tidy_translation(Some("A: What's your name?"), Some("A")).as_deref(),
            Some("What's your name?")
        );
        assert_eq!(
            tidy_translation(Some("Away: gone"), Some("A")).as_deref(),
            Some("Away: gone")
        );
    }

    #[test]
    fn tidying_a_page_cleans_lines_and_drops_what_is_left_empty() {
        let tidied = tidy_page(TextbookPage {
            blocks: vec![
                dialogue(vec![
                    TextbookLine {
                        speaker: Some("A:".into()),
                        text: "你叫 什么 名字？".into(),
                        reading: Some(" Nǐ jiào shénme míngzi? ".into()),
                        translation: Some("A: What's your name?".into()),
                    },
                    line(None, "(...)"),
                    line(Some("2. Leen"), "  "),
                ]),
                TextbookBlock {
                    kind: BlockKind::Sentences,
                    lines: vec![line(Some("1"), "（1）李月是我的老师。")],
                    ..TextbookBlock::default()
                },
                words(vec![word(" "), word("名字")]),
                words(vec![]),
            ],
            ..TextbookPage::default()
        });
        assert_eq!(tidied.blocks.len(), 3);
        assert_eq!(
            tidied.blocks[0].lines,
            [TextbookLine {
                speaker: Some("A".into()),
                text: "你叫什么名字？".into(),
                reading: Some("Nǐ jiào shénme míngzi?".into()),
                translation: Some("What's your name?".into()),
            }]
        );
        // A sentence block has no speakers, and loses its numbering.
        assert_eq!(tidied.blocks[1].lines, [line(None, "李月是我的老师。")]);
        assert_eq!(tidied.blocks[2].words, [word("名字")]);
    }

    #[test]
    fn a_lesson_is_its_lines_in_page_order_and_its_words_once_each() {
        let first = TextbookPage {
            lesson_starts: vec![LessonStart {
                lesson: "3".into(),
                title: Some("你叫什么名字".into()),
            }],
            blocks: vec![
                dialogue(vec![line(Some("A"), "你叫什么名字？")]),
                words(vec![
                    TextbookWord {
                        term: "名字".into(),
                        reading: Some("míngzi".into()),
                        ..TextbookWord::default()
                    },
                    word("叫"),
                ]),
            ],
            ..TextbookPage::default()
        };
        let second = page(vec![
            TextbookBlock {
                continues: true,
                ..dialogue(vec![line(Some("B"), "我叫李月。")])
            },
            words(vec![
                TextbookWord {
                    term: "名字".into(),
                    meaning: Some("name".into()),
                    ..TextbookWord::default()
                },
                TextbookWord {
                    proper: true,
                    ..word("李月")
                },
            ]),
        ]);

        let draft = assemble_textbook(&[first, second]);
        assert_eq!(draft.title.as_deref(), Some("3 · 你叫什么名字"));
        let texts: Vec<&str> = draft.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["你叫什么名字？", "我叫李月。"]);
        assert!(draft.segments.iter().all(|s| s.start.is_none()));
        assert_eq!(
            draft.words,
            [
                TextbookWord {
                    term: "名字".into(),
                    reading: Some("míngzi".into()),
                    meaning: Some("name".into()),
                    ..TextbookWord::default()
                },
                word("叫"),
                TextbookWord {
                    proper: true,
                    ..word("李月")
                },
            ]
        );
    }

    #[test]
    fn the_title_is_the_label_where_the_title_is_missing_or_already_says_it() {
        let opening = |lesson: &str, title: Option<&str>| TextbookPage {
            lesson_starts: vec![LessonStart {
                lesson: lesson.into(),
                title: title.map(str::to_owned),
            }],
            ..TextbookPage::default()
        };
        assert_eq!(
            assemble_textbook(&[opening("LES 4", None)])
                .title
                .as_deref(),
            Some("LES 4")
        );
        assert_eq!(
            assemble_textbook(&[opening("4", Some("Les 4: Ik kom uit Italië"))])
                .title
                .as_deref(),
            Some("Les 4: Ik kom uit Italië")
        );
        assert_eq!(assemble_textbook(&[page(vec![])]).title, None);
    }

    #[test]
    fn a_page_reads_back_from_the_json_the_model_writes() {
        let page: TextbookPage = serde_json::from_str(
            r#"{"pages":[{"number":"14","lesson":null}],"lessonStarts":[],
                "blocks":[{"kind":"words","lesson":null,"heading":"New Words","number":null,
                "continues":false,"lines":[],"words":[{"term":"叫","notes":"v.","reading":"jiào",
                "meaning":"to call","proper":false}]}]}"#,
        )
        .unwrap();
        assert_eq!(page.pages[0].number.as_deref(), Some("14"));
        assert_eq!(page.blocks[0].kind, BlockKind::Words);
        assert_eq!(page.blocks[0].words[0].notes.as_deref(), Some("v."));
    }
}
