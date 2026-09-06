//! Playing a spoken clip, because this webview cannot.
//!
//! Everywhere else in Sapling a clip is an `<audio>` element over a blob, and
//! that is a deliberate one-player-for-both-hosts choice. It did not survive
//! contact with WebKitGTK. Measured on this machine (WebKitGTK 2.52.6,
//! GStreamer 1.28.5): `<audio>` over a blob *plays correctly*, but it builds a
//! fresh GStreamer pipeline per clip, so the first sample lands about a second
//! after `play()` and the window stalls while it is built — on every spoken
//! word. Web Audio, the obvious way to keep one pipeline for the session, is
//! worse than slow: a bare oscillator on a fresh `AudioContext` alternates
//! between clean and noise across runs, and an `AudioBufferSourceNode` fed a
//! sine plays silence. Commit f78eff6 reverted that attempt and its message
//! records the measurements.
//!
//! So speech moved out of the webview's audio stack entirely. This is the same
//! bargain the rest of `tts/` already made — the host lends a *platform
//! primitive* with no domain knowledge in it, and every decision about what to
//! say stays in `src/lib/tts/` — except that the primitive is now "make this
//! sound" rather than only "render this text". Nothing else in the app moved:
//! the reader's `<video>` and the YouTube frame still go through GStreamer,
//! which is why the shell still carries the plugins.
//!
//! ## One stream, one thread
//!
//! Opening an output device costs tens of milliseconds and is exactly the
//! per-clip cost we came here to remove, so the process opens one and keeps it.
//! It cannot simply be put in Tauri's managed state: rodio's `MixerDeviceSink`
//! owns a `cpal::Stream`, which is `!Send` on ALSA — the same problem `Core`
//! has for the same kind of reason, and it takes the same answer. One thread
//! owns the stream for its whole life and every call is a message posted to it
//! (`host.rs`'s header is the long version). Dropping [`PlayerHandle`] closes
//! the channel, which ends the thread, which drops the stream on the thread
//! that opened it.
//!
//! The device is opened on the *first* clip rather than at boot, and the
//! outcome is memoised either way: a learner who never taps 🔊 never holds an
//! audio device open, exactly as `TtsHandle` never touches the disk until it is
//! asked to. A failure is kept rather than retried because there is nothing to
//! retry — a machine with no output device does not grow one mid-session, and
//! `native.ts` latches its own fallback on the first refusal anyway.
//!
//! ## Waiting is the caller's, not the thread's
//!
//! `tts_play` resolves when the clip finishes, because that is the promise
//! `speak()` has always made and there are no events in this seam. The owning
//! thread cannot block on the clip, though — it would stop answering `Stop`.
//! So the caller waits on a channel of its own and the owning thread holds the
//! *sending* end: nothing is ever sent on it, and dropping it is the signal.
//! One drop site per outcome, and they are the three outcomes there are — the
//! clip ended, a `Stop` arrived, or another clip replaced it.
//!
//! ## The command surface is bytes today and need not stay that way
//!
//! `tts_play` takes a finished WAV because the clip caches live in JavaScript
//! (`tts.ts`), so the bytes are already on the window thread. If the clip cache
//! ever moves to the host, this becomes `tts_speak(text, sid, speed)` —
//! synthesize, then hand the samples to the same channel — and nothing in here
//! changes shape: [`PlayerHandle::play`] would take a [`Clip`] instead of
//! decoding one. That is not built, and should not be until the cache actually
//! moves.

use std::error::Error;
use std::fmt;
use std::io::Cursor;
use std::num::NonZero;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;

use rodio::buffer::SamplesBuffer;
use rodio::{ChannelCount, DeviceSinkBuilder, DeviceSinkError, Player, Sample, SampleRate};

/// How a refusal for want of a device begins. `src/lib/tts/native.ts` carries
/// the same string and matches on it, because it is the one failure that is
/// worth latching for the session rather than retrying per clip — every other
/// error here is about the clip that was handed over.
pub const NO_OUTPUT_DEVICE: &str = "no audio output device";

/// The channel is closed, which only happens once the handle is being dropped.
const CLOSED: &str = "the audio output is closed";

/// How often the owning thread looks up from its channel to see whether the
/// clip it is playing has ended — and only while one is; with nothing playing
/// it blocks on the channel and costs nothing. rodio signals the end of a
/// source through a one-shot receiver that a second `append` steals, which is
/// not usable when two `tts_play` calls can overlap, so the end is polled
/// instead. It bounds how late `tts_play` can resolve, and ten milliseconds is
/// far under what anyone can hear between two spoken words.
const TICK: Duration = Duration::from_millis(10);

