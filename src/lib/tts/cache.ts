/**
 * A tiny LRU used to keep synthesized clips around for the length of a
 * session. Kokoro takes a second or two per phrase on WASM, and a learner
 * replays the same word several times, so re-synthesizing is the one cost
 * worth avoiding. Deliberately in-memory only: the model files are already
 * cached by the browser, and cached *audio* is cheap to rebuild.
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
