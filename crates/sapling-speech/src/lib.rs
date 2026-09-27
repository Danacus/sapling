//! Native speech, both ways, on k2-fsa's sherpa-onnx.
//!
//! The `tts` module is Kokoro synthesis (and a Cantonese VITS voice beside it),
//! which the browser runs as sherpa-onnx compiled to WASM and a native host
//! runs here, because WebKitGTK cannot run that WASM path at all. The `asr`
//! module is SenseVoice dictation, which the browser has only as the Web Speech
//! API — absent in WebKitGTK, absent in Firefox, and a round trip to a vendor
//! where it exists. `tts::play` is the one piece that is a single webview's
//! problem: WebKitGTK's audio stack starts a second late per clip and its Web
//! Audio output does not work at all, so a desktop host plays the clip too.
//!
//! All three are *host* capabilities — text in, a WAV file out; a WAV file in,
//! a sound out; samples in, a sentence out — with no domain knowledge
//! whatsoever. Which language routes to which engine, which speaker, when to
//! fall back and what a transcript is then for all stay in `src/lib/tts/` and
//! `src/lib/asr/`. Nothing here knows about Tauri either: `sapling-desktop`
//! wraps each handle in a command and hands it the app-data directory.
//!
//! ## Features
//!
//! `tts` and `asr` (both default) are the two engines; they share sherpa-onnx
//! and `sapling-models`' pinned-archive install, and the pins themselves are
//! [`specs`]. `playback` adds `tts::play` and `rodio`. This crate cannot see
//! Tauri's `desktop` cfg alias, so the *caller* decides where a host plays:
//! `sapling-desktop` enables `playback` for desktop targets only, and
//! [`tts::HOST_PLAYS_AUDIO`] reports exactly that choice to the window.
//!
//! The crate **forbids** `unsafe_code`, and no module may opt out. It used to
//! only deny it, for `tts::kokoro`, which hand-rolled the FFI call into
//! sherpa-onnx because the third-party wrapper of the day freed a config string
//! before the C library read it. That crate is gone: the voice now goes through
//! k2-fsa's own `sherpa-onnx` wrapper, which keeps its `CString`s alive across
//! the call, so there is no FFI here at all any more (`tts/kokoro.rs`).

#![forbid(unsafe_code)]

#[cfg(feature = "asr")]
pub mod asr;
pub mod specs;
#[cfg(feature = "tts")]
pub mod tts;
