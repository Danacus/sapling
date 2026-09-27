//! The recognizer itself: SenseVoice through k2-fsa's own Rust API.
//!
//! `kokoro.rs`'s opposite number, and deliberately the same shape — check the
//! paths ourselves so a bad configuration says which file is missing rather
//! than logging a line and handing back `None`, then one call into
//! [`OfflineRecognizer`]. The wrapper keeps every `CString` alive across the C
//! call (`to_sys(&mut cstrings)`), which is what made the FFI here safe enough
//! for the crate to `forbid(unsafe_code)`.
//!
//! ## Offline, one utterance at a time
//!
//! SenseVoice is a non-streaming model: it wants a whole utterance and gives
//! back a whole sentence, which is exactly the shape `listen()` has always
//! promised — one press, one `onTranscript(text, true)`, one `onEnd()`. A
//! streaming Zipformer with endpoint detection and partial transcripts is a
//! different model and a different set of host commands (`asr_start` /
//! `asr_feed` / `asr_stop`); the handler signature already has room for it and
//! nothing here is in its way.
//!
//! ## The language is `auto`, and that is the model's own job
//!
//! `OfflineSenseVoiceModelConfig::language` is fixed at create time, so telling
//! the recognizer which language to expect would mean rebuilding it — a fresh
//! ONNX session over 239 MB — every time a learner changes target language, in
//! exchange for a hint on a model whose whole selling point is that it
//! identifies zh, en, ja, ko and yue itself. So the engine is built once with
//! `auto`, and the *routing* decision — which languages reach this host at all
//! — stays where every other language decision in the app lives, in
//! `src/lib/asr/` over `bcp47For`.
//!
//! ## Inverse text normalization is on
//!
//! `use_itn` is what turns a spoken "twenty twenty six" into "2026" and puts
//! the commas and full stops in. The transcript lands in the composer for the
//! learner to read and send, so it should look like something a person would
//! type; a sentence of bare lowercase syllables would be a thing they have to
//! repair before every send.

use std::path::Path;

use sherpa_onnx::{
    OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
};

/// Everything sherpa-onnx needs to build the recognizer. Paths are absolute,
/// since the process's working directory is nothing this host controls.
pub struct SenseVoiceConfig {
    pub model: String,
    pub tokens: String,
    pub num_threads: i32,
}

/// A loaded SenseVoice recognizer.
///
/// The wrapper's `OfflineRecognizer` is `Send + Sync`, but this host keeps it
/// behind a `Mutex` all the same ([`super::AsrHandle`]): sherpa-onnx makes no
/// promise about two threads decoding on one recognizer, and one ONNX session
/// on a shared CPU is what we want anyway.
pub struct SenseVoice {
    recognizer: OfflineRecognizer,
}

impl SenseVoice {
    /// Loads the recognizer, or says why it could not.
    ///
    /// The paths are checked here rather than left to sherpa-onnx: the C API
    /// answers a bad configuration with a log line and a null pointer, which
    /// reaches us as `None`, and "no recognizer" is not something a caller
    /// should have to diagnose from a log.
    pub fn load(config: &SenseVoiceConfig) -> Result<SenseVoice, String> {
        for path in [&config.model, &config.tokens] {
            if !Path::new(path).exists() {
                return Err(format!("dictation is missing {path}"));
            }
        }

        let recognizer = OfflineRecognizer::create(&OfflineRecognizerConfig {
            model_config: OfflineModelConfig {
                sense_voice: OfflineSenseVoiceModelConfig {
                    model: Some(config.model.clone()),
                    // See the module header: the model identifies the language
                    // itself, and the app has already decided that whatever is
                    // being spoken is one of the five it knows.
                    language: Some("auto".to_owned()),
                    use_itn: true,
                },
                tokens: Some(config.tokens.clone()),
                num_threads: config.num_threads.max(1),
                debug: false,
                provider: Some("cpu".to_owned()),
                // Every other model family stays at its default, which is all
                // paths unset — that is how the C API is told "not this one".
                ..Default::default()
            },
            ..Default::default()
        })
        .ok_or_else(|| "sherpa-onnx refused the dictation configuration".to_owned())?;

        Ok(SenseVoice { recognizer })
    }

    /// Transcribes one utterance of 16 kHz mono samples in [-1, 1].
    ///
    /// Seconds of CPU at worst; never call it on a UI thread.
    ///
    /// An empty result is not an error and must not be turned into one: a
    /// learner who opened the microphone and said nothing gets an empty string,
    /// which `native.ts` ends silently, exactly as Web Speech's `no-speech`
    /// does.
    pub fn transcribe(&self, samples: &[f32], sample_rate: i32) -> Result<String, String> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(sample_rate, samples);
        self.recognizer.decode(&stream);
        let result = stream
            .get_result()
            .ok_or_else(|| "the recognizer returned no result".to_owned())?;
        Ok(result.text.trim().to_owned())
    }
}
