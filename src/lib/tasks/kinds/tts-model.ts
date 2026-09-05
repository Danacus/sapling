/**
 * `tts-model` — the one-time voice model download.
 *
 * Wraps `preloadKokoro`, whose per-file progress events are summed here into
 * one fraction in megabytes — the same arithmetic the Settings bar did. Not
 * cancellable: the download runs in the TTS worker, which does not listen for
 * an abort, so cancelling only stops the tray waiting on it. Serial, though
 * `initSherpa` already coalesces concurrent starts onto one promise.
 */

import { preloadKokoro } from '$lib/tts';
import type { TaskKindDef } from '../types';

/** Bytes → megabytes, one decimal, for the progress line. */
function megabytes(bytes: number): number {
	return Math.round(bytes / 1e5) / 10;
}

export const ttsModelTask = {
	serial: true,
	cancellable: false,

	title() {
		return 'Voice model download';
	},

	async run(_input: undefined, ctx) {
		const files = new Map<string, { loaded: number; total: number }>();
		await preloadKokoro((progress) => {
			files.set(progress.file, { loaded: progress.loaded, total: progress.total });
			let loaded = 0;
			let total = 0;
			for (const entry of files.values()) {
				loaded += entry.loaded;
				total += entry.total;
			}
			if (total > 0) ctx.progress(megabytes(loaded), megabytes(total), 'MB');
		});
	},

	summary() {
		return 'Voice model ready';
	}
} satisfies TaskKindDef<undefined, void>;
