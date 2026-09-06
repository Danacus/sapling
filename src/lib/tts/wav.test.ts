import { describe, expect, it } from 'vitest';

import { encodeWav, WAV_HEADER_BYTES } from './wav';

function chunkId(view: DataView, offset: number): string {
	return String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3)
	);
}

describe('encodeWav', () => {
	it('writes a 44-byte canonical mono 16-bit PCM header', () => {
		const wav = encodeWav(new Float32Array(100), 24000);
		const view = new DataView(wav);

		expect(wav.byteLength).toBe(WAV_HEADER_BYTES + 200);
		expect(chunkId(view, 0)).toBe('RIFF');
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(chunkId(view, 8)).toBe('WAVE');

		expect(chunkId(view, 12)).toBe('fmt ');
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(24000);
		expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate
		expect(view.getUint16(32, true)).toBe(2); // block align
		expect(view.getUint16(34, true)).toBe(16); // bits per sample

		expect(chunkId(view, 36)).toBe('data');
		expect(view.getUint32(40, true)).toBe(200);
	});

	it('scales samples to signed 16-bit, little-endian', () => {
		const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 24000);
		const view = new DataView(wav);
		const at = (index: number) => view.getInt16(WAV_HEADER_BYTES + index * 2, true);

		expect(at(0)).toBe(0);
		expect(at(1)).toBe(Math.round(0.5 * 32767));
		expect(at(2)).toBe(Math.round(-0.5 * 32768));
		expect(at(3)).toBe(32767);
		expect(at(4)).toBe(-32768);
	});

	it('clamps rather than wrapping, so a hot sample is not a burst of noise', () => {
		const wav = encodeWav(new Float32Array([4, -4]), 24000);
		const view = new DataView(wav);
		expect(view.getInt16(WAV_HEADER_BYTES, true)).toBe(32767);
		expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-32768);
	});

	it('survives an empty clip and a fractional sample rate', () => {
		const wav = encodeWav(new Float32Array(0), 22050.4);
		const view = new DataView(wav);
		expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
		expect(view.getUint32(24, true)).toBe(22050);
		expect(view.getUint32(40, true)).toBe(0);
	});
});
