//! A textbook's pages, transcribed, and the one lesson they become.
//!
//! A page arrives from the model (`sapling-llm`'s `textbook.rs`) as a
//! [`TextbookPage`]: its target-language lines in reading order, block by
//! block, and nothing else on it. The model's reply also sorts out speakers,
//! printed pronunciation guides, translations and vocabulary lists — giving it
//! somewhere to put them is what keeps them out of the lines — but none of
//! that leaves `sapling-llm`: **a stored text is only the text** (`reading.md`),
//! readings are the frontend's (`$lib/romanize`), and words are added from a
//! stored text afterwards, not here.
//!
//! This module holds the two steps after the model, both pure:
//!
//! - [`tidy_page`]: the deterministic clean-up every page gets whatever the
//!   model did — a sentence's "(1)" numbering, an "A:" left on a line, the
//!   spaces a Chinese or Japanese book prints between words, empty and elided
//!   lines, and, on a page written in Han or kana, every pinyin run inside a
//!   line and every line with no Han or kana in it at all (a pinyin guide or a
//!   translation that landed as a line) — `pinyin.rs`; and what is not a
//!   sentence: a frame to complete ("我……") and, on such a page, a bare label
//!   with no punctuation (a warm-up word, a picture caption like "中国菜");
//! - [`assemble_textbook`]: the pages of one lesson, in order, into a title
//!   and one untimed segment per line.

use sapling_domain::types::Segment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pinyin::{has_han_or_kana, is_han_or_kana, strip_pinyin};

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
    /// The target-language lines, block by block, in reading order.
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
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct TextbookBlock {
    pub kind: BlockKind,
    /// One entry per printed line, target language only.
    #[serde(default)]
    pub lines: Vec<String>,
}

