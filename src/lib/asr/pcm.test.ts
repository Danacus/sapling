/**
 * The framing between the microphone and the host.
 *
 * Everything here is a claim about bytes, and every one of them fails silently
 * in the real thing: a wrong sample rate transcribes the right words at the
 * wrong speed, a wrong byte order transcribes noise, and a gate set wrong puts
 * `嗯。` in the composer of a learner who said nothing. None of it produces an
 * error anywhere, which is exactly why it is worth pinning here rather than
 * noticing on a device.
 */

import { describe, expect, it } from 'vitest';

import { frameUtterance, joinChunks, peakOf, resampleTo16k, toPcm16 } from './pcm';

/** The worklet's quantum size, so the fixtures look like real captures. */
const QUANTUM = 128;

/** `seconds` of a steady tone at `rate`, in quanta, as the worklet posts them. */
function capture(seconds: number, rate: number, amplitude = 0.4): Float32Array[] {
	const total = Math.round(seconds * rate);
	const chunks: Float32Array[] = [];
	for (let at = 0; at < total; at += QUANTUM) {
		const chunk = new Float32Array(Math.min(QUANTUM, total - at));
		for (let i = 0; i < chunk.length; i++) {
			chunk[i] = amplitude * Math.sin((2 * Math.PI * 220 * (at + i)) / rate);
		}
		chunks.push(chunk);
	}
	return chunks;
}

/** The host's `decode_pcm16`, so the two directions are checked against each other. */
function decodePcm16(bytes: Uint8Array): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples: number[] = [];
	for (let at = 0; at < bytes.byteLength; at += 2) samples.push(view.getInt16(at, true) / 32768);
	return samples;
}

describe('joinChunks', () => {
	it('concatenates the quanta in the order they arrived', () => {
		const joined = joinChunks([
			new Float32Array([0.1, 0.2]),
			new Float32Array([0.3]),
			new Float32Array([0.4, 0.5])
		]);

		expect(Array.from(joined)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5].map((n) => Math.fround(n)));
	});

	it('is empty for a capture that never started', () => {
		expect(joinChunks([]).length).toBe(0);
	});
});

describe('resampleTo16k', () => {
	it('leaves a capture that already opened at 16 kHz alone, object and all', () => {
		const samples = new Float32Array([0.1, -0.2, 0.3]);

		expect(resampleTo16k(samples, 16_000)).toBe(samples);
	});

	it('turns three 48 kHz samples into one', () => {
		const samples = new Float32Array(48_000).fill(0.5);

		const resampled = resampleTo16k(samples, 48_000);

		expect(resampled.length).toBe(16_000);
		// A constant signal survives the averaging exactly, which is the cheapest
		// possible check that the window arithmetic does not drift.
		expect(peakOf(resampled)).toBeCloseTo(0.5, 6);
	});

	it('averages the window rather than picking one of it, so decimation is filtered', () => {
		// Alternating ±1 at 48 kHz is 24 kHz — three times the 8 kHz that fits in
		// a 16 kHz capture. Picking every third sample would fold it back in at
		// full amplitude; averaging pairs of opposites cancels it.
		const samples = new Float32Array(4_800);
		for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 1 : -1;

		expect(peakOf(resampleTo16k(samples, 48_000))).toBeLessThan(0.5);
	});

	it('interpolates upwards from a device that opened below 16 kHz', () => {
		const samples = new Float32Array([0, 1, 0, -1]);

		const resampled = resampleTo16k(samples, 8_000);

		expect(resampled.length).toBe(8);
		expect(resampled[0]).toBe(0);
		expect(resampled[1]).toBeCloseTo(0.5, 6);
		expect(resampled[2]).toBe(1);
	});
});

describe('toPcm16', () => {
	it('writes two little-endian bytes per sample', () => {
		// 0.5 -> 16384 -> 0x4000, low byte first.
		expect(Array.from(toPcm16(new Float32Array([0.5])))).toEqual([0x00, 0x40]);
	});

	it('maps the range the way the host reverses it', () => {
		const bytes = toPcm16(new Float32Array([0, 0.5, -0.5, -1]));

		expect(decodePcm16(bytes)).toEqual([0, 0.5, -0.5, -1]);
	});

	it('clamps rather than wrapping, which is what a wrapped sample sounds like', () => {
		// +1 is the one value the format cannot hold; it must come back just
		// under, never as the negative full scale a wrap would produce.
		expect(decodePcm16(toPcm16(new Float32Array([1, 2, -2])))).toEqual([
			32767 / 32768,
			32767 / 32768,
			-1
		]);
	});
});

describe('frameUtterance', () => {
	it('frames a spoken second at 16 kHz into two bytes a sample', () => {
		const pcm = frameUtterance(capture(1, 16_000), 16_000);

		expect(pcm?.byteLength).toBe(16_000 * 2);
	});

	it('resamples a capture the context opened at the device rate', () => {
		const pcm = frameUtterance(capture(1, 48_000), 48_000);

		// Still one second, now at the rate the recognizer reads.
		expect(pcm?.byteLength).toBe(16_000 * 2);
	});

	it('is nothing at all for a press that never became an utterance', () => {
		// A tenth of a second: under a syllable, and under the floor.
		expect(frameUtterance(capture(0.1, 16_000), 16_000)).toBeUndefined();
		expect(frameUtterance([], 16_000)).toBeUndefined();
	});

	it('is nothing at all for a muted microphone, however long it was open', () => {
		// Exact zeros are what a muted or unplugged device produces — and what
		// SenseVoice answers `嗯。` to, which is the whole reason for the gate.
		expect(frameUtterance(capture(3, 16_000, 0), 16_000)).toBeUndefined();
	});

	it('keeps a quiet but real utterance, because this is a gate and not a VAD', () => {
		// Well under conversational level and still comfortably above the floor.
		expect(frameUtterance(capture(1, 16_000, 0.05), 16_000)).toBeDefined();
	});
});
