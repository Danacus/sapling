//! A textbook's pages, transcribed, and the chapters they become.
//!
//! A page arrives from the model (`sapling-llm`'s `textbook.rs`) as a
//! [`TextbookPage`]: its printed page numbers and running lesson labels, the
//! lessons that open on it, and its blocks in reading order — each a
//! `sapling-domain` [`Section`] (a dialogue with its speakers, standalone
//! sentences, or a vocabulary list with the book's own notes and meanings)
//! with the lesson its page labels it with and whether it carries on a block
//! cut off by the page before. The model's reply also has places for a
//! printed pronunciation guide and a line's translation — giving it somewhere
//! to put them is what keeps them out of the text — but neither leaves
//! `sapling-llm`: **readings are the frontend's** (`$lib/romanize`), and a book
//! keeps what it says in the target language, not its translations.
//!
//! The two steps after the model, both pure:
//!
//! - [`tidy_page`]: the deterministic clean-up every page gets whatever the
//!   model did — a sentence's "(1)", an "A:" left on a line, a speaker's
//!   dialogue number and colon, the spaces a Chinese or Japanese book prints
//!   between words, empty and elided lines, frames to complete ("我……"), and,
//!   for a target written in Han or kana, every pinyin run (`pinyin.rs`), every
//!   line and vocabulary term left with no character at all (a pinyin guide or
//!   drill, a translation that became a line), a lesson title with none
//!   ("Hello" under 你好), and in a `sentences` block a bare label (a warm-up
//!   word, "中国菜");
//! - [`assemble_book`]: a whole book's pages, in order, into its chapters —
//!   split where the lesson label changes, a continued block joined to the one
//!   it continues, each chapter titled by its opening and spanning the printed
//!   pages it came from.

use std::collections::{HashMap, HashSet};

use sapling_domain::types::{Chapter, Section, SectionKind, TextbookLine, TextbookWord};
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
    /// The target-language content, in reading order.
    #[serde(default)]
    pub blocks: Vec<PageBlock>,
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