/// One lesson's pages, ready to review and store.
#[derive(Debug, Clone, Default, PartialEq, Serialize, TS)]
pub struct TextbookDraft {
    /// The lesson's title as printed, with its label; absent when no page opens one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    /// One untimed segment per line, in reading order.
    pub segments: Vec<Segment>,
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
    let mut out = String::new();
    for word in text.split_whitespace() {
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

/// A speaker label the model left on the line: one capital letter and a colon,
/// "A: 你好" or "B：我叫李月。". A name is not stripped — "Els: Dag." could be
/// either — only the lettered speakers textbooks use.
fn strip_letter_speaker(text: &str) -> &str {
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars();
    match (
        chars.next(),
        chars.as_str().trim_start().strip_prefix([':', '：']),
    ) {
        (Some(letter), Some(rest)) if letter.is_ascii_uppercase() && !rest.trim().is_empty() => {
            rest.trim_start()
        }
        _ => text,
    }
}

/// A line that holds no word at all — "(...)", "……" — is an elision.
fn has_words(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// A frame to complete, not a sentence: a line ending in an ellipsis with at
/// most three letters before it — "我……", "我的……", "B: ……". "Dag Els en
/// ..." is a line someone says, and stays.
fn is_frame(text: &str) -> bool {
    let body = text.trim_end().trim_end_matches(['…', '.', '。', '⋯', ' ']);
    body.len() < text.trim_end().len() && body.chars().filter(|c| c.is_alphanumeric()).count() <= 3
}

/// On a Chinese or Japanese page, a picture label or a warm-up word rather
/// than a sentence: no punctuation at all, and at most four Han characters
/// ("妈妈", "说汉语", "中国菜"). Asked only of a `sentences` block: a
/// dialogue's line is said by someone, and a model that dropped its full stop
/// ("我叫李月") must not cost the learner the line.
fn is_label(text: &str) -> bool {
    !text
        .chars()
        .any(|c| c.is_ascii_punctuation() || matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFF65))
        && text.chars().filter(|&c| is_han_or_kana(c)).count() <= 4
}

/// Whether the page is written in Han or kana: a couple of such characters
/// anywhere in its lines. A Dutch or Spanish page has none.
fn is_han_page(page: &TextbookPage) -> bool {
    page.blocks
        .iter()
        .flat_map(|block| &block.lines)
        .flat_map(|line| line.chars())
        .filter(|&c| is_han_or_kana(c))
        .nth(1)
        .is_some()
}

/// The clean-up every transcribed page gets, whatever the model did.
///
/// `han_target` says the language being learned is written in Han or kana —
/// Chinese, Japanese — which decides the script for **every** page of it. A
/// page alone cannot be trusted to say so: a pronunciation lesson's tone
/// tables and drill words ("ā á ǎ à", "xuéxiào") hold no character at all,
/// and read page by page they looked like a Latin page and were kept. Without
/// the flag (a host that cannot tell), a page with Han or kana on it counts.
pub fn tidy_page(page: TextbookPage, han_target: bool) -> TextbookPage {
    let han = han_target || is_han_page(&page);
    let blocks = page
        .blocks
        .into_iter()
        .map(|block| TextbookBlock {
            lines: block
                .lines
                .into_iter()
                .filter_map(|line| {
                    let line = strip_letter_speaker(strip_numbering(&line));
                    let text = if han {
                        tidy_text(&strip_pinyin(line))
                    } else {
                        tidy_text(line)
                    };
                    // On a Chinese page a line without a Chinese character is a
                    // pinyin guide or a translation the model made a line of.
                    let keep = has_words(&text)
                        && !is_frame(&text)
                        && (!han
                            || (has_han_or_kana(&text)
                                && !(block.kind == BlockKind::Sentences && is_label(&text))));
                    keep.then_some(text)
                })
                .collect(),
            ..block
        })
        .filter(|block| !block.lines.is_empty())
        .collect();
    let lesson_starts = page
        .lesson_starts
        .into_iter()
        .filter_map(|start| {
            Some(LessonStart {
                lesson: non_blank(Some(&start.lesson))?,
                // On a Chinese page a title is its characters: "Hello" printed
                // under 你好 is a translation, "Nǐ hǎo" over it a reading.
                title: non_blank(start.title.as_deref())
                    .map(|title| {
                        if han {
                            tidy_text(&strip_pinyin(&title))
                        } else {
                            title
                        }
                    })
                    .filter(|title| has_words(title) && (!han || has_han_or_kana(title))),
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

/// The pages of one lesson, in order, into its title and its segments.
///
/// - The title is the first lesson opening's title, prefixed with its label
///   where the title does not already say it ("3 · 你叫什么名字"), else the
///   label alone; absent when no page opens a lesson.
/// - Every line becomes one untimed segment, in page order. A block that
///   continues one from the previous page needs no joining: segments carry no
///   headings, so it simply follows on.
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
    let segments = pages
        .iter()
        .flat_map(|page| &page.blocks)
        .flat_map(|block| &block.lines)
        .map(|line| Segment {
            text: line.clone(),
            start: None,
            end: None,
        })
        .collect();
    TextbookDraft { title, segments }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(kind: BlockKind, lines: &[&str]) -> TextbookBlock {
        TextbookBlock {
            kind,
            lines: lines.iter().map(|line| (*line).to_owned()).collect(),
        }
    }

    fn page(blocks: Vec<TextbookBlock>) -> TextbookPage {
        TextbookPage {
            blocks,
            ..TextbookPage::default()
        }
    }

    /// Page-by-page detection only, as a host that cannot name the script.
    fn tidy_page_test(page: TextbookPage) -> TextbookPage {
        tidy_page(page, false)
    }

    #[test]
    fn a_chinese_target_drops_the_pinyin_of_a_page_with_no_characters_on_it() {
        // A pronunciation lesson: tone tables and drill words, no hanzi at all.
        let drill = TextbookPage {
            lesson_starts: vec![LessonStart {
                lesson: "1".into(),
                title: Some("Hello".into()),
            }],
            blocks: vec![
                block(BlockKind::Sentences, &["ā á ǎ à", "ū ú ǔ ù", "ǖ ǘ ǚ ǜ"]),
                block(BlockKind::Sentences, &["xuéxiào", "yóu yǒng", "shíjiān"]),
            ],
            ..TextbookPage::default()
        };
        let as_chinese = tidy_page(drill.clone(), true);
        assert!(lines(&as_chinese).is_empty());
        // The English under 你好 is not the lesson's title in Chinese.
        assert_eq!(as_chinese.lesson_starts[0].title, None);
        // Read alone, the page would look Latin; that is what the flag is for.
        assert_eq!(lines(&tidy_page(drill, false)).len(), 6);

        let mixed = tidy_page(
            TextbookPage {
                lesson_starts: vec![LessonStart {
                    lesson: "1".into(),
                    title: Some("Nǐ hǎo 你好 Hello".into()),
                }],
                blocks: vec![block(
                    BlockKind::Sentences,
                    &["汉语的音节一般由声母、韵母、声调三部分组成。", "bāng máng"],
                )],
                ..TextbookPage::default()
            },
            true,
        );
        assert_eq!(
            lines(&mixed),
            ["汉语的音节一般由声母、韵母、声调三部分组成。"]
        );
        assert_eq!(mixed.lesson_starts[0].title.as_deref(), Some("你好 Hello"));
    }

    fn lines(page: &TextbookPage) -> Vec<&str> {
        page.blocks
            .iter()
            .flat_map(|b| &b.lines)
            .map(String::as_str)
            .collect()
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
    fn a_chinese_page_keeps_only_its_chinese() {
        let tidied = tidy_page_test(page(vec![
            block(
                BlockKind::Dialogue,
                &[
                    // Pinyin printed above, copied as a line of its own.
                    "Nǐ jiào shénme míngzi?",
                    "你叫 什么 名字？",
                    // Copied into the line, before or after it, or word by word.
                    "Wǒ jiào Lǐ Yuè. 我叫李月。",
                    "你好！Nǐ hǎo!",
                    "你 nǐ 是 shì 学生 xuésheng 吗 ma？",
                    // A translation that became a line.
                    "What's your name?",
                    "A: 你是哪国人？",
                    // Its full stop dropped, but a dialogue line all the same.
                    "我叫李月",
                    "(...)",
                ],
            ),
            block(
                BlockKind::Sentences,
                &["（1）我是 Peter 的朋友。", "Zhōngguó"],
            ),
            // Warm-up words and frames to complete are not sentences.
            block(
                BlockKind::Sentences,
                &[
                    "妈妈",
                    "说 汉语",
                    "中国菜",
                    "我……",
                    "我的……",
                    "好！",
                    "你会写汉字吗？",
                ],
            ),
        ]));
        assert_eq!(
            lines(&tidied),
            [
                "你叫什么名字？",
                "我叫李月。",
                "你好！",
                "你是学生吗？",
                "你是哪国人？",
                "我叫李月",
                "我是 Peter 的朋友。",
                "好！",
                "你会写汉字吗？"
            ]
        );
    }

    #[test]
    fn a_latin_page_keeps_its_lines_and_its_accents() {
        let tidied = tidy_page_test(page(vec![block(
            BlockKind::Dialogue,
            &[
                "Hallo ! Goedemorgen.",
                "¿Qué desea?",
                "Un café, por favor.",
                "Dag Els en ...",
                "Ik ...",
                "  ",
                "(...)",
                // A bare word is a label only on a Chinese page.
                "Goedenavond",
            ],
        )]));
        assert_eq!(
            lines(&tidied),
            [
                "Hallo ! Goedemorgen.",
                "¿Qué desea?",
                "Un café, por favor.",
                "Dag Els en ...",
                "Goedenavond"
            ]
        );
    }

    #[test]
    fn only_a_lettered_speaker_comes_off_a_line() {
        assert_eq!(strip_letter_speaker("A: 你好"), "你好");
        assert_eq!(strip_letter_speaker("B：我叫李月。"), "我叫李月。");
        assert_eq!(strip_letter_speaker("Els: Dag."), "Els: Dag.");
        assert_eq!(strip_letter_speaker("A:"), "A:");
        assert_eq!(
            strip_letter_speaker("Ah ! An, goedemiddag."),
            "Ah ! An, goedemiddag."
        );
    }

    #[test]
    fn a_lesson_is_its_lines_in_page_order() {
        let first = TextbookPage {
            lesson_starts: vec![LessonStart {
                lesson: "3".into(),
                title: Some("Nǐ jiào shénme míngzi 你叫什么名字".into()),
            }],
            blocks: vec![block(BlockKind::Dialogue, &["你叫什么名字？"])],
            ..TextbookPage::default()
        };
        let second = page(vec![block(BlockKind::Dialogue, &["我叫李月。"])]);
        let draft = assemble_textbook(&[tidy_page_test(first), tidy_page_test(second)]);
        assert_eq!(draft.title.as_deref(), Some("3 · 你叫什么名字"));
        let texts: Vec<&str> = draft.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["你叫什么名字？", "我叫李月。"]);
        assert!(draft.segments.iter().all(|s| s.start.is_none()));
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
}
