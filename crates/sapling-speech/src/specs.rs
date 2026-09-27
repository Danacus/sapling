//! Every model this crate downloads, pinned.
//!
//! A [`ModelSpec`] is the *only* place a model is described — URL, exact byte
//! size, sha256 and the files that must exist — so swapping one is a constant
//! change here. The shape, and the one install every spec goes through, are
//! `sapling-models`'; the pins are speech's, and live beside the engines that
//! read them. Ungated by feature on purpose: three constants cost nothing, and
//! one list is what the pin tests below walk.

use sapling_models::ModelSpec;

/// Kokoro multi-lang v1.1, fp32 — 103 speakers, Mandarin + English.
///
/// **fp32, and not int8, deliberately.** The release also ships
/// `kokoro-int8-multi-lang-v1_1.tar.bz2` at 147 MB against this one's 365 MB,
/// and the temptation is obvious. See the note in `tts/mod.rs` for what was
/// measured: the int8 bug is the *WASM* build's, and one model on both hosts is
/// still worth more than the megabytes.
///
/// The size and hash are of the release asset as published; they are not
/// derived from anything and must be re-measured if the pin ever moves.
pub const KOKORO: ModelSpec = ModelSpec {
    dir: "kokoro-multi-lang-v1_1",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
    bytes: 364_816_464,
    sha256: "a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad",
    files: &[
        "model.onnx",
        "voices.bin",
        "tokens.txt",
        "lexicon-us-en.txt",
        "lexicon-zh.txt",
        "date-zh.fst",
        "number-zh.fst",
        "espeak-ng-data/phontab",
        "dict/jieba.dict.utf8",
    ],
};

/// Single-speaker Cantonese VITS model, converted and published by k2-fsa.
pub const CANTONESE_VITS: ModelSpec = ModelSpec {
    dir: "vits-cantonese-hf-xiaomaiiwn",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-cantonese-hf-xiaomaiiwn.tar.bz2",
    bytes: 107_995_442,
    sha256: "bf3013cd4be34f531b7e514e708d835584dd60c9ad6eaf467ac1402005c04e46",
    files: &[
        "vits-cantonese-hf-xiaomaiiwn.onnx",
        "tokens.txt",
        "lexicon.txt",
        "rule.fst",
    ],
};

/// SenseVoice small, int8 — the recognizer, covering zh, en, ja, ko and yue.
///
/// **int8 here, and that is not a contradiction of [`KOKORO`].** The reason
/// Kokoro ships fp32 is that one model must sound the same on both hosts, and
/// the browser's fp32 is the one that works; there is no browser recognizer at
/// all, so nothing has to agree with anything. What is left is the trade on its
/// own terms, and int8 wins it: 239 MB of weights against 938 MB, indexed
/// against a quality difference nobody has been able to hear in a dictated
/// sentence, on a phone that has to hold the voice model too.
///
/// **The archive is the int8-only one**, not the combined release asset. Both
/// unpack the same `model.int8.onnx`, but the combined archive is 1,047,870,769
/// bytes because it also carries the fp32 export — a gigabyte downloaded to
/// keep a sixth of it. This one is 163 MB and contains exactly what is used.
///
/// It also ships `test_wavs/`, one sentence per language, which is what
/// `tests/dictation.rs` transcribes.
pub const SENSE_VOICE: ModelSpec = ModelSpec {
    dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
    bytes: 163_002_883,
    sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    files: &["model.int8.onnx", "tokens.txt"],
};

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn every_pin_names_an_immutable_release_asset() {
        for spec in [&KOKORO, &CANTONESE_VITS, &SENSE_VOICE] {
            // A tag, not `latest`, and not a branch: the bytes behind this URL
            // may never change, because the size and hash beside it are
            // constants.
            assert!(
                spec.url
                    .starts_with("https://github.com/k2-fsa/sherpa-onnx/releases/download/"),
                "{}",
                spec.url
            );
            // The URL ends in the archive the progress key names, which is what
            // makes one `dir` enough to describe the whole install.
            assert!(spec.url.ends_with(&spec.download_step()), "{}", spec.url);
            assert_eq!(spec.sha256.len(), 64);
            assert!(spec
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
            assert!(!spec.files.is_empty());
        }

        // The published sizes of the two release assets, which is also what
        // each download refuses to exceed by a byte.
        assert_eq!(KOKORO.bytes, 364_816_464);
        assert_eq!(SENSE_VOICE.bytes, 163_002_883);
    }

    #[test]
    fn the_two_progress_keys_of_one_model_are_distinct_and_named_after_it() {
        assert_eq!(
            KOKORO.download_step(),
            "kokoro-multi-lang-v1_1.tar.bz2",
            "the key `tts-model` has always summed"
        );
        assert_eq!(KOKORO.extract_step(), "kokoro-multi-lang-v1_1 (unpacking)");
        assert_ne!(SENSE_VOICE.download_step(), SENSE_VOICE.extract_step());
        assert_ne!(SENSE_VOICE.download_step(), KOKORO.download_step());
    }

    #[test]
    fn an_absent_model_is_neither_installed_nor_counted() {
        let missing = Path::new("/nonexistent/sapling-models");

        assert!(!KOKORO.installed_in(missing));
        assert_eq!(KOKORO.bytes_in(missing), 0);
        assert!(!SENSE_VOICE.installed_in(missing));
    }
}
