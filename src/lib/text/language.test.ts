/** Which tag a profile means: the stored one, else its legacy name once more. */
import { describe, expect, it } from 'vitest';

import { legacyLanguageTag, nativeTagOf, primarySubtag, targetTagOf } from './language';

describe('legacyLanguageTag', () => {
	it('maps every language the old onboarding datalist offered', () => {
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
			expect(legacyLanguageTag(name), name).toBe(tag);
		}
	});

	it('ignores case, accents and surrounding whitespace', () => {
		expect(legacyLanguageTag('  SPANISH ')).toBe('es');
		expect(legacyLanguageTag('Español')).toBe('es');
		expect(legacyLanguageTag('espanol')).toBe('es');
	});

	it('reads CLDR names and endonyms, regional ones included', () => {
		expect(legacyLanguageTag('Vlaams')).toBe('nl-BE');
		expect(legacyLanguageTag('Flemish')).toBe('nl-BE');
		expect(legacyLanguageTag('Nederlands')).toBe('nl');
		expect(legacyLanguageTag('Brazilian Portuguese')).toBe('pt-BR');
		expect(legacyLanguageTag('British English')).toBe('en-GB');
		expect(legacyLanguageTag('Swiss High German')).toBe('de-CH');
		expect(legacyLanguageTag('日本語')).toBe('ja');
	});

	it('prefers the longest legacy name, so "Mandarin Chinese" beats "Chinese"', () => {
		expect(legacyLanguageTag('Mandarin Chinese (Simplified)')).toBe('zh-CN');
		expect(legacyLanguageTag('Chinese')).toBe('zh-CN');
		expect(legacyLanguageTag('Traditional Chinese')).toBe('zh-TW');
	});

	it('accepts a tag typed directly, canonicalized', () => {
		expect(legacyLanguageTag('nl')).toBe('nl');
		expect(legacyLanguageTag('pt-br')).toBe('pt-BR');
		expect(legacyLanguageTag('EN-GB')).toBe('en-GB');
	});

	it('resolves nonsense to no tag, never to English', () => {
		expect(legacyLanguageTag('Klingon')).toBeUndefined();
		expect(legacyLanguageTag('')).toBeUndefined();
		expect(legacyLanguageTag(undefined)).toBeUndefined();
	});
});

describe('targetTagOf / nativeTagOf', () => {
	it('prefers the stored tag over the name', () => {
		expect(targetTagOf({ targetLanguage: 'Dutch', targetLanguageTag: 'nl-BE' })).toBe('nl-BE');
		expect(nativeTagOf({ nativeLanguage: 'English', nativeLanguageTag: 'en-GB' })).toBe('en-GB');
	});

	it('falls back to the name when no tag is stored', () => {
		expect(targetTagOf({ targetLanguage: 'Vlaams' })).toBe('nl-BE');
		expect(nativeTagOf({ nativeLanguage: 'English' })).toBe('en');
	});

	it('is undefined for an unresolvable name or no profile', () => {
		expect(targetTagOf({ targetLanguage: 'Klingon' })).toBeUndefined();
		expect(targetTagOf(undefined)).toBeUndefined();
	});
});

describe('primarySubtag', () => {
	it('lowercases the language subtag and passes no tag through', () => {
		expect(primarySubtag('zh-Hant-TW')).toBe('zh');
		expect(primarySubtag('YUE')).toBe('yue');
		expect(primarySubtag(undefined)).toBeUndefined();
	});
});
