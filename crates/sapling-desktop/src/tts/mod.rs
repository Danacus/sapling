//! The neural voice, natively.
//!
//! In the browser Kokoro runs as sherpa-onnx compiled to WASM inside a Worker
//! (`static/tts/sherpa-worker.js`). That path cannot be the desktop's: the
//! whole engine is an Emscripten *file package* whose 427 MB in-memory
//! filesystem is byte-offset-addressed by vendored glue, and WebKitGTK has no
//! `SharedArrayBuffer` to spare it any of that. So on this host synthesis moves
//! to Rust.
//!
//! **And so does playback**, which was not the plan. `<audio>` over a blob does
//! work in this webview, but it builds a fresh GStreamer pipeline per clip and
//! starts about a second late, and Web Audio — the way to keep one pipeline —
//! is unusable here altogether. [`play`] is the measurement and the answer;
//! the short version is that speech no longer touches the webview's audio
//! stack at all, while everything else in the app still does.
//!
//! The seam is still small and boring: five commands, and none of them knows a
//! word of any language. `src/lib/tts/native.ts` offers `tts.ts` exactly the
//! shape `sherpa.ts` offers it, and `speak()` cannot tell which host it is on.
//!
//! ## The engine is loaded once and kept
//!
//! Loading Kokoro means an ONNX session over a 325 MB graph plus a 54 MB voice
//! table — seconds, and hundreds of megabytes resident. Doing that per phrase
//! would be absurd, so the first [`TtsHandle::synthesize`] builds it and every
//! later one reuses it. The engine is `!Sync`, so it lives behind a `Mutex` and
//! phrases are synthesized one at a time; that is also what we want from a
//! single ONNX session on a shared CPU. There is no separate "warm up" command
//! — the session screen already calls `warmSpeech` when a challenge is shown,
//! so the load happens while the learner is reading the question.
//!
//! Nothing here runs on the main thread. Tauri executes a synchronous command
//! there, and a second of inference on the main thread is a frozen window — as
//! is a clip's whole playing time — so every long command is `async` and hands
//! its work to `spawn_blocking` (`lib.rs`).
//!
//! ## fp32, natively too
//!
//! `models.ts` records why the browser pays 439 MB for fp32 rather than 227 MB
//! for int8: every published int8 Kokoro WASM build returns all-`NaN` samples
//! from ONNX inference (sherpa-onnx#2236). That is a *WASM* observation, and it
//! was worth re-asking natively — the answer is in the `gotchas` skill, and it
//! does not change what ships. [`is_audible`] is the same guard the worker
//! carries for the same reason: an all-`NaN` clip encodes to a perfectly silent
//! WAV, and silence is the one failure the learner cannot diagnose. Failing
//! loudly here is what makes `tts.ts` fall back to the browser voice.

pub mod kokoro;
pub mod model;
pub mod play;
pub mod wav;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use kokoro::{Kokoro, KokoroConfig};
use model::{ModelSpec, KOKORO};

/// Directory holding every voice model, inside Tauri's app-data directory.
pub const TTS_DIR: &str = "tts";

/// Sentences per generate call. One, matching the worker: the app speaks a
/// phrase at a time and a longer window only costs latency on the first word.
const MAX_NUM_SENTENCES: i32 = 1;

/// Pause between sentences, matching the worker's `silenceScale`.
const SILENCE_SCALE: f32 = 0.2;

/// Speech rate baked into the model config. Per-call speed is a separate
/// argument to `create`, exactly as the browser passes it to `generate`.
const LENGTH_SCALE: f32 = 1.0;

/// Anything below this counts as silence, matching `sherpa-worker.js`.
/// `abs(NaN) > threshold` is false, so an all-`NaN` clip fails this test.
const AUDIBLE_THRESHOLD: f32 = 1e-4;

/// What `tts_status` answers. Serialized camelCase because it is read by
/// TypeScript, and the field names are `native.ts`'s `NativeTtsStatus`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    /// The model this host would use, for the Settings copy.
    pub model: &'static str,
    /// Every file the engine config names is present.
    pub installed: bool,
    /// Bytes the model occupies on disk; 0 when nothing is installed.
    pub bytes: u64,
    /// Bytes a fresh install downloads — the pinned archive size.
    pub download_bytes: u64,
    /// Whether the engine is loaded and warm in this process.
    pub loaded: bool,
}

/// The voice: where its files live, and the engine once it has been loaded.
pub struct TtsHandle {
    /// `<app-data>/tts`.
    dir: PathBuf,
    spec: &'static ModelSpec,
    /// `None` until the first synthesis; kept for the life of the process.
    engine: Mutex<Option<Kokoro>>,
    /// Held for the length of an install, so two Settings taps do not download
    /// the same 365 MB twice over each other.
    installing: Mutex<()>,
}

impl TtsHandle {
    /// A handle over the app-data directory. Touches no disk and loads
    /// nothing — a learner who never taps 🔊 pays for none of this.
    pub fn new(app_data_dir: &Path) -> TtsHandle {
        TtsHandle {
            dir: app_data_dir.join(TTS_DIR),
            spec: &KOKORO,
            engine: Mutex::new(None),
            installing: Mutex::new(()),
        }
    }

