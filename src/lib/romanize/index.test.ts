import { describe, expect, it } from 'vitest';

import { hasLocalRomanizer, loadRomanizer, romanizerFor, writtenWithReadings } from './index';

describe('hasLocalRomanizer', () => {
	it('accepts every zh tag', () => {
		for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans', 'zh-Hant-TW']) {
			expect(hasLocalRomanizer(language), language).toBe(true);
		}
	});

	it('rejects languages with no local implementation', () => {
		for (const language of ['ja', 'nl', 'ko', 'ru']) {
			expect(hasLocalRomanizer(language), language).toBe(false);
		}
	});

	it('rejects Cantonese — jyutping is not pinyin', () => {
		expect(hasLocalRomanizer('yue')).toBe(false);
		expect(hasLocalRomanizer('yue-HK')).toBe(false);
	});

	it('rejects a missing tag rather than guessing', () => {
		expect(hasLocalRomanizer(undefined)).toBe(false);
		expect(hasLocalRomanizer('')).toBe(false);
	});
});

describe('writtenWithReadings', () => {
	it('is the languages written in a script other than Latin', () => {
		for (const language of ['zh-CN', 'ja', 'ko', 'ru', 'yue', 'ar', 'sr-Cyrl']) {
			expect(writtenWithReadings(language), language).toBe(true);
		}
		for (const language of ['es', 'nl-BE', 'vi', 'tl', undefined]) {
			expect(writtenWithReadings(language), String(language)).toBe(false);
		}
	});
});

describe('loadRomanizer / romanizerFor', () => {
	it('resolves null for a language with no implementation, both ways', async () => {
		expect(await loadRomanizer('nl')).toBeNull();
		expect(romanizerFor('nl')).toBeNull();
	});

	it('hands the synchronous accessor the same instance once loaded', async () => {
		const loaded = await loadRomanizer('zh-CN');
		expect(loaded).not.toBeNull();
		expect(romanizerFor('zh-CN')).toBe(loaded);
	});

	it('caches across every tag that shares a primary subtag', async () => {
		const cn = await loadRomanizer('zh-CN');
		expect(await loadRomanizer('zh-TW')).toBe(cn);
		expect(romanizerFor('zh')).toBe(cn);
	});

	it('returns a working romanizer', async () => {
		const romanizer = await loadRomanizer('zh');
		expect(romanizer?.tokenize('银行', ['银行'])).toEqual([{ text: '银行', reading: 'yín háng' }]);
	});
});
