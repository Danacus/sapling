/**
 * Float32 PCM → RIFF/WAVE, because `HTMLAudioElement` cannot play raw samples.
 *
 * sherpa-onnx hands back mono `Float32Array` samples in [-1, 1] plus a sample
 * rate (24 kHz for Kokoro); this wraps them in the smallest container every
 * browser understands. 16-bit signed is deliberate — it halves the blob we
 * keep in the audio LRU and is indistinguishable at speech bandwidth.
 *
 * Pure and DOM-free so it can be unit-tested in node.
 */

/** Bytes of RIFF + fmt + data headers before the samples start. */
export const WAV_HEADER_BYTES = 44;

/**
 * Encodes mono samples as a 16-bit PCM WAV file.
 *
 * Values outside [-1, 1] are clamped rather than wrapped: a clipped peak is
 * ugly, an integer overflow is a burst of noise.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const rate = Math.max(1, Math.round(sampleRate));
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * 2);
	const view = new DataView(buffer);

	const ascii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};

	ascii(0, 'RIFF');
	view.setUint32(4, 36 + samples.length * 2, true); // file size - 8
	ascii(8, 'WAVE');

	ascii(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM fmt chunk length
	view.setUint16(20, 1, true); // format 1 = PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true); // byte rate = rate * channels * 2
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample

	ascii(36, 'data');
	view.setUint32(40, samples.length * 2, true);

	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		// Asymmetric scaling: -1 maps to -32768, +1 to 32767.
		view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
	}

	return buffer;
}
