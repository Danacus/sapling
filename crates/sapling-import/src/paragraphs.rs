//! Prose as an import format: a pasted or uploaded text, one segment per
//! paragraph.
//!
//! A paragraph is the unit its writer chose, so it is the unit that is stored.
//! Sentences are not cut here: the reader splits a paragraph too long for one
//! page at the sentence boundaries ICU finds, on screen and never in the store,
//! so no rule about abbreviations or decimals lives in the data.
//!
//! A paragraph is kept verbatim apart from trimming — its own line breaks
//! included, because a song or a poem is laid out in them.

use crate::subtitles::normalize_newlines;

/// Whether a line is blank: nothing on it but spaces and tabs.
fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// The paragraphs of `text`: runs of lines separated by one or more blank
/// lines, each trimmed, empty ones dropped. A byte-order mark and CRLF/CR line
/// endings are normalised first, so a file saved on any system cuts the same.
pub fn split_paragraphs(text: &str) -> Vec<String> {
    let normalized = normalize_newlines(text);
    let mut out = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    for line in normalized.split('\n') {
        if is_blank(line) {
            if !paragraph.is_empty() {
                out.push(paragraph.join("\n").trim().to_owned());
                paragraph.clear();
            }
        } else {
            paragraph.push(line);
        }
    }
    if !paragraph.is_empty() {
        out.push(paragraph.join("\n").trim().to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_on_blank_lines_and_keeps_each_paragraph_whole() {
        assert_eq!(
            split_paragraphs("Fuimos al restaurante. Pedí sopa.\n\nLa cuenta no era cara."),
            [
                "Fuimos al restaurante. Pedí sopa.",
                "La cuenta no era cara."
            ]
        );
    }

    #[test]
    fn keeps_the_line_breaks_inside_a_paragraph() {
        assert_eq!(
            split_paragraphs("床前明月光\n疑是地上霜\n\n举头望明月\n低头思故乡"),
            ["床前明月光\n疑是地上霜", "举头望明月\n低头思故乡"]
        );
    }

    #[test]
    fn treats_a_run_of_blank_or_whitespace_lines_as_one_break_and_trims() {
        assert_eq!(
            split_paragraphs("\u{FEFF}  Uno. \r\n \t \r\n\r\n\r\n  Dos.  \r\n"),
            ["Uno.", "Dos."]
        );
    }

    #[test]
    fn has_nothing_to_say_about_an_empty_text() {
        assert!(split_paragraphs("").is_empty());
        assert!(split_paragraphs("  \n \n").is_empty());
    }
}
