//! Float32 PCM → RIFF/WAVE, so the webview has something `<audio>` can play.
//!
//! The webview still *plays* the audio — only synthesis moved native (see
//! `mod.rs`) — and the thing it plays is an `<audio>` element over a blob. So
//! the command hands back a complete WAV file rather than samples: the
//! TypeScript side never sees a float, never allocates a 24 kHz array, and the
//! byte layout is decided in exactly one place per host. Mono, 16-bit signed:
//! 16 bits is indistinguishable at speech bandwidth and halves what the
//! in-memory clip cache holds.
//!
//! ## The container is `hound`'s, and the samples are ours
//!
//! Writing RIFF by hand is thirty lines of offsets to get subtly wrong, so
//! `hound` writes the header and patches its sizes; all this module still owns
//! is the f32 → i16 conversion, which is a decision about audio rather than
//! about a file format.
//!
//! ## This is *not* kept byte-identical to `src/lib/tts/wav.ts`
//!
//! It used to be, and the parity cost a `f64` widening and a hand-rolled
//! `Math.round` tie-break. Nothing enforced it — there is no fixture and no
//! cross-host test comparing the two encoders — and nothing depends on it: a
//! synthesized clip is never synced, never replayed and never diffed, only
//! played once and cached in memory on the host that made it. A one-LSB
//! difference between the two encoders is inaudible and reaches nothing.
//!
//! The load-bearing JavaScript parity lives in `crates/sapling-core/src/js.rs`,
//! where number formatting really is the contract, because every device
//! replays the same event log and must derive the same bytes. That is a
//! different problem and this file is not part of it.

use std::io::Cursor;

/// Bytes of RIFF + fmt + data headers before the samples start.
///
/// `hound` writes the plain 16-byte PCM `fmt ` chunk for this spec, so the
/// figure is the classic 44; `writes_a_riff_header_that_describes_the_samples`
/// is what holds it to that rather than an assumption.
pub const HEADER_BYTES: usize = 44;

/// Encodes mono `samples` as a 16-bit PCM WAV file.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        // A rate of 0 makes the file undecodable and `<audio>` fails silently,
        // which is the one failure mode speech may not have.
        sample_rate: sample_rate.max(1),
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut out = Vec::with_capacity(HEADER_BYTES + samples.len() * 2);
    // Every one of these can only fail on I/O or on a spec `hound` rejects, and
    // the destination is a `Vec` and the spec is the constant above — so an
    // error here is this file being wrong, not the audio.
    let mut writer = hound::WavWriter::new(Cursor::new(&mut out), spec)
        .expect("a mono 16-bit PCM spec is one hound accepts");
    for &sample in samples {
        writer
            .write_sample(to_i16(sample))
            .expect("writing to a Vec cannot fail");
    }
    writer.finalize().expect("writing to a Vec cannot fail");

    out
}

/// Scales one float sample into the 16-bit range.
///
/// Values outside [-1, 1] are clamped rather than wrapped: a clipped peak is
/// ugly, an integer overflow is a burst of noise. A non-finite sample (the
/// shape the int8 Kokoro bug takes — see `mod.rs`) becomes silence rather than
/// a random integer, but it is `synthesize` that refuses to return such a clip
/// at all.
///
/// The scaling is symmetric — ±1 maps to ±32767 — which is one multiply and no
/// branch on the sign. Reaching -32768 as well would buy a thirty-thousandth of
/// a dB of headroom and cost a conditional on every sample.
fn to_i16(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn u16_at(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    fn i16_at(bytes: &[u8], index: usize) -> i16 {
        let offset = HEADER_BYTES + index * 2;
        i16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    #[test]
    fn writes_a_riff_header_that_describes_the_samples() {
        let wav = encode_wav(&[0.0; 10], 24000);

        // This is also what pins `HEADER_BYTES`: the `data` chunk starting at
        // 36 means hound wrote the plain 16-byte `fmt ` chunk and no other.
        assert_eq!(wav.len(), HEADER_BYTES + 20);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32_at(&wav, 4), wav.len() as u32 - 8);
        assert_eq!(u32_at(&wav, 16), 16, "PCM fmt chunk length");
        assert_eq!(u16_at(&wav, 20), 1, "format 1 = PCM");
        assert_eq!(u16_at(&wav, 22), 1, "mono");
        assert_eq!(u32_at(&wav, 24), 24000, "sample rate");
        assert_eq!(u32_at(&wav, 28), 48000, "byte rate");
        assert_eq!(u16_at(&wav, 32), 2, "block align");
        assert_eq!(u16_at(&wav, 34), 16, "bits per sample");
        assert_eq!(u32_at(&wav, 40), 20, "data chunk length");
    }

    #[test]
    fn scales_the_full_range_symmetrically() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 0.5, -0.5], 24000);

        assert_eq!(i16_at(&wav, 0), 0);
        assert_eq!(i16_at(&wav, 1), 32767);
        assert_eq!(i16_at(&wav, 2), -32767);
        // 0.5 * 32767 = 16383.5, and Rust's `round` takes a half away from
        // zero — so this pair is symmetric where JavaScript's `Math.round`
        // would have sent both towards +∞.
        assert_eq!(i16_at(&wav, 3), 16384);
        assert_eq!(i16_at(&wav, 4), -16384);
    }

    #[test]
    fn clamps_instead_of_wrapping() {
        let wav = encode_wav(&[9.0, -9.0, f32::NAN, f32::INFINITY], 24000);

        assert_eq!(i16_at(&wav, 0), 32767);
        assert_eq!(i16_at(&wav, 1), -32767);
        assert_eq!(i16_at(&wav, 2), 0, "NaN is silence, never a random integer");
        assert_eq!(i16_at(&wav, 3), 32767);
    }

    #[test]
    fn an_empty_clip_is_a_valid_header_with_no_data() {
        let wav = encode_wav(&[], 24000);

        assert_eq!(wav.len(), HEADER_BYTES);
        assert_eq!(u32_at(&wav, 40), 0);
        assert_eq!(u32_at(&wav, 4), 36);
    }

    #[test]
    fn a_zero_sample_rate_is_never_written_to_the_header() {
        // A rate of 0 would make the file undecodable; `<audio>` would refuse
        // it silently, which is the one failure mode speech may not have.
        let wav = encode_wav(&[0.25], 0);

        assert_eq!(u32_at(&wav, 24), 1);
        assert_eq!(u32_at(&wav, 28), 2);
    }
}
