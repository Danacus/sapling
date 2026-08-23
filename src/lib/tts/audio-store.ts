/**
 * The persistent half of the clip cache: everything that actually touches
 * Cache Storage. The rules it enforces (keys, budget, eviction order) live in
 * `cache.ts` as pure functions — this file only opens the bucket, reads and
 * writes Responses, and applies the plan it is handed.
 *
 * **Every export here fails soft.** Cache Storage is unavailable in private
 * windows in some browsers, throws under a full disk or a tight quota, and is
 * simply absent in the node test environment. A cache that cannot be reached
 * has to degrade to plain synthesis, never to broken audio, so each entry
 * point swallows its own failures: a read returns `undefined`, a write does
 * nothing, a size query reports 0. `speak()` stays fire-and-forget safe.
 *
 * Clips are stored exactly as the play path consumes them — the WAV blob
 * `sherpa.ts` builds — so a hit needs no decoding step of its own.
 */

import { AUDIO_CACHE_MAX_BYTES, planEviction, type StoredClip } from './cache';
import { AUDIO_CACHE_NAME } from './models';

/** Clip size in bytes, so the budget can be summed without reading bodies. */
const BYTES_HEADER = 'x-bytes';
/** Epoch ms of the last play — the recency the eviction planner sorts on. */
const USED_AT_HEADER = 'x-used-at';

/** MIME type of what we store; `wav.ts` produces nothing else. */
const CLIP_TYPE = 'audio/wav';

/** The bucket, or `undefined` wherever Cache Storage is not usable. */
async function openAudioCache(): Promise<Cache | undefined> {
	try {
		if (typeof caches === 'undefined') return undefined;
		return await caches.open(AUDIO_CACHE_NAME);
	} catch (cause) {
		console.warn('[tts] Audio cache unavailable; clips will not persist.', cause);
		return undefined;
	}
}

/** Wraps a clip with the metadata the budget sweep needs. */
function clipResponse(blob: Blob, usedAt: number): Response {
	return new Response(blob, {
		headers: {
			'Content-Type': CLIP_TYPE,
			[BYTES_HEADER]: String(blob.size),
			[USED_AT_HEADER]: String(usedAt)
		}
	});
}

function headerNumber(response: Response, header: string): number {
	const parsed = Number(response.headers.get(header));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Every stored clip with its metadata. One `match` per key, but the bodies are
 * never touched, so this walks headers only — and it runs after a write or on
 * the Settings screen, never on the hot path.
 */
async function listClips(cache: Cache): Promise<StoredClip[]> {
	const requests = await cache.keys();
	const clips: StoredClip[] = [];
	for (const request of requests) {
		const response = await cache.match(request);
		// A key whose response vanished (evicted by the browser mid-walk) has no
		// size to account for; leaving it out means the next write may re-add it.
		if (!response) continue;
		clips.push({
			url: request.url,
			bytes: headerNumber(response, BYTES_HEADER),
			usedAt: headerNumber(response, USED_AT_HEADER)
		});
	}
	return clips;
}

/**
 * Looks up one clip, refreshing its recency on a hit.
 *
 * The refresh is a full re-`put` — Cache Storage has no way to edit a header
 * in place — which sounds expensive until you notice the in-memory LRU sits in
 * front of this: a replayed word never gets here twice, so a clip is read from
 * disk roughly once per session. It is also deliberately not awaited; a slow
 * write must not delay playback of audio we already hold.
 */
export async function readClip(url: string): Promise<Blob | undefined> {
	try {
		const cache = await openAudioCache();
		if (!cache) return undefined;

		const hit = await cache.match(url);
		if (!hit) return undefined;

		const blob = await hit.blob();
		void cache.put(url, clipResponse(blob, Date.now())).catch(() => {
			/* recency is a nicety; a failed refresh just ages the clip faster */
		});
		return blob;
	} catch (cause) {
		console.warn('[tts] Could not read the cached clip.', cause);
		return undefined;
	}
}

/**
 * Stores one freshly synthesized clip and trims the cache back under budget.
 *
 * Awaiting the sweep here (rather than after playback) keeps the invariant
 * simple: once this resolves, the cache fits. Callers do not await it at all.
 */
export async function writeClip(url: string, blob: Blob): Promise<void> {
	try {
		const cache = await openAudioCache();
		if (!cache) return;

		await cache.put(url, clipResponse(blob, Date.now()));

		const doomed = planEviction(await listClips(cache), AUDIO_CACHE_MAX_BYTES, url);
		for (const victim of doomed) await cache.delete(victim);
	} catch (cause) {
		// A quota error is the expected failure here: the clip is already in the
		// memory LRU, so the session is unaffected — only persistence is lost.
		console.warn('[tts] Could not cache the clip.', cause);
	}
}

/** Total bytes held, for the Settings row. 0 whenever the cache is unreadable. */
export async function audioCacheBytes(): Promise<number> {
	try {
		const cache = await openAudioCache();
		if (!cache) return 0;
		return (await listClips(cache)).reduce((total, clip) => total + clip.bytes, 0);
	} catch (cause) {
		console.warn('[tts] Could not measure the audio cache.', cause);
		return 0;
	}
}

/**
 * Drops every stored clip. The model files live in a different bucket and are
 * untouched — clearing clips must never cost a 439 MB re-download.
 */
export async function clearAudioCache(): Promise<void> {
	try {
		if (typeof caches === 'undefined') return;
		await caches.delete(AUDIO_CACHE_NAME);
	} catch (cause) {
		console.warn('[tts] Could not clear the audio cache.', cause);
	}
}
