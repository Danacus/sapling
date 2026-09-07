/**
 * The line the voice install draws, on both hosts.
 *
 * The desktop host reports the same archive twice — once coming down, once
 * being unpacked, both against the archive's own size — and a bar that summed
 * those two keys ran to 100%, dropped to half of a suddenly doubled total, and
 * climbed again. What is worth pinning is the *shape* of the line rather than
 * any one number: it never goes backwards, it is full exactly once, and the
 * megabytes it names are the model's own on either host.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TtsProgress } from '$lib/tts';
import type { TaskProgress } from '../types';

/** One progress event as a host emits it: file, bytes so far, bytes expected. */
type Tick = [file: string, loaded: number, total: number];

const tts = {
	voiceInstallPasses: vi.fn(() => 1),
	preloadKokoro: vi.fn(async (_onProgress?: (progress: TtsProgress) => void) => {})
};

vi.mock('$lib/tts', () => tts);

/** The pinned archive the desktop host downloads and then unpacks. */
const ARCHIVE = 364_816_464;
/** The browser's two runtime files, announced together and fetched in turn. */
const WASM = 11_903_250;
const DATA = 426_654_376;

/** Runs the task against a scripted progress stream; returns every bar it drew. */
async function bars(passes: number, ticks: Tick[]): Promise<TaskProgress[]> {
	tts.voiceInstallPasses.mockReturnValue(passes);
	tts.preloadKokoro.mockImplementation(async (onProgress) => {
		for (const [file, loaded, total] of ticks) {
			onProgress?.({ file, loaded, total, progress: total > 0 ? (loaded / total) * 100 : 0 });
		}
	});

	const drawn: TaskProgress[] = [];
	const { ttsModelTask } = await import('./tts-model');
	await ttsModelTask.run(undefined, {
		signal: new AbortController().signal,
		step: () => {},
		progress: (done, total, unit) => drawn.push({ done, total, unit })
	});
	return drawn;
}

/** How full the tray draws each bar — `done / total`, as `TaskTray` computes it. */
const fill = (drawn: TaskProgress[]) => drawn.map((bar) => bar.done / bar.total);

describe('tts-model progress', () => {
	it('crosses the model once on a host that downloads and then unpacks it', async () => {
		const drawn = await bars(2, [
			['kokoro-multi-lang-v1_1.tar.bz2', 0, ARCHIVE],
			['kokoro-multi-lang-v1_1.tar.bz2', ARCHIVE / 2, ARCHIVE],
			['kokoro-multi-lang-v1_1.tar.bz2', ARCHIVE, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', 0, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', ARCHIVE / 2, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', ARCHIVE, ARCHIVE]
		]);

		// Downloading fills the first half, unpacking the second: the unpack's
		// opening tick holds the bar where the download left it instead of
		// halving it.
		expect(drawn.map((bar) => bar.done)).toEqual([0, 91.2, 182.4, 182.4, 273.6, 364.8]);
		expect(new Set(drawn.map((bar) => bar.total))).toEqual(new Set([364.8]));
		expect(new Set(drawn.map((bar) => bar.unit))).toEqual(new Set(['MB']));
	});

	it('never goes backwards and ends full', async () => {
		const drawn = await bars(2, [
			['kokoro-multi-lang-v1_1.tar.bz2', 0, ARCHIVE],
			['kokoro-multi-lang-v1_1.tar.bz2', 4_194_304, ARCHIVE],
			['kokoro-multi-lang-v1_1.tar.bz2', 180_000_000, ARCHIVE],
			['kokoro-multi-lang-v1_1.tar.bz2', ARCHIVE, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', 0, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', 4_194_304, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', 300_000_000, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', ARCHIVE, ARCHIVE]
		]);

		const filled = fill(drawn);
		expect(filled).toEqual([...filled].sort((a, b) => a - b));
		expect(filled.at(-1)).toBe(1);
	});

	it('spans both runtime files from the moment they are announced, in the browser', async () => {
		const drawn = await bars(1, [
			['sherpa-onnx-wasm-main-tts.wasm', 0, WASM],
			['sherpa-onnx-wasm-main-tts.data', 0, DATA],
			['sherpa-onnx-wasm-main-tts.wasm', WASM, WASM],
			['sherpa-onnx-wasm-main-tts.data', DATA / 2, DATA],
			['sherpa-onnx-wasm-main-tts.data', DATA, DATA]
		]);

		// One pass, so the arithmetic is the plain sum it always was: both files
		// are announced before a byte moves, and the total never changes after.
		expect(drawn.map((bar) => bar.done)).toEqual([0, 0, 11.9, 225.2, 438.6]);
		expect(drawn.map((bar) => bar.total)).toEqual([11.9, 438.6, 438.6, 438.6, 438.6]);

		const filled = fill(drawn);
		expect(filled).toEqual([...filled].sort((a, b) => a - b));
		expect(filled.at(-1)).toBe(1);
	});

	it('fills the bar for an install the host had already done', async () => {
		// Both halves arrive complete on their first event, which is how the
		// desktop host answers "it is already here" without leaving a bar that
		// never moves.
		const drawn = await bars(2, [
			['kokoro-multi-lang-v1_1.tar.bz2', ARCHIVE, ARCHIVE],
			['kokoro-multi-lang-v1_1 (unpacking)', ARCHIVE, ARCHIVE]
		]);

		expect(fill(drawn)).toEqual([0.5, 1]);
	});
});
