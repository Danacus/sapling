/**
 * Caching *policy* for synthesized clips — all of it pure, so every rule here
 * is unit-testable in node (Cache Storage does not exist there; the effectful
 * half lives in `audio-store.ts`, the `db/migrate.ts` split applied to speech).
 *
 * Two tiers, because Kokoro takes a second or two per phrase on the CPU:
 *
 * 1. {@link LruCache} — this tab, this session. Absorbs the replays a learner
 *    fires off while drilling one word.
 * 2. Cache Storage (`ll-tts-audio`) — survives a reload, keyed by
 *    {@link audioCacheUrl} and trimmed to {@link AUDIO_CACHE_MAX_BYTES} by
 *    {@link planEviction}.
 */

/** Insertion-ordered map with a hard cap; reading refreshes recency. */
export class LruCache<V> {
	private readonly max: number;
	private readonly entries = new Map<string, V>();

	constructor(max = 50) {
		this.max = Math.max(1, Math.floor(max));
	}

	get(key: string): V | undefined {
		const value = this.entries.get(key);
		if (value === undefined) return undefined;
		// Re-insert so this key becomes the newest again.
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: string, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, value);
		while (this.entries.size > this.max) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}

	/** Oldest first — the eviction order. */
	keys(): string[] {
		return [...this.entries.keys()];
	}
}

/** Cache key for one clip. The NUL separator cannot occur in either part. */
export function audioCacheKey(text: string, voice: string): string {
	return `${voice}\u0000${text}`;
}

// -- The persistent tier ----------------------------------------------------

/**
 * Ceiling for the on-disk clip cache.
 *
 * Kokoro is mono 16-bit PCM at 24 kHz — ~48 KB per second of speech — so a
 * lesson phrase costs roughly 100-200 KB and 100 MB buys well past 500 clips:
 * months of drilling for one learner, while staying a rounding error next to
 * the 439 MB of model files in the neighbouring bucket. Big enough that
 * eviction is rare, small enough that the cache can never quietly grow into
 * gigabytes on someone's laptop.
 */
export const AUDIO_CACHE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Origin for the synthetic Requests we key Cache Storage on. Never fetched —
 * Cache Storage only needs a URL to hash — but it has to be `https:` (the API
 * refuses to store anything else) and it must not collide with a real host we
 * might one day talk to.
 */
const AUDIO_CACHE_ORIGIN = 'https://tts-audio.local';

/**
 * Request URL standing in for one cached clip.
 *
 * Everything that changes the *sound* goes into the path — speaker and speed,
 * plus the text itself — so flipping a voice, or a future speed control, can
 * never serve audio rendered under the old setting: it simply misses and
 * re-synthesizes, while switching back is still an instant hit. `v1` is there
 * so a change to the WAV encoding can orphan the old entries rather than play
 * them. Phrases are single sentences, so percent-encoding stays comfortably
 * inside every URL length limit.
 */
export function audioCacheUrl(text: string, voice: string, speed = 1): string {
	// Fixed decimals: 1 and 1.0 must not hash to two different clips.
	const rate = Number.isFinite(speed) ? speed.toFixed(2) : '1.00';
	return `${AUDIO_CACHE_ORIGIN}/v1/${encodeURIComponent(voice)}/${rate}/${encodeURIComponent(text)}`;
}

/** One clip as the persistent cache knows it: its url plus its two headers. */
export interface StoredClip {
	/** The synthetic Request URL — see {@link audioCacheUrl}. */
	readonly url: string;
	/** `x-bytes`: the clip's own size. */
	readonly bytes: number;
	/** `x-used-at`: epoch ms of the last play, refreshed on every hit. */
	readonly usedAt: number;
}

/**
 * Decides which clips have to go for the cache to fit inside `cap`, least
 * recently used first. Pure: the caller (`audio-store.ts`) does nothing but
 * `delete()` what comes back, which is what makes the budget rule testable at
 * all — Cache Storage does not exist in the node test environment.
 *
 * `keepUrl` is the clip we just wrote. Evicting it would be absurd (we would
 * re-synthesize it on the very next tap), so it is skipped — *unless* it alone
 * blows the budget, in which case no arrangement fits and it goes last. Ties
 * on `usedAt` (two clips written in the same millisecond) break on the url, so
 * the plan is deterministic.
 */
export function planEviction(clips: StoredClip[], cap: number, keepUrl?: string): string[] {
	const size = (clip: StoredClip): number => (clip.bytes > 0 ? clip.bytes : 0);

	let total = clips.reduce((sum, clip) => sum + size(clip), 0);
	if (total <= cap) return [];

	const oldestFirst = [...clips].sort(
		(a, b) => a.usedAt - b.usedAt || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
	);

	const doomed: string[] = [];
	for (const clip of oldestFirst) {
		if (total <= cap) break;
		if (clip.url === keepUrl) continue;
		doomed.push(clip.url);
		total -= size(clip);
	}

	// Nothing else left to give: the protected clip outweighs the whole budget
	// on its own, so keeping it would break the cap permanently.
	if (total > cap && keepUrl !== undefined && clips.some((clip) => clip.url === keepUrl)) {
		doomed.push(keepUrl);
	}

	return doomed;
}

/**
 * Cache size for the Settings row. Decimal units, matching `formatMb` — what a
 * browser's own storage UI shows — and never more precise than the number
 * deserves: this is a "what is this costing me?" figure, not a measurement.
 */
export function formatCacheSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 kB';
	if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
	return `${Math.round(bytes / 1e6)} MB`;
}
