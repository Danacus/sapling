import { describe, expect, it } from 'vitest';

import { hasLocalRomanizer, loadRomanizer, romanizerFor } from './index';

describe('hasLocalRomanizer', () => {
	it('accepts every spelling of Mandarin that resolves to a zh tag', () => {
		for (const language of [
			'Mandarin Chinese',
			'chinese',
			'Mandarin',
			'zh',
			'zh-CN',
			'zh-TW',
			'zh-Hans',
			'Simplified Chinese',
			'Traditional Chinese'
		]) {
			expect(hasLocalRomanizer(language), language).toBe(true);
		}
	});

	it('rejects languages with no local implementation', () => {
		for (const language of ['Japanese', 'Dutch', 'Korean', 'Russian', 'ja', 'nl']) {
			expect(hasLocalRomanizer(language), language).toBe(false);
		}
	});

	it('rejects Cantonese — jyutping is not pinyin', () => {
		expect(hasLocalRomanizer('Cantonese')).toBe(false);
		expect(hasLocalRomanizer('yue')).toBe(false);
	});

	it('rejects unknown and missing languages rather than guessing', () => {
		// bcp47For falls back to 'en', so anything unrecognised lands outside the
		// registry by construction.
		expect(hasLocalRomanizer('Klingon')).toBe(false);
		expect(hasLocalRomanizer(undefined)).toBe(false);
		expect(hasLocalRomanizer('')).toBe(false);
	});
});

describe('loadRomanizer / romanizerFor', () => {
	it('resolves null for a language with no implementation, both ways', async () => {
		expect(await loadRomanizer('Dutch')).toBeNull();
		expect(romanizerFor('Dutch')).toBeNull();
	});

	it('hands the synchronous accessor the same instance once loaded', async () => {
		const loaded = await loadRomanizer('Mandarin Chinese');
		expect(loaded).not.toBeNull();
		expect(romanizerFor('Mandarin Chinese')).toBe(loaded);
	});

	it('caches across every spelling that shares a primary subtag', async () => {
		const cn = await loadRomanizer('zh-CN');
		expect(await loadRomanizer('zh-TW')).toBe(cn);
		expect(romanizerFor('chinese')).toBe(cn);
	});

	it('returns a working romanizer', async () => {
		const romanizer = await loadRomanizer('zh');
		expect(romanizer?.tokenize('银行', ['银行'])).toEqual([{ text: '银行', reading: 'yín háng' }]);
	});
});
