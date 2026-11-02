//! A recording's transcript from two imperfect witnesses: what speech
//! recognition heard, and the burnt-in subtitles read off sampled frames.
//!
//! Speech gives every line and its timing but mishears homophones (曲饼 for
//! 曲柄) and keeps the fillers; the screen gives the exact characters but only
//! where there are subtitles, and only at the frames that were read. So each
//! spoken span keeps its timing, and its text is the screen's wherever a line
//! read during it **overlaps** what was heard — a character-overlap test after
//! stripping punctuation, loose enough for a misheard character or a filler and
//! strict enough that on-screen text nobody said is never taken. Two different
//! lines during one span split it at the midpoint between their frames;
//! neighbouring spans that read the same line become one cue — including a span
//! too misheard to overlap anything (`Zhong于` for 终于) whose frame shows the
//! line its neighbour was matched to. A line seen in one frame and matching
//! nothing — a stray glyph, a sign in the picture — is never used.
//!
//! Traditional glyph variants (別/别) are not folded: there is no conversion
//! table in this crate and none is invented, so two such readings are simply
//! "the same line" by the overlap test, not equal strings.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::subtitles::{push_joined, Cue};

/// One span the recognizer found speech in, milliseconds into the media.
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
pub struct HeardSpan {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// The target-script lines read off one frame, top to bottom.
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
pub struct SeenFrame {
    /// Milliseconds into the media.
    pub at: f64,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
pub struct TranscriptInput {
    pub heard: Vec<HeardSpan>,
    pub seen: Vec<SeenFrame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct MergedTranscript {
    /// The cues as an SRT file, for `importSource` like any uploaded one.
    pub srt: String,
    pub cues: usize,
    /// How many cues took their text from the screen.
    pub read: usize,
}

/// The characters that carry meaning: letters and digits, lowercased.
fn key(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// How many characters two keys share, counted as multisets.
fn shared(a: &[char], b: &[char]) -> usize {
    let mut rest = b.to_vec();
    a.iter()
        .filter(|c| {
            rest.iter()
                .position(|r| r == *c)
                .map(|i| rest.swap_remove(i))
                .is_some()
        })
        .count()
}

/// Whether two readings are one line: almost every character in common.
fn same_line(a: &[char], b: &[char]) -> bool {
    let longest = a.len().max(b.len());
    longest > 0 && shared(a, b) * 4 >= longest * 3
}

/// Whether a line read on screen is (part of) what was heard.
fn overlaps(heard: &[char], seen: &[char]) -> bool {
    let shortest = heard.len().min(seen.len());
    let common = shared(heard, seen);
    shortest > 0 && common * 2 >= shortest && common >= shortest.min(2)
}

/// One distinct line seen during a span: its most-read spelling and the first
/// and last frame it was on.
struct Seen {
    text: String,
    key: Vec<char>,
    first: f64,
    last: f64,
}

/// A cue on its way out: the screen line's key when its text is the screen's,
/// and every line glimpsed during a span that kept its speech.
type Placed = (Cue, Option<Vec<char>>, Vec<Vec<char>>);

/// The cues: each heard span, its text replaced or split by the screen where
/// the screen agrees with it.
pub fn merge_transcript(input: &TranscriptInput) -> (Vec<Cue>, usize) {
    let mut frames: Vec<(f64, String)> = input
        .seen
        .iter()
        .filter_map(|frame| {
            let mut text = String::new();
            for line in &frame.lines {
                let line = line.trim();
                if !line.is_empty() {
                    push_joined(&mut text, line);
                }
            }
            (!text.is_empty()).then_some((frame.at, text))
        })
        .collect();
    frames.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut out: Vec<Placed> = Vec::new();
    for span in &input.heard {
        let heard = key(&span.text);
        let mut lines: Vec<Seen> = Vec::new();
        for (at, text) in frames
            .iter()
            .filter(|(at, _)| *at >= span.start && *at <= span.end)
        {
            let k = key(text);
            match lines.iter_mut().find(|line| same_line(&line.key, &k)) {
                Some(line) => line.last = *at,
                None => lines.push(Seen {
                    text: text.clone(),
                    key: k,
                    first: *at,
                    last: *at,
                }),
            }
        }
        let glimpsed: Vec<Vec<char>> = lines.iter().map(|line| line.key.clone()).collect();
        lines.retain(|line| overlaps(&heard, &line.key));
        // The screen must account for most of what was heard, or a span that
        // ran over two cues would lose the half no frame was read in.
        let covered: usize = lines.iter().map(|line| shared(&heard, &line.key)).sum();
        if lines.is_empty() || covered * 5 < heard.len() * 3 {
            out.push((
                Cue {
                    start: span.start,
                    end: span.end,
                    text: span.text.trim().to_owned(),
                },
                None,
                glimpsed,
            ));
            continue;
        }
        for (i, line) in lines.iter().enumerate() {
            let start = if i == 0 {
                span.start
            } else {
                (lines[i - 1].last + line.first) / 2.0
            };
            let end = lines
                .get(i + 1)
                .map_or(span.end, |next| (line.last + next.first) / 2.0);
            out.push((
                Cue {
                    start,
                    end,
                    text: line.text.clone(),
                },
                Some(line.key.clone()),
                Vec::new(),
            ));
        }
    }

    let glimpsed = |glimpses: &[Vec<char>], k: &[char]| glimpses.iter().any(|g| same_line(g, k));
    let mut cues: Vec<Placed> = Vec::with_capacity(out.len());
    for (cue, seen, glimpses) in out {
        if let Some((last, last_seen, last_glimpses)) = cues.last_mut() {
            let joins = match (&*last_seen, &seen) {
                (Some(a), Some(b)) => same_line(a, b),
                (Some(a), None) => glimpsed(&glimpses, a),
                (None, Some(b)) => glimpsed(last_glimpses, b),
                (None, None) => false,
            };
            if joins {
                last.end = cue.end;
                if last_seen.is_none() {
                    last.text = cue.text;
                    *last_seen = seen;
                    last_glimpses.clear();
                }
                continue;
            }
        }
        cues.push((cue, seen, glimpses));
    }
    let read = cues.iter().filter(|(_, seen, _)| seen.is_some()).count();
    (
        cues.into_iter()
            .map(|(cue, _, _)| cue)
            .filter(|cue| !cue.text.is_empty())
            .collect(),
        read,
    )
}

/// `cues` as an SRT file.
pub fn to_srt(cues: &[Cue]) -> String {
    fn stamp(ms: f64) -> String {
        let ms = ms.max(0.0).round() as u64;
        format!(
            "{:02}:{:02}:{:02},{:03}",
            ms / 3_600_000,
            ms / 60_000 % 60,
            ms / 1000 % 60,
            ms % 1000
        )
    }
    cues.iter()
        .enumerate()
        .map(|(i, cue)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                stamp(cue.start),
                stamp(cue.end),
                cue.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// [`merge_transcript`] as the protocol answers it.
pub fn merged_transcript(input: &TranscriptInput) -> MergedTranscript {
    let (cues, read) = merge_transcript(input);
    MergedTranscript {
        srt: to_srt(&cues),
        cues: cues.len(),
        read,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_subtitles;

    fn heard(start: f64, end: f64, text: &str) -> HeardSpan {
        HeardSpan {
            start,
            end,
            text: text.to_owned(),
        }
    }

    fn seen(at: f64, lines: &[&str]) -> SeenFrame {
        SeenFrame {
            at,
            lines: lines.iter().map(|l| l.to_string()).collect(),
        }
    }

    fn merge(heard: Vec<HeardSpan>, seen: Vec<SeenFrame>) -> Vec<(f64, f64, String)> {
        merge_transcript(&TranscriptInput { heard, seen })
            .0
            .into_iter()
            .map(|cue| (cue.start, cue.end, cue.text))
            .collect()
    }

    #[test]
    fn the_screen_corrects_a_misheard_homophone_and_drops_the_fillers() {
        let cues = merge(
            vec![heard(1000.0, 3000.0, "呃，这个曲饼要转一下。")],
            vec![
                seen(1600.0, &["这个曲柄要转一下。"]),
                seen(2300.0, &["这个曲柄要转一下"]),
            ],
        );
        assert_eq!(
            cues,
            vec![(1000.0, 3000.0, "这个曲柄要转一下。".to_owned())]
        );
    }

    #[test]
    fn without_subtitles_the_speech_stands() {
        let cues = merge(vec![heard(0.0, 900.0, "我拉不起来。")], vec![]);
        assert_eq!(cues, vec![(0.0, 900.0, "我拉不起来。".to_owned())]);
    }

    #[test]
    fn text_on_screen_that_nobody_said_is_never_taken() {
        let cues = merge(
            vec![heard(0.0, 2000.0, "我拉不起来。")],
            vec![seen(700.0, &["继续游戏"]), seen(1300.0, &["设置"])],
        );
        assert_eq!(cues, vec![(0.0, 2000.0, "我拉不起来。".to_owned())]);
    }

    #[test]
    fn two_lines_during_one_span_split_it_between_their_frames() {
        let cues = merge(
            vec![heard(0.0, 3000.0, "前面又是一个巨大的建筑我拉不起来")],
            vec![
                seen(1000.0, &["前面又是一个巨大的建筑。"]),
                seen(2000.0, &["我拉不起来。"]),
            ],
        );
        assert_eq!(
            cues,
            vec![
                (0.0, 1500.0, "前面又是一个巨大的建筑。".to_owned()),
                (1500.0, 3000.0, "我拉不起来。".to_owned()),
            ]
        );
    }

    #[test]
    fn a_line_read_with_a_variant_glyph_or_a_stray_mark_is_still_one_line() {
        let cues = merge(
            vec![heard(0.0, 3000.0, "别担心这个就够了")],
            vec![
                seen(1000.0, &["別担心，这个就够了。"]),
                seen(2000.0, &["别担心，这个就夠了"]),
            ],
        );
        assert_eq!(cues.len(), 1, "{cues:?}");
        assert_eq!(cues[0].2, "別担心，这个就够了。", "the first reading wins");
    }

    #[test]
    fn a_span_the_screen_only_half_covers_keeps_its_speech() {
        // The span ran over two cues and only the first was read.
        let cues = merge(
            vec![heard(
                0.0,
                1800.0,
                "前面又是一个巨大的建筑我拉不起来但是没关系",
            )],
            vec![seen(900.0, &["我拉不起来。"])],
        );
        assert_eq!(cues[0].2, "前面又是一个巨大的建筑我拉不起来但是没关系");
    }

    #[test]
    fn neighbouring_spans_that_read_one_line_become_one_cue() {
        let cues = merge(
            vec![
                heard(0.0, 900.0, "前面又是"),
                heard(1100.0, 2400.0, "一个巨大的建筑"),
            ],
            vec![
                seen(450.0, &["前面又是一个巨大的建筑。"]),
                seen(1700.0, &["前面又是一个巨大的建筑。"]),
            ],
        );
        assert_eq!(
            cues,
            vec![(0.0, 2400.0, "前面又是一个巨大的建筑。".to_owned())]
        );
    }

    #[test]
    fn a_span_too_misheard_to_match_joins_the_neighbour_whose_line_it_shows() {
        let line = "终于，我从水里出来了";
        let cues = merge(
            vec![
                heard(5670.0, 6438.0, "Zhong于。"),
                heard(6982.0, 8454.0, "我从水里出来了。"),
            ],
            vec![seen(6054.0, &[line]), seen(7718.0, &[line])],
        );
        assert_eq!(cues, vec![(5670.0, 8454.0, line.to_owned())]);

        // Either way round, and only when the frame really showed that line.
        let cues = merge(
            vec![
                heard(0.0, 1500.0, "我从水里出来了。"),
                heard(1800.0, 2400.0, "嗯。"),
            ],
            vec![seen(750.0, &[line]), seen(2100.0, &[line])],
        );
        assert_eq!(cues, vec![(0.0, 2400.0, line.to_owned())]);
        let cues = merge(
            vec![
                heard(0.0, 1500.0, "我从水里出来了。"),
                heard(1800.0, 2400.0, "嗯。"),
            ],
            vec![seen(750.0, &[line])],
        );
        assert_eq!(cues.len(), 2);
    }

    #[test]
    fn a_frame_s_lines_join_top_to_bottom_like_a_cue_s() {
        let cues = merge(
            vec![heard(0.0, 2000.0, "前面又是一个巨大的建筑")],
            vec![seen(1000.0, &["前面又是", "一个巨大的建筑。"])],
        );
        assert_eq!(cues[0].2, "前面又是一个巨大的建筑。");
    }

    #[test]
    fn the_srt_reads_back_as_the_same_cues() {
        let input = TranscriptInput {
            heard: vec![
                heard(1234.0, 5678.0, "你好。"),
                heard(3_723_004.0, 3_725_000.0, "再见。"),
            ],
            seen: vec![],
        };
        let merged = merged_transcript(&input);
        assert_eq!(merged.cues, 2);
        assert_eq!(merged.read, 0);
        assert!(
            merged.srt.contains("01:02:03,004 --> 01:02:05,000"),
            "{}",
            merged.srt
        );

        let (_, cues) = parse_subtitles(&merged.srt).expect("an SRT file");
        assert_eq!(cues, merge_transcript(&input).0);
    }
}
