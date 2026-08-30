/**
 * {@link Player} over YouTube's IFrame Player API — the second implementation of
 * the same five verbs and a clock, and the reader never learns which one it got.
 *
 * The shape of this file is dictated by three things the DOM's own media element
 * gives away for free and YouTube does not:
 *
 * 1. **The API arrives late.** `https://www.youtube.com/iframe_api` is a script
 *    that loads a second script and then calls a *global* callback, so the
 *    player cannot be built synchronously. It is loaded **once per page and only
 *    on demand**: a module-level promise, resolved from
 *    `onYouTubeIframeAPIReady`, so a learner who never opens a YouTube text
 *    never fetches it and a second text reuses what the first pulled in. The
 *    factory below stays synchronous anyway and queues what it is asked to do
 *    before the iframe exists — the alternative is a `Promise<Player>`, which
 *    would put an `await` in the reader's effect and a torn-down player on the
 *    other side of it.
 * 2. **There is no `timeupdate`.** The API reports *state* changes and nothing
 *    else, so the clock is polled — but only while something is actually
 *    playing ({@link POLL_MS}), because a timer running against a paused video
 *    is exactly what `Player`'s own doc says a subscription exists to avoid. A
 *    seek, a pause or an ended video comes through `onStateChange` instead and
 *    announces once, so the highlight is right the instant the learner lands
 *    somewhere rather than at the next tick.
 * 3. **Seconds, again.** `getCurrentTime`/`seekTo` are seconds because the DOM's
 *    are; this file and `video.ts` are the only two that know that, exactly as
 *    the area's rule says.
 *
 * The host is `youtube-nocookie.com`: same API, same player, and no cookie
 * planted on a learner who is here to read subtitles. Native controls stay on
 * for the reason `<video controls>` does — scrubbing, volume and fullscreen are
 * free and better than anything written here.
 *
 * **The keyboard is YouTube's once the iframe has focus.** A click inside the
 * player gives the iframe the keyboard, and Space and the arrows then go to
 * YouTube's own shortcuts; nothing in this app can see those events, and the
 * only way to take them back would be to steal focus from a player the learner
 * just clicked on. That is accepted rather than fought — the on-screen transport
 * is always there — and the reader says so beside the controls.
 *
 * Thin like `video.ts` and untested for the same reason: node has no iframe, and
 * everything about *following* a subtitle track is in `follow.ts`, which is
 * pure. `youtube-url.ts` holds the one piece of logic here worth a test.
 */

import type { Player } from './player';

/* -------------------------------------------------------------------------- */
/* The slice of the IFrame API this file uses                                  */
/* -------------------------------------------------------------------------- */

/*
  Hand-written rather than `@types/youtube`, which would be a dependency for six
  signatures. Only what is called below is declared; anything else is a compile
  error here rather than a silent `any`.
*/

interface YTPlayer {
	getCurrentTime(): number;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	playVideo(): void;
	pauseVideo(): void;
	destroy(): void;
}

interface YTPlayerOptions {
	host?: string;
	videoId: string;
	width?: string;
	height?: string;
	playerVars?: Record<string, number>;
	events?: {
		onReady?: () => void;
		onStateChange?: (event: { data: number }) => void;
		onError?: (event: { data: number }) => void;
	};
}

interface YTApi {
	Player: new (el: HTMLElement, options: YTPlayerOptions) => YTPlayer;
	PlayerState: { PLAYING: number };
}

declare global {
	interface Window {
		YT?: YTApi;
		onYouTubeIframeAPIReady?: () => void;
	}
}

/** How often the clock is read while the video is playing. */
const POLL_MS = 250;

/**
 * How long the API gets to arrive before the reader is told it will not.
 *
 * One timeout covers both failures worth distinguishing to nobody: a script that
 * 404s or is blocked (no `onerror` fires for some blockers, which is why a plain
 * `onerror` is not enough) and a script that loads but never calls back.
 */
const LOAD_TIMEOUT_MS = 10_000;

/** The one load, shared by every player on the page. Cleared on failure so a later open retries. */
let apiPromise: Promise<YTApi> | undefined;

/**
 * The IFrame API, loading it if this page has not already.
 *
 * `onYouTubeIframeAPIReady` is a *global* the script calls when it is done —
 * there is no other signal — so any existing one is kept and called through, on
 * the principle that a global this app did not set belongs to somebody.
 */
function loadApi(): Promise<YTApi> {
	if (apiPromise) return apiPromise;

	apiPromise = new Promise<YTApi>((resolve, reject) => {
		if (window.YT?.Player) {
			resolve(window.YT);
			return;
		}

		const timer = setTimeout(() => {
			apiPromise = undefined;
			reject(new Error('The YouTube player did not load.'));
		}, LOAD_TIMEOUT_MS);

		const previous = window.onYouTubeIframeAPIReady;
		window.onYouTubeIframeAPIReady = () => {
			previous?.();
			clearTimeout(timer);
			if (window.YT?.Player) resolve(window.YT);
			else {
				apiPromise = undefined;
				reject(new Error('The YouTube player did not load.'));
			}
		};

		const script = document.createElement('script');
		script.src = 'https://www.youtube.com/iframe_api';
		script.async = true;
		script.onerror = () => {
			clearTimeout(timer);
			apiPromise = undefined;
			reject(new Error('The YouTube player could not be reached.'));
		};
		document.head.appendChild(script);
	});

	return apiPromise;
}

