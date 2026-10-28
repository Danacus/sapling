import { describe, expect, it } from 'vitest';

import { captionsAvailable, fetchCaptions, listCaptions } from './captions';

describe('captions', () => {
	it('is unavailable where there is no DOM to relay from', () => {
		expect(captionsAvailable()).toBe(false);
	});

	it('refuses anything that is not a video id before asking anyone', async () => {
		await expect(listCaptions('https://evil.example')).rejects.toThrow('not a YouTube video id');
		await expect(fetchCaptions('x', { lang: 'nl', name: 'Dutch', auto: false })).rejects.toThrow(
			'not a YouTube video id'
		);
	});
});
