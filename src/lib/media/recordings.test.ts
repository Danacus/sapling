import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	fileMedia,
	fileOf,
	playing,
	prefersFile,
	recordingsOf,
	setPrefersFile,
	youtubeOf
} from './recordings';

const file = { kind: 'file', name: 'ep1.mp4', type: 'video/mp4' } as const;
const youtube = { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } as const;

describe('a text’s recordings', () => {
	it('finds each kind in the list, or nothing', () => {
		expect(youtubeOf([file, youtube])).toBe('dQw4w9WgXcQ');
		expect(fileOf([file, youtube])).toEqual(file);
		expect(youtubeOf([file])).toBeUndefined();
		expect(fileOf(undefined)).toBeUndefined();
	});

	it('stores a picked file by name, and its type only when the browser gave one', () => {
		expect(fileMedia({ name: 'a.mp4', type: 'video/mp4' })).toEqual({
			kind: 'file',
			name: 'a.mp4',
			type: 'video/mp4'
		});
		expect(fileMedia({ name: 'a.mkv', type: '' })).toEqual({ kind: 'file', name: 'a.mkv' });
	});

	it('builds the list YouTube first, leaving out what is absent', () => {
		expect(recordingsOf(youtube.videoId, file)).toEqual([youtube, file]);
		expect(recordingsOf(undefined, file)).toEqual([file]);
		expect(recordingsOf(undefined, undefined)).toEqual([]);
	});

	it('plays YouTube by default and the file when asked or when it is the only one', () => {
		expect(playing([file, youtube], false)).toBe('youtube');
		expect(playing([file, youtube], true)).toBe('file');
		expect(playing([file], false)).toBe('file');
		expect(playing([youtube], true)).toBe('youtube');
		expect(playing([], true)).toBeUndefined();
	});
});

describe('the play-from-file switch', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is remembered per text', () => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key)
		});
		setPrefersFile('t1', true);
		expect(prefersFile('t1')).toBe(true);
		expect(prefersFile('t2')).toBe(false);
		setPrefersFile('t1', false);
		expect(prefersFile('t1')).toBe(false);
	});

	it('reads as off where storage throws', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		});
		expect(() => setPrefersFile('t1', true)).not.toThrow();
		expect(prefersFile('t1')).toBe(false);
	});
});
