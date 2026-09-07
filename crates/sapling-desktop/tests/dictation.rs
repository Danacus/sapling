//! Native dictation, against the real model.
//!
//! `voice.rs`'s opposite number, and the same contract: nothing here can be
//! mocked usefully, because what is worth checking is that sherpa-onnx, the
//! pinned SenseVoice archive and this host's config turn real speech into the
//! right words. So the test **skips itself** unless the model is installed, and
//! says so — a checkout with no model is a normal state, and `pnpm
//! desktop:check` must stay green in it.
//!
//! To make it run, install the model once:
//!
//! ```sh
//! nix develop .#desktop -c cargo test -p sapling-desktop --test dictation -- --ignored --nocapture
//! ```
//!
//! which downloads it into the same place the app does, so the app has it too.
//! Then run the suite with `--nocapture` to see the load and decode timings.
//!
//! **The audio comes from the archive itself.** SenseVoice ships `test_wavs/`,
//! one sentence per language it claims, already 16 kHz 16-bit mono — which is
//! exactly what the window sends over `asr_transcribe`, so the bytes handed to
//! [`AsrHandle::transcribe`] here are the bytes an utterance arrives as, with
//! nothing in between.

mod common;

use std::path::{Path, PathBuf};
use std::time::Instant;

use common::app_data_dir;
use sapling_desktop::asr::{AsrHandle, ASR_DIR, LANGUAGES, SAMPLE_RATE};
use sapling_desktop::models::SENSE_VOICE;

/// The handle and the installed model's directory, or `None` when there is no
/// model to listen with.
fn installed_handle() -> Option<(AsrHandle, PathBuf)> {
    let dir = app_data_dir()?;
    let handle = AsrHandle::new(&dir);
    let model = SENSE_VOICE.dir_in(&dir.join(ASR_DIR));
    if !handle.status().installed {
        eprintln!(
            "skipping: no dictation model under {}. Install it with \
             `cargo test -p sapling-desktop --test dictation -- --ignored`.",
            model.display()
        );
        return None;
    }
    Some((handle, model))
}

/// The 16-bit mono PCM inside a canonical 44-byte WAV, which is precisely the
/// raw IPC body `asr_transcribe` takes.
///
/// The header is asserted rather than skipped: a test wav at some other rate
/// would transcribe into plausible nonsense, and a wrong sample rate is the one
/// mistake in this whole path that produces no error anywhere.
fn utterance(model_dir: &Path, language: &str) -> Vec<u8> {
    let path = model_dir.join("test_wavs").join(format!("{language}.wav"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));

    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    assert_eq!(
        u16::from_le_bytes(bytes[22..24].try_into().unwrap()),
        1,
        "mono"
    );
    assert_eq!(
        u16::from_le_bytes(bytes[34..36].try_into().unwrap()),
        16,
        "16-bit"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        SAMPLE_RATE as u32,
        "the rate the window resamples to and the recognizer expects"
    );
    let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
    assert_eq!(
        bytes.len(),
        44 + data_bytes,
        "the data chunk is the rest of the file"
    );

    bytes[44..].to_vec()
}

/// Transcribes one utterance and reports how long it took against how long it
/// was — the number that decides whether this is usable on a phone.
fn heard(handle: &AsrHandle, pcm: &[u8], label: &str) -> String {
    let seconds = (pcm.len() / 2) as f32 / SAMPLE_RATE as f32;
    let started = Instant::now();
    let text = handle
        .transcribe(pcm)
        .unwrap_or_else(|e| panic!("{label}: {e}"));
    let elapsed = started.elapsed();

    eprintln!(
        "{label}: {seconds:.2}s of speech in {:.2}s ({:.1}x real time) -> {text}",
        elapsed.as_secs_f32(),
        seconds / elapsed.as_secs_f32().max(f32::EPSILON)
    );
    text
}