/// Sapling's clips are mono; [`decode`] refuses anything else.
fn mono() -> ChannelCount {
    NonZero::new(1).expect("one channel is not zero channels")
}

/// One decoded clip: mono samples in rodio's own sample type, and the rate they
/// were recorded at.
pub struct Clip {
    samples: Vec<Sample>,
    sample_rate: SampleRate,
}

impl Clip {
    /// How long this clip plays for. Used by the tests; the player itself never
    /// needs to know, because it waits for the source to end rather than for a
    /// duration to elapse.
    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(self.samples.len() as f64 / f64::from(self.sample_rate.get()))
    }
}

impl fmt::Debug for Clip {
    /// Everything but the samples. A phrase is tens of thousands of them, and a
    /// failed assertion that prints all of them is one nobody reads.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Clip")
            .field("samples", &self.samples.len())
            .field("sample_rate", &self.sample_rate)
            .field("duration", &self.duration())
            .finish()
    }
}

/// Reads a complete WAV file into samples, refusing anything that is not
/// 16-bit mono PCM.
///
/// That is not a general audio player and is not meant to be: the only thing
/// that ever reaches this command is what `wav.rs` wrote one command earlier,
/// and the two agree on mono 16-bit by construction. Refusing loudly is what
/// keeps a future mismatch between the encoder and this decoder from arriving
/// as silence, which is the one failure a learner cannot diagnose.
fn decode(wav: &[u8]) -> Result<Clip, String> {
    let mut reader = hound::WavReader::new(Cursor::new(wav))
        .map_err(|cause| format!("that clip is not a WAV file: {cause}"))?;
    let spec = reader.spec();

    if spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        let format = match spec.sample_format {
            hound::SampleFormat::Int => "integer",
            hound::SampleFormat::Float => "float",
        };
        return Err(format!(
            "the host plays 16-bit mono PCM only, and that clip is {} channel(s) of {}-bit {format}",
            spec.channels, spec.bits_per_sample
        ));
    }

    let sample_rate = NonZero::new(spec.sample_rate)
        .ok_or_else(|| "that clip claims a sample rate of zero".to_owned())?;

    // i16::MIN maps to exactly -1 and i16::MAX to a hair under +1, which is the
    // inverse of `wav.rs`'s symmetric scaling to within one LSB. Matching it
    // exactly would cost a branch per sample for a difference no one can hear.
    let samples = reader
        .samples::<i16>()
        .map(|sample| sample.map(|value| Sample::from(value) / 32768.0))
        .collect::<Result<Vec<Sample>, _>>()
        .map_err(|cause| format!("that clip's samples could not be read: {cause}"))?;

    Ok(Clip {
        samples,
        sample_rate,
    })
}

