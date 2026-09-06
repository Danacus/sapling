/**
 * {@link Player} over the hosted embed page — the third implementation of the
 * same five verbs and a clock, and still nothing the reader learns about.
 *
 * It exists because of one refusal: YouTube's IFrame API will not configure a
 * player for a document with no valid HTTP(S) referer, and the desktop shell
 * serves the app from `tauri://localhost`, a custom scheme for which a browser
 * sends none. The symptom is error 153 and a frame that never fills. So the
 * document that talks to YouTube is moved to a real HTTPS origin (`embed/`,
 * deployed separately) and framed from here; `embed-protocol.ts` carries the
 * reasoning and the wire.
 *
 * **This file is a proxy, not a second player.** Everything YouTube-shaped —
 * the late API, the 250 ms poll, the queue, `nocookie`, the error codes — is in
 * `youtube.ts`, which the page runs. What is here is the four things a
 * `postMessage` boundary costs:
 *
 * 1. **The clock is a report, not a reading.** `currentTime()` answers the last
 *    position the page announced rather than asking across the boundary, which
 *    cannot be done synchronously. The page announces on `youtube.ts`'s own
 *    schedule — every 250 ms while playing, and once on every state change — so
 *    this is exactly as fresh as the direct player's poll and never staler.
 * 2. **The same queue, one frame further out.** A `seek` or a `play` asked for
 *    before the page answers is held and posted on `ready`, in that order, and
 *    `paused()` answers from the wish rather than lying — the same contract
 *    `youtube.ts` states, for the same reason: the reader builds its player
 *    synchronously inside an effect and there is no `await` to put in front.
 *    The page's own player queues in turn, so the two queues compose.
 * 3. **A page that never loads must still be reported.** There is no `onerror`
 *    worth trusting on a cross-origin iframe, so {@link LOAD_TIMEOUT_MS} is the
 *    only signal: no `ready` in ten seconds is a failure, with the same sentence
 *    the direct player uses, because to the learner it is the same event.
 * 4. **Every message is checked twice** — the frame it came from and the origin
 *    it came from — before the protocol tag is even looked at.
 *
 * The iframe is created here and the caller's node is only emptied into, exactly
 * as `youtube.ts` does with the element the API replaces, so the reader's
 * `.yt-frame` stays a plain `<div>` it owns and this owns everything inside it.
 * Width and height are *attributes* rather than inline styles, again as the API
 * sets them, so the reader's `:global(iframe)` rule still decides how the
 * picture is sized.
 */

import {
	embedFrameUrl,
	parseEvent,
	pauseCommand,
	playCommand,
	seekCommand,
	type EmbedCommand
} from './embed-protocol';
import { deadPlayer, type Player } from './player';
import type { YouTubeOptions } from './youtube';

/**
 * How long the page gets to say `ready` before the reader is told it will not.
 *
 * The same ten seconds `youtube.ts` gives the API script, and for the same
 * failures: a host that cannot be reached, a page that 404s, a network that is
 * simply not there.
 */
const LOAD_TIMEOUT_MS = 10_000;

/** The sentence for every way the page can fail to arrive — one event, to a learner. */
const NO_PLAYER = 'The YouTube player did not load.';

/**
 * Mounts the embed page inside `el` and wraps it as a {@link Player}.
 *
 * `embedUrl` is the deployed page's full URL and comes from the build
 * (`embed-url.ts`); `youtube-host.ts` is what decides this player is the one to
 * build. A failure before there is anything to fail — an unusable URL, an id
 * that is not one — is reported through `onFail` **asynchronously**, because the
 * reader calls this from inside the effect that renders the element it would
 * replace, and a synchronous report would unmount that element mid-build.
 */
