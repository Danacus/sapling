//! The deterministic half of the reading import: what a pasted or uploaded
//! text *is*, and the sentences it cuts into — before anything is sent to a
//! model.
//!
//! A plain library: no SQL, no clock, no I/O. Everything here is a function of
//! the text's own bytes. [`import_source`] is the one entry point the protocol
//! exposes (`importSource`); [`sentences`] and [`subtitles`] are its halves.

#![forbid(unsafe_code)]

use serde::Serialize;
use ts_rs::TS;

pub mod sentences;
pub mod subtitles;

pub use sentences::{has_sentence_end, split_sentences};
pub use subtitles::{
    cues_to_sentences, detect_subtitle_format, parse_subtitles, Cue, SubtitleFormat, TimedSentence,
};

/// When one sentence is spoken, in milliseconds from the start of the media.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, TS)]
pub struct Timing {
    pub start: f64,
    pub end: f64,
}

/// A text on its way in, recognised and cut into sentences.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSource {
    /// The subtitle format the text was read as; absent for prose.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub format: Option<SubtitleFormat>,
    /// How many cues the subtitles held once cleaned; `0` for prose.
    pub cues: usize,
    /// The furthest point any cue reaches, in milliseconds; `0` for prose.
    pub duration_ms: f64,
    /// The sentences, verbatim substrings of the text.
    pub sentences: Vec<String>,
    /// Index-aligned with `sentences`; present only for subtitles.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timings: Option<Vec<Timing>>,
}

/// Recognises `text` and cuts it into sentences.
///
/// Subtitles are cleaned into cues and re-cut with [`cues_to_sentences`], each
/// sentence keeping its timing; anything else is prose and is split with
/// [`split_sentences`], untimed. The content decides, never a file name.
pub fn import_source(text: &str) -> ImportedSource {
    let Some((format, cues)) = parse_subtitles(text) else {
        return ImportedSource {
            format: None,
            cues: 0,
            duration_ms: 0.0,
            sentences: split_sentences(text)
                .into_iter()
                .map(str::to_owned)
                .collect(),
            timings: None,
        };
    };
    let timed = cues_to_sentences(&cues);
    ImportedSource {
        format: Some(format),
        cues: cues.len(),
        duration_ms: cues.iter().fold(0.0, |furthest, cue| cue.end.max(furthest)),
        timings: Some(
            timed
                .iter()
                .map(|s| Timing {
                    start: s.start,
                    end: s.end,
                })
                .collect(),
        ),
        sentences: timed.into_iter().map(|s| s.text).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_is_split_and_untimed() {
        let source = import_source("Fuimos al restaurante. Pedí sopa.\nLa cuenta no era cara.");
        assert_eq!(
            source,
            ImportedSource {
                format: None,
                cues: 0,
                duration_ms: 0.0,
                sentences: vec![
                    "Fuimos al restaurante.".into(),
                    "Pedí sopa.".into(),
                    "La cuenta no era cara.".into()
                ],
                timings: None,
            }
        );
    }

    #[test]
    fn subtitles_are_recut_and_keep_their_timings() {
        let source =
            import_source("1\n00:00:01,000 --> 00:00:03,500\nHola. Adiós.\n\n2\n00:00:03,500 --> 00:00:06,000\nBien.\n");
        assert_eq!(source.format, Some(SubtitleFormat::Srt));
        assert_eq!(source.cues, 2);
        assert_eq!(source.duration_ms, 6000.0);
        assert_eq!(source.sentences, ["Hola.", "Adiós.", "Bien."]);
        let starts: Vec<f64> = source.timings.unwrap().iter().map(|t| t.start).collect();
        assert_eq!(starts, [1000.0, 1000.0, 3500.0]);
    }

    #[test]
    fn serializes_as_the_typescript_reads_it() {
        let prose = serde_json::to_value(import_source("Hola.")).unwrap();
        assert_eq!(
            prose,
            serde_json::json!({ "cues": 0, "durationMs": 0.0, "sentences": ["Hola."] })
        );
        let panel = serde_json::to_value(import_source("0:00\nUno.\n0:04\nDos.")).unwrap();
        assert_eq!(panel["format"], "youtube-transcript");
    }
}