#[test]
fn transcribes_the_languages_the_model_claims() {
    let Some((handle, model)) = installed_handle() else {
        return;
    };

    // The first call loads the model, so it times the load plus one utterance;
    // the ones after it are decoding alone. Both numbers matter — the load is
    // what a learner waits for on their first dictated sentence.
    let mandarin = heard(
        &handle,
        &utterance(&model, "zh"),
        "zh (cold, includes load)",
    );
    assert_eq!(mandarin, "开饭时间早上9点至下午5点。");

    // Capitalized, punctuated, and "fifty" written as `50` — inverse text
    // normalization doing its job on the language it is least often shown off
    // in. Asserted by substring rather than in full: the tail of this clip is
    // an unusual word the model mishears consistently, and pinning a wrong
    // transcription would only look like a promise to keep it.
    let english = heard(&handle, &utterance(&model, "en"), "en (warm)");
    assert!(
        english.starts_with("The tribal chieftain called for the boy"),
        "en: {english}"
    );
    assert!(english.contains("50 pieces"), "en: {english}");

    // Cantonese is its own language here, not a `zh` region — the same line
    // `languages.ts` draws for the voice, drawn again for the recognizer. The
    // three characters asserted are why the distinction is worth making: 唔,
    // 嘅 and 呢 are Cantonese particles a Mandarin decoder would never produce,
    // so this is the assertion that the model really did switch and did not
    // simply transcribe the clip as bad Mandarin.
    let cantonese = heard(&handle, &utterance(&model, "yue"), "yue (warm)");
    for particle in ['唔', '嘅', '呢'] {
        assert!(cantonese.contains(particle), "yue: {cantonese}");
    }

    assert!(handle.status().loaded, "the recognizer stays warm");
}

/// Inverse text normalization is on, and this is what it buys: digits and
/// punctuation, so a transcript reads like something the learner would have
/// typed rather than something they have to repair before pressing Send.
#[test]
fn the_transcript_is_punctuated_and_normalized() {
    let Some((handle, model)) = installed_handle() else {
        return;
    };

    let text = heard(&handle, &utterance(&model, "zh"), "zh (itn)");

    assert!(text.ends_with('。'), "punctuated: {text}");
    assert!(text.contains('9') && text.contains('5'), "digits: {text}");
}

/// **Silence is not empty, and that is the model's answer, not a bug here.**
///
/// Half a second of digital silence comes back as `嗯。` — SenseVoice fills a
/// hole rather than declining to. Measured, and pinned here because it is the
/// reason `src/lib/asr/pcm.ts` gates on the utterance's own peak before the
/// samples ever cross the IPC: a muted microphone produces exact zeros, and a
/// learner who opened the mic and thought better of it must get the silent end
/// Web Speech's `no-speech` gives them, not a filler word in the composer.
///
/// The host stays honest — it reports what the recognizer said — and the window
/// owns the contract, which is the same division `desktop.md` draws everywhere
/// else. What this test pins is only that silence *decodes*, without an error
/// and without taking the process with it.
#[test]
fn silence_decodes_to_whatever_the_model_makes_of_it_and_never_fails() {
    let Some((handle, _)) = installed_handle() else {
        return;
    };

    // Half a second of digital silence, framed exactly as a real utterance is.
    let quiet = vec![0u8; SAMPLE_RATE as usize];

    let text = handle.transcribe(&quiet).expect("silence decodes");
    eprintln!("silence -> {text:?}");
    assert!(
        text.chars().count() < 8,
        "silence should not invent a sentence: {text}"
    );
}

/// Not part of the suite: the one-off that puts the model on this machine, for
/// the tests above and for the app itself. Minutes, and a hundred and sixty
/// megabytes.
#[test]
#[ignore = "downloads ~163 MB"]
fn installs_the_model() {
    let dir = app_data_dir().expect("a home directory");
    let handle = AsrHandle::new(&dir);

    let started = Instant::now();
    handle
        .install(&|file, loaded, total| {
            if loaded == total {
                eprintln!("{file}: {loaded} / {total} bytes");
            }
        })
        .expect("the dictation model installs");

    let status = handle.status();
    eprintln!(
        "installed {} ({} bytes on disk) in {:.1}s, covering {:?}",
        status.model,
        status.bytes,
        started.elapsed().as_secs_f32(),
        status.languages
    );
    assert!(status.installed);
    assert!(
        status.bytes > SENSE_VOICE.bytes,
        "unpacked is larger than packed"
    );
    assert_eq!(status.languages, LANGUAGES);
}
