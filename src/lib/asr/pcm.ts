/**
 * Turning what the microphone gave us into what the recognizer takes.
 *
 * The `AudioWorklet` (`static/asr/pcm-worklet.js`) posts one `Float32Array` per
 * rendering quantum at whatever rate the `AudioContext` opened at; the native
 * host wants **one run of 16 kHz mono 16-bit little-endian samples**, which is
 * what crosses the IPC as a raw body. This module is that conversion, and it is
 * here rather than in `native.ts` because it is pure: no microphone, no Tauri,
 * no DOM, so every claim below is checkable in node.
 *
 * `frameUtterance` is the whole of the public shape. It answers `undefined` for
 * an utterance with nothing in it, which is the module's one piece of judgement
 * and the reason it exists as a unit — see below.
 *
 * ## Why the rate can be wrong in the first place
 *
 * `new AudioContext({ sampleRate: 16000 })` asks the browser to resample for
 * us, with a resampler far better than anything worth writing here, and both
 * webviews take it. But the option is allowed to throw, and a context that came
 * back at the device's own 44.1 or 48 kHz still has to be handled — silently,
 * because a wrong sample rate produces no error anywhere at all. It produces a
 * transcript of the right words at the wrong speed, which reads as the model
 * being bad.
 *
 * ## Why an empty utterance is this module's problem
 *
 * SenseVoice does not decline to answer. Half a second of digital silence comes
 * back as `嗯。` — measured, and pinned in `crates/sapling-desktop/tests/
 * dictation.rs`. The host stays honest and reports what the recognizer said;
 * the *contract* is `$lib/asr`'s, and it says a learner who opened the
 * microphone and thought better of it gets a silent end, exactly as Web
 * Speech's `no-speech` gives them. So the gate is here, before the samples ever
 * cross: an utterance too short to be one, or one whose loudest moment is
 * quieter than a muted microphone's room, is nothing and is never sent.
 *
 * It is a gate, not a voice-activity detector. It catches a microphone that was
 * muted, unplugged or never opened — which produce exact or near-exact zeros —
 * and it deliberately does not try to catch a learner who said nothing into a
 * live microphone, because that capture contains real room noise and telling it
 * from a quiet word is the job of a VAD the app does not have. That case ends
 * with a filler word in the composer, which is precisely the failure the
 * composer exists to absorb.
 */

/** What the host's recognizer expects, and what `asr::SAMPLE_RATE` says. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Shorter than this and nobody said anything — a press and release, or a
 * button that bounced. Two tenths of a second is under one syllable.
 */
const MIN_UTTERANCE_SECONDS = 0.2;

/**
 * Peak amplitude below which the capture carries no signal at all: roughly
 * −46 dBFS, where speech peaks between −20 and −6 and even a quiet room floats
 * above it. What this catches is a muted or dead microphone, whose samples are
 * exactly or nearly zero. See the module header for what it deliberately does
 * not catch.
 */
const SILENCE_PEAK = 0.005;

/**
 * Every chunk the worklet posted, end to end.
 *
 * Separate from the rest because it is the one step that has to happen before
 * anything can be measured: the quanta are 128 samples each, so a ten-second
 * utterance arrives as more than a thousand of them.
 */
export function joinChunks(chunks: readonly Float32Array[]): Float32Array {
	let length = 0;
	for (const chunk of chunks) length += chunk.length;

	const joined = new Float32Array(length);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return joined;
}

/**
 * `samples` at {@link TARGET_SAMPLE_RATE}, or unchanged when they are already
 * there — which is the ordinary case, since the context is asked to open at
 * that rate.
 *
 * Downsampling averages the source window each output sample covers rather than
 * picking one of them. That is a crude low-pass, and a crude one is the point:
 * dropping two samples in three at 48 kHz with no filter folds everything above
 * 8 kHz back into the speech band as aliasing, which is exactly the frequency
 * range that tells an `s` from an `f`. Upsampling interpolates linearly, and is
 * only reachable from a device that opened below 16 kHz.
 */
export function resampleTo16k(samples: Float32Array, from: number): Float32Array {
	if (from === TARGET_SAMPLE_RATE || samples.length === 0 || from <= 0) return samples;

	const ratio = from / TARGET_SAMPLE_RATE;
	const length = Math.floor(samples.length / ratio);
	const out = new Float32Array(length);

	if (ratio > 1) {
		for (let i = 0; i < length; i++) {
			const start = Math.floor(i * ratio);
			const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
			let sum = 0;
			for (let j = start; j < end; j++) sum += samples[j];
			out[i] = end > start ? sum / (end - start) : (samples[start] ?? 0);
		}
		return out;
	}

	for (let i = 0; i < length; i++) {
		const at = i * ratio;
		const low = Math.floor(at);
		const high = Math.min(samples.length - 1, low + 1);
		const fraction = at - low;
		out[i] = samples[low] * (1 - fraction) + samples[high] * fraction;
	}
	return out;
}

/**
 * Float samples in [-1, 1] as 16-bit little-endian PCM — half the bytes of the
 * `Float32Array` they came from, and the format the whole world agrees on.
 *
 * The scale is 32768 in both directions, which is what `decode_pcm16` in
 * `crates/sapling-desktop/src/asr/mod.rs` reverses: it maps the range
 * symmetrically, so −1 is `i16::MIN` exactly, and the one value it cannot
 * represent is +1, which clamps a sixteen-thousandth low.
 */
export function toPcm16(samples: Float32Array): Uint8Array {
	const bytes = new Uint8Array(samples.length * 2);
	const view = new DataView(bytes.buffer);

	for (let i = 0; i < samples.length; i++) {
		const scaled = Math.round(samples[i] * 32768);
		view.setInt16(i * 2, Math.max(-32768, Math.min(32767, scaled)), true);
	}
	return bytes;
}

/** The loudest sample in the run, ignoring sign. 0 for an empty one. */
export function peakOf(samples: Float32Array): number {
	let peak = 0;
	for (const sample of samples) {
		const size = Math.abs(sample);
		if (size > peak) peak = size;
	}
	return peak;
}

/**
 * One captured utterance as the body `asr_transcribe` takes — resampled,
 * measured and framed — or `undefined` when there was nothing in it.
 *
 * `undefined` is not a failure and callers must not report it as one: it means
 * the learner opened the microphone and closed it again, which ends the session
 * silently, the way `no-speech` always has.
 */
export function frameUtterance(
	chunks: readonly Float32Array[],
	sampleRate: number
): Uint8Array | undefined {
	const samples = resampleTo16k(joinChunks(chunks), sampleRate);

	if (samples.length < MIN_UTTERANCE_SECONDS * TARGET_SAMPLE_RATE) return undefined;
	if (peakOf(samples) < SILENCE_PEAK) return undefined;

	return toPcm16(samples);
}