    /// What the Settings screen shows without downloading anything.
    pub fn status(&self) -> TtsStatus {
        TtsStatus {
            model: self.spec.dir,
            installed: self.spec.installed_in(&self.dir),
            bytes: self.spec.bytes_in(&self.dir),
            download_bytes: self.spec.bytes,
            loaded: self
                .engine
                .lock()
                .map(|engine| engine.is_some())
                .unwrap_or(false),
        }
    }

    /// Downloads and unpacks the model if it is not already here.
    ///
    /// Idempotent and safe to call from two places at once — the second caller
    /// waits on the first and then finds the model installed.
    pub fn install(&self, on_progress: model::OnProgress<'_>) -> Result<(), String> {
        let _guard = self
            .installing
            .lock()
            .map_err(|_| "the previous voice-model download failed badly".to_owned())?;
        self.spec.install(&self.dir, on_progress)
    }

    /// Synthesizes one phrase and returns a complete WAV file.
    ///
    /// `sid` indexes the model's 103 voices and `speed` is a multiplier
    /// (1 = as trained) — the same two numbers the browser worker takes, from
    /// the same `languages.ts` table, because it is the same model.
    ///
    /// Blocking, and expected to be: seconds of ONNX inference. The caller runs
    /// it off the main thread.
    pub fn synthesize(&self, text: &str, sid: i32, speed: f32) -> Result<Vec<u8>, String> {
        let mut engine = self
            .engine
            .lock()
            .map_err(|_| "the voice engine failed and cannot be reused".to_owned())?;
        if engine.is_none() {
            *engine = Some(self.load()?);
        }
        let tts = engine.as_mut().expect("the engine was just loaded");

        let clip = tts.generate(text, sid, speed)?;

        if clip.samples.is_empty() {
            return Err("the model produced no samples".to_owned());
        }
        if !is_audible(&clip.samples) {
            return Err("the model produced silence (all-zero or NaN samples)".to_owned());
        }
        Ok(wav::encode_wav(&clip.samples, clip.sample_rate))
    }

    /// Builds the engine over the installed files.
    ///
    /// The config mirrors `sherpa-worker.js`'s `TTS_CONFIG` field for field —
    /// two lexicons plus espeak-ng data, and the date/number FSTs that turn
    /// "2026" into 二零二六 — because a phrase must sound the same on both
    /// hosts.
    fn load(&self) -> Result<Kokoro, String> {
        if !self.spec.installed_in(&self.dir) {
            return Err("the voice model is not downloaded yet".to_owned());
        }
        let dir = self.spec.dir_in(&self.dir);
        let path = |file: &str| dir.join(file).to_string_lossy().into_owned();

        Kokoro::load(&KokoroConfig {
            model: path("model.onnx"),
            voices: path("voices.bin"),
            tokens: path("tokens.txt"),
            data_dir: path("espeak-ng-data"),
            // The browser worker leaves this empty, and the comment there
            // explains why: from sherpa-onnx v1.12.15 the Chinese frontend
            // segments with a phrase matcher over the lexicon and a dict dir
            // only logs "not used". The native build here is pinned to the
            // v1.12.9 C API, which is *before* that change and refuses to start
            // a multi-lingual Kokoro without one — so the same archive's
            // jieba dictionaries are handed over.
            dict_dir: path("dict"),
            lexicon: format!("{},{}", path("lexicon-us-en.txt"), path("lexicon-zh.txt")),
            rule_fsts: format!("{},{}", path("date-zh.fst"), path("number-zh.fst")),
            // The whole machine: this is one interactive request at a time, not
            // a batch job sharing the box with anything else.
            num_threads: available_threads(),
            length_scale: LENGTH_SCALE,
            max_num_sentences: MAX_NUM_SENTENCES,
            silence_scale: SILENCE_SCALE,
        })
    }
}

/// Whether a clip carries any signal at all. One pass with an early exit, and
/// NaN-safe by construction — see the module note.
fn is_audible(samples: &[f32]) -> bool {
    samples.iter().any(|s| s.abs() > AUDIBLE_THRESHOLD)
}

/// Cores to give ONNX, never fewer than one.
fn available_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|cores| cores.get().min(i32::MAX as usize) as i32)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_and_nan_both_fail_the_audible_check() {
        assert!(!is_audible(&[]));
        assert!(!is_audible(&[0.0, 0.0, 0.0]));
        assert!(!is_audible(&[f32::NAN; 8]), "sherpa-onnx#2236's shape");
        assert!(!is_audible(&[1e-5, -1e-5]), "below the threshold");
        assert!(is_audible(&[0.0, 0.0, 0.2]));
        assert!(is_audible(&[-0.5]));
    }

    #[test]
    fn there_is_always_at_least_one_thread() {
        assert!(available_threads() >= 1);
    }

    #[test]
    fn a_handle_over_an_empty_directory_reports_nothing_installed() {
        let status = TtsHandle::new(Path::new("/nonexistent/sapling")).status();

        assert!(!status.installed);
        assert!(!status.loaded);
        assert_eq!(status.bytes, 0);
        assert_eq!(status.download_bytes, KOKORO.bytes);
        assert_eq!(status.model, KOKORO.dir);
    }

    #[test]
    fn synthesis_without_a_model_is_an_error_and_not_a_crash() {
        let handle = TtsHandle::new(Path::new("/nonexistent/sapling"));

        let failure = handle.synthesize("你好", 3, 1.0).unwrap_err();
        assert!(failure.contains("not downloaded"), "{failure}");
    }
}
