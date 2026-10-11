/** The free-text → BCP-47 guess every language-aware area routes through. */
import { describe, expect, it } from 'vitest';

import { bcp47For, DEFAULT_LANGUAGE_TAG } from './language';

describe('bcp47For', () => {
	it('maps every language offered during onboarding', () => {
		const expected: Record<string, string> = {
			English: 'en',
			Spanish: 'es',
			French: 'fr',
			German: 'de',
			Italian: 'it',
			Portuguese: 'pt',
			Dutch: 'nl',
			Swedish: 'sv',
			Norwegian: 'nb',
			Danish: 'da',
			Polish: 'pl',
			Czech: 'cs',
			Greek: 'el',
			Turkish: 'tr',
			Russian: 'ru',
			Ukrainian: 'uk',
			Arabic: 'ar',
			Hebrew: 'he',
			Hindi: 'hi',
			'Mandarin Chinese': 'zh-CN',
			Cantonese: 'yue',
			Japanese: 'ja',
			Korean: 'ko',
			Vietnamese: 'vi',
			Indonesian: 'id'
		};

		for (const [name, tag] of Object.entries(expected)) {
			expect(bcp47For(name), name).toBe(tag);
		}
	});

	it('ignores case and surrounding whitespace', () => {
		expect(bcp47For('  SPANISH ')).toBe('es');
		expect(bcp47For('japanese')).toBe('ja');
	});

	it('prefers the longest matching name, so "Mandarin Chinese" beats "Chinese"', () => {
		expect(bcp47For('Mandarin Chinese (Simplified)')).toBe('zh-CN');
		expect(bcp47For('Chinese')).toBe('zh-CN');
		expect(bcp47For('Traditional Chinese')).toBe('zh-TW');
	});

	it('accepts a language tag typed directly, canonicalizing the region', () => {
		expect(bcp47For('nl')).toBe('nl');
		expect(bcp47For('pt-br')).toBe('pt-BR');
		expect(bcp47For('EN-GB')).toBe('en-GB');
	});

	it('handles endonyms and regional variants', () => {
		expect(bcp47For('Español')).toBe('es');
		expect(bcp47For('Brazilian Portuguese')).toBe('pt-BR');
		expect(bcp47For('British English')).toBe('en-GB');
	});

	it('falls back to the default tag rather than throwing on nonsense', () => {
		expect(bcp47For('Klingon')).toBe(DEFAULT_LANGUAGE_TAG);
		expect(bcp47For('')).toBe(DEFAULT_LANGUAGE_TAG);
		expect(bcp47For(undefined)).toBe(DEFAULT_LANGUAGE_TAG);
	});
});