/** What the caller needs beyond the {@link Player} itself. */
export interface YouTubeOptions {
	/**
	 * Called if the API never arrives — offline, blocked, or simply slow past
	 * {@link LOAD_TIMEOUT_MS}. The reader puts one line in the video's place; the
	 * text is still readable, which is the whole point of telling it.
	 */
	onFail?: (message: string) => void;
}

/**
 * Mounts a YouTube video inside `el` and wraps it as a {@link Player}.
 *
 * `el` is emptied and filled: the API *replaces* the element it is handed with
 * its iframe, so what it gets is a child created here rather than the caller's
 * node — a Svelte-owned element swapped out underneath Svelte is a bug waiting
 * for the next re-render.
 *
 * Everything asked of the player before the iframe exists is **queued, not
 * dropped**: a `play()` pressed during the load is a learner who wants this
 * playing, and a `seek()` is where they want it to start. Both are applied on
 * ready, in that order.
 */
export function youtubePlayer(
	el: HTMLElement,
	videoId: string,
	options: YouTubeOptions = {}
): Player {
	const listeners = new Set<(ms: number) => void>();

	let api: YTApi | undefined;
	let yt: YTPlayer | undefined;
	/**
	 * Not `yt !== undefined`: the object exists from the moment it is constructed
	 * but its methods are only wired up when the iframe answers, and calling one
	 * before `onReady` throws from inside the API. So this, and not the handle, is
	 * what every call below is gated on.
	 */
	let ready = false;
	let destroyed = false;
	/** Ticks only while playing; `undefined` is the honest state of a paused video. */
	let poll: ReturnType<typeof setInterval> | undefined;

	/** Where the learner asked to be before there was anything to ask. */
	let pendingMs = 0;
	let wantPlay = false;
	/**
	 * Whether the video is running, mirrored from the state the API *pushes*.
	 *
	 * `getPlayerState()` is the obvious alternative and is not used: it throws
	 * before ready for the same reason the rest does, and every change arrives
	 * through `onStateChange` anyway — a mirror of a push is not a cache that can
	 * go stale.
	 */
	let playing = false;

	const now = () => (ready && yt ? Math.round(yt.getCurrentTime() * 1000) : pendingMs);

	const announce = () => {
		const ms = now();
		for (const listener of listeners) listener(ms);
	};

	const stopPolling = () => {
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
	};

	const startPolling = () => {
		if (poll !== undefined) return;
		poll = setInterval(announce, POLL_MS);
	};

	const mount = document.createElement('div');
	el.replaceChildren(mount);

	void loadApi()
		.then((loaded) => {
			// The reader tore the view down while the script was in flight: build
			// nothing, because there is nothing left to build it in.
			if (destroyed) return;
			api = loaded;

			yt = new api.Player(mount, {
				host: 'https://www.youtube-nocookie.com',
				videoId,
				width: '100%',
				height: '100%',
				// `playsinline` so a phone plays it in the page instead of taking over
				// the screen — the text beside it is the point. `rel: 0` keeps the
				// end-card suggestions to this channel, which is as far as YouTube
				// lets anyone turn them off.
				playerVars: { playsinline: 1, rel: 0, controls: 1 },
				events: {
					onReady: () => {
						if (destroyed || !yt) return;
						ready = true;
						// The queue, drained in the order it was filled: where they asked
						// to be, and then whether they wanted it running.
						if (pendingMs > 0) yt.seekTo(pendingMs / 1000, true);
						if (wantPlay) yt.playVideo();
						announce();
					},
					onStateChange: (event) => {
						if (destroyed) return;
						playing = event.data === api?.PlayerState.PLAYING;
						// A state change is the only news this API volunteers: a seek, a
						// pause, the end of the video. Announce first, then let the poll
						// take over if something is actually running.
						if (playing) startPolling();
						else stopPolling();
						announce();
					}
				}
			});
		})
		.catch((cause: unknown) => {
			if (destroyed) return;
			options.onFail?.(cause instanceof Error ? cause.message : 'The YouTube player did not load.');
		});

	return {
		currentTime: now,
		seek(ms) {
			// Clamped at zero for the same reason `video.ts` clamps: "replay this
			// line" on a first cue at 0 must not hand a negative time to a player.
			const at = Math.max(0, ms);
			pendingMs = at;
			if (ready) yt?.seekTo(at / 1000, true);
			// The API reports the new position through a state change, but not
			// always and not immediately (a paused player seeking within a buffered
			// range is silent), so the seek says so itself.
			announce();
		},
		play() {
			wantPlay = true;
			if (ready) yt?.playVideo();
		},
		pause() {
			wantPlay = false;
			if (ready) yt?.pauseVideo();
		},
		// Before the iframe answers, whatever was last asked for: a learner who
		// pressed play during the load should see a Pause button, not a lie.
		paused: () => (ready ? !playing : !wantPlay),
		onTime(cb) {
			listeners.add(cb);
			// Immediately, as `videoPlayer` does — a subscriber never renders a frame
			// against a position it has not been told. Before ready that is 0.
			cb(now());
			return () => listeners.delete(cb);
		},
		destroy() {
			destroyed = true;
			ready = false;
			stopPolling();
			listeners.clear();
			// `destroy()` on a player whose iframe has already gone (a navigation
			// that took the container with it) throws from inside the API; there is
			// nothing to do about it and nothing to report.
			try {
				yt?.destroy();
			} catch {
				/* already gone */
			}
			yt = undefined;
		}
	};
}
