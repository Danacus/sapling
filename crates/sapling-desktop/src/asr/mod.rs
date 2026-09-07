//! Dictation, natively — the second thing this host lends to speech, and the
//! mirror of [`crate::tts`].
//!
//! The web app has had one recognizer since dictation existed: the browser's
//! Web Speech API. It is absent in Firefox, absent in WebKitGTK, absent in
//! Android's WebView, and where it *is* present it ships the audio to a vendor.
//! sherpa-onnx runs a recognizer on the device, over the same libraries the
//! voice already links, so on a Tauri host dictation stops being a browser
//! feature and becomes a host capability — text in, audio out for the voice;
//! audio in, text out for this.
//!
//! It is still a *host* capability in the narrow sense `desktop.md` insists on:
//! samples in, a sentence out, and not one word of domain knowledge. Which
//! languages route here, what a transcript is then used for, and the rule that
//! it lands in the composer for the learner to endorse rather than being sent —
//! all of that stays in `src/lib/asr/`, which is the same code the web build
//! runs.
//!
//! ## The audio is captured in the WebView, on both hosts
//!
//! Unlike playback, capture did not move. The desktop's reason for taking
//! *playback* over is a measured WebKitGTK stall building a GStreamer pipeline
//! per clip, and nothing like it applies to `getUserMedia` — which works in
//! both webviews. So one code path captures 16 kHz mono PCM with an
//! `AudioWorklet` (`static/asr/pcm-worklet.js`), the learner presses stop, and
//! the samples cross the IPC as a raw body exactly as `tts_play`'s clip does.
//! The host never opens a microphone and has no `cpal` on the recording side.
//!
//! ## The engine is loaded once and kept, and status waits for nothing
//!
//! Both are the voice's rules for the voice's reasons, and this module is the
//! same shape one model over: [`AsrHandle::transcribe`] builds the recognizer
//! on the first utterance and every later one reuses it, behind a `Mutex`;
//! [`AsrHandle::status`] takes no lock at all, because Settings asks it while
//! an utterance may be decoding and because the screen that asks is one a
//! learner opens mid-sentence. `loaded` is an [`AtomicBool`] beside the engine,
//! and "installed" is measured once and latched — an installed model does not
//! uninstall itself while the process runs.
//!
//! ## One utterance, and no VAD
//!
//! Phase one is button-stopped: the learner presses stop, and only then does
//! anything reach this module. sherpa-onnx ships Silero VAD and a streaming
//! Zipformer, and either would live here — but the handler shape
//! (`onTranscript(text, final)`) is what a future phase changes, not this
//! seam's, and a recognizer that answers once is the simplest host command that
//! honours the contract.

pub mod sense_voice;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::models::{self, available_threads, ModelSpec, SENSE_VOICE};
use sense_voice::{SenseVoice, SenseVoiceConfig};

/// Directory holding every recognition model, inside Tauri's app-data
/// directory. A sibling of `tts/`, so neither install can see the other's
/// staging trees.
pub const ASR_DIR: &str = "asr";

/// What the samples crossing the IPC are, and what the recognizer is fed.
///
/// 16 kHz mono is what every speech model in sherpa-onnx wants and what the
/// feature extractor is configured for; the window resamples to it if the
/// `AudioContext` would not open at that rate (`src/lib/asr/pcm.ts`). Named
/// here as well because a mismatch is not an error anywhere — it is a
/// transcript of the right words at the wrong speed.
pub const SAMPLE_RATE: i32 = 16_000;

/// The BCP-47 primary subtags this model covers, in the order upstream names
/// them.
///
/// This is the whole of the routing contract with the window: `src/lib/asr/`
/// resolves the learner's free-text language through `bcp47For`, takes the
/// primary subtag, and asks whether it is in this list. Everything else keeps
/// Web Speech, or gets no microphone button at all.
pub const LANGUAGES: &[&str] = &["zh", "en", "ja", "ko", "yue"];

