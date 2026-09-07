/**
 * `tts-model` — the one-time voice model download.
 *
 * Wraps `preloadKokoro`, whose per-file progress events are folded here into
 * one bar in megabytes — the same arithmetic the Settings bar did. Not
 * cancellable: the download runs in the TTS worker (or, on the desktop, in the
 * Tauri host), neither of which listens for an abort, so cancelling only stops
 * the tray waiting on it. Serial, though both providers already coalesce
 * concurrent starts onto one promise.
 *
 * **The bar is over the model, once, and it may never go backwards.** Two
 * rules get it there, and both exist because a sum of `loaded/total` over
 * whatever keys have been seen so far does not.
 *
 * The denominator is what the install *announced before it moved a byte*: the
 * browser's worker names every artifact at 0 bytes for exactly this reason, so
 * a key that starts reporting later cannot stretch a total the bar has already
 * been drawn against.
 *
 * And a host that crosses the same megabytes more than once says so
 * (`voiceInstallPasses`). The desktop downloads an archive and then unpacks it,
 * reporting both halves against the archive's own size — and it cannot announce
 * the unpacking until the download has finished. Counted as two files that was
 * a bar which reached 100%, dropped to half of a doubled total and climbed
 * again; counted as two passes over one model it runs 0 → 50% → 100%, and the
 * megabytes it names stay the model's own size, the same number Settings offers
 * to download. The browser makes one pass, so its arithmetic is untouched.
 */

import { preloadKokoro, voiceInstallPasses } from '$lib/tts';
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
		const passes = voiceInstallPasses();
		const files = new Map<string, { loaded: number; total: number }>();
		/** Bytes one pass over the model moves — the bar's denominator. */
		let size = 0;
		await preloadKokoro((progress) => {
			files.set(progress.file, { loaded: progress.loaded, total: progress.total });
			let loaded = 0;
			let announced = 0;
			for (const entry of files.values()) {
				loaded += entry.loaded;
				announced += entry.total;
			}
			// Still announcing while nothing has moved; after that the total is
			// fixed, and a later pass adds to `loaded` alone. The `size === 0`
			// case is a host reporting an install it had already done, which
			// arrives complete on its very first event.
			if (size === 0 || loaded === 0) size = announced;
			if (size > 0) ctx.progress(megabytes(loaded / passes), megabytes(size), 'MB');
		});
	},

	summary() {
		return 'Voice model ready';
	}
} satisfies TaskKindDef<undefined, void>;