/// The whole message chain of a rodio failure. Its variants carry their detail
/// as a `#[source]`, so `Display` alone says "Error opening the stream with the
/// OS" and stops exactly where the useful part starts.
fn because(error: &DeviceSinkError) -> String {
    let mut message = error.to_string();
    let mut cause: Option<&(dyn Error + 'static)> = error.source();
    while let Some(source) = cause {
        message.push_str(&format!(": {source}"));
        cause = source.source();
    }
    message
}

/// One instruction for the thread that owns the output stream.
enum Command {
    /// Play this clip, cutting off whatever is playing.
    ///
    /// `finished` is never sent on. Dropping it is what wakes the caller, so
    /// the owning thread holds it for exactly as long as the clip is playing —
    /// see the module header.
    Play { clip: Clip, finished: Sender<()> },
    /// Cut off whatever is playing, and play nothing.
    Stop,
}

/// The output device: one thread, one stream, one player.
struct Output {
    /// `Option` only so [`Drop`] can close the channel before joining.
    commands: Option<Sender<Command>>,
    thread: Option<JoinHandle<()>>,
}

impl Output {
    /// Opens the default output device on a thread of its own.
    ///
    /// Returns once the device is open (or has refused to be), so a caller that
    /// gets an `Output` has something that can play.
    fn open() -> Result<Output, String> {
        let (commands, incoming) = channel::<Command>();
        let (opened, outcome) = channel::<Result<(), String>>();

        let thread = std::thread::Builder::new()
            .name("sapling-audio".to_owned())
            .spawn(move || run(&incoming, &opened))
            .map_err(|cause| {
                format!("{NO_OUTPUT_DEVICE}: could not start the audio thread: {cause}")
            })?;

        match outcome.recv() {
            Ok(Ok(())) => Ok(Output {
                commands: Some(commands),
                thread: Some(thread),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(format!(
                "{NO_OUTPUT_DEVICE}: the audio thread stopped before it opened one"
            )),
        }
    }

    fn send(&self, command: Command) -> Result<(), String> {
        self.commands
            .as_ref()
            .ok_or_else(|| CLOSED.to_owned())?
            .send(command)
            .map_err(|_| CLOSED.to_owned())
    }
}

impl Drop for Output {
    fn drop(&mut self) {
        // Closing the channel ends the loop; joining is what makes "the device
        // is released" true by the time this returns, since the `cpal::Stream`
        // can only be dropped on the thread that built it.
        self.commands.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The owning thread's whole life: open the device, then serve the channel.
fn run(commands: &Receiver<Command>, opened: &Sender<Result<(), String>>) {
    let mut sink = match DeviceSinkBuilder::open_default_sink() {
        Ok(sink) => {
            let _ = opened.send(Ok(()));
            sink
        }
        Err(error) => {
            let _ = opened.send(Err(format!("{NO_OUTPUT_DEVICE}: {}", because(&error))));
            return;
        }
    };
    // Otherwise rodio prints a paragraph to stderr when the process ends.
    sink.log_on_drop(false);
    let player = Player::connect_new(sink.mixer());

    // The clip currently playing, held as the sending end of the caller's
    // channel: whenever this is dropped or replaced, that caller's `tts_play`
    // returns. `None` means nothing is playing and the loop can block.
    let mut playing: Option<Sender<()>> = None;

    loop {
        let next = if playing.is_some() {
            commands.recv_timeout(TICK)
        } else {
            commands.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };

        match next {
            Ok(Command::Play { clip, finished }) => {
                player.stop();
                // Dropped *before* the append, so the call this one interrupts
                // returns now rather than when the new clip ends — and `append`
                // on a stopped player blocks for a few milliseconds.
                drop(playing.take());
                // `append` on a stopped player waits for the queue to flush and
                // then clears the stop, which is what makes a second tap cut
                // the first word off rather than queue behind it.
                player.append(SamplesBuffer::new(mono(), clip.sample_rate, clip.samples));
                playing = Some(finished);
            }
            Ok(Command::Stop) => {
                player.stop();
                playing = None;
            }
            Err(RecvTimeoutError::Timeout) => {
                if player.empty() {
                    playing = None;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// The process's one audio output, addressable from any thread.
///
/// This is what Tauri manages, behind an `Arc` for the same reason the database
/// is: the commands are `async` and `spawn_blocking` needs something owned and
/// `'static`.
pub struct PlayerHandle {
    /// `None` until the first clip; then the running output, or the reason
    /// there is none. Memoised either way — see the module header.
    output: Mutex<Option<Result<Output, String>>>,
}

impl PlayerHandle {
    /// A handle that has opened nothing. Costs one mutex.
    pub fn new() -> PlayerHandle {
        PlayerHandle {
            output: Mutex::new(None),
        }
    }

    /// Runs `use_output` against the device, opening it on first use.
    ///
    /// The lock is held across the open, so two first clips at once wait for
    /// one device rather than racing to build two.
    fn with_output<T>(
        &self,
        use_output: impl FnOnce(&Output) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut output = self.output.lock().map_err(|_| {
            // Only reachable if a panic escaped while the lock was held. There
            // is no usable output either way, and the caller's fallback is the
            // same one a missing device gets.
            format!("{NO_OUTPUT_DEVICE}: the audio output failed and cannot be reopened")
        })?;
        match output.get_or_insert_with(Output::open) {
            Ok(output) => use_output(output),
            Err(error) => Err(error.clone()),
        }
    }

    /// Plays one complete WAV file, returning when it ends or is stopped.
    ///
    /// A clip arriving while another plays cuts that one off, and the call that
    /// was playing it returns. Blocking, and expected to be — it is as long as
    /// the audio. The caller runs it off the main thread.
    pub fn play(&self, wav: &[u8]) -> Result<(), String> {
        // Decoded before the device is touched, so a malformed clip is never
        // reported as a missing device and never opens one.
        let clip = decode(wav)?;

        let (finished, over) = channel::<()>();
        self.with_output(|output| output.send(Command::Play { clip, finished }))?;

        // Nothing is ever sent; the owning thread dropping its end is the
        // signal, so this returns `Err` on every path and that is the success.
        let _ = over.recv();
        Ok(())
    }

    /// Cuts off whatever is playing, and makes the [`play`](Self::play) call
    /// that was waiting on it return.
    ///
    /// Never opens the device: if it was never opened, nothing can be playing.
    pub fn stop(&self) {
        let Ok(output) = self.output.lock() else {
            return;
        };
        if let Some(Ok(output)) = output.as_ref() {
            let _ = output.send(Command::Stop);
        }
    }
}

impl Default for PlayerHandle {
    fn default() -> PlayerHandle {
        PlayerHandle::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tts::wav::encode_wav;

    /// A WAV with the same spec `wav.rs` writes, so the two are checked against
    /// each other rather than against an assumption.
    fn ours(samples: &[f32], rate: u32) -> Vec<u8> {
        encode_wav(samples, rate)
    }

    /// The same audio in a shape this host refuses, written by `hound` directly.
    fn foreign(spec: hound::WavSpec) -> Vec<u8> {
        let mut out = Vec::new();
        let mut writer = hound::WavWriter::new(Cursor::new(&mut out), spec).expect("a valid spec");
        for _ in 0..8 {
            match spec.sample_format {
                hound::SampleFormat::Int => writer.write_sample(0i16).expect("a Vec"),
                hound::SampleFormat::Float => writer.write_sample(0.0f32).expect("a Vec"),
            }
        }
        writer.finalize().expect("a Vec");
        out
    }

    #[test]
    fn reads_back_what_this_host_wrote() {
        let clip = decode(&ours(&[0.0, 1.0, -1.0, 0.5], 24000)).expect("our own WAV decodes");

        assert_eq!(clip.sample_rate.get(), 24000);
        assert_eq!(clip.samples.len(), 4);
        assert!((clip.samples[0] - 0.0).abs() < 1e-6);
        // The round trip is symmetric to within the one LSB `decode` documents.
        assert!((clip.samples[1] - 1.0).abs() < 1e-4, "{}", clip.samples[1]);
        assert!((clip.samples[2] + 1.0).abs() < 1e-4, "{}", clip.samples[2]);
        assert!((clip.samples[3] - 0.5).abs() < 1e-4, "{}", clip.samples[3]);
    }

    #[test]
    fn a_body_that_is_not_a_wav_file_is_refused() {
        let failure = decode(b"this is not audio").unwrap_err();
        assert!(failure.contains("not a WAV file"), "{failure}");

        // The likeliest real accident: an empty or truncated body.
        assert!(decode(&[]).is_err());
        assert!(decode(&ours(&[0.25], 24000)[..20]).is_err());
    }

    #[test]
    fn stereo_is_refused_rather_than_played_at_double_speed() {
        let failure = decode(&foreign(hound::WavSpec {
            channels: 2,
            sample_rate: 24000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }))
        .unwrap_err();

        assert!(failure.contains("16-bit mono PCM only"), "{failure}");
        assert!(failure.contains("2 channel(s)"), "{failure}");
    }

    #[test]
    fn a_float_or_wider_clip_is_refused_too() {
        let float = decode(&foreign(hound::WavSpec {
            channels: 1,
            sample_rate: 24000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        }))
        .unwrap_err();
        assert!(float.contains("32-bit float"), "{float}");

        let wide = decode(&foreign(hound::WavSpec {
            channels: 1,
            sample_rate: 24000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        }))
        .unwrap_err();
        assert!(wide.contains("24-bit integer"), "{wide}");
    }

    #[test]
    fn a_clip_knows_how_long_it_plays_for() {
        let clip = decode(&ours(&vec![0.0; 2400], 24000)).expect("decodes");
        assert_eq!(clip.duration(), Duration::from_millis(100));
    }

    #[test]
    fn stopping_a_handle_that_never_played_opens_nothing() {
        let handle = PlayerHandle::new();

        handle.stop();

        assert!(
            handle.output.lock().expect("not poisoned").is_none(),
            "stop() must never be what opens a device"
        );
    }

    #[test]
    fn a_malformed_clip_never_opens_a_device() {
        let handle = PlayerHandle::new();

        assert!(handle.play(b"not audio").is_err());

        assert!(
            handle.output.lock().expect("not poisoned").is_none(),
            "decoding comes first, so a bad clip cannot be mistaken for a bad device"
        );
    }
}