/// What `asr_status` answers. Serialized camelCase because it is read by
/// TypeScript, and the field names are `native.ts`'s `NativeAsrStatus`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrStatus {
    /// The model this host would use, for the Settings copy.
    pub model: &'static str,
    /// Every file the recognizer config names is present.
    pub installed: bool,
    /// Bytes the model occupies on disk; 0 while it is not installed.
    pub bytes: u64,
    /// Bytes a fresh install downloads — the pinned archive size.
    pub download_bytes: u64,
    /// Whether the recognizer is loaded and warm in this process.
    pub loaded: bool,
    /// The languages this host can transcribe — [`LANGUAGES`]. Sent rather than
    /// hard-coded on the other side, so swapping the model is a spec change
    /// here and nothing at all in the window.
    pub languages: &'static [&'static str],
}

/// Dictation: where its model lives, and the recognizer once it has been
/// loaded.
pub struct AsrHandle {
    /// `<app-data>/asr`.
    dir: PathBuf,
    spec: &'static ModelSpec,
    /// `None` until the first utterance; kept for the life of the process.
    engine: Mutex<Option<SenseVoice>>,
    /// Whether [`engine`](Self::engine) holds a model, readable *without* that
    /// lock — which is the only reason it exists. See the module header.
    loaded: AtomicBool,
    /// What the installed model occupies on disk, latched the first time every
    /// file the recognizer names is present.
    installed: OnceLock<u64>,
    /// Held for the length of an install, so two Settings taps do not download
    /// the same 163 MB twice over each other. Nothing that *reads* the model
    /// touches it — not [`status`](Self::status) and not [`load`](Self::load) —
    /// because the staging rename means a reader can never catch the model
    /// mid-write.
    installing: Mutex<()>,
}

impl AsrHandle {
    /// A handle over the app-data directory. Touches no disk and loads
    /// nothing — a learner who never taps 🎤 pays for none of this.
    pub fn new(app_data_dir: &Path) -> AsrHandle {
        AsrHandle {
            dir: app_data_dir.join(ASR_DIR),
            spec: &SENSE_VOICE,
            engine: Mutex::new(None),
            loaded: AtomicBool::new(false),
            installed: OnceLock::new(),
            installing: Mutex::new(()),
        }
    }

    /// What the Settings screen shows without downloading anything, and what
    /// the window's one memoised probe reads to decide whether the microphone
    /// button renders at all.
    ///
    /// Waits on nothing — not the engine mutex a decode holds, and not the
    /// model tree once it has been walked.
    pub fn status(&self) -> AsrStatus {
        let installed = self.installed_bytes();
        AsrStatus {
            model: self.spec.dir,
            installed: installed.is_some(),
            bytes: installed.unwrap_or(0),
            download_bytes: self.spec.bytes,
            // Relaxed because nothing is published through this flag: it is one
            // boolean on a settings row, and the engine it describes is reached
            // through the mutex either way.
            loaded: self.loaded.load(Ordering::Relaxed),
            languages: LANGUAGES,
        }
    }

    /// What the model costs on disk, or `None` while it is not (yet) all here.
    ///
    /// Latched once it answers, and it takes no lock of any kind to answer: an
    /// install in flight is assembling its tree somewhere else entirely.
    fn installed_bytes(&self) -> Option<u64> {
        if let Some(bytes) = self.installed.get() {
            return Some(*bytes);
        }
        if !self.spec.installed_in(&self.dir) {
            return None;
        }
        Some(*self.installed.get_or_init(|| self.spec.bytes_in(&self.dir)))
    }

    /// Downloads and unpacks the model if it is not already here.
    ///
    /// Idempotent and safe to call from two places at once — the second caller
    /// waits on the first and then finds the model installed.
    pub fn install(&self, on_progress: models::OnProgress<'_>) -> Result<(), String> {
        let _guard = self
            .installing
            .lock()
            .map_err(|_| "the previous dictation-model download failed badly".to_owned())?;
        self.spec.install(&self.dir, on_progress)
    }

