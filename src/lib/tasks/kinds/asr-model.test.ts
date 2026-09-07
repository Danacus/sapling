/**
 * The dictation install's bar.
 *
 * `model-download.ts` owns the arithmetic and `tts-model.test.ts` puts it
 * through both a one-pass and a two-pass host. What is this kind's own is the
 * number it hands over: there is no browser recognizer, so this install is
 * always the native one and always crosses the model twice. A def that passed 1
 * would draw a bar reaching 100% halfway through the download and then sitting
 * there through the unpack — which is exactly the bug the voice already had.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AsrProgress } from '$lib/asr';
import type { TaskProgress } from '../types';

const asr = {
	preloadDictationModel: vi.fn(async (_onProgress?: (progress: AsrProgress) => void) => {})
};

vi.mock('$lib/asr', () => asr);

/** The pinned archive the host downloads and then unpacks. */
const ARCHIVE = 163_002_883;
const MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';

/** Runs the task against a scripted progress stream; returns every bar it drew. */
async function bars(
	ticks: [file: string, loaded: number, total: number][]
): Promise<TaskProgress[]> {
	asr.preloadDictationModel.mockImplementation(async (onProgress) => {
		for (const [file, loaded, total] of ticks) {
			onProgress?.({ file, loaded, total, progress: total > 0 ? (loaded / total) * 100 : 0 });
		}
	});

	const drawn: TaskProgress[] = [];
	const { asrModelTask } = await import('./asr-model');
	await asrModelTask.run(undefined, {
		signal: new AbortController().signal,
		step: () => {},
		progress: (done, total, unit) => drawn.push({ done, total, unit })
	});
	return drawn;
}

describe('asr-model progress', () => {
	it('crosses the model once across the download and the unpack', async () => {
		const drawn = await bars([
			[`${MODEL}.tar.bz2`, 0, ARCHIVE],
			[`${MODEL}.tar.bz2`, ARCHIVE / 2, ARCHIVE],
			[`${MODEL}.tar.bz2`, ARCHIVE, ARCHIVE],
			[`${MODEL} (unpacking)`, 0, ARCHIVE],
			[`${MODEL} (unpacking)`, ARCHIVE / 2, ARCHIVE],
			[`${MODEL} (unpacking)`, ARCHIVE, ARCHIVE]
		]);

		// Downloading fills the first half, unpacking the second: the unpack's
		// opening tick holds the bar where the download left it instead of
		// halving it.
		expect(drawn.map((bar) => bar.done)).toEqual([0, 40.8, 81.5, 81.5, 122.3, 163]);
		// The megabytes named are the model's own — the same number Settings
		// offers to download, not twice it.
		expect(new Set(drawn.map((bar) => bar.total))).toEqual(new Set([163]));
		expect(new Set(drawn.map((bar) => bar.unit))).toEqual(new Set(['MB']));

		const filled = drawn.map((bar) => bar.done / bar.total);
		expect(filled).toEqual([...filled].sort((a, b) => a - b));
		expect(filled.at(-1)).toBe(1);
	});

	it('fills the bar for an install the host had already done', async () => {
		const drawn = await bars([
			[`${MODEL}.tar.bz2`, ARCHIVE, ARCHIVE],
			[`${MODEL} (unpacking)`, ARCHIVE, ARCHIVE]
		]);

		expect(drawn.map((bar) => bar.done / bar.total)).toEqual([0.5, 1]);
	});
});
