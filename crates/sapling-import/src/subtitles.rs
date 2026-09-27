//! Subtitles as an import format: a `.srt`/`.vtt`/`.json3` file, or the
//! transcript panel off a video page, turned into cues that carry when they
//! are spoken.
//!
//! A cue is what the text is stored as: one segment per cue, its span kept
//! exactly. What this module removes is only what is presentation or
//! repetition — markup, entities, line breaks inside a cue, and the rolling
//! repeats of auto-generated captions. It never joins cues or re-cuts them into
//! sentences: a sentence spread over two cues is two segments, each with the
//! span it was shown for, which is what the follow view needs to highlight the
//! line actually on screen. The timings are recovered here because this is the
//! only moment they exist: the file is gone as soon as the import finishes.

use serde_json::Value;
use ts_rs::TS;

/// The four shapes a learner actually turns up with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleFormat {
    Srt,
    Vtt,
    YoutubeTranscript,
    Json3,
}

/// One subtitle cue: a span of the media, and what is said in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    /// Milliseconds from the start of the media.
    pub start: f64,
    /// Milliseconds from the start of the media; never before `start`.
    pub end: f64,
    /// Cleaned and joined — no markup, no entities, no line breaks.
    pub text: String,
}

/// How long a cue with nothing after it to end it is assumed to last: the last
/// line of a transcript panel, or a final json3 event with no duration. Four
/// seconds is a spoken sentence.
const LAST_CUE_MS: f64 = 4000.0;

/// A character that sets its own spacing, so joining across it must not
/// insert a space: Han, kana, Hangul, and the CJK and fullwidth punctuation
/// that sits between them (`。`, `、`, `，`, `？`). Block ranges rather than
/// Unicode script data, which would cost a table in the wasm build.
fn is_cjk(c: char) -> bool {
    // Hangul Jamo; CJK and Kangxi radicals; CJK symbols and punctuation;
    // Hiragana and Katakana; Hangul compatibility Jamo; Kanbun through CJK
    // compatibility; extension A; unified ideographs; Hangul syllables;
    // compatibility ideographs; compatibility forms; fullwidth ASCII; halfwidth
    // kana and Hangul; the supplementary ideograph planes.
    matches!(
        c as u32,
        0x1100..=0x11FF
            | 0x2E80..=0x2FDF
            | 0x3001..=0x303F
            | 0x3040..=0x30FF
            | 0x3130..=0x318F
            | 0x3190..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0xFE30..=0xFE4F
            | 0xFF01..=0xFF60
            | 0xFF61..=0xFFDC
            | 0x20000..=0x3FFFF
    )
}

/// The separator between two pieces of text that were on different lines: a
/// space everywhere except between two CJK characters, where a space is not a
/// word boundary but a visible mark the source did not have.
fn joiner(before: &str, after: &str) -> &'static str {
    match (before.chars().next_back(), after.chars().next()) {
        (Some(left), Some(right)) if !(is_cjk(left) && is_cjk(right)) => " ",
        _ => "",
    }
}

/// Appends `piece` to `out`, spacing the seam by [`joiner`].
fn push_joined(out: &mut String, piece: &str) {
    let seam = joiner(out, piece);
    out.push_str(seam);
    out.push_str(piece);
}