    /// Transcribes one utterance handed over as 16-bit little-endian mono PCM.
    ///
    /// The bytes are what crossed the IPC as a raw body: signed 16-bit samples
    /// at [`SAMPLE_RATE`], which is half the size of the `f32` the
    /// `AudioWorklet` produced and the format every speech tool in the world
    /// agrees on. An odd length is a caller bug and says so.
    ///
    /// **Silence is not a failure.** No samples, or samples the model found no
    /// words in, come back as an empty string; `native.ts` ends such a session
    /// silently, which is exactly what Web Speech's `no-speech` does. Only a
    /// recognizer that could not be built or could not run is an `Err`.
    ///
    /// Blocking, and expected to be. The caller runs it off the main thread.
    pub fn transcribe(&self, pcm: &[u8]) -> Result<String, String> {
        let samples = decode_pcm16(pcm)?;
        // Nothing was said. Building a 239 MB ONNX session to be told so would
        // be the most expensive way to answer a question with no content.
        if samples.is_empty() {
            return Ok(String::new());
        }

        let mut engine = self
            .engine
            .lock()
            .map_err(|_| "the recognizer failed and cannot be reused".to_owned())?;
        if engine.is_none() {
            *engine = Some(self.load()?);
            // Published beside the engine rather than inside it, so `status`
            // can answer "warm" without waiting for this call to finish.
            self.loaded.store(true, Ordering::Relaxed);
        }
        let asr = engine.as_ref().expect("the recognizer was just loaded");

        asr.transcribe(&samples, SAMPLE_RATE)
    }

    /// Builds the recognizer over the installed files.
    ///
    /// Runs happily while a download is unpacking and takes no install lock to
    /// do it, for the reason `crate::models` gives: the live path is either a
    /// whole model or nothing at all. Nothing at all is an ordinary `Err`, and
    /// the window turns it into a microphone button that is simply not there.
    fn load(&self) -> Result<SenseVoice, String> {
        if !self.spec.installed_in(&self.dir) {
            return Err("the dictation model is not downloaded yet".to_owned());
        }
        let dir = self.spec.dir_in(&self.dir);
        let path = |file: &str| dir.join(file).to_string_lossy().into_owned();

        SenseVoice::load(&SenseVoiceConfig {
            model: path("model.int8.onnx"),
            tokens: path("tokens.txt"),
            // The whole machine on a desktop, capped on a phone — the same
            // answer the voice gets, and for the same reason.
            num_threads: available_threads(),
        })
    }
}

