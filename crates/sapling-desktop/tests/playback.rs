//! The audio device, for real.
//!
//! What `play.rs`'s own tests cover is the part that is pure: which WAV files
//! this host accepts and which it refuses. What they cannot cover is the whole
//! point of the module — that opening a device on this machine works, that a
//! clip plays for as long as it lasts, and that a stop cuts one short. Those
//! need a sound card, so this file **skips itself** when there is none and says
//! so, exactly as `voice.rs` skips when the model is not installed: a headless
//! CI runner is a normal place to run `pnpm desktop:check`, and it must stay
//! green there.
//!
//! Running it makes a quiet sound. The clips are sine waves at a tenth of full
//! scale, a fraction of a second each.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use sapling_desktop::tts::play::{PlayerHandle, NO_OUTPUT_DEVICE};
use sapling_desktop::tts::wav::encode_wav;

/// The rate the voice synthesizes at, so the test plays what the app plays.
const SAMPLE_RATE: u32 = 24000;

/// Quiet enough that running the suite is not an event in the room.
const AMPLITUDE: f32 = 0.1;

/// A 440 Hz sine of `millis`, as a complete WAV file — the same encoder
/// `tts_synthesize` answers with, so the decoder is exercised over real output
/// rather than over bytes written for the test.
fn tone(millis: u64) -> Vec<u8> {
    let count = (SAMPLE_RATE as u64 * millis / 1000) as usize;
    let samples: Vec<f32> = (0..count)
        .map(|n| {
            let seconds = n as f32 / SAMPLE_RATE as f32;
            (seconds * 440.0 * std::f32::consts::TAU).sin() * AMPLITUDE
        })
        .collect();
    encode_wav(&samples, SAMPLE_RATE)
}

/// A handle that has proved it can open the default device, or `None` — in
/// which case the reason is printed and the test passes.
///
/// The probe is a real (very short, near-inaudible) clip rather than a separate
/// "open the device" call, because there is no such call: opening is what the
/// first clip does, and a probe that took another path would be testing another
/// path.
fn audible_handle() -> Option<PlayerHandle> {
    let handle = PlayerHandle::new();
    match handle.play(&tone(20)) {
        Ok(()) => Some(handle),
        Err(error) if error.starts_with(NO_OUTPUT_DEVICE) => {
            eprintln!("skipping: {error}");
            None
        }
        Err(error) => panic!("the probe clip should have played: {error}"),
    }
}

#[test]
fn the_default_device_opens_and_a_clip_plays_for_as_long_as_it_lasts() {
    let Some(handle) = audible_handle() else {
        return;
    };

    let started = Instant::now();
    handle.play(&tone(100)).expect("a 100 ms clip plays");
    let elapsed = started.elapsed();

    eprintln!("a 100 ms clip returned after {elapsed:?}");
    assert!(
        elapsed >= Duration::from_millis(60),
        "returned after {elapsed:?} — that is not long enough to have played the clip"
    );
    // The floor is the clip; the ceiling is the clip plus the poll interval
    // plus whatever the device buffers, with room for a loaded machine.
    assert!(
        elapsed < Duration::from_millis(700),
        "returned after {elapsed:?} — playback is not what it waited for"
    );
}

#[test]
fn stopping_cuts_the_clip_short_and_the_play_call_returns() {
    let Some(handle) = audible_handle() else {
        return;
    };
    let handle = Arc::new(handle);

    let playing = Arc::clone(&handle);
    let started = Instant::now();
    let clip = thread::spawn(move || {
        playing
            .play(&tone(3000))
            .expect("a three-second clip plays");
        started.elapsed()
    });

    thread::sleep(Duration::from_millis(150));
    handle.stop();

    let elapsed = clip.join().expect("the play call returns");
    eprintln!("a stopped 3 s clip returned after {elapsed:?}");
    assert!(
        elapsed < Duration::from_millis(1500),
        "returned after {elapsed:?} — the stop did not cut it off"
    );
}

#[test]
fn a_second_clip_cuts_off_the_first_and_both_calls_return() {
    let Some(handle) = audible_handle() else {
        return;
    };
    let handle = Arc::new(handle);

    let interrupted = Arc::clone(&handle);
    let started = Instant::now();
    let first = thread::spawn(move || {
        interrupted.play(&tone(3000)).expect("the first clip plays");
        started.elapsed()
    });

    thread::sleep(Duration::from_millis(150));
    handle.play(&tone(100)).expect("the second clip plays");
    let second = started.elapsed();

    let first = first.join().expect("the interrupted call returns");
    eprintln!("the first clip returned after {first:?}, the second after {second:?}");
    assert!(
        first < Duration::from_millis(1500),
        "the first clip returned after {first:?} — it was not cut off"
    );
    assert!(
        first <= second,
        "the interrupted call must not outlive the clip that interrupted it"
    );
}

/// A clip the host will not play is an error, on a machine with a device or
/// without one — and it never opens a device to find that out (`play.rs`'s own
/// tests hold the second half).
#[test]
fn a_refused_clip_is_an_error_everywhere() {
    let handle = PlayerHandle::new();

    let failure = handle.play(b"RIFFnope").unwrap_err();

    assert!(!failure.starts_with(NO_OUTPUT_DEVICE), "{failure}");
    assert!(failure.contains("not a WAV file"), "{failure}");
}

/// `Arc<PlayerHandle>` is what Tauri manages and what `tts_play` clones into
/// its `spawn_blocking` closure, which needs `Send + Sync + 'static` — and
/// `tts_stop` reaches the same handle from the main thread while a clip is
/// playing. Neither is visible from a single-threaded test, so it is asserted
/// the way `persistence.rs` asserts it for the database.
#[test]
fn the_handle_can_be_shared_across_threads() {
    fn shareable<T: Send + Sync + 'static>() {}
    shareable::<PlayerHandle>();
}
