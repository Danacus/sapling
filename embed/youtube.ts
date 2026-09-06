/**
 * The hosted YouTube player: everything the app cannot run itself, and nothing
 * else.
 *
 * Sapling's desktop shell serves the app from `tauri://localhost`. A browser
 * sends no referer for a document on a custom scheme, and YouTube's IFrame API
 * will not configure a player without one — error 153, and a frame that never
 * fills. Nothing in Tauri's configuration fixes that, and serving the whole app
 * over `http://` would cost the IPC the database rides on. So this one document
 * is deployed to a real HTTPS origin and framed by the app, which drives it over
 * `postMessage`. `src/lib/media/embed-protocol.ts` is the wire and carries the
 * full reasoning; `src/lib/media/youtube-framed.ts` is the other end.
 *
 * **It runs the app's own player.** `youtubePlayer` is imported from
 * `src/lib/media/youtube.ts` — the same module the web build runs, not a copy —
 * so there is one implementation of the late API, the 250 ms poll, the queue and
 * the `nocookie` host. What is written here is only the translation between that
 * `Player` and six messages, which is why the file is this short.
 *
 * **The video id is the only input, and it is checked twice.** It arrives as
 * `?v=`, goes through the app's own `isVideoId`, and is passed to the player as
 * a `videoId` — never into markup, never into a URL this page builds. A page
 * that is meant to be framed by anything has to treat its query string as
 * hostile, because anyone can put it in an iframe with any query they like. The
 * worst they can do is watch a video.
 *
 * **This page is deliberately frameable and deliberately dull.** It is on its
 * own origin rather than the app's — see `embed/public/_headers` — it stores
 * nothing, reads nothing, and knows nothing about a learner. What crosses the
 * boundary is a video id someone chose and where it is up to.
 */

import {
	failEvent,
	parseCommand,
	readyEvent,
	timeEvent,
	type EmbedEvent
} from '$lib/media/embed-protocol';
import { youtubePlayer } from '$lib/media/youtube';
import { isVideoId } from '$lib/media/youtube-url';

/**
 * The framer, or this window when there is none.
 *
 * `window.parent` is the window itself for a top-level document, which is how
 * "somebody opened this URL directly" is told apart from "the app is using it".
 */
const framer = window.parent;
const framed = framer !== window;

/**
 * Posted to `'*'` on purpose, and this is the one place it is unavoidable: the
 * framer's origin is `tauri://localhost`, a custom scheme, which cannot be named
 * as a `targetOrigin` — a browser rejects it and the message goes nowhere. The
 * app's side names *this* origin when it posts, and checks both the frame and
 * the origin on everything it receives, so the strict half of the handshake is
 * the half that can be strict. Nothing sent here is private.
 */
function post(event: EmbedEvent): void {
	if (framed) framer.postMessage(event, '*');
}

/** The one visible thing this page can do, and only for a person who came here directly. */
function note(text: string): void {
	const el = document.getElementById('note');
	if (!el) return;
	el.textContent = text;
	el.hidden = false;
}

const mount = document.getElementById('player');
const videoId = new URLSearchParams(window.location.search).get('v') ?? '';

if (!mount) {
	// Unreachable unless the HTML and this file disagree, which is a build
	// mistake rather than a runtime one — but silence would look like a network
	// failure, so it is reported like one.
	post(failEvent('The YouTube player did not load.'));
} else if (!isVideoId(videoId)) {
	post(failEvent('That link does not name a YouTube video.'));
	note('This page plays one YouTube video, named by a ?v= parameter.');
} else {
	const player = youtubePlayer(mount, videoId, {
		onFail: (message) => post(failEvent(message))
	});

	// The app never polls across the boundary; this does the announcing, on
	// `youtube.ts`'s own schedule — every 250 ms while playing, and once on every
	// state change, including a seek and a pause. `paused()` is asked here rather
	// than mirrored, because the player is right beside it.
	player.onTime((ms) => post(timeEvent(ms, !player.paused())));

	// Listening before announcing readiness, so a command sent the instant the
	// app hears `ready` cannot arrive before there is anything to hear it.
	window.addEventListener('message', (event) => {
		// The framer and nobody else. The app posts with this page's origin as its
		// target, so a message from anywhere else is either a mistake or somebody
		// trying something; either way it is not a command.
		if (event.source !== framer) return;

		const command = parseCommand(event.data);
		if (!command) return;

		if (command.type === 'play') player.play();
		else if (command.type === 'pause') player.pause();
		else player.seek(command.ms);
	});

	// "The document loaded and will honour commands" — not "YouTube is ready",
	// which nobody needs to know: the player above queues what it is asked before
	// its own iframe answers, so the app's queue drains straight into it.
	post(readyEvent());

	if (!framed)
		note('This page is the player Sapling embeds. It is playing the video you asked for.');
}
