//! The one place this crate speaks FFI.
//!
//! ## Why this exists rather than `sherpa-rs`
//!
//! `sherpa-rs` is the safe wrapper over `sherpa-rs-sys`, and it is what this
//! module was going to be a thin call into. It cannot be used here: its
//! `KokoroTts::new` builds the rule-FST paths as
//! `raw.rule_fsts.map(|v| v.as_ptr()).unwrap_or(null())`, and `Option::map`
//! *consumes* the `CString` — so the pointer handed to
//! `SherpaOnnxCreateOfflineTts` dangles the moment the closure returns. With
//! non-empty `rule_fsts` (which is every configuration we want) sherpa-onnx
//! reads freed memory, logs `Rule fst '<garbage>' does not exist`, returns a
//! null engine, and the next call segfaults. Reproduced against 0.6.8, still
//! present on the crate's `main` at the time of writing.
//!
//! Dropping the FSTs instead was the alternative, and it is not acceptable:
//! `date-zh.fst` and `number-zh.fst` are what turn "2026" into 二零二六 rather
//! than letting an Arabic digit fall through to espeak and come out as English
//! "three" in the middle of a Chinese sentence. The browser has them
//! (`sherpa-worker.js`'s `ruleFsts`), so this host must too, or the same phrase
//! is a different phrase depending on where the app is running.
//!
//! So the dependency is `sherpa-rs-sys` — the *bindings*, which are generated
//! against the headers of the exact sherpa-onnx tag whose prebuilt libraries
//! its build script downloads — and the twenty lines `sherpa-rs` would have
//! contributed live here, with the `CString`s kept alive across the call that
//! reads them.
//!
//! ## What the unsafety rests on
//!
//! Every raw pointer handed across is derived from a `CString` local to
//! [`Kokoro::load`], and none of them outlive the
//! `SherpaOnnxCreateOfflineTts` call that copies their contents into C++
//! `std::string`s. `mem::zeroed` fills the model configs for the engines we do
//! not use, which is how the C API is meant to be called — a null `const char *`
//! reads as "not configured", and sherpa-onnx picks the engine whose model path
//! is set. The generated audio is copied out and freed through the C API's own
//! destructor before this module hands anything back, so no Rust value ever
//! borrows sherpa-onnx's memory.

// The one exception to the crate's `deny(unsafe_code)`; see `lib.rs`.
#![allow(unsafe_code)]

use std::ffi::CString;
use std::mem;
use std::path::Path;
use std::ptr::null;

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
    /// Comma-separated rule-FST paths — the reason this module exists.
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
/// `Send` but deliberately not `Sync`: sherpa-onnx makes no promise about two
/// threads calling `Generate` on one engine, so the owner keeps it behind a
/// `Mutex` and this type does not invite anything else.
pub struct Kokoro {
    tts: *const sherpa_rs_sys::SherpaOnnxOfflineTts,
}

// SAFETY: the engine is a self-contained C++ object with no thread affinity;
// only concurrent *use* is unsound, and `!Sync` is what rules that out.
unsafe impl Send for Kokoro {}

impl Kokoro {
    /// Loads the engine, or says why it could not.
    ///
    /// The paths are checked here rather than left to sherpa-onnx: the C API
    /// answers a bad configuration with a log line and a null pointer, and a
    /// null pointer is not something a caller should have to think about.
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

        let model = cstring(&config.model)?;
        let voices = cstring(&config.voices)?;
        let tokens = cstring(&config.tokens)?;
        let data_dir = cstring(&config.data_dir)?;
        let dict_dir = cstring(&config.dict_dir)?;
        let lexicon = cstring(&config.lexicon)?;
        let rule_fsts = cstring(&config.rule_fsts)?;
        let provider = cstring("cpu")?;
        // `lang` is empty: the multi-lingual model decides per run, which is the
        // whole reason it is the one we ship.
        let empty = cstring("")?;

