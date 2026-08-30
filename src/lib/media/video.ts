/**
 * {@link Player} over a `<video>` element — the local-file implementation, and
 * an audio file's too, since `<video>` plays one without complaint and a second
 * element would be a second set of listeners for no behavioural difference.
 *
 * Thin on purpose, and it is the one file in the app that knows a media clock
 * is measured in **seconds**. Everything above it — the follow logic, the
 * sentence timings, the reader's state — is milliseconds, so the conversion
 * lives here at the boundary and nowhere else.
 *
 * The events it listens to are what makes `onTime` trustworthy: `timeupdate`
 * alone fires only while playing and only every 200-odd milliseconds, so a
 * learner who scrubs while paused would keep the old line highlighted. Adding
 * `seeking`/`seeked`, `play` and `pause` means the callback fires the moment the
 * position becomes something else, whatever caused it.
 *
 * Untested beyond the typechecker, deliberately: node has no media element, and
 * everything here that could be wrong in an interesting way was moved into
 * `./follow`, which is pure.
 */

import type { Player } from './player';

/** Every event after which the position may be something other than it was. */
const MOVED = ['timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ratechange'] as const;

/** Wraps a media element as a {@link Player}. Milliseconds in, milliseconds out. */
export function videoPlayer(el: HTMLVideoElement): Player {
	const listeners = new Set<(ms: number) => void>();

	const now = () => Math.round(el.currentTime * 1000);
	const announce = () => {
		const ms = now();
		for (const listener of listeners) listener(ms);
	};

	for (const type of MOVED) el.addEventListener(type, announce);

	return {
		currentTime: now,
		seek(ms) {
			// Clamped at zero: a "replay this line" on the first line of a file whose
			// first cue starts at 0 would otherwise hand the element a negative time,
			// which browsers treat inconsistently.
			el.currentTime = Math.max(0, ms) / 1000;
		},
		play() {
			// `play()` rejects when autoplay policy blocks it or when the element is
			// torn down mid-promise. Neither is worth an error in the reader: the
			// learner still has the native controls, which is the whole reason they
			// are left on.
			void el.play().catch(() => undefined);
		},
		pause() {
			el.pause();
		},
		paused: () => el.paused,
		onTime(cb) {
			listeners.add(cb);
			// Immediately, so a subscriber never renders one frame against a position
			// it has not been told yet.
			cb(now());
			return () => listeners.delete(cb);
		},
		destroy() {
			for (const type of MOVED) el.removeEventListener(type, announce);
			listeners.clear();
		}
	};
}
