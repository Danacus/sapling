import { describe, expect, it } from 'vitest';

import { audioCacheKey, LruCache } from './cache';

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
