/**
 * A YouTube video's caption tracks: the list, and one track as raw `json3`.
 *
 * One implementation, Rust's (`crates/sapling-captions`, InnerTube as the
 * ANDROID client), lent a transport per host. YouTube's `player` endpoint
 * refuses any `Origin` but none, its own or `null`, so a browser sends the
 * requests through a sandboxed frame (`youtube-relay.ts`) and a Tauri window —
 * whose origin it refuses — asks the host, which makes them natively.
 *
 * **What comes back is a file, not a parse**: the caller hands the `json3` to
 * the core's `importSource`, the door an uploaded `.srt` goes through.
 * `@tauri-apps/api` is imported dynamically and only in Tauri.
 */

import type { CaptionsListing, CaptionTrack } from '$lib/db/generated/index';
import type { Captions } from '$lib/db/generated/captions';
import { captions } from '$lib/db/wasm/sapling_core';
import { loadWindowCore } from '$lib/db/window-core';
import { inTauri } from '$lib/platform';
import { relayRequest } from './youtube-relay';
import { isVideoId } from './youtube-url';

export type { CaptionsListing, CaptionTrack };

/** Whether this host can fetch captions: anywhere with a DOM to relay from. */
export function captionsAvailable(): boolean {
	return typeof document !== 'undefined';
}

/** Every caption track a video has, manual ones first. Rejects for the learner. */
export function listCaptions(videoId: string): Promise<CaptionsListing> {
	return call('listCaptions', { videoId }, 'captions_list');
}

/** One track of one video, as raw `json3` text for `importSource`. */
export function fetchCaptions(videoId: string, track: CaptionTrack): Promise<string> {
	const { lang, name, auto } = track;
	return call('fetchCaptions', { videoId, track: { lang, name, auto } }, 'captions_fetch');
}

async function call<M extends keyof Captions>(
	method: M,
	args: Parameters<Captions[M]>[0],
	command: string
): Promise<Awaited<ReturnType<Captions[M]>>> {
	if (!isVideoId(args.videoId)) throw new Error('That is not a YouTube video id.');
	try {
		if (inTauri()) {
			// Awaited on its own statement: a `.then` on a dynamic `import()` runs
			// inside Vite's preload helper, which would report a rejection from the
			// call as a chunk that failed to load.
			const { invoke } = await import('@tauri-apps/api/core');
			return await invoke<Awaited<ReturnType<Captions[M]>>>(command, args);
		}
		await loadWindowCore();
		const answer = await captions(method, JSON.stringify([args]), relayRequest);
		return JSON.parse(answer) as Awaited<ReturnType<Captions[M]>>;
	} catch (cause) {
		// Tauri and wasm both reject with the bare string Rust wrote for a human.
		if (cause instanceof Error) throw cause;
		throw new Error(typeof cause === 'string' ? cause : `${method} failed.`);
	}
}
