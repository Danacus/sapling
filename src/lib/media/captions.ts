/**
 * A video's caption tracks, fetched by the desktop host.
 *
 * This closes the one thing reading mode could never do from a page. A YouTube
 * text has always had to start with a subtitle file the learner obtained
 * themselves, because the caption tracks are simply not readable from a
 * browser: the timedtext endpoints send no CORS headers, the IFrame API exposes
 * no track list, and this app has no server by design. A *host* that can run a
 * program has none of those problems, so the desktop shell lends yt-dlp the way
 * it lends the voice and the recognizer — `docs/desktop.md`, and
 * `crates/sapling-desktop/src/captions.rs` is the other end.
 *
 * **What comes back is a file, not a parse.** {@link fetchCaptions} answers raw
 * `json3` text and nothing more, and the caller hands it to
 * `$lib/reading`'s `detectSubtitleFormat`/`parseSubtitles` — the same door an
 * uploaded `.srt` goes through. That is deliberate: there is one subtitle parser
 * in this repo, it is pure and tested, and the host has no business growing a
 * second one.
 *
 * **This is the second place in `$lib/media` that asks `inTauri()`** (the first
 * is `youtube-host.ts`, which picks the player), and it asks for the same
 * reason: the capability is the host's, and the seam is the area's rather than
 * the page's. `@tauri-apps/api` is imported **dynamically** and only when the
 * answer is yes, exactly as `tts/native.ts` does it, so a browser fetches
 * neither the module nor the SDK — and in a browser every function here reports
 * unavailable rather than throwing something a page would have to catch.
 *
 * Stateless like the rest of the area: **nothing here imports `$lib/db`**. The
 * one piece of module state is the memoised probe, which is a fact about the
 * machine and not about the learner.
 */

import { inTauri } from '$lib/platform';
import { isVideoId } from './youtube-url';

/** One caption track a video carries. Mirrors the Rust `CaptionTrack`. */
export interface CaptionTrack {
	/** The language code yt-dlp names it by, and takes back to fetch it. */
	lang: string;
	/** What to call it on screen — yt-dlp's name, or the code where it has none. */
	name: string;
	/**
	 * Machine-generated rather than written by a person. Worth a mark in the
	 * list: an automatic track is usually unpunctuated, which is exactly what
	 * makes `cuesToSentences` fall back to one sentence per cue.
	 */
	auto: boolean;
}

/** What a video turned out to have. Mirrors the Rust `CaptionsListing`. */
export interface CaptionsListing {
	id: string;
	title: string;
	/** Manual tracks first, then the automatic ones. */
	tracks: CaptionTrack[];
}

/**
 * Which of the two programs the host has, and at what version.
 *
 * Absent means "not on that machine's PATH". `ytdlp` is the one that decides
 * whether captions can be fetched at all; `deno` is reported because yt-dlp has
 * needed an external JavaScript runtime for full YouTube extraction since late
 * 2025 and warns without one — captions usually still come back, so it is worth
 * naming rather than blocking on.
 */
export interface CaptionsTools {
	ytdlp?: string;
	deno?: string;
}

/** The watch URL a bare id is normalised to before the host is handed it. */
const WATCH = 'https://www.youtube.com/watch?v=';

/** The one `@tauri-apps/api` entry point this module needs, loaded once. */
let api: Promise<{ invoke: typeof import('@tauri-apps/api/core').invoke }> | undefined;

function tauri(): NonNullable<typeof api> {
	api ??= import('@tauri-apps/api/core').then((core) => ({ invoke: core.invoke }));
	return api;
}

/** The probe, memoised: it starts two processes and its answer cannot change. */
let tools: Promise<CaptionsTools | undefined> | undefined;

/**
 * What this host can do about captions, or `undefined` when there is no host to
 * ask.
 *
 * The two answers are kept apart on purpose, because they mean opposite things
 * to a page: `undefined` is "this is a browser, or a shell without the
 * commands" and nothing about captions should render at all, while an object
 * with no `ytdlp` is "this *is* the desktop app and the program is missing",
 * which is worth one line naming it. Same shape `tts.ts`'s host probe has.
 *
 * Memoised and safe to call from an effect: it never rejects.
 */
export function captionsAvailable(): Promise<CaptionsTools | undefined> {
	tools ??= probe();
	return tools;
}

async function probe(): Promise<CaptionsTools | undefined> {
	if (!inTauri()) return undefined;
	try {
		// Awaited on its own statement, then called on the next: a `.then` chained
		// onto a dynamic `import()` is inside Vite's preload helper, so a
		// rejection from the call would be reported as a chunk that failed to load
		// and the layout's heal-by-reload would fire for it.
		const { invoke } = await tauri();
		return await invoke<CaptionsTools>('captions_status');
	} catch (cause) {
		// A host built without the command is a host with no captions to fetch —
		// the browser's answer, reached a different way.
		console.warn('[captions] The host could not say whether yt-dlp is here.', cause);
		return undefined;
	}
}

/**
 * Every caption track a video has, manual ones first.
 *
 * Takes an **id**, not a link: the URL is rebuilt here so the host is only ever
 * handed a normalised watch address, and `isVideoId` is the same rule
 * `videoIdFrom` applies — never a second one.
 *
 * Slow (seconds): yt-dlp fetches the watch page and runs the player's
 * JavaScript. Rejects with a message written for the learner.
 */
export async function listCaptions(videoId: string): Promise<CaptionsListing> {
	const invoke = await hostInvoke(videoId);
	return call<CaptionsListing>(invoke, 'captions_list', { url: WATCH + videoId });
}

/**
 * One track of one video, as raw `json3` text for `$lib/reading` to parse.
 *
 * Slower than the listing — a second fetch — and the reason this is wrapped in
 * the `captions` task rather than awaited by a page.
 */
export async function fetchCaptions(videoId: string, track: CaptionTrack): Promise<string> {
	const invoke = await hostInvoke(videoId);
	return call<string>(invoke, 'captions_fetch', {
		url: WATCH + videoId,
		lang: track.lang,
		auto: track.auto
	});
}

/**
 * `invoke`, once it is established that there is a host to invoke on and an id
 * worth sending.
 *
 * Both refusals are `Error`s rather than a quiet `undefined`, because unlike
 * the probe these two are only ever reached from a control the learner pressed
 * — and a button that does nothing is the failure. Neither is reachable through
 * the UI: the action renders only when the probe found yt-dlp, and the id comes
 * from `videoIdFrom`.
 */
async function hostInvoke(videoId: string): Promise<Awaited<ReturnType<typeof tauri>>['invoke']> {
	if (!isVideoId(videoId)) throw new Error('That is not a YouTube video id.');
	if ((await captionsAvailable())?.ytdlp === undefined) {
		throw new Error('Fetching captions needs the desktop app with yt-dlp installed.');
	}
	const { invoke } = await tauri();
	return invoke;
}

/**
 * One command, with the host's `Err(String)` turned back into an `Error`.
 *
 * Tauri rejects with the bare string a command returned, and every layer above
 * this — the task runner, the tray, the composer — reads `error.message`. The
 * host already writes those strings for a human (it carries yt-dlp's own last
 * lines), so there is nothing to rephrase, only to wrap.
 */
async function call<T>(
	invoke: Awaited<ReturnType<typeof tauri>>['invoke'],
	command: string,
	args: Record<string, unknown>
): Promise<T> {
	try {
		return await invoke<T>(command, args);
	} catch (cause) {
		if (cause instanceof Error) throw cause;
		throw new Error(typeof cause === 'string' ? cause : `${command} failed.`);
	}
}
