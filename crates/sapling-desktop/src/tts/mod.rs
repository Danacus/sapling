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
//! ## Status waits for nothing, and that is the point
//!
//! Settings opens while a phrase is being spoken, and it asks [`TtsHandle::status`]
//! how big the download is. If that answer came from *inside* the engine mutex
//! it would queue behind a model load plus a second of inference, on the thread
//! that composites the window. So it takes no lock at all: `loaded` is an
//! [`AtomicBool`] beside the engine rather than a peek into it.
//!
//! It also stops re-walking the model tree. "Installed" is nine `stat`s and
//! "what does it cost" is every file under 400 MB of model, espeak-ng's
//! thousands included — so both are measured once and latched, because an
//! installed model does not uninstall itself while the process runs. While it
//! is *not* installed every call re-probes, since a download finishing is
//! precisely the change the screen is waiting for.
//!
//! ## A model on the live path is a whole model
//!
//! Nothing above would be safe if an install could be seen half-done, and none
//! of it defends against that. [`model`] does, one layer down: an install
//! unpacks into a `.partial` directory and reaches the live path by a single
//! `rename`, so at every instant that path is either absent or a complete
//! model. That is what lets [`TtsHandle::status`] latch a size without ever
//! consulting the install lock, and it is what makes [`TtsHandle::load`] safe
//! to run while a download is unpacking — the case that used to kill the
//! process, because sherpa-onnx over a half-written `espeak-ng-data` does not
//! fail, it calls `exit(-1)`. `load` deliberately does *not* take the install
//! lock: taking it would park every phrase behind a 365 MB download for the
//! sake of a tree it can no longer see. Loading with no model installed is an
//! ordinary `Err`, as it always was.
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

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
    /// Bytes the model occupies on disk; 0 while it is not installed. A
    /// download in progress is not a cost the learner has yet, and it is not
    /// visible here either: it is assembled under another name entirely.
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
    /// Whether [`engine`](Self::engine) holds a model, readable *without* that
    /// lock — which is the only reason it exists. See the module header.
    loaded: AtomicBool,
    /// What the installed model occupies on disk, latched the first time every
    /// file the engine names is present. Absent means "not installed, ask the
    /// disk again"; see the module header for why the answer keeps once true.
    installed: OnceLock<u64>,
    /// Held for the length of an install, so two Settings taps do not download
    /// the same 365 MB twice over each other. Nothing that *reads* the model
    /// touches it — not [`status`](Self::status) and not
    /// [`load`](Self::load) — because the staging rename means a reader can
    /// never catch the model mid-write.
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
            loaded: AtomicBool::new(false),
            installed: OnceLock::new(),
            installing: Mutex::new(()),
        }
    }

    /// What the Settings screen shows without downloading anything.
    ///
    /// Waits on nothing — not the engine mutex a synthesis holds for seconds,
    /// and not the model tree once it has been walked. The screen that asks
    /// this is one a learner opens mid-phrase.
    pub fn status(&self) -> TtsStatus {
        let installed = self.installed_bytes();
        TtsStatus {
            model: self.spec.dir,
            installed: installed.is_some(),
            bytes: installed.unwrap_or(0),
            download_bytes: self.spec.bytes,
            // Relaxed because nothing is published through this flag: it is one
            // boolean on a settings row, and the engine it describes is reached
            // through the mutex either way.
            loaded: self.loaded.load(Ordering::Relaxed),
        }
    }

    /// What the model costs on disk, or `None` while it is not (yet) all here.
    ///
    /// Latched once it answers, and it takes no lock of any kind to answer:
    /// an install in flight is assembling its tree somewhere else entirely, so
    /// there is no half-written model here to be caught measuring.
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
            // Published beside the engine rather than inside it, so `status`
            // can answer "warm" without waiting for this call to finish.
            self.loaded.store(true, Ordering::Relaxed);
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
    /// Runs happily while a download is unpacking, and takes no install lock to
    /// do it: what that install is writing is a `.partial` tree under another
    /// name, and the model directory this reads is either the whole previous
    /// model or nothing at all. Nothing at all is an `Err` and always has been
    /// — a phrase spoken before the download finishes falls back to the
    /// browser voice, which is what `tts.ts` does with every other refusal.
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
    use std::fs;

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
        assert!(!handle.status().loaded, "a load that failed is not warm");
    }

    #[test]
    fn status_answers_while_a_synthesis_holds_the_engine() {
        let handle = TtsHandle::new(Path::new("/nonexistent/sapling"));
        // The lock `synthesize` holds across a model load and a second of
        // inference. If `status` took it too this test would hang here — which
        // is what Settings did to the main thread.
        let engine = handle.engine.lock().expect("the engine lock is free");

        let status = handle.status();

        assert!(!status.loaded);
        assert!(!status.installed);
        drop(engine);
    }

    #[test]
    fn the_installed_answer_is_measured_once_and_then_kept() {
        let root = fake_model("latched");
        let handle = TtsHandle::new(&root);

        let first = handle.status();
        assert!(first.installed);
        assert_eq!(first.bytes, KOKORO.files.len() as u64, "one byte per file");

        // The tree is gone and the answer does not change: an installed model
        // does not uninstall itself while the process runs, and re-walking it
        // per call is exactly what this avoids.
        fs::remove_dir_all(&root).unwrap();
        let second = handle.status();
        assert!(second.installed);
        assert_eq!(second.bytes, first.bytes);

        // A handle that never saw it, though, reports what is on disk now.
        assert!(!TtsHandle::new(&root).status().installed);
    }

    #[test]
    fn status_does_not_wait_for_an_install_to_finish() {
        let root = fake_model("installing");
        let handle = TtsHandle::new(&root);
        // What `install` holds while it downloads and unpacks. `status` used to
        // read this lock and answer "not installed" whenever it was held,
        // because `unpack` extracted into the live directory. It extracts into
        // a `.partial` sibling now, so what is here is the whole previous model
        // and there is nothing to protect a reader from.
        let installing = handle.installing.lock().expect("the install lock is free");

        let status = handle.status();

        assert!(
            status.installed,
            "the live path is a model or it is nothing"
        );
        assert_eq!(status.bytes, KOKORO.files.len() as u64);

        drop(installing);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tree_that_is_still_unpacking_is_neither_installed_nor_loadable() {
        let root = temp_root("unpacking");
        let models = root.join(TTS_DIR);
        // What `unpack` is writing while it runs: nearly a whole model, under
        // the staging name. Handing this one to sherpa-onnx is what used to end
        // the process — its espeak init calls `exit(-1)` over a partial
        // `espeak-ng-data` rather than returning an error anyone could catch.
        write_model(&KOKORO.staging_in(&models), &KOKORO.files[1..]);
        let handle = TtsHandle::new(&root);

        assert!(!handle.status().installed, "a staging tree is not a model");
        // `.err()` rather than `expect_err`, because a loaded `Kokoro` has no
        // `Debug` and this call cannot return one anyway.
        let failure = handle.load().err().expect("there is no model to load");
        assert!(failure.contains("not downloaded"), "{failure}");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn committing_a_staged_tree_publishes_it_and_takes_the_staging_away() {
        let root = temp_root("staged");
        let models = root.join(TTS_DIR);
        let staging = KOKORO.staging_in(&models);
        write_model(&staging, KOKORO.files);
        let handle = TtsHandle::new(&root);
        assert!(
            !handle.status().installed,
            "not until it is moved into place"
        );

        KOKORO.commit_staged(&staging, &models).unwrap();

        let status = handle.status();
        assert!(status.installed, "the rename is the whole install");
        assert_eq!(status.bytes, KOKORO.files.len() as u64, "one byte per file");
        assert!(!staging.exists(), "and the staging tree is gone");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_incomplete_staging_tree_never_reaches_the_live_path() {
        let root = temp_root("incomplete");
        let models = root.join(TTS_DIR);
        let staging = KOKORO.staging_in(&models);
        write_model(&staging, &KOKORO.files[1..]);

        let failure = KOKORO
            .commit_staged(&staging, &models)
            .expect_err("an archive short of a file is a failed install");

        assert!(failure.contains("missing files"), "{failure}");
        assert!(!KOKORO.dir_in(&models).exists(), "nothing was published");
        assert!(!TtsHandle::new(&root).status().installed);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_next_install_sweeps_the_last_one_s_remains() {
        let root = fake_model("leftover");
        let models = root.join(TTS_DIR);
        let staging = KOKORO.staging_in(&models);
        // A crash or a cancel mid-unpack leaves this, and it is 400 MB of
        // nothing: the install that follows clears it before it does anything
        // else — including before answering "already installed", which is the
        // answer this call gets and the only reason it needs no network.
        write_model(&staging, &KOKORO.files[1..]);
        let handle = TtsHandle::new(&root);

        handle.install(&|_, _, _| {}).unwrap();

        assert!(!staging.exists(), "the remains are swept");
        assert!(handle.status().installed, "and the model is untouched");

        fs::remove_dir_all(&root).unwrap();
    }

    /// An app-data directory whose model is complete: every file the engine
    /// names, one byte each, nested directories included.
    fn fake_model(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_model(&root.join(TTS_DIR), KOKORO.files);
        root
    }

    /// An empty directory of this test's own, standing in for app-data.
    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sapling-tts-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&root);
        root
    }

    /// Writes a model tree under `models_dir`, one byte per file. `models_dir`
    /// is wherever the model directory goes — the live `tts/` directory, or the
    /// staging tree an unpack is filling. `KOKORO.files` makes a whole model;
    /// anything less is what an interrupted unpack looks like.
    fn write_model(models_dir: &Path, files: &[&str]) {
        let dir = KOKORO.dir_in(models_dir);
        for file in files {
            let path = dir.join(file);
            fs::create_dir_all(path.parent().expect("every entry has a parent")).unwrap();
            fs::write(path, b"x").unwrap();
        }
    }
}