/// One block of a page: the section it is, and where it belongs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
pub struct PageBlock {
    /// The lesson its page labels it with, as printed ("LES 2", "DEEL 1 - LES 3B").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lesson: Option<String>,
    /// Carries on a block cut off at the end of the previous page.
    #[serde(default)]
    pub continues: bool,
    pub section: Section,
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
/// either — only the lettered speakers textbooks use. Answers the letter too.
fn strip_letter_speaker(text: &str) -> (&str, Option<char>) {
    let trimmed = text.trim_start();
    let mut chars = trimmed.chars();
    match (
        chars.next(),
        chars.as_str().trim_start().strip_prefix([':', '：']),
    ) {
        (Some(letter), Some(rest)) if letter.is_ascii_uppercase() && !rest.trim().is_empty() => {
            (rest.trim_start(), Some(letter))
        }
        _ => (text, None),
    }
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
    non_blank(Some(speaker.trim_end_matches([':', '：']).trim_end()))
}

/// A line that holds no word at all — "(...)", "……" — is an elision.
fn has_words(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

/// A frame to complete, not a sentence: a line ending in an ellipsis with at
/// most three letters before it — "我……", "我的……", "Ik ...". "Dag Els en
/// ..." is a line someone says, and stays.
fn is_frame(text: &str) -> bool {
    let body = text.trim_end().trim_end_matches(['…', '.', '。', '⋯', ' ']);
    body.len() < text.trim_end().len() && body.chars().filter(|c| c.is_alphanumeric()).count() <= 3
}

/// For a Chinese or Japanese target, a picture label or a warm-up word rather
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
/// anywhere in its lines or words. A Dutch or Spanish page has none.
fn is_han_page(page: &TextbookPage) -> bool {
    page.blocks
        .iter()
        .flat_map(|block| {
            let section = &block.section;
            section
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .chain(section.words.iter().map(|word| word.term.as_str()))
        })
        .flat_map(str::chars)
        .filter(|&c| is_han_or_kana(c))
        .nth(1)
        .is_some()
}

/// A section's lines, tidied: what is not text in the target script goes. A
/// dropped line's speaker passes to the next kept line that names none — a
/// pinyin line printed above the characters often carries the "A:".
fn tidy_lines(kind: SectionKind, lines: Vec<TextbookLine>, han: bool) -> Vec<TextbookLine> {
    let mut pending: Option<String> = None;
    let mut kept = Vec::new();
    for line in lines {
        let (rest, letter) = strip_letter_speaker(strip_numbering(&line.text));
        let speaker = match kind {
            SectionKind::Dialogue => {
                tidy_speaker(line.speaker.as_deref()).or_else(|| letter.map(String::from))
            }
            _ => None,
        };
        let text = if han {
            tidy_text(&strip_pinyin(rest))
        } else {
            tidy_text(rest)
        };
        // For a Chinese target a line without a Chinese character is a pinyin
        // guide, a drill or a translation the model made a line of.
        let keep = has_words(&text)
            && !is_frame(&text)
            && (!han
                || (has_han_or_kana(&text)
                    && !(kind == SectionKind::Sentences && is_label(&text))));
        if !keep {
            pending = speaker.or(pending);
            continue;
        }
        kept.push(TextbookLine {
            speaker: speaker.or_else(|| pending.take()),
            text,
        });
        pending = None;
    }
    kept
}

/// A vocabulary list, tidied: for a Chinese target a term is its characters,
/// and one with none (a pinyin or English entry) is not a term.
fn tidy_words(words: Vec<TextbookWord>, han: bool) -> Vec<TextbookWord> {
    words
        .into_iter()
        .filter_map(|word| {
            let term = if han {
                tidy_text(&strip_pinyin(&word.term))
            } else {
                tidy_text(&word.term)
            };
            let keep = has_words(&term) && (!han || has_han_or_kana(&term));
            keep.then(|| TextbookWord {
                term,
                notes: non_blank(word.notes.as_deref()),
                meaning: non_blank(word.meaning.as_deref()),
                proper: word.proper,
            })
        })
        .collect()
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
        .filter_map(|block| {
            let section = block.section;
            let kind = section.kind;
            let lines = tidy_lines(kind, section.lines, han);
            let words = tidy_words(section.words, han);
            if lines.is_empty() && words.is_empty() {
                return None;
            }
            Some(PageBlock {
                lesson: non_blank(block.lesson.as_deref()),
                continues: block.continues,
                section: Section {
                    kind,
                    heading: non_blank(section.heading.as_deref()),
                    number: non_blank(section.number.as_deref()),
                    lines,
                    words,
                },
            })
        })
        .collect();
    let lesson_starts = page
        .lesson_starts
        .into_iter()
        .filter_map(|start| {
            Some(LessonStart {
                lesson: non_blank(Some(&start.lesson))?,
                // For a Chinese target a title is its characters: "Hello"
                // printed under 你好 is a translation, "Nǐ hǎo" over it a reading.
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

/// Which lesson a label names: its **last** number ("DEEL 1 - LES 3B" is 3,
/// "Lesson 12" is 12), else the label itself, case-folded ("第三课").
pub fn lesson_key(label: &str) -> Option<String> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let last_number = label
        .split(|c: char| !c.is_ascii_digit())
        .rfind(|run| !run.is_empty());
    Some(match last_number {
        Some(number) => match number.trim_start_matches('0') {
            "" => "0".to_owned(),
            trimmed => trimmed.to_owned(),
        },
        None => label.to_lowercase(),
    })
}

/// A chapter while it is being put together.
struct Building {
    key: Option<String>,
    label: Option<String>,
    first_page: Option<String>,
    last_page: Option<String>,
    sections: Vec<Section>,
}

impl Building {
    fn new(key: Option<String>, label: Option<String>) -> Self {
        Building {
            key,
            label,
            first_page: None,
            last_page: None,
            sections: Vec::new(),
        }
    }

    fn page(&mut self, number: Option<&str>) {
        if let Some(number) = number {
            self.first_page.get_or_insert_with(|| number.to_owned());
            self.last_page = Some(number.to_owned());
        }
    }

    /// A continued block joins the last section when it is the same kind;
    /// otherwise it is a section of its own.
    fn push(&mut self, block: PageBlock) {
        if block.continues {
            if let Some(last) = self.sections.last_mut() {
                if last.kind == block.section.kind {
                    last.lines.extend(block.section.lines);
                    last.words.extend(block.section.words);
                    return;
                }
            }
        }
        self.sections.push(block.section);
    }
}

/// A whole book's pages, in order, into its chapters.
///
/// - **Where a chapter starts**: a block's lesson is [`lesson_key`] of its own
///   label, else the lesson before it, else the page's running label, else a
///   lesson that opens on the page. A new chapter begins where that changes to
///   a lesson not seen yet; a label naming an earlier lesson again is a misread
///   header, and the block stays where it is. Blocks before the first lesson
///   are a chapter of their own with no label (an introduction).
/// - **What it is called**: the title of the lesson opening with its key, the
///   label as that opening prints it.
/// - **What it holds**: its blocks' sections in order, a block that continues
///   one cut off by the page before joined to it.
/// - **Which pages**: the printed numbers of the first and last pages that
///   gave it a block.
pub fn assemble_book(pages: &[TextbookPage]) -> Vec<Chapter> {
    let mut openings: HashMap<String, &LessonStart> = HashMap::new();
    for start in pages.iter().flat_map(|page| &page.lesson_starts) {
        if let Some(key) = lesson_key(&start.lesson) {
            openings.entry(key).or_insert(start);
        }
    }

    let mut chapters: Vec<Building> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for page in pages {
        let running = page
            .pages
            .iter()
            .find_map(|printed| printed.lesson.as_deref())
            .and_then(lesson_key);
        let opening = page
            .lesson_starts
            .first()
            .and_then(|start| lesson_key(&start.lesson));
        let first_number = page
            .pages
            .iter()
            .find_map(|printed| printed.number.as_deref());
        let last_number = page
            .pages
            .iter()
            .rev()
            .find_map(|printed| printed.number.as_deref());
        for block in page.blocks.iter().cloned() {
            let own = block.lesson.as_deref().and_then(lesson_key);
            let current = chapters.last().and_then(|c| c.key.clone());
            let key = own
                .or(current)
                .or_else(|| running.clone())
                .or_else(|| opening.clone());
            let starts_new = match (&key, chapters.last()) {
                (_, None) => true,
                (Some(key), Some(last)) => last.key.as_ref() != Some(key) && !seen.contains(key),
                (None, Some(_)) => false,
            };
            if starts_new {
                let label = key.as_ref().map(|key| {
                    openings
                        .get(key)
                        .map(|start| start.lesson.clone())
                        .or_else(|| block.lesson.clone())
                        .unwrap_or_else(|| key.clone())
                });
                if let Some(key) = &key {
                    seen.insert(key.clone());
                }
                chapters.push(Building::new(key, label));
            }
            let chapter = chapters.last_mut().expect("a chapter was just ensured");
            chapter.page(first_number);
            chapter.page(last_number);
            chapter.push(block);
        }
    }

    chapters
        .into_iter()
        .filter(|chapter| !chapter.sections.is_empty())
        .map(|chapter| Chapter {
            title: chapter
                .key
                .as_ref()
                .and_then(|key| openings.get(key))
                .and_then(|start| start.title.clone()),
            label: chapter.label,
            first_page: chapter.first_page,
            last_page: chapter.last_page,
            sections: chapter.sections,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: Option<&str>, text: &str) -> TextbookLine {
        TextbookLine {
            speaker: speaker.map(str::to_owned),
            text: text.into(),
        }
    }

    fn lines_of(kind: SectionKind, texts: &[&str]) -> Section {
        Section {
            kind,
            lines: texts.iter().map(|t| line(None, t)).collect(),
            ..Section::default()
        }
    }

    fn block(lesson: Option<&str>, section: Section) -> PageBlock {
        PageBlock {
            lesson: lesson.map(str::to_owned),
            continues: false,
            section,
        }
    }

    fn page(number: &str, blocks: Vec<PageBlock>) -> TextbookPage {
        TextbookPage {
            pages: vec![PrintedPage {
                number: Some(number.into()),
                lesson: None,
            }],
            blocks,
            ..TextbookPage::default()
        }
    }

    fn texts(page: &TextbookPage) -> Vec<&str> {
        page.blocks
            .iter()
            .flat_map(|b| &b.section.lines)
            .map(|l| l.text.as_str())
            .collect()
    }

    #[test]
    fn spaces_go_only_between_characters_of_an_unspaced_script() {
        assert_eq!(tidy_text("你叫 什么 名字？"), "你叫什么名字？");
        assert_eq!(
            tidy_text("Dag  Els.\n Goedemorgen."),
            "Dag Els. Goedemorgen."
        );
        assert_eq!(tidy_text("我是 Peter 的朋友"), "我是 Peter 的朋友");
        assert_eq!(tidy_text("저는 학생입니다"), "저는 학생입니다");
    }

    #[test]
    fn a_speaker_loses_its_number_and_colon_and_a_letter_left_on_a_line_becomes_one() {
        assert_eq!(tidy_speaker(Some("A:")).as_deref(), Some("A"));
        assert_eq!(tidy_speaker(Some("1. Paolo")).as_deref(), Some("Paolo"));
        assert_eq!(
            tidy_speaker(Some("prof. Deman")).as_deref(),
            Some("prof. Deman")
        );
        let tidied = tidy_page(
            page(
                "14",
                vec![block(
                    None,
                    Section {
                        kind: SectionKind::Dialogue,
                        lines: vec![
                            line(None, "A: 你好！"),
                            line(Some("2. Leen"), "我叫 Leen。"),
                        ],
                        ..Section::default()
                    },
                )],
            ),
            false,
        );
        assert_eq!(
            tidied.blocks[0].section.lines,
            [line(Some("A"), "你好！"), line(Some("Leen"), "我叫 Leen。")]
        );
    }

    #[test]
    fn a_chinese_target_keeps_only_its_characters() {
        let tidied = tidy_page(
            TextbookPage {
                lesson_starts: vec![LessonStart {
                    lesson: "1".into(),
                    title: Some("Hello".into()),
                }],
                blocks: vec![
                    block(
                        None,
                        Section {
                            kind: SectionKind::Dialogue,
                            lines: vec![
                                line(Some("A"), "Nǐ jiào shénme míngzi?"),
                                line(Some("A"), "你叫 什么 名字？"),
                                line(Some("B"), "Wǒ jiào Lǐ Yuè. 我叫李月。"),
                                line(None, "What's your name?"),
                                line(None, "我叫李月"),
                            ],
                            ..Section::default()
                        },
                    ),
                    block(
                        None,
                        lines_of(SectionKind::Sentences, &["ā á ǎ à", "xuéxiào"]),
                    ),
                    block(
                        None,
                        lines_of(
                            SectionKind::Sentences,
                            &["妈妈", "中国菜", "我……", "（1）她是我的老师。"],
                        ),
                    ),
                    block(
                        None,
                        Section {
                            kind: SectionKind::Words,
                            words: vec![
                                TextbookWord {
                                    term: "名字 míngzi".into(),
                                    notes: Some(" n. ".into()),
                                    meaning: Some("name".into()),
                                    proper: false,
                                },
                                TextbookWord {
                                    term: "xuéxiào".into(),
                                    ..TextbookWord::default()
                                },
                            ],
                            ..Section::default()
                        },
                    ),
                ],
                ..TextbookPage::default()
            },
            true,
        );
        assert_eq!(
            texts(&tidied),
            ["你叫什么名字？", "我叫李月。", "我叫李月", "她是我的老师。"]
        );
        // The drill block left nothing and is gone; the speakers stay.
        assert_eq!(tidied.blocks.len(), 3);
        assert_eq!(
            tidied.blocks[0].section.lines[0].speaker.as_deref(),
            Some("A")
        );
        assert_eq!(
            tidied.blocks[2].section.words,
            [TextbookWord {
                term: "名字".into(),
                notes: Some("n.".into()),
                meaning: Some("name".into()),
                proper: false,
            }]
        );
        assert_eq!(tidied.lesson_starts[0].title, None);
    }

    #[test]
    fn a_latin_book_keeps_its_lines_and_its_word_list() {
        let tidied = tidy_page(
            page(
                "15",
                vec![
                    block(
                        Some("LES 2"),
                        lines_of(
                            SectionKind::Dialogue,
                            &[
                                "Hallo ! Goedemorgen.",
                                "Dag Els en ...",
                                "Ik ...",
                                "(...)",
                                "Goedenavond",
                            ],
                        ),
                    ),
                    block(
                        Some("LES 2"),
                        Section {
                            kind: SectionKind::Words,
                            words: vec![TextbookWord {
                                term: "collega".into(),
                                notes: Some("de".into()),
                                ..TextbookWord::default()
                            }],
                            ..Section::default()
                        },
                    ),
                ],
            ),
            false,
        );
        assert_eq!(
            texts(&tidied),
            ["Hallo ! Goedemorgen.", "Dag Els en ...", "Goedenavond"]
        );
        assert_eq!(tidied.blocks[1].section.words[0].term, "collega");
    }

    #[test]
    fn a_lesson_is_the_last_number_of_its_label() {
        assert_eq!(lesson_key("DEEL 1 - LES 3B").as_deref(), Some("3"));
        assert_eq!(lesson_key("LES 2").as_deref(), Some("2"));
        assert_eq!(lesson_key("Lesson 12").as_deref(), Some("12"));
        assert_eq!(lesson_key("03").as_deref(), Some("3"));
        assert_eq!(lesson_key("第三课").as_deref(), Some("第三课"));
        assert_eq!(lesson_key(" "), None);
    }

    #[test]
    fn a_book_splits_into_chapters_where_the_lesson_changes() {
        let dialogue = |lesson: Option<&str>, texts: &[&str]| {
            block(lesson, lines_of(SectionKind::Dialogue, texts))
        };
        let pages = vec![
            // An introduction before any lesson.
            page("1", vec![dialogue(None, &["汉语很有意思。"])]),
            TextbookPage {
                pages: vec![PrintedPage {
                    number: Some("14".into()),
                    lesson: None,
                }],
                lesson_starts: vec![LessonStart {
                    lesson: "3".into(),
                    title: Some("你叫什么名字".into()),
                }],
                blocks: vec![dialogue(Some("3"), &["你叫什么名字？"])],
            },
            // Cut off at the page break and carried on, then a block with no label.
            page(
                "15",
                vec![
                    PageBlock {
                        continues: true,
                        ..dialogue(Some("3"), &["我叫李月。"])
                    },
                    dialogue(None, &["你好！"]),
                ],
            ),
            // A misread header naming lesson 3 again later stays put; then a
            // spread: the end of lesson 3, and lesson 4 opens.
            TextbookPage {
                pages: vec![
                    PrintedPage {
                        number: Some("16".into()),
                        lesson: Some("DEEL 1 - LES 3".into()),
                    },
                    PrintedPage {
                        number: Some("17".into()),
                        lesson: Some("LES 4".into()),
                    },
                ],
                lesson_starts: vec![LessonStart {
                    lesson: "LES 4".into(),
                    title: Some("她是我的汉语老师".into()),
                }],
                blocks: vec![
                    dialogue(Some("DEEL 1 - LES 3"), &["李月是老师。"]),
                    dialogue(Some("LES 4"), &["她是我的汉语老师。"]),
                ],
            },
            page("18", vec![dialogue(Some("3"), &["她是哪国人？"])]),
        ];
        let chapters = assemble_book(&pages);
        let summary: Vec<_> = chapters
            .iter()
            .map(|c| {
                (
                    c.label.as_deref(),
                    c.title.as_deref(),
                    c.first_page.as_deref(),
                    c.last_page.as_deref(),
                    c.sections.len(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (None, None, Some("1"), Some("1"), 1),
                (Some("3"), Some("你叫什么名字"), Some("14"), Some("17"), 3),
                (
                    Some("LES 4"),
                    Some("她是我的汉语老师"),
                    Some("16"),
                    Some("18"),
                    2
                ),
            ]
        );
        // The continued dialogue is one section of two lines.
        let lesson3 = &chapters[1].sections;
        assert_eq!(lesson3[0].lines.len(), 2);
        assert_eq!(lesson3[1].lines[0].text, "你好！");
        assert_eq!(lesson3[2].lines[0].text, "李月是老师。");
        assert_eq!(chapters[2].sections[1].lines[0].text, "她是哪国人？");
    }

    #[test]
    fn a_page_reads_back_from_the_json_the_protocol_carries() {
        let page: TextbookPage = serde_json::from_str(
            r#"{"pages":[{"number":"14"}],"lessonStarts":[],
                "blocks":[{"lesson":"3","continues":false,"section":{"kind":"words",
                "heading":"New Words","lines":[],"words":[{"term":"叫","notes":"v.",
                "meaning":"to call","proper":false}]}}]}"#,
        )
        .unwrap();
        assert_eq!(page.blocks[0].section.kind, SectionKind::Words);
        assert_eq!(page.blocks[0].section.words[0].notes.as_deref(), Some("v."));
    }
}
