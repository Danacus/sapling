/**
 * Mono PCM samples ⇄ RIFF/WAVE, both directions, no DOM.
 *
 * {@link encodeWav} is here because `HTMLAudioElement` cannot play raw samples.
 * sherpa-onnx hands back mono `Float32Array` samples in [-1, 1] plus a sample
 * rate (24 kHz for Kokoro); this wraps them in the smallest container every
 * browser understands. 16-bit signed is deliberate — it halves the blob we
 * keep in the audio LRU and is indistinguishable at speech bandwidth.
 *
 * {@link decodeWav} unwraps them again for the desktop playback path in
 * `tts.ts`, which fills an `AudioBuffer` instead of an element. It exists
 * rather than `AudioContext.decodeAudioData` because on WebKitGTK that call is
 * another GStreamer pipeline — the exact cost that path was written to avoid —
 * and because every clip the app plays came out of this file or out of
 * `crates/sapling-desktop/src/tts/wav.rs`, which both write plain 16-bit mono
 * PCM. It still walks the chunk list instead of trusting the 44-byte layout:
 * that layout is a fact about today's two writers, not about RIFF, and a
 * decoder that assumes offsets reads garbage as audio the day one of them
 * starts emitting a `LIST` chunk.
 *
 * Pure and DOM-free so it can be unit-tested in node.
 */

/** Bytes of RIFF + fmt + data headers before the samples start. */
export const WAV_HEADER_BYTES = 44;

/** Raw mono audio, the shape an `AudioBuffer` wants filling. */
export interface PcmClip {
	/**
	 * Mono samples in [-1, 1]. Spelled with its buffer type because
	 * `copyToChannel` refuses a possibly-shared one, and this array is always
	 * freshly allocated here.
	 */
	samples: Float32Array<ArrayBuffer>;
	/** Frames per second, as the file declares it. */
	sampleRate: number;
}

/** `WAVE_FORMAT_PCM`, the only encoding either of our writers emits. */
const FORMAT_PCM = 1;

/** The four ASCII bytes at `offset`, as a chunk id or a form type. */
function fourCC(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3)
	);
}

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
		view.setInt16(
			WAV_HEADER_BYTES + i * 2,
			Math.round(sample * (sample < 0 ? 32768 : 32767)),
			true
		);
	}

	return buffer;
}

/**
 * Reads a 16-bit mono PCM WAV file back into samples.
 *
 * Throws — with a reason — on anything it does not recognise: a buffer that is
 * not RIFF/WAVE, a compressed or float format, stereo, a missing `data` chunk.
 * Being strict is the safe half of the bargain, because the caller's fallback
 * is the `<audio>` element that understands all of those, while a decoder that
 * guessed would play them as noise at full volume.
 *
 * A `data` chunk whose declared length runs past the end of the buffer is read
 * as far as the bytes go rather than refused: a clip truncated in transit is
 * still mostly a clip, and this is the shape of failure a fallback cannot
 * improve on.
 */
export function decodeWav(buffer: ArrayBuffer): PcmClip {
	const view = new DataView(buffer);
	if (buffer.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') {
		throw new Error('Not a RIFF/WAVE file.');
	}

	let format: number | undefined;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let data: { offset: number; length: number } | undefined;

	// Chunks are id, little-endian length, payload — padded to an even length,
	// which is the byte everyone forgets.
	let offset = 12;
	while (offset + 8 <= buffer.byteLength) {
		const id = fourCC(view, offset);
		const declared = view.getUint32(offset + 4, true);
		const body = offset + 8;
		const present = Math.max(0, Math.min(declared, buffer.byteLength - body));

		if (id === 'fmt ' && present >= 16) {
			format = view.getUint16(body, true);
			channels = view.getUint16(body + 2, true);
			sampleRate = view.getUint32(body + 4, true);
			bitsPerSample = view.getUint16(body + 14, true);
		} else if (id === 'data') {
			data = { offset: body, length: present };
		}

		offset = body + declared + (declared % 2);
	}

	if (format === undefined) throw new Error('The WAV file has no fmt chunk.');
	if (format !== FORMAT_PCM) throw new Error(`Unsupported WAV format ${format}; expected PCM.`);
	if (channels !== 1) throw new Error(`Unsupported WAV channel count ${channels}; expected mono.`);
	if (bitsPerSample !== 16) throw new Error(`Unsupported WAV depth ${bitsPerSample}; expected 16.`);
	if (sampleRate < 1) throw new Error('The WAV file declares no sample rate.');
	if (!data) throw new Error('The WAV file has no data chunk.');

	const count = data.length >> 1;
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const value = view.getInt16(data.offset + i * 2, true);
		// The inverse of the asymmetric scaling above, so a round trip through
		// the pair costs at most half a bit.
		samples[i] = value < 0 ? value / 32768 : value / 32767;
	}

	return { samples, sampleRate };
}
