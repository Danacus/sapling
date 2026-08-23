import { describe, expect, it } from 'vitest';

import {
	audioCacheKey,
	audioCacheUrl,
	formatCacheSize,
	LruCache,
	planEviction,
	type StoredClip
} from './cache';

describe('LruCache', () => {
	it('returns what was put in, and undefined for misses', () => {
		const cache = new LruCache<string>(3);
		cache.set('a', 'A');
		expect(cache.get('a')).toBe('A');
		expect(cache.get('nope')).toBeUndefined();
	});

	it('evicts the oldest entry once the cap is exceeded', () => {
		const cache = new LruCache<number>(2);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);

		expect(cache.size).toBe(2);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.keys()).toEqual(['b', 'c']);
	});

	it('counts a read as use, so a replayed clip survives eviction', () => {
		const cache = new LruCache<number>(2);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.get('a'); // 'a' is now the newest
		cache.set('c', 3);

		expect(cache.get('a')).toBe(1);
		expect(cache.get('b')).toBeUndefined();
	});

	it('overwriting a key refreshes it instead of duplicating it', () => {
		const cache = new LruCache<number>(2);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('a', 9);

		expect(cache.size).toBe(2);
		expect(cache.get('a')).toBe(9);
		expect(cache.keys()).toEqual(['b', 'a']);
	});

	it('clears everything', () => {
		const cache = new LruCache<number>(5);
		cache.set('a', 1);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.has('a')).toBe(false);
	});

	it('never accepts a cap below one', () => {
		const cache = new LruCache<number>(0);
		cache.set('a', 1);
		cache.set('b', 2);
		expect(cache.keys()).toEqual(['b']);
	});
});

describe('audioCacheKey', () => {
	it('separates voice from text so different voices never collide', () => {
		expect(audioCacheKey('hello', 'af_heart')).not.toBe(audioCacheKey('hello', 'bf_emma'));
	});

	it('is stable for the same pair', () => {
		expect(audioCacheKey('hello', 'af_heart')).toBe(audioCacheKey('hello', 'af_heart'));
	});
});

describe('audioCacheUrl', () => {
	it('is a stable https url for the same phrase, voice and speed', () => {
		expect(audioCacheUrl('你好', 'zf_001')).toBe(audioCacheUrl('你好', 'zf_001', 1));
		expect(audioCacheUrl('你好', 'zf_001').startsWith('https://')).toBe(true);
	});

	it('scopes clips by voice and by speed', () => {
		expect(audioCacheUrl('hello', 'af_maple')).not.toBe(audioCacheUrl('hello', 'bf_vale'));
		expect(audioCacheUrl('hello', 'af_maple', 1)).not.toBe(audioCacheUrl('hello', 'af_maple', 1.2));
	});

	it('treats 1 and 1.0 as the same speed', () => {
		expect(audioCacheUrl('hello', 'af_maple', 1.0)).toBe(audioCacheUrl('hello', 'af_maple', 1));
	});

	it('round-trips the text, including scripts and characters a url would eat', () => {
		const text = '早上好! 你 好吗? #1 / 100%';
		const encoded = audioCacheUrl(text, 'zf_001').split('/').pop() as string;
		expect(decodeURIComponent(encoded)).toBe(text);
	});

	it('keeps phrases that differ only in whitespace apart', () => {
		expect(audioCacheUrl('a b', 'zf_001')).not.toBe(audioCacheUrl('a  b', 'zf_001'));
	});
});

describe('planEviction', () => {
	const clip = (url: string, bytes: number, usedAt: number): StoredClip => ({
		url,
		bytes,
		usedAt
	});

	it('deletes nothing while the cache fits', () => {
		expect(planEviction([clip('a', 40, 1), clip('b', 50, 2)], 100)).toEqual([]);
		expect(planEviction([], 100)).toEqual([]);
	});

	it('deletes nothing when the total lands exactly on the cap', () => {
		expect(planEviction([clip('a', 60, 1), clip('b', 40, 2)], 100)).toEqual([]);
	});

	it('drops least-recently-used clips until the total fits', () => {
		const clips = [clip('old', 40, 100), clip('newer', 40, 300), clip('mid', 40, 200)];
		// 120 bytes against an 80-byte cap: only the oldest has to go.
		expect(planEviction(clips, 80)).toEqual(['old']);
	});

	it('keeps dropping while still over the cap', () => {
		const clips = [clip('old', 40, 100), clip('newer', 40, 300), clip('mid', 40, 200)];
		expect(planEviction(clips, 40)).toEqual(['old', 'mid']);
	});

	it('breaks ties on the url so the plan is deterministic', () => {
		const clips = [clip('b', 50, 7), clip('a', 50, 7), clip('c', 50, 9)];
		expect(planEviction(clips, 100)).toEqual(['a']);
	});

	it('never evicts the clip just written, even when it is the oldest', () => {
		// Same millisecond, and 'fresh' sorts first — the keep flag is what saves it.
		const clips = [clip('fresh', 60, 5), clip('other', 60, 5)];
		expect(planEviction(clips, 100, 'fresh')).toEqual(['other']);
	});

	it('evicts the clip just written only when it alone blows the budget', () => {
		const clips = [clip('huge', 200, 9), clip('small', 10, 1)];
		expect(planEviction(clips, 100, 'huge')).toEqual(['small', 'huge']);
	});

	it('empties the cache when the cap is zero', () => {
		const clips = [clip('a', 10, 1), clip('b', 10, 2)];
		expect(planEviction(clips, 0, 'b')).toEqual(['a', 'b']);
	});

	it('treats a clip with no recorded size as free but still evictable', () => {
		const clips = [clip('meta-less', 0, 0), clip('real', 200, 5)];
		expect(planEviction(clips, 100, 'real')).toEqual(['meta-less', 'real']);
	});

	it('does not mutate the clips it was handed', () => {
		const clips = [clip('b', 80, 2), clip('a', 80, 1)];
		planEviction(clips, 100);
		expect(clips.map((entry) => entry.url)).toEqual(['b', 'a']);
	});
});

describe('formatCacheSize', () => {
	it('reports an empty cache as zero rather than a stray unit', () => {
		expect(formatCacheSize(0)).toBe('0 kB');
		expect(formatCacheSize(-1)).toBe('0 kB');
		expect(formatCacheSize(Number.NaN)).toBe('0 kB');
	});

	it('never rounds a non-empty cache down to nothing', () => {
		expect(formatCacheSize(120)).toBe('1 kB');
	});

	it('uses decimal kB below a megabyte', () => {
		expect(formatCacheSize(150_000)).toBe('150 kB');
	});

	it('switches to MB above a megabyte', () => {
		expect(formatCacheSize(37_400_000)).toBe('37 MB');
		expect(formatCacheSize(100 * 1024 * 1024)).toBe('105 MB');
	});
});
