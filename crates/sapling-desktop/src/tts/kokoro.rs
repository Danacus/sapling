//! The engine itself: Kokoro through k2-fsa's own Rust API.
//!
//! ## Whose wrapper this is
//!
//! sherpa-onnx publishes two crates from its own repository — `sherpa-onnx-sys`
//! (pregenerated bindings to the C API) and `sherpa-onnx` (the safe wrapper over
//! them) — and this module is a thin call into the second. It did not start
//! that way. The first version of this host used the third-party `sherpa-rs`
//! family and could not use *its* wrapper at all: `KokoroTts::new` built the
//! rule-FST path as `raw.rule_fsts.map(|v| v.as_ptr()).unwrap_or(null())`, and
//! `Option::map` *consumes* the `CString` — so the pointer handed to
//! `SherpaOnnxCreateOfflineTts` dangled the moment the closure returned, and a
//! non-empty `rule_fsts` (which is every configuration we want) got a null
//! engine and a segfault on the next call. So this module hand-rolled the FFI,
//! and it was the crate's only `unsafe`.
//!
//! The official wrapper does not have that bug: [`OfflineTts::create`] builds
//! the config with `to_sys(&mut cstrings)` and every `CString` it makes lives
//! in that `Vec` until after `SherpaOnnxCreateOfflineTts` has copied the
//! strings. So the twenty lines of FFI are gone, and with them the crate's last
//! `unsafe` — `lib.rs` **forbids** it now rather than denying it.
//!
//! The rule FSTs are not optional here, which is why any of this mattered:
//! `date-zh.fst` and `number-zh.fst` are what turn "2026" into 二零二六 rather
//! than letting an Arabic digit fall through to espeak and come out as English
//! digits in the middle of a Chinese sentence. The browser worker passes them
//! (`sherpa-worker.js`'s `ruleFsts`), so this host must too, or the same phrase
//! is a different phrase depending on where the app is running.
//!
//! ## What is still this module's job
//!
//! Two things the wrapper does not do. It answers a bad configuration the way
//! the C API does — with a log line and `None` — so the paths are checked here
//! first and the failure says which file is missing. And `CString::new` panics
//! on an interior NUL inside the wrapper, so text that came out of a lesson is
//! checked here before it is handed over: a stray NUL is an `Err` and a
//! fallback to the browser voice, never a dead process.

use std::ffi::CString;
use std::path::Path;

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};

/// Everything sherpa-onnx needs to build the engine. Paths are absolute, since
/// the process's working directory is nothing this host controls.
pub struct KokoroConfig {
    pub model: String,
    pub voices: String,
    pub tokens: String,
    pub data_dir: String,
    /// The jieba dictionaries the Chinese frontend segments with.
    pub dict_dir: String,
    /// Comma-separated lexicon paths.
    pub lexicon: String,
    /// Comma-separated rule-FST paths — see the module header.
    pub rule_fsts: String,
    pub num_threads: i32,
    pub length_scale: f32,
    pub max_num_sentences: i32,
    pub silence_scale: f32,
}