/// 16-bit little-endian PCM to the `f32` samples in [-1, 1] sherpa-onnx wants.
///
/// The divisor is 32768 rather than 32767, matching `tts::wav`'s encoder in the
/// other direction: it is the one that maps the format's range symmetrically
/// and cannot overflow on `i16::MIN`.
fn decode_pcm16(pcm: &[u8]) -> Result<Vec<f32>, String> {
    if !pcm.len().is_multiple_of(2) {
        return Err(format!(
            "the audio is {} bytes, which is not whole 16-bit samples",
            pcm.len()
        ));
    }
    Ok(pcm
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn the_languages_are_the_ones_the_model_was_trained_on() {
        // The routing contract with `src/lib/asr/`: primary subtags, lowercase,
        // and `yue` rather than a `zh-` region, because Cantonese is its own
        // language everywhere else in this app too (`languages.ts`).
        assert_eq!(LANGUAGES, &["zh", "en", "ja", "ko", "yue"]);
        assert!(LANGUAGES.iter().all(|tag| !tag.contains('-')));
    }

    #[test]
    fn a_handle_over_an_empty_directory_reports_nothing_installed() {
        let status = AsrHandle::new(Path::new("/nonexistent/sapling")).status();

        assert!(!status.installed);
        assert!(!status.loaded);
        assert_eq!(status.bytes, 0);
        assert_eq!(status.download_bytes, SENSE_VOICE.bytes);
        assert_eq!(status.model, SENSE_VOICE.dir);
        assert_eq!(status.languages, LANGUAGES);
    }

    #[test]
    fn transcription_without_a_model_is_an_error_and_not_a_crash() {
        let handle = AsrHandle::new(Path::new("/nonexistent/sapling"));

        // One sample, so the empty-audio shortcut does not answer first.
        let failure = handle.transcribe(&[0x00, 0x10]).unwrap_err();
        assert!(failure.contains("not downloaded"), "{failure}");
        assert!(!handle.status().loaded, "a load that failed is not warm");
    }

    #[test]
    fn an_empty_utterance_is_an_empty_transcript_and_never_loads_the_model() {
        // The learner opened the microphone and said nothing. Web Speech calls
        // that `no-speech` and ends silently; so does this, and without paying
        // for an ONNX session to find out.
        let handle = AsrHandle::new(Path::new("/nonexistent/sapling"));

        assert_eq!(handle.transcribe(&[]).unwrap(), "");
        assert!(!handle.status().loaded);
    }

    #[test]
    fn half_a_sample_is_a_caller_bug_and_says_so() {
        let handle = AsrHandle::new(Path::new("/nonexistent/sapling"));

        let failure = handle.transcribe(&[0x01, 0x02, 0x03]).unwrap_err();
        assert!(failure.contains("16-bit samples"), "{failure}");
    }

    #[test]
    fn pcm_decodes_to_the_range_sherpa_onnx_wants() {
        let decoded = decode_pcm16(&[
            0x00, 0x00, // 0
            0x00, 0x40, // 16384 -> 0.5
            0x00, 0xc0, // -16384 -> -0.5
            0x00, 0x80, // i16::MIN -> -1.0 exactly, which 32767 would not give
        ])
        .unwrap();

        assert_eq!(decoded, vec![0.0, 0.5, -0.5, -1.0]);
    }

    #[test]
    fn status_answers_while_an_utterance_holds_the_recognizer() {
        let handle = AsrHandle::new(Path::new("/nonexistent/sapling"));
        // The lock `transcribe` holds across a model load and a decode. If
        // `status` took it too this test would hang here — which is what
        // Settings did to the main thread before the voice's rule existed.
        let engine = handle.engine.lock().expect("the recognizer lock is free");

        let status = handle.status();

        assert!(!status.loaded);
        assert!(!status.installed);
        drop(engine);
    }

    #[test]
    fn status_does_not_wait_for_an_install_to_finish() {
        let root = fake_model("installing");
        let handle = AsrHandle::new(&root);
        // What `install` holds while it downloads and unpacks. The live path is
        // a whole model or nothing, so a reader needs no protection from it.
        let installing = handle.installing.lock().expect("the install lock is free");

        let status = handle.status();

        assert!(status.installed, "the live path is a model or it is nothing");
        assert_eq!(status.bytes, SENSE_VOICE.files.len() as u64);

        drop(installing);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tree_that_is_still_unpacking_is_neither_installed_nor_loadable() {
        let root = temp_root("unpacking");
        let models = root.join(ASR_DIR);
        write_model(&SENSE_VOICE.staging_in(&models), &SENSE_VOICE.files[1..]);
        let handle = AsrHandle::new(&root);

        assert!(!handle.status().installed, "a staging tree is not a model");
        let failure = handle
            .load()
            .err()
            .expect("there is no model to load")
            .to_owned();
        assert!(failure.contains("not downloaded"), "{failure}");

        fs::remove_dir_all(&root).unwrap();
    }

    /// An app-data directory whose model is complete: every file the recognizer
    /// names, one byte each.
    fn fake_model(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_model(&root.join(ASR_DIR), SENSE_VOICE.files);
        root
    }

    /// An empty directory of this test's own, standing in for app-data.
    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sapling-asr-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    /// Writes a model tree under `models_dir`, one byte per file.
    fn write_model(models_dir: &Path, files: &[&str]) {
        let dir = SENSE_VOICE.dir_in(models_dir);
        for file in files {
            let path = dir.join(file);
            fs::create_dir_all(path.parent().expect("every entry has a parent")).unwrap();
            fs::write(path, b"x").unwrap();
        }
    }
}