/// Drops the byte-order mark a downloaded file arrives wearing, and CRLF / CR.
pub(crate) fn normalize_newlines(text: &str) -> String {
    text.strip_prefix('\u{FEFF}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

/// `digits` as a number when it is 1..=`max` ASCII digits.
fn digits(raw: &str, max: usize) -> Option<f64> {
    if raw.is_empty() || raw.len() > max || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// `HH:MM:SS.mmm` or `MM:SS.mmm`, either separator, in milliseconds. VTT writes
/// the fraction with a dot and SRT with a comma, and both are seen with the
/// hours omitted.
fn parse_timestamp(raw: &str) -> Option<f64> {
    let (clock, fraction) = raw.trim().rsplit_once(['.', ','])?;
    let millis = digits(fraction, 3)? * 10f64.powi(3 - fraction.len() as i32);
    let parts: Vec<&str> = clock.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [h, m, s] => (digits(h, usize::MAX)?, m, s),
        [m, s] => (0.0, m, s),
        _ => return None,
    };
    Some(
        hours * 3_600_000.0
            + digits(minutes, 2)? * 60_000.0
            + digits(seconds, 2)? * 1000.0
            + millis,
    )
}

/// A transcript-panel timestamp on a line of its own — `0:04`, `1:02:33` — in
/// milliseconds.
fn panel_time(line: &str) -> Option<f64> {
    let parts: Vec<&str> = line.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [h, m, s] => (digits(h, 2)?, *m, *s),
        [m, s] => (0.0, *m, *s),
        _ => return None,
    };
    if seconds.len() != 2 {
        return None;
    }
    Some(hours * 3_600_000.0 + digits(minutes, 2)? * 60_000.0 + digits(seconds, 2)? * 1000.0)
}

/// Whether `lines[i]` is an SRT index and `lines[i + 1]` an SRT timing line
/// (`00:00:01,000 -->`, a comma before the fraction).
fn is_srt_header(index: &str, timing: &str) -> bool {
    if digits(index.trim_matches([' ', '\t']), usize::MAX).is_none() {
        return false;
    }
    let Some((stamp, _)) = timing.split_once("-->") else {
        return false;
    };
    let stamp = stamp.trim_end_matches([' ', '\t']);
    let Some((clock, fraction)) = stamp.split_once(',') else {
        return false;
    };
    let parts: Vec<&str> = clock.split(':').collect();
    fraction.len() == 3
        && digits(fraction, 3).is_some()
        && matches!(parts.as_slice(), [h, m, s]
            if digits(h, 2).is_some() && m.len() == 2 && digits(m, 2).is_some()
                && s.len() == 2 && digits(s, 2).is_some())
}

/// The named entities a subtitle file actually contains. `&amp;` is decoded
/// last on purpose: `&amp;lt;` means a literal `&lt;`.
fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// One line of cue text, stripped of everything that is presentation.
///
/// Every angle-bracket run goes: styling tags (`<i>`, `<c.colorE5E5E5>`), voice
/// spans (`<v Speaker>`), and the per-word timestamps (`<00:00:01.240>`)
/// auto-generated captions carry. Stripping tags before decoding entities is
/// what makes that safe: a real `<` in the dialogue was written `&lt;`.
fn clean_line(line: &str) -> String {
    let mut stripped = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        stripped.push_str(&rest[..open]);
        rest = &rest[open + close + 1..];
    }
    stripped.push_str(rest);
    decode_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cue lines, already cleaned, with the empty ones dropped.
struct RawCue {
    start: f64,
    end: f64,
    lines: Vec<String>,
}

/// A file's blank-line-separated blocks, each as its lines, trimmed. A cue's
/// text may not contain a blank line, so this is very nearly the whole of the
/// SRT and VTT structure.
fn blocks(text: &str) -> Vec<Vec<&str>> {
    let mut out = Vec::new();
    let mut block: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if line.trim_matches([' ', '\t']).is_empty() {
            if !block.is_empty() {
                out.push(std::mem::take(&mut block));
            }
        } else {
            block.push(line);
        }
    }
    if !block.is_empty() {
        out.push(block);
    }
    out
}

