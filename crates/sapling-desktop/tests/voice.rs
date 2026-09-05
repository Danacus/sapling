//! The native voice, against the real model.
//!
//! Nothing here can be mocked usefully: what is worth checking is that
//! sherpa-onnx, the pinned Kokoro archive and this host's config actually
//! produce audio, in both languages the model claims. So the test **skips
//! itself** unless the model is installed, and says so — a checkout with no
//! model is a normal state, and `pnpm desktop:check` must stay green in it.
//!
//! To make it run, install the model once:
//!
//! ```sh
//! nix develop .#desktop -c cargo test -p sapling-desktop --test voice -- --ignored --nocapture
//! ```
//!
//! which downloads it into the same place the app does, so the app has it too.
//! Then run the suite with `--nocapture` to see the load and synthesis timings.

use std::path::PathBuf;
use std::time::Instant;

use sapling_desktop::tts::{model::KOKORO, TtsHandle, TTS_DIR};

/// Tauri's app-data directory for `app.sapling.desktop` — the same path
/// `lib.rs` gets from `app.path().app_data_dir()`, worked out by hand because a
/// test has no `App` to ask. `SAPLING_APP_DATA` overrides it.
fn app_data_dir() -> Option<PathBuf> {
    const IDENTIFIER: &str = "app.sapling.desktop";

    if let Some(overridden) = std::env::var_os("SAPLING_APP_DATA") {
        return Some(PathBuf::from(overridden));
    }
    if cfg!(target_os = "windows") {
        return std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join(IDENTIFIER));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support").join(IDENTIFIER));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Some(data.join(IDENTIFIER))
}

/// The handle, or `None` when there is no model to speak with.
fn installed_handle() -> Option<TtsHandle> {
    let dir = app_data_dir()?;
    let handle = TtsHandle::new(&dir);
    if !handle.status().installed {
        eprintln!(
            "skipping: no voice model under {}. Install it with \
             `cargo test -p sapling-desktop --test voice -- --ignored`.",
            dir.join(TTS_DIR).join(KOKORO.dir).display()
        );
        return None;
    }
    Some(handle)
}

/// Header fields of a 16-bit mono WAV, so the test reads the clip the way the
/// webview's `<audio>` will rather than trusting what produced it.
struct Wav {
    sample_rate: u32,
    samples: Vec<f32>,
}

fn parse_wav(bytes: &[u8]) -> Wav {
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
    let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
    let data_bytes = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
    assert_eq!(
        bytes.len(),
        44 + data_bytes,
        "the data chunk is the rest of the file"
    );

    let samples = bytes[44..]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0)
        .collect();
    Wav {
        sample_rate,
        samples,
    }
}

/// Asserts one clip is real speech, and reports how long it took to make.
fn check(wav: &[u8], label: &str, elapsed: std::time::Duration) {
    let clip = parse_wav(wav);
    let seconds = clip.samples.len() as f32 / clip.sample_rate as f32;
    let peak = clip.samples.iter().fold(0.0f32, |max, s| max.max(s.abs()));

    eprintln!(
        "{label}: {seconds:.2}s of audio at {} Hz in {:.2}s ({:.1}x real time), peak {peak:.3}",
        clip.sample_rate,
        elapsed.as_secs_f32(),
        seconds / elapsed.as_secs_f32().max(f32::EPSILON)
    );

    assert_eq!(clip.sample_rate, 24000, "Kokoro's rate");
    assert!(
        clip.samples.iter().all(|s| s.is_finite()),
        "{label}: the clip contains non-finite samples"
    );
    assert!(peak > 0.01, "{label}: the clip is silent (peak {peak})");
    assert!(
        (0.5..30.0).contains(&seconds),
        "{label}: {seconds:.2}s is not a plausible length for one sentence"
    );
}

#[test]
fn speaks_mandarin_and_english() {
    let Some(handle) = installed_handle() else {
        return;
    };

    // The first call loads the model, so it times the load plus one sentence;
    // the ones after it are synthesis alone. Both numbers matter — the load is
    // what a learner waits for once per launch.
    let started = Instant::now();
    let mandarin = handle
        .synthesize("今天天气很好，我们一起去公园散步吧。", 3, 1.0)
        .expect("Mandarin synthesis");
    let first = started.elapsed();
    check(&mandarin, "mandarin (cold, includes engine load)", first);

    let started = Instant::now();
    let english = handle
        .synthesize("The garden is quiet this morning.", 0, 1.0)
        .expect("English synthesis");
    check(&english, "english (warm)", started.elapsed());

    let started = Instant::now();
    let again = handle
        .synthesize("今天天气很好，我们一起去公园散步吧。", 3, 1.0)
        .expect("Mandarin synthesis, warm");
    check(&again, "mandarin (warm)", started.elapsed());

    // The same phrase twice is the *same* clip to a listener and not the same
    // bytes: ONNX on many threads reduces in whatever order the threads finish,
    // so two runs differ in the low bits of some samples and, through the
    // duration predictor, by a few samples of length (measured: 181454 against
    // 181442 bytes, peak 0.433 against 0.439). Harmless — the clip caches key
    // on text, speaker and speed, so a learner hears one rendering — but worth
    // pinning here rather than discovering as a flaky test elsewhere.
    let drift = (mandarin.len() as i64 - again.len() as i64).abs();
    assert!(
        drift < 24000 / 20,
        "the same phrase drifted by {drift} bytes, far more than float noise"
    );
    assert_ne!(mandarin, english, "two languages, two clips");
}

/// Mixed zh/en in one sentence is the case the model is chosen for, and the
/// case a lesson actually hits (`languages.ts` routes both to Kokoro).
#[test]
fn speaks_a_sentence_that_mixes_the_two() {
    let Some(handle) = installed_handle() else {
        return;
    };

    let started = Instant::now();
    let wav = handle
        .synthesize("我最喜欢的水果是 mango。", 3, 1.0)
        .expect("mixed synthesis");
    check(&wav, "mixed zh/en", started.elapsed());
}

/// Not part of the suite: the one-off that puts the model on this machine, for
/// the tests above and for the app itself. Minutes, and hundreds of megabytes.
#[test]
#[ignore = "downloads ~365 MB"]
fn installs_the_model() {
    let dir = app_data_dir().expect("a home directory");
    let handle = TtsHandle::new(&dir);

    let started = Instant::now();
    handle
        .install(&|file, loaded, total| {
            if loaded == total {
                eprintln!("{file}: {loaded} / {total} bytes");
            }
        })
        .expect("the voice model installs");

    let status = handle.status();
    eprintln!(
        "installed {} ({} bytes on disk) in {:.1}s",
        status.model,
        status.bytes,
        started.elapsed().as_secs_f32()
    );
    assert!(status.installed);
    assert!(
        status.bytes > KOKORO.bytes,
        "unpacked is larger than packed"
    );
}
