//! Splitting an imported text into sentences — locally, before anything is
//! sent.
//!
//! The split happens here rather than in the model's reply for one reason: the
//! text on screen must be exactly what the learner pasted. A model handed a
//! blob and asked to return it in pieces will silently tidy punctuation, merge
//! a clause it finds ungainly and drop a line it takes for a heading. So the
//! app cuts, sends the pieces numbered, and asks only for annotations back.
//!
//! Deliberately unclever. It has no opinion about abbreviations or decimals; it
//! knows sentence-final punctuation and hard newlines, which between them cover
//! prose, dialogue and transcript blobs. A text with no punctuation at all — a
//! subtitle dump, a lyric sheet — falls back to one sentence per line, which is
//! exactly how such a text is already laid out.

/// The marks a sentence ends on, in both the Latin and the CJK sets.
///
/// `…` is in: a line that trails off is a whole sentence, and the alternative
/// is gluing it to the next one. `;` and `:` are out — they join clauses rather
/// than closing them.
fn is_ender(c: char) -> bool {
    matches!(c, '.' | '!' | '?' | '。' | '！' | '？' | '…')
}

/// Marks that ride along at the end of a sentence rather than starting the
/// next one — the closing half of every quote and bracket pair. Without this,
/// `He said "go."` would leave a lone `"` opening the following sentence.
fn is_closer(c: char) -> bool {
    matches!(
        c,
        '"' | '\''
            | '”'
            | '’'
            | '»'
            | '›'
            | ')'
            | ']'
            | '}'
            | '」'
            | '』'
            | '）'
            | '】'
            | '〕'
            | '》'
    )
}

/// Whether `text` closes a sentence anywhere.
pub fn has_sentence_end(text: &str) -> bool {
    text.chars().any(is_ender)
}

/// Splits one line, keeping every mark with the sentence it closes. A run of
/// enders is one ending: `...` and `?!` close a sentence once.
fn split_line<'a>(line: &'a str, out: &mut Vec<&'a str>) {
    let mut start = 0;
    let mut chars = line.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if !is_ender(c) {
            continue;
        }
        while chars.next_if(|&(_, c)| is_ender(c)).is_some() {}
        while chars.next_if(|&(_, c)| is_closer(c)).is_some() {}
        let end = chars.peek().map_or(line.len(), |&(i, _)| i);
        let piece = line[start..end].trim();
        if !piece.is_empty() {
            out.push(piece);
        }
        start = end;
    }
    let tail = line[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
}

/// Splits `text` into sentences: on sentence-final punctuation, and on every
/// hard newline.
///
/// Newlines split unconditionally, because a line break in a pasted text is an
/// authorial decision — a line of dialogue, a subtitle cue, a bullet — and
/// running two together to satisfy a missing full stop would misrepresent the
/// source. Blank pieces are dropped and every survivor is trimmed, so each
/// sentence is a substring of `text`.
pub fn split_sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        split_line(line, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_spanish_prose_on_its_sentence_final_punctuation() {
        assert_eq!(
            split_sentences(
                "El sábado fuimos al restaurante. ¿Tienen una mesa para dos? ¡Claro que sí!"
            ),
            [
                "El sábado fuimos al restaurante.",
                "¿Tienen una mesa para dos?",
                "¡Claro que sí!"
            ]
        );
    }

    #[test]
    fn splits_mandarin_which_has_no_spaces_to_help() {
        assert_eq!(
            split_sentences("我们去了饭馆。有两个人的桌子吗？太好了！"),
            ["我们去了饭馆。", "有两个人的桌子吗？", "太好了！"]
        );
    }

    #[test]
    fn keeps_a_closing_quote_with_the_sentence_it_closes() {
        assert_eq!(
            split_sentences("She said \"go.\" Then she left."),
            ["She said \"go.\"", "Then she left."]
        );
        assert_eq!(
            split_sentences("姐姐问：“有桌子吗？”我说有。"),
            ["姐姐问：“有桌子吗？”", "我说有。"]
        );
    }

    #[test]
    fn treats_a_run_of_marks_as_one_ending() {
        assert_eq!(
            split_sentences("¿Qué?! No lo sé... Bueno."),
            ["¿Qué?!", "No lo sé...", "Bueno."]
        );
    }

    #[test]
    fn splits_on_hard_newlines_even_mid_sentence() {
        assert_eq!(
            split_sentences("Uno\ndos. Tres\n\ncuatro"),
            ["Uno", "dos.", "Tres", "cuatro"]
        );
        assert_eq!(split_sentences("Uno\r\ndos."), ["Uno", "dos."]);
    }

    #[test]
    fn gives_a_transcript_blob_one_sentence_per_line() {
        let blob = [
            "so anyway I was walking home",
            "and I saw this cat",
            "   it was just sitting there   ",
            "",
            "anyway",
        ]
        .join("\n");
        assert_eq!(
            split_sentences(&blob),
            [
                "so anyway I was walking home",
                "and I saw this cat",
                "it was just sitting there",
                "anyway"
            ]
        );
    }

    #[test]
    fn drops_blanks_and_trims_what_is_left() {
        assert!(split_sentences("   \n\n   ").is_empty());
        assert!(split_sentences("").is_empty());
        assert_eq!(split_sentences("  Hola.  "), ["Hola."]);
    }

    #[test]
    fn loses_no_characters_but_whitespace() {
        let input = "Uno. Dos!\n¿Tres? \"Cuatro.\"\ncinco";
        let strip = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
        assert_eq!(strip(&split_sentences(input).concat()), strip(input));
    }

    #[test]
    fn knows_whether_a_text_ends_a_sentence_anywhere() {
        assert!(has_sentence_end("不妨订阅我们。"));
        assert!(has_sentence_end("so… anyway"));
        assert!(!has_sentence_end("这个字有三个读音"));
    }
}