export function framedYouTubePlayer(
	el: HTMLElement,
	videoId: string,
	embedUrl: string,
	options: YouTubeOptions = {}
): Player {
	const listeners = new Set<(ms: number) => void>();

	let destroyed = false;
	/** The page has answered; before that every verb is queued, not dropped. */
	let ready = false;
	/** Mirrored from what the page pushes, never asked for — see the header. */
	let playing = false;

	/** Where the learner asked to be before there was anything to ask. */
	let pendingMs = 0;
	let wantPlay = false;
	/** The last position the page announced; the clock, such as it is. */
	let lastMs = 0;

	const now = () => (ready ? lastMs : pendingMs);

	const announce = () => {
		const ms = now();
		for (const listener of listeners) listener(ms);
	};

	const fail = (message: string) => {
		if (destroyed) return;
		options.onFail?.(message);
	};

	const frame = embedFrameUrl(embedUrl, videoId);
	if (!frame) {
		queueMicrotask(() => fail(NO_PLAYER));
		return deadPlayer();
	}

	const iframe = document.createElement('iframe');
	iframe.src = frame.src;
	// Named for a screen reader, which finds a frame and would otherwise announce
	// a URL. The player inside it names the video itself.
	iframe.title = 'YouTube video';
	iframe.width = '100%';
	iframe.height = '100%';
	// Forwarded because a nested frame gets only what its parent grants it: the
	// player is two frames down and would silently lose autoplay, DRM playback,
	// picture-in-picture and the fullscreen button without this.
	iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
	iframe.allowFullscreen = true;
	el.replaceChildren(iframe);

	const post = (command: EmbedCommand) => {
		// The origin is named rather than `'*'`: a redirect could put somebody
		// else's document in this frame, and it would be handed the learner's
		// position rather than nothing.
		iframe.contentWindow?.postMessage(command, frame.origin);
	};

	const timer = setTimeout(() => fail(NO_PLAYER), LOAD_TIMEOUT_MS);

	const onMessage = (event: MessageEvent) => {
		if (destroyed) return;
		// `message` is a channel shared with every other frame and extension on the
		// page. Both halves of the check matter: the frame says it came from the
		// player, the origin says the frame is still showing what was put in it.
		if (event.source !== iframe.contentWindow || event.origin !== frame.origin) return;

		const message = parseEvent(event.data);
		if (!message) return;

		switch (message.type) {
			case 'ready':
				clearTimeout(timer);
				ready = true;
				// Carried across, because `ready` is where the clock stops being the
				// queued wish and starts being what the page reports: without it the
				// announcement below would say 0 and the highlight would fall back to
				// the first line for one round trip.
				lastMs = pendingMs;
				// The queue, drained in the order it was filled — where they asked to
				// be, and then whether they wanted it running.
				if (pendingMs > 0) post(seekCommand(pendingMs));
				if (wantPlay) post(playCommand());
				announce();
				break;
			case 'time':
				lastMs = message.ms;
				playing = message.playing;
				announce();
				break;
			case 'fail':
				clearTimeout(timer);
				fail(message.message);
				break;
		}
	};
	window.addEventListener('message', onMessage);

	return {
		currentTime: now,
		seek(ms) {
			const at = Math.max(0, ms);
			pendingMs = at;
			// Moved here too, not only in the queue: the highlight follows this
			// number, and waiting a round trip for the page to confirm a position the
			// learner just chose would show them the old line for a beat.
			if (ready) {
				lastMs = at;
				post(seekCommand(at));
			}
			announce();
		},
		play() {
			wantPlay = true;
			if (ready) post(playCommand());
		},
		pause() {
			wantPlay = false;
			if (ready) post(pauseCommand());
		},
		// Before the page answers, whatever was last asked for — a learner who
		// pressed play during the load should see a Pause button, not a lie.
		paused: () => (ready ? !playing : !wantPlay),
		onTime(cb) {
			listeners.add(cb);
			cb(now());
			return () => listeners.delete(cb);
		},
		destroy() {
			destroyed = true;
			ready = false;
			clearTimeout(timer);
			window.removeEventListener('message', onMessage);
			listeners.clear();
			// The whole player is this element: removing it stops the page, its
			// player and the network inside both.
			iframe.remove();
		}
	};
}