        // SAFETY: every pointer below borrows a `CString` that lives until the
        // end of this function, and `SherpaOnnxCreateOfflineTts` copies what it
        // reads. The zeroed configs are the other TTS families, which are
        // "absent" precisely by having null model paths.
        let tts = unsafe {
            let raw = sherpa_rs_sys::SherpaOnnxOfflineTtsConfig {
                model: sherpa_rs_sys::SherpaOnnxOfflineTtsModelConfig {
                    vits: mem::zeroed(),
                    matcha: mem::zeroed(),
                    kitten: mem::zeroed(),
                    kokoro: sherpa_rs_sys::SherpaOnnxOfflineTtsKokoroModelConfig {
                        model: model.as_ptr(),
                        voices: voices.as_ptr(),
                        tokens: tokens.as_ptr(),
                        data_dir: data_dir.as_ptr(),
                        length_scale: config.length_scale,
                        dict_dir: dict_dir.as_ptr(),
                        lexicon: lexicon.as_ptr(),
                        lang: empty.as_ptr(),
                    },
                    num_threads: config.num_threads.max(1),
                    debug: 0,
                    provider: provider.as_ptr(),
                },
                rule_fsts: rule_fsts.as_ptr(),
                rule_fars: null(),
                max_num_sentences: config.max_num_sentences,
                silence_scale: config.silence_scale,
            };
            sherpa_rs_sys::SherpaOnnxCreateOfflineTts(&raw)
        };

        if tts.is_null() {
            return Err("sherpa-onnx refused the voice configuration".to_owned());
        }
        Ok(Kokoro { tts })
    }

    /// The model's output rate, in Hz.
    pub fn sample_rate(&self) -> u32 {
        // SAFETY: `self.tts` is non-null for the life of the value.
        let rate = unsafe { sherpa_rs_sys::SherpaOnnxOfflineTtsSampleRate(self.tts) };
        rate.max(1) as u32
    }

    /// How many voices `sid` may index.
    pub fn speakers(&self) -> i32 {
        // SAFETY: as above.
        unsafe { sherpa_rs_sys::SherpaOnnxOfflineTtsNumSpeakers(self.tts) }
    }

    /// Synthesizes one phrase. Seconds of CPU; never call it on a UI thread.
    ///
    /// `&mut self` because sherpa-onnx promises nothing about concurrent
    /// generation, and a `&mut` is how that is said in Rust.
    pub fn generate(&mut self, text: &str, sid: i32, speed: f32) -> Result<Clip, String> {
        let text = cstring(text)?;

        // SAFETY: `text` outlives the call; the returned pointer is either null
        // or a `SherpaOnnxGeneratedAudio` we own until we destroy it below.
        let audio = unsafe {
            sherpa_rs_sys::SherpaOnnxOfflineTtsGenerate(self.tts, text.as_ptr(), sid, speed)
        };
        if audio.is_null() {
            return Err("the voice produced nothing".to_owned());
        }

        // SAFETY: `audio` is non-null, and `n`/`samples` are the length and
        // buffer sherpa-onnx just filled. The samples are copied before the
        // destructor runs, so nothing outlives the C allocation.
        let clip = unsafe {
            let generated = *audio;
            let samples = if generated.samples.is_null() || generated.n <= 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(generated.samples, generated.n as usize).to_vec()
            };
            let sample_rate = generated.sample_rate.max(1) as u32;
            sherpa_rs_sys::SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
            Clip {
                samples,
                sample_rate,
            }
        };
        Ok(clip)
    }
}

impl Drop for Kokoro {
    fn drop(&mut self) {
        // SAFETY: the pointer came from `SherpaOnnxCreateOfflineTts`, is
        // non-null, and this is the only place it is destroyed.
        unsafe { sherpa_rs_sys::SherpaOnnxDestroyOfflineTts(self.tts) };
    }
}

/// A NUL-terminated copy of `text`, or an error rather than a panic — the text
/// being spoken comes from a lesson, and a stray NUL must not take the app down.
fn cstring(text: &str) -> Result<CString, String> {
    CString::new(text).map_err(|_| "the text contains a NUL byte".to_owned())
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
        assert!(cstring("hello\0world").is_err());
        assert!(cstring("你好").is_ok());
    }
}