/// Whether a VTT block is a header or a `NOTE`/`STYLE`/`REGION` block.
fn is_vtt_chrome(first: &str) -> bool {
    ["WEBVTT", "NOTE", "STYLE", "REGION"].iter().any(|word| {
        first.trim_start().strip_prefix(word).is_some_and(|rest| {
            !rest
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    })
}

/// Reads the cues out of an SRT or VTT body.
///
/// One reader for both: after the header the two formats differ only in how
/// the fraction is punctuated and in what may appear around a cue — VTT's
/// `NOTE`/`STYLE`/`REGION` blocks, an identifier line before the timing, and
/// settings after it, all presentation.
///
/// The one repair: a block with no timing line, straight after a cue, is folded
/// back into that cue. YouTube's automatic captions leave the top line of their
/// rolling window blank until it has filled, and a blank-line split cuts the
/// cue in half there; dropping the orphan would lose the transcript's opening
/// line.
fn parse_block_cues(text: &str) -> Vec<RawCue> {
    let normalized = normalize_newlines(text);
    let mut out: Vec<RawCue> = Vec::new();
    let mut open = false;

    for lines in blocks(&normalized) {
        if is_vtt_chrome(lines[0]) {
            open = false;
            continue;
        }

        let arrow_at = lines.iter().position(|line| line.contains("-->"));
        let body_from = arrow_at.map_or(0, |at| at + 1);
        let body: Vec<String> = lines[body_from..]
            .iter()
            .map(|line| clean_line(line))
            .filter(|line| !line.is_empty())
            .collect();

        let Some(arrow_at) = arrow_at else {
            if let (true, Some(last)) = (open, out.last_mut()) {
                last.lines.extend(body);
            }
            continue;
        };

        // Before the arrow is the start; after the second timestamp on the
        // arrow line is cue settings.
        let mut halves = lines[arrow_at].split("-->");
        let start = halves.next().and_then(parse_timestamp);
        let end = halves
            .next()
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(parse_timestamp);
        let (Some(start), Some(end)) = (start, end) else {
            open = false;
            continue;
        };

        out.push(RawCue {
            start,
            end: end.max(start),
            lines: body,
        });
        open = true;
    }
    out
}

/// Reads a transcript panel: alternating timestamp and text lines.
///
/// The panel prints no end times, so a cue runs until the next one starts and
/// the last gets [`LAST_CUE_MS`]. A line that is not a timestamp belongs to the
/// timestamp before it; text before the first timestamp is the panel's own
/// chrome and belongs to no cue.
fn parse_panel_cues(text: &str) -> Vec<RawCue> {
    let mut out: Vec<RawCue> = Vec::new();
    for raw in normalize_newlines(text).split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(start) = panel_time(line) {
            out.push(RawCue {
                start,
                end: start + LAST_CUE_MS,
                lines: Vec::new(),
            });
            continue;
        }
        let cleaned = clean_line(line);
        if let (false, Some(last)) = (cleaned.is_empty(), out.last_mut()) {
            last.lines.push(cleaned);
        }
    }

    for i in 1..out.len() {
        let next = out[i].start;
        let cue = &mut out[i - 1];
        cue.end = next.max(cue.start);
    }
    out.retain(|cue| !cue.lines.is_empty());
    out
}

/// The events of a `json3` document, or `None` for anything else.
///
/// Detection has to be certain rather than eager, because the paste box runs it
/// on every keystroke: a `{` is not enough, an `events` array is not enough,
/// and what settles it is an event carrying both an offset and segments.
fn parse_json3(text: &str) -> Option<Vec<Value>> {
    let normalized = normalize_newlines(text);
    let trimmed = normalized.trim();
    // Cheap gate first: parsing a novel as JSON is not free.
    if !trimmed.starts_with('{') {
        return None;
    }
    let Value::Object(mut document) = serde_json::from_str(trimmed).ok()? else {
        return None;
    };
    let Value::Array(events) = document.remove("events")? else {
        return None;
    };
    let events: Vec<Value> = events.into_iter().filter(Value::is_object).collect();
    let carries_a_cue = events
        .iter()
        .any(|event| event["tStartMs"].is_number() && event["segs"].is_array());
    carries_a_cue.then_some(events)
}

/// `json3` events as cues.
///
/// A cue's `segs` are **joined with nothing** — they are word-level pieces of
/// one line and carry their own spaces. An event with **no `dDurationMs`** ends
/// where the next event starts: those are the newline-only separators between
/// lines and the last line of a paragraph, and a real auto-generated track is
/// about half separators. The events with nothing to say are dropped *after*
/// the boundaries are worked out, so a separator still marks where the line
/// before it ended.
fn parse_json3_cues(events: &[Value]) -> Vec<RawCue> {
    let timed: Vec<(f64, &Value)> = events
        .iter()
        .filter_map(|event| Some((event["tStartMs"].as_f64()?, event)))
        .collect();

    let mut out = Vec::new();
    for (i, &(start, event)) in timed.iter().enumerate() {
        let joined: String = event["segs"]
            .as_array()
            .map(|segs| segs.iter().filter_map(|seg| seg["utf8"].as_str()).collect())
            .unwrap_or_default();
        let text = clean_line(&joined);
        if text.is_empty() {
            continue;
        }
        let end = match event["dDurationMs"].as_f64() {
            Some(duration) => start + duration,
            None => timed.get(i + 1).map_or(start + LAST_CUE_MS, |next| next.0),
        };
        out.push(RawCue {
            start,
            end: end.max(start),
            lines: vec![text],
        });
    }
    out
}

/// Which of the four shapes `text` is, or `None` for ordinary prose — a learner
/// who pastes an article must not have it reinterpreted because one line of it
/// looked like a timestamp.
pub fn detect_subtitle_format(text: &str) -> Option<SubtitleFormat> {
    let normalized = normalize_newlines(text);
    let normalized = normalized.trim_start();
    if normalized.is_empty() {
        return None;
    }
    if parse_json3(normalized).is_some() {
        return Some(SubtitleFormat::Json3);
    }
    if normalized.starts_with("WEBVTT") {
        return Some(SubtitleFormat::Vtt);
    }
    let lines: Vec<&str> = normalized.split('\n').collect();
    if lines.windows(2).any(|pair| is_srt_header(pair[0], pair[1])) {
        return Some(SubtitleFormat::Srt);
    }

    // A panel starts on a timestamp and alternates: two cues that both carry
    // text is not something prose does by accident.
    let first = lines
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())?;
    panel_time(first)?;
    (parse_panel_cues(normalized).len() >= 2).then_some(SubtitleFormat::YoutubeTranscript)
}

