/**
 * The line a model install draws, shared by the two kinds that draw one.
 *
 * `tts-model` and `asr-model` differ in what they download and in nothing else:
 * both wrap a host install that emits `{ file, loaded, total }` per artifact,
 * and both have to fold that into one bar in megabytes. The arithmetic is
 * subtle enough that two copies would drift, so there is one, here.
 *
 * **The bar is over the model, once, and it may never go backwards.** Two rules
 * get it there, and both exist because a sum of `loaded/total` over whatever
 * keys have been seen so far does not.
 *
 * The denominator is what the install *announced before it moved a byte*: the
 * browser's TTS worker names every artifact at 0 bytes for exactly this reason,
 * so a key that starts reporting later cannot stretch a total the bar has
 * already been drawn against.
 *
 * And a host that crosses the same megabytes more than once says how many times
 * (`passes`). A native install downloads an archive and then unpacks it,
 * reporting both halves against the archive's own size, and it cannot announce
 * the unpacking until the download has finished. Counted as two files that was
 * a bar which reached 100%, dropped to half of a suddenly doubled total and
 * climbed again; counted as two passes over one model it runs 0 → 50% → 100%,
 * and the megabytes it names stay the model's own size — the same number
 * Settings offers to download. A browser install makes one pass, so its
 * arithmetic is the plain sum it always was.
 */

import type { TaskContext } from '../types';

/** One progress tick as a host emits it. Both `TtsProgress` and `AsrProgress`. */
export interface InstallTick {
	file: string;
	loaded: number;
	total: number;
}

/** Bytes → megabytes, one decimal, for the progress line. */
function megabytes(bytes: number): number {
	return Math.round(bytes / 1e5) / 10;
}

/**
 * Runs one model install, drawing its bar.
 *
 * @param passes How many times this host's events cross the same model.
 * @param install The install itself, taking the progress listener to feed.
 */
export async function installWithBar(
	ctx: TaskContext,
	passes: number,
	install: (onProgress: (tick: InstallTick) => void) => Promise<void>
): Promise<void> {
	const files = new Map<string, { loaded: number; total: number }>();
	/** Bytes one pass over the model moves — the bar's denominator. */
	let size = 0;

	await install((tick) => {
		files.set(tick.file, { loaded: tick.loaded, total: tick.total });
		let loaded = 0;
		let announced = 0;
		for (const entry of files.values()) {
			loaded += entry.loaded;
			announced += entry.total;
		}
		// Still announcing while nothing has moved; after that the total is
		// fixed, and a later pass adds to `loaded` alone. The `size === 0` case
		// is a host reporting an install it had already done, which arrives
		// complete on its very first event.
		if (size === 0 || loaded === 0) size = announced;
		if (size > 0) ctx.progress(megabytes(loaded / passes), megabytes(size), 'MB');
	});
}
