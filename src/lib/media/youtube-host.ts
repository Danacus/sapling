/**
 * Which YouTube player this host can actually run — the one place that asks.
 *
 * The reader mounts a player and never learns what it got; that is what `Player`
 * is for, and it is why this decision lives here rather than in the page. There
 * are two implementations and one question between them:
 *
 * - **In a browser** the app already has a real HTTPS origin, so `youtube.ts`
 *   talks to YouTube directly. Nothing about the web build changes.
 * - **In the desktop shell** the document is served from `tauri://localhost`,
 *   for which a browser sends no referer, and YouTube refuses to configure a
 *   player without one (error 153 — the frame simply never fills). So the app
 *   frames a copy of `youtube.ts` hosted on a real origin and speaks to it over
 *   `postMessage` (`youtube-framed.ts`, `embed-protocol.ts`).
 *
 * **The gate is `inTauri()` and not a platform test**, although the refusal is
 * only observed on Linux and macOS today: Windows' `useHttpsScheme` is a Tauri
 * setting that could be turned on or off under us, and one desktop path that is
 * always exercised is worth more than a second path that only some machines
 * ever run. `pnpm desktop:dev` takes it too — it is the path that ships, so it
 * is the path that gets tested, which is why `VITE_YOUTUBE_EMBED_URL` belongs in
 * a desktop developer's `.env`.
 *
 * Unlike `db/tauri.ts` and `tts/native.ts`, this is a **static** import rather
 * than a dynamic one gated on the host. Those exist to keep `@tauri-apps/api`
 * out of the browser bundle; this module imports nothing but a few hundred bytes
 * of DOM and a message listener, and making it dynamic would make the factory
 * `async` — which is precisely what `youtube.ts` refuses to be, because the
 * reader builds its player synchronously inside an effect.
 */

import { inTauri } from '$lib/platform';

import { YOUTUBE_EMBED_URL } from './embed-url';
import { deadPlayer, type Player } from './player';
import { youtubePlayer, type YouTubeOptions } from './youtube';
import { framedYouTubePlayer } from './youtube-framed';

/**
 * What a desktop build with no embed page can say.
 *
 * A build-time fact stated plainly rather than dressed up as a network error:
 * the learner cannot fix it, but the person who built the app can, and a
 * message that names the variable is the difference between a bug report and a
 * one-line change. The text underneath is untouched and "Read as text" still
 * works, which is what every failure in this stage degrades to.
 */
const NOT_CONFIGURED =
	'YouTube playback in the desktop app needs the embed page configured (VITE_YOUTUBE_EMBED_URL); this build has none. The text is still here to read.';

/**
 * Mounts the video in `el` with whichever player this host can run.
 *
 * The signature is `youtubePlayer`'s, because it *is* `youtubePlayer` in a
 * browser — the reader calls this and passes the same `onFail`, which is still
 * the one line that lands in the picture's place.
 */
export function youtubePlayerForHost(
	el: HTMLElement,
	videoId: string,
	options: YouTubeOptions = {}
): Player {
	if (!inTauri()) return youtubePlayer(el, videoId, options);

	if (!YOUTUBE_EMBED_URL) {
		// Asynchronously, like every other failure here: the reader calls this from
		// the effect that renders the element being replaced, and reporting inside
		// that effect would unmount it mid-build.
		queueMicrotask(() => options.onFail?.(NOT_CONFIGURED));
		return deadPlayer();
	}

	return framedYouTubePlayer(el, videoId, YOUTUBE_EMBED_URL, options);
}
