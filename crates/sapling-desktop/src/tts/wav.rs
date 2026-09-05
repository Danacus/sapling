//! Float32 PCM → RIFF/WAVE, the Rust half of `src/lib/tts/wav.ts`.
//!
//! The webview still *plays* the audio — only synthesis moved native (see
//! `mod.rs`) — and the thing it plays is an `<audio>` element over a blob. So
//! the command hands back a complete WAV file rather than samples: the
//! TypeScript side never sees a float, never allocates a 24 kHz array, and the
//! byte layout is decided in exactly one place per host.
//!
//! Kept byte-identical to the TypeScript encoder on purpose — mono, 16-bit
//! signed, the same asymmetric scaling — so a clip synthesized in the browser
//! and the same clip synthesized here are the same file. 16-bit is
//! indistinguishable at speech bandwidth and halves what the in-memory clip
//! cache holds.

/// Bytes of RIFF + fmt + data headers before the samples start.
pub const HEADER_BYTES: usize = 44;

/// Encodes mono `samples` as a 16-bit PCM WAV file.
///
/// Values outside [-1, 1] are clamped rather than wrapped: a clipped peak is
/// ugly, an integer overflow is a burst of noise. A non-finite sample (the
/// shape the int8 Kokoro bug takes — see `mod.rs`) clamps to silence rather
/// than to a random integer, but it is `synthesize` that refuses to return
/// such a clip at all.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let rate = sample_rate.max(1);
    let data_bytes = samples.len() * 2;
    let mut out = Vec::with_capacity(HEADER_BYTES + data_bytes);

    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes as u32).to_le_bytes()); // file size - 8
    out.extend_from_slice(b"WAVE");

    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk length
    out.extend_from_slice(&1u16.to_le_bytes()); // format 1 = PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate = rate * channels * 2
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample

    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());

    for sample in samples {
        // `clamp` would panic on a NaN; this ordering maps NaN to 0.0.
        let value = if *sample > 1.0 {
            1.0
        } else if *sample > -1.0 {
            *sample
        } else if *sample <= -1.0 {
            -1.0
        } else {
            0.0
        };
        // Asymmetric scaling, matching `wav.ts`: -1 maps to -32768, +1 to 32767.
        // The arithmetic is `f64` because the TypeScript's is: a `Float32Array`
        // element widens to a double before it is multiplied, and doing it in
        // `f32` here would round a handful of samples the other way.
        let scale = if value < 0.0 { 32768.0 } else { 32767.0 };
        // JavaScript's `Math.round`: halves go towards +∞, not away from zero.
        let rounded = (value as f64 * scale + 0.5).floor() as i32;
        out.extend_from_slice(&(rounded.clamp(-32768, 32767) as i16).to_le_bytes());
    }

    out
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
    fn scales_the_full_range_asymmetrically() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 0.5], 24000);

        assert_eq!(i16_at(&wav, 0), 0);
        assert_eq!(i16_at(&wav, 1), 32767);
        assert_eq!(i16_at(&wav, 2), -32768);
        // 0.5 * 32767 = 16383.5, and JavaScript rounds a half towards +∞.
        assert_eq!(i16_at(&wav, 3), 16384);
    }

    #[test]
    fn clamps_instead_of_wrapping() {
        let wav = encode_wav(&[9.0, -9.0, f32::NAN, f32::INFINITY], 24000);

        assert_eq!(i16_at(&wav, 0), 32767);
        assert_eq!(i16_at(&wav, 1), -32768);
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