/// One synthesized clip, owned by Rust.
pub struct Clip {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// A loaded Kokoro engine.
///
/// The wrapper's `OfflineTts` is `Send + Sync`, but this host keeps it behind a
/// `Mutex` all the same ([`super::TtsHandle`]): sherpa-onnx makes no promise
/// about two threads calling `Generate` on one engine, and one ONNX session on
/// a shared CPU is what we want anyway.
pub struct Kokoro {
    tts: OfflineTts,
    silence_scale: f32,
}

impl Kokoro {
    /// Loads the engine, or says why it could not.
    ///
    /// The paths are checked here rather than left to sherpa-onnx: the C API
    /// answers a bad configuration with a log line and a null pointer, which
    /// reaches us as `None`, and "no engine" is not something a caller should
    /// have to diagnose from a log.
    pub fn load(config: &KokoroConfig) -> Result<Kokoro, String> {
        for path in [
            &config.model,
            &config.voices,
            &config.tokens,
            &config.data_dir,
            &config.dict_dir,
        ] {
            if !Path::new(path).exists() {
                return Err(format!("the voice is missing {path}"));
            }
        }

        let tts = OfflineTts::create(&OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                kokoro: OfflineTtsKokoroModelConfig {
                    model: Some(config.model.clone()),
                    voices: Some(config.voices.clone()),
                    tokens: Some(config.tokens.clone()),
                    data_dir: Some(config.data_dir.clone()),
                    length_scale: config.length_scale,
                    dict_dir: Some(config.dict_dir.clone()),
                    lexicon: Some(config.lexicon.clone()),
                    // Left unset: the multi-lingual model decides per run,
                    // which is the whole reason it is the one we ship.
                    lang: None,
                },
                num_threads: config.num_threads.max(1),
                debug: false,
                provider: Some("cpu".to_owned()),
                // Every other model family stays at its default, which is all
                // paths unset — that is how the C API is told "not this one".
                ..Default::default()
            },
            rule_fsts: Some(config.rule_fsts.clone()),
            max_num_sentences: config.max_num_sentences,
            silence_scale: config.silence_scale,
            ..Default::default()
        })
        .ok_or_else(|| "sherpa-onnx refused the voice configuration".to_owned())?;

        Ok(Kokoro {
            tts,
            silence_scale: config.silence_scale,
        })
    }

    /// The model's output rate, in Hz.
    pub fn sample_rate(&self) -> u32 {
        self.tts.sample_rate().max(1) as u32
    }

    /// How many voices `sid` may index.
    pub fn speakers(&self) -> i32 {
        self.tts.num_speakers()
    }

    /// Synthesizes one phrase. Seconds of CPU; never call it on a UI thread.
    ///
    /// `&mut self` because sherpa-onnx promises nothing about concurrent
    /// generation, and a `&mut` is how that is said in Rust.
    pub fn generate(&mut self, text: &str, sid: i32, speed: f32) -> Result<Clip, String> {
        speakable(text)?;

        let audio = self
            .tts
            .generate_with_config(
                text,
                &GenerationConfig {
                    sid,
                    speed,
                    silence_scale: self.silence_scale,
                    ..Default::default()
                },
                // No progress callback: a phrase is one short generate, and the
                // caller is already off the main thread.
                None::<fn(&[f32], f32) -> bool>,
            )
            .ok_or_else(|| "the voice produced nothing".to_owned())?;

        Ok(Clip {
            samples: audio.samples().to_vec(),
            sample_rate: audio.sample_rate().max(1) as u32,
        })
    }
}

/// Rejects text the wrapper would panic on.
///
/// `generate_with_config` builds its `CString` with `.unwrap()`, and the text
/// being spoken came out of a lesson — so an interior NUL has to be an `Err`
/// here, which `tts.ts` turns into the browser voice, rather than a dead host.
fn speakable(text: &str) -> Result<(), String> {
    CString::new(text)
        .map(|_| ())
        .map_err(|_| "the text contains a NUL byte".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_model_is_reported_and_not_a_null_engine() {
        // Matched rather than `unwrap_err`, which would want `Kokoro: Debug` —
        // and a `Debug` for a live ONNX session is worth less than nothing.
        let Err(failure) = Kokoro::load(&KokoroConfig {
            model: "/nonexistent/model.onnx".to_owned(),
            voices: "/nonexistent/voices.bin".to_owned(),
            tokens: "/nonexistent/tokens.txt".to_owned(),
            data_dir: "/nonexistent/espeak-ng-data".to_owned(),
            dict_dir: "/nonexistent/dict".to_owned(),
            lexicon: String::new(),
            rule_fsts: String::new(),
            num_threads: 1,
            length_scale: 1.0,
            max_num_sentences: 1,
            silence_scale: 0.2,
        }) else {
            panic!("a configuration pointing at nothing must not produce an engine");
        };

        assert!(failure.contains("/nonexistent/model.onnx"), "{failure}");
    }

    #[test]
    fn text_with_a_nul_byte_is_an_error() {
        assert!(speakable("hello\0world").is_err());
        assert!(speakable("你好").is_ok());
    }
}