/// Drops the repetition out of auto-generated captions.
///
/// YouTube's automatic captions *roll*: each cue repeats the line already on
/// screen and adds the next under it, and a ten-millisecond transition cue
/// between every pair shows the same text again. So a line is emitted the first
/// time it is seen, keeps the timing of the cue it first appeared in, and a cue
/// left with nothing is dropped — which disposes of the transition cues without
/// recognising them. Applied to every format: two consecutive cues with
/// identical text are a subtitle held across a shot change, and reading it
/// twice is wrong there too.
fn dedupe_rolling(cues: Vec<RawCue>) -> Vec<Cue> {
    let mut out = Vec::new();
    let mut previous = String::new();
    for cue in cues {
        let mut text = String::new();
        for line in cue.lines {
            if line == previous {
                continue;
            }
            push_joined(&mut text, &line);
            previous = line;
        }
        if !text.is_empty() {
            out.push(Cue {
                start: cue.start,
                end: cue.end,
                text,
            });
        }
    }
    out
}

/// Every cue of `text`, in order, cleaned and de-duplicated, with the format it
/// was read as; `None` for anything that is not subtitles.
pub fn parse_subtitles(text: &str) -> Option<(SubtitleFormat, Vec<Cue>)> {
    let format = detect_subtitle_format(text)?;
    let raw = match format {
        SubtitleFormat::Json3 => parse_json3_cues(&parse_json3(text).unwrap_or_default()),
        SubtitleFormat::YoutubeTranscript => parse_panel_cues(text),
        SubtitleFormat::Srt | SubtitleFormat::Vtt => parse_block_cues(text),
    };
    Some((format, dedupe_rolling(raw)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1
00:00:01,000 --> 00:00:03,500
Fuimos al restaurante y
pedimos sopa.

2
00:00:03,500 --> 00:00:06,000
La cuenta no era cara. Dejamos
una propina.
";

    const VTT: &str = "WEBVTT
Kind: captions
Language: zh

NOTE
This file was generated by a machine.

intro
00:00:01.000 --> 00:00:03.000 align:start position:0%
<v Speaker>我们去了<i>饭馆</i>。</v>
我点了汤。

00:00:03.000 --> 00:00:05.000
她点了鱼
和米饭。
";

    /// What `yt-dlp --write-auto-subs` produces: a rolling two-line window, a
    /// ten-millisecond transition cue between every pair, an empty top line
    /// where the window has not filled yet, and per-word timestamps.
    const ROLLING_VTT: &str = "WEBVTT
Kind: captions
Language: zh

00:00:00.030 --> 00:00:03.270 align:start position:0%

大家好<00:00:00.630><c>欢迎</c><00:00:01.240><c>来到</c>

00:00:03.270 --> 00:00:03.280 align:start position:0%
大家好欢迎来到


00:00:03.280 --> 00:00:06.140 align:start position:0%
大家好欢迎来到
我的<00:00:04.000><c.colorE5E5E5>频道</c>

00:00:06.140 --> 00:00:06.150 align:start position:0%
我的频道


00:00:06.150 --> 00:00:09.000 align:start position:0%
我的频道
今天<00:00:07.000><c>我们</c><00:00:07.500><c>聊聊</c>
";

    const PANEL: &str = "0:00
第一句话。
0:04
第二句话。
1:02:33
最后一句。";

    /// What `yt-dlp --sub-format json3` writes: a `wireMagic` header and sibling
    /// arrays that are not events, a timed window definition with nothing to
    /// read, word-level `segs`, a newline-only separator, and an event with no
    /// `dDurationMs`.
    const JSON3: &str = r#"{"wireMagic":"pb3","pens":[{}],"wpWinPositions":[{}],"events":[
        {"tStartMs":0,"dDurationMs":3270,"wWinId":1},
        {"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"我们去了饭馆"},{"utf8":"。","tOffsetMs":600}]},
        {"tStartMs":3000,"dDurationMs":10,"aAppend":1,"segs":[{"utf8":"\n"}]},
        {"tStartMs":3000,"segs":[{"utf8":"我点了汤"},{"utf8":"。"}]},
        {"tStartMs":5000,"dDurationMs":1500,"segs":[{"utf8":"她点了鱼和米饭"},{"utf8":"。"}]}
    ]}"#;

    fn cue(start: f64, end: f64, text: &str) -> Cue {
        Cue {
            start,
            end,
            text: text.to_owned(),
        }
    }

    fn cues(text: &str) -> Vec<Cue> {
        parse_subtitles(text)
            .map(|(_, cues)| cues)
            .unwrap_or_default()
    }

    /* ---- detect_subtitle_format -------------------------------------------- */

    #[test]
    fn knows_the_four_shapes_a_learner_turns_up_with() {
        assert_eq!(detect_subtitle_format(SRT), Some(SubtitleFormat::Srt));
        assert_eq!(detect_subtitle_format(VTT), Some(SubtitleFormat::Vtt));
        assert_eq!(
            detect_subtitle_format(PANEL),
            Some(SubtitleFormat::YoutubeTranscript)
        );
        assert_eq!(detect_subtitle_format(JSON3), Some(SubtitleFormat::Json3));
    }

    #[test]
    fn wants_an_event_with_an_offset_and_segments_before_it_calls_something_json3() {
        assert_eq!(detect_subtitle_format(r#"{"hello": "world"}"#), None);
        assert_eq!(detect_subtitle_format(r#"{"events": []}"#), None);
        assert_eq!(
            detect_subtitle_format(r#"{"events": [{"note": "no offsets here"}]}"#),
            None
        );
        assert_eq!(detect_subtitle_format("{ not valid json at all"), None);
    }

    #[test]
    fn sees_through_a_bom_and_crlf_line_endings() {
        let vtt = format!("\u{FEFF}{}", VTT.replace('\n', "\r\n"));
        assert_eq!(detect_subtitle_format(&vtt), Some(SubtitleFormat::Vtt));
        assert_eq!(
            detect_subtitle_format(&SRT.replace('\n', "\r\n")),
            Some(SubtitleFormat::Srt)
        );
        assert_eq!(cues(&SRT.replace('\n', "\r\n")), cues(SRT));
    }

    #[test]
    fn leaves_ordinary_prose_alone_timestamps_in_it_or_not() {
        assert_eq!(
            detect_subtitle_format("Fuimos al restaurante. Pedí sopa."),
            None
        );
        assert_eq!(
            detect_subtitle_format("El tren sale a las 9:30 y llega a las 11:45."),
            None
        );
        assert_eq!(detect_subtitle_format(""), None);
        assert_eq!(detect_subtitle_format("   \n  "), None);
    }

    #[test]
    fn wants_more_than_one_timed_line_before_it_calls_something_a_transcript() {
        assert_eq!(detect_subtitle_format("0:00\nUna sola línea."), None);
    }

    /* ---- parse_subtitles ---------------------------------------------------- */

    #[test]
    fn reads_srt_blocks_and_joins_their_lines_with_a_space() {
        assert_eq!(
            cues(SRT),
            [
                cue(1000.0, 3500.0, "Fuimos al restaurante y pedimos sopa."),
                cue(
                    3500.0,
                    6000.0,
                    "La cuenta no era cara. Dejamos una propina."
                ),
            ]
        );
    }

    #[test]
    fn skips_the_vtt_header_notes_identifiers_and_settings_and_strips_markup() {
        assert_eq!(
            cues(VTT),
            [
                cue(1000.0, 3000.0, "我们去了饭馆。我点了汤。"),
                cue(3000.0, 5000.0, "她点了鱼和米饭。"),
            ]
        );
    }

    #[test]
    fn decodes_the_entities_a_subtitle_file_actually_carries() {
        let parsed = cues(
            "1\n00:00:01,000 --> 00:00:02,000\nBen &amp; Jerry said &lt;hello&gt;&nbsp;there\n",
        );
        assert_eq!(parsed[0].text, "Ben & Jerry said <hello> there");
    }

    #[test]
    fn reads_a_transcript_panel_ending_each_cue_where_the_next_begins() {
        assert_eq!(
            cues(PANEL),
            [
                cue(0.0, 4000.0, "第一句话。"),
                cue(4000.0, 3_753_000.0, "第二句话。"),
                cue(3_753_000.0, 3_757_000.0, "最后一句。"),
            ]
        );
    }

    #[test]
    fn returns_nothing_for_a_text_that_is_not_subtitles_at_all() {
        assert!(parse_subtitles("Fuimos al restaurante.").is_none());
    }

    #[test]
    fn reads_json3_events_as_cues_joining_segs_with_nothing() {
        // Five events in, three cues out: the window definition has no text,
        // the separator's only text is a newline, and the event with no
        // duration ends where the next one starts.
        assert_eq!(
            cues(JSON3),
            [
                cue(1000.0, 3000.0, "我们去了饭馆。"),
                cue(3000.0, 5000.0, "我点了汤。"),
                cue(5000.0, 6500.0, "她点了鱼和米饭。"),
            ]
        );
    }

    #[test]
    fn gives_a_final_json3_event_with_no_duration_a_plausible_last_cue() {
        assert_eq!(
            cues(r#"{"events":[{"tStartMs":2000,"segs":[{"utf8":"最后一句。"}]}]}"#),
            [cue(2000.0, 6000.0, "最后一句。")]
        );
    }

    #[test]
    fn emits_every_rolling_line_exactly_once_with_the_timing_it_first_appeared_in() {
        // The first line is the one a blank-line split would have orphaned;
        // the transition cues are gone.
        assert_eq!(
            cues(ROLLING_VTT),
            [
                cue(30.0, 3270.0, "大家好欢迎来到"),
                cue(3280.0, 6140.0, "我的频道"),
                cue(6150.0, 9000.0, "今天我们聊聊"),
            ]
        );
    }
}
