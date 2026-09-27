//! The reading import: what a pasted or uploaded text *is*, and the segments
//! it is stored as.
//!
//! A plain library: no SQL, no clock, no I/O. Everything here is a function of
//! the text's own bytes. [`import_source`] is the one entry point the protocol
//! exposes (`importSource`); [`subtitles`] and [`paragraphs`] are its halves.
//! What comes out is the stored shape itself — `sapling-domain`'s [`Segment`] —
//! so the caller hands it to `addText` untouched: there is no model call and no
//! re-cutting between the import and the store.

#![forbid(unsafe_code)]

use sapling_domain::types::Segment;
use serde::Serialize;
use ts_rs::TS;

pub mod paragraphs;
pub mod subtitles;

pub use paragraphs::split_paragraphs;
pub use subtitles::{detect_subtitle_format, parse_subtitles, Cue, SubtitleFormat};

/// A text on its way in, recognised and cut into the segments it is stored as.
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
    /// One per cue, timed, for subtitles; one per paragraph, untimed, for prose.
    pub segments: Vec<Segment>,
}

/// Recognises `text` and cuts it into segments.
///
/// Subtitles are cleaned into cues and each cue becomes a segment with its own
/// span; anything else is prose and becomes one untimed segment per paragraph.
/// The content decides, never a file name.
pub fn import_source(text: &str) -> ImportedSource {
    let Some((format, cues)) = parse_subtitles(text) else {
        return ImportedSource {
            format: None,
            cues: 0,
            duration_ms: 0.0,
            segments: split_paragraphs(text)
                .into_iter()
                .map(|text| Segment {
                    text,
                    start: None,
                    end: None,
                })
                .collect(),
        };
    };
    ImportedSource {
        format: Some(format),
        cues: cues.len(),
        duration_ms: cues.iter().fold(0.0, |furthest, cue| cue.end.max(furthest)),
        segments: cues
            .into_iter()
            .map(|cue| Segment {
                text: cue.text,
                start: Some(cue.start),
                end: Some(cue.end),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn untimed(text: &str) -> Segment {
        Segment {
            text: text.into(),
            start: None,
            end: None,
        }
    }

    #[test]
    fn prose_is_one_untimed_segment_per_paragraph() {
        let source = import_source("Fuimos al restaurante. Pedí sopa.\n\nLa cuenta no era cara.");
        assert_eq!(
            source,
            ImportedSource {
                format: None,
                cues: 0,
                duration_ms: 0.0,
                segments: vec![
                    untimed("Fuimos al restaurante. Pedí sopa."),
                    untimed("La cuenta no era cara."),
                ],
            }
        );
    }

    #[test]
    fn subtitles_are_one_segment_per_cue_with_its_own_span() {
        let source = import_source(
            "1\n00:00:01,000 --> 00:00:03,500\nHola. Adiós.\n\n2\n00:00:03,500 --> 00:00:06,000\nBien.\n",
        );
        assert_eq!(source.format, Some(SubtitleFormat::Srt));
        assert_eq!(source.cues, 2);
        assert_eq!(source.duration_ms, 6000.0);
        assert_eq!(
            source.segments,
            [
                Segment {
                    text: "Hola. Adiós.".into(),
                    start: Some(1000.0),
                    end: Some(3500.0),
                },
                Segment {
                    text: "Bien.".into(),
                    start: Some(3500.0),
                    end: Some(6000.0),
                },
            ]
        );
    }

    #[test]
    fn never_joins_a_sentence_that_runs_across_two_cues() {
        let source = import_source(
            "1\n00:00:01,000 --> 00:00:03,000\nFuimos al restaurante\n\n2\n00:00:03,000 --> 00:00:05,000\ny pedimos sopa.\n",
        );
        let texts: Vec<&str> = source.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["Fuimos al restaurante", "y pedimos sopa."]);
    }

    #[test]
    fn serializes_as_the_typescript_reads_it() {
        let prose = serde_json::to_value(import_source("Hola.")).unwrap();
        assert_eq!(
            prose,
            serde_json::json!({ "cues": 0, "durationMs": 0.0, "segments": [{ "text": "Hola." }] })
        );
        let panel = serde_json::to_value(import_source("0:00\nUno.\n0:04\nDos.")).unwrap();
        assert_eq!(panel["format"], "youtube-transcript");
        assert_eq!(
            panel["segments"][0],
            serde_json::json!({ "text": "Uno.", "start": 0.0, "end": 4000.0 })
        );
    }
}
