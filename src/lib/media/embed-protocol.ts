/**
 * The wire between the app and the hosted YouTube page, and the whole of it.
 *
 * **Why there is a wire at all.** YouTube's IFrame API will not configure a
 * player without a valid HTTP(S) referer, and the desktop shell serves the app
 * from `tauri://localhost` — a custom scheme, for which a browser sends no
 * referer at all — so YouTube answers every embed with error 153 and a frozen
 * frame. Nothing in Tauri's configuration fixes that (`useHttpsScheme` is
 * Windows and Android only), and serving the whole app over `http://` costs the
 * IPC the database rides on. So the *one document* that talks to YouTube is
 * fetched over a genuine network connection to a real HTTPS host — `embed/`,
 * deployed on its own origin — and the app frames it.
 *
 * **What is bridged is {@link Player}, not the IFrame API.** The page runs the
 * real `youtubePlayer` (the same module the web build runs, imported by the
 * embed entry) and speaks only in the five verbs and the clock: three commands
 * down, three events up. That is what keeps the app side free of YouTube — a
 * change to the API is a change to `youtube.ts` and to nothing here — and it is
 * why the parent never polls across the boundary: the page keeps `youtube.ts`'s
 * 250 ms poll while playing, announces on every state change, and posts what it
 * hears. A poll on the parent side would sample a clock it does not own.
 *
 * **Every message is tagged** with {@link EMBED_PROTOCOL}, a namespace and a
 * version in one string, because `window`'s `message` event is a shared channel:
 * an extension, a widget or YouTube's own API can post anything to either side,
 * and everything without this tag is ignored. Origins are checked as well — the
 * parent posts with the embed page's origin as `targetOrigin` and accepts only
 * messages from that origin and that frame; the page accepts only
 * `event.source === window.parent`, and posts with `'*'` because the framer's
 * origin is `tauri://localhost`, which cannot be named as a `targetOrigin`.
 * Nothing secret crosses either way: a video id the learner chose, and where it
 * is up to.
 *
 * Pure and node-testable like `youtube-url.ts`, and for the same reason — the
 * parsers decide what a hostile page can make the app do, so they are the part
 * of this area worth a test.
 */

import { isVideoId } from './youtube-url';

/**
 * The namespace and version every message carries.
 *
 * Bump the version when a message changes shape rather than adding a field with
 * a fallback: the page and the app are deployed separately and *will* be at
 * different versions, and a mismatch that is simply ignored is a video that does
 * not play, which is visible. A half-understood message is not.
 */
export const EMBED_PROTOCOL = 'sapling/youtube-embed@1';

/** App to page: the three verbs the page can act on. */
export type EmbedCommand =
	| { protocol: typeof EMBED_PROTOCOL; type: 'play' }
	| { protocol: typeof EMBED_PROTOCOL; type: 'pause' }
	| { protocol: typeof EMBED_PROTOCOL; type: 'seek'; ms: number };

/** Page to app: alive, where the clock is, or why there is no player. */
export type EmbedEvent =
	| { protocol: typeof EMBED_PROTOCOL; type: 'ready' }
	| { protocol: typeof EMBED_PROTOCOL; type: 'time'; ms: number; playing: boolean }
	| { protocol: typeof EMBED_PROTOCOL; type: 'fail'; message: string };

export function playCommand(): EmbedCommand {
	return { protocol: EMBED_PROTOCOL, type: 'play' };
}

export function pauseCommand(): EmbedCommand {
	return { protocol: EMBED_PROTOCOL, type: 'pause' };
}

/** Clamped and rounded here, so neither side has to wonder which it got. */
export function seekCommand(ms: number): EmbedCommand {
	return { protocol: EMBED_PROTOCOL, type: 'seek', ms: Math.max(0, Math.round(ms)) };
}

/**
 * The page is running and will honour commands.
 *
 * Not "YouTube is ready": the page's own player queues what it is asked before
 * its iframe answers, exactly as `youtube.ts` documents, so the app's queue
 * drains into the page's and both are correct. What this event really says is
 * that the document loaded at all — which is the failure the app cannot
 * otherwise see, and why the app gives up on a page that never sends it.
 */
export function readyEvent(): EmbedEvent {
	return { protocol: EMBED_PROTOCOL, type: 'ready' };
}

export function timeEvent(ms: number, playing: boolean): EmbedEvent {
	return { protocol: EMBED_PROTOCOL, type: 'time', ms: Math.max(0, Math.round(ms)), playing };
}

export function failEvent(message: string): EmbedEvent {
	return { protocol: EMBED_PROTOCOL, type: 'fail', message };
}

/** The message in `data` if it is one of ours, `undefined` for everything else. */
export function parseCommand(data: unknown): EmbedCommand | undefined {
	const message = tagged(data);
	if (!message) return undefined;

	switch (message.type) {
		case 'play':
			return playCommand();
		case 'pause':
			return pauseCommand();
		case 'seek':
			return isPosition(message.ms) ? seekCommand(message.ms) : undefined;
		default:
			return undefined;
	}
}

/** The event in `data` if it is one of ours, `undefined` for everything else. */
export function parseEvent(data: unknown): EmbedEvent | undefined {
	const message = tagged(data);
	if (!message) return undefined;

	switch (message.type) {
		case 'ready':
			return readyEvent();
		case 'time':
			return isPosition(message.ms) && typeof message.playing === 'boolean'
				? timeEvent(message.ms, message.playing)
				: undefined;
		case 'fail':
			return typeof message.message === 'string' ? failEvent(message.message) : undefined;
		default:
			return undefined;
	}
}

/**
 * Where the page for `videoId` lives, and the origin to post to it.
 *
 * The id goes in as a query parameter and never anywhere else — the page puts it
 * through `isVideoId` again on arrival and hands it to the player as a
 * `videoId`, never into markup — and the base URL is whatever the build was
 * configured with, so nothing here knows a domain. `undefined` is a build
 * configured with something that is not an http(s) URL, or an id that is not
 * one; both are a misconfiguration rather than something a learner did, and the
 * caller says so in the picture's place.
 */
export function embedFrameUrl(
	base: string,
	videoId: string
): { src: string; origin: string } | undefined {
	if (!isVideoId(videoId)) return undefined;

	let url: URL;
	try {
		url = new URL(base);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

	// `set`, not `append`: a base that already carries a `v` is a copy-paste of a
	// page URL, and the id this call is about is the only one that may survive.
	url.searchParams.set('v', videoId);
	return { src: url.toString(), origin: url.origin };
}

/**
 * A message object carrying our tag and naming a type, its payload unchecked.
 *
 * The tag is the whole of the trust decision: anything else on the channel —
 * YouTube's own API posts to `window` too — never reaches the switches above.
 */
function tagged(data: unknown): ({ type: string } & Record<string, unknown>) | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const message = data as Record<string, unknown>;
	if (message.protocol !== EMBED_PROTOCOL || typeof message.type !== 'string') return undefined;
	return { ...message, type: message.type };
}

/** A real, finite number — `NaN` and the infinities are not positions. */
function isPosition(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
