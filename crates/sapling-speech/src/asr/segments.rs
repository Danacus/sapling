//! A long recording to timed sentences: Silero VAD cuts the speech out, and
//! SenseVoice transcribes each span on its own.
//!
//! Still a capability with no opinion — samples in, `(start, end, text)` out.
//! What the spans are for (subtitles, and the hardsub text that may replace
//! them) is the window's and `sapling-import`'s.
//!
//! The VAD settings were measured on a 26-minute Chinese recording against its
//! burnt-in subtitles: span starts land a median ~100 ms from the cue starts,
//! and `MAX_SPEECH_S` keeps a run-on speaker from becoming one 40-second cue.

use serde::Serialize;
use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

use super::sense_voice::SenseVoice;
use super::SAMPLE_RATE;

const THRESHOLD: f32 = 0.5;
const MIN_SILENCE_S: f32 = 0.25;
const MIN_SPEECH_S: f32 = 0.25;
const WINDOW: i32 = 512;
const MAX_SPEECH_S: f32 = 8.0;

/// One span of speech, in milliseconds from the first sample handed over.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechSegment {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

/// Every span of speech in `samples` (16 kHz mono), transcribed. A span the
/// recognizer heard nothing in is left out.
pub fn segments(
    asr: &SenseVoice,
    vad_model: &str,
    samples: &[f32],
) -> Result<Vec<SpeechSegment>, String> {
    let vad = VoiceActivityDetector::create(
        &VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(vad_model.to_owned()),
                threshold: THRESHOLD,
                min_silence_duration: MIN_SILENCE_S,
                min_speech_duration: MIN_SPEECH_S,
                window_size: WINDOW,
                max_speech_duration: MAX_SPEECH_S,
            },
            sample_rate: SAMPLE_RATE,
            num_threads: 1,
            ..Default::default()
        },
        // Seconds of audio the detector may buffer; a span is at most
        // MAX_SPEECH_S, so this is generous.
        60.0,
    )
    .ok_or_else(|| "sherpa-onnx refused the voice-activity configuration".to_owned())?;

    let mut out = Vec::new();
    let mut drain = |vad: &VoiceActivityDetector| -> Result<(), String> {
        while let Some(span) = vad.front() {
            let text = asr.transcribe(span.samples(), SAMPLE_RATE)?;
            if !text.is_empty() {
                let start_ms = span.start() as f64 * 1000.0 / SAMPLE_RATE as f64;
                out.push(SpeechSegment {
                    start_ms,
                    end_ms: start_ms + span.n() as f64 * 1000.0 / SAMPLE_RATE as f64,
                    text,
                });
            }
            vad.pop();
        }
        Ok(())
    };
    for chunk in samples.chunks(WINDOW as usize) {
        vad.accept_waveform(chunk);
        drain(&vad)?;
    }
    vad.flush();
    drain(&vad)?;
    Ok(out)
}
