/** The picker's options from CLDR, and its fuzzy search over them. */
import { describe, expect, it } from 'vitest';

import { LANGUAGE_CODES } from './language-codes';
import {
	canonicalTag,
	flagOf,
	languageOption,
	languageOptions,
	scoreLanguage,
	searchLanguages
} from './language-options';

describe('canonicalTag', () => {
	it('canonicalizes case and rejects malformed tags', () => {
		expect(canonicalTag('pt-br')).toBe('pt-BR');
		expect(canonicalTag(' zh-hant ')).toBe('zh-Hant');
		expect(canonicalTag('not a tag')).toBeUndefined();
		expect(canonicalTag('')).toBeUndefined();
	});
});

describe('languageOption', () => {
	it('names a regional tag in English and in itself, with its flag', () => {
		expect(languageOption('nl-BE')).toEqual({
			tag: 'nl-BE',
			name: 'Flemish',
			endonym: 'Vlaams',
			flag: '🇧🇪'
		});
	});

	it('gives no flag without a two-letter region', () => {
		expect(languageOption('ar')?.flag).toBeUndefined();
		expect(languageOption('es-419')?.flag).toBeUndefined();
		expect(languageOption('sr-Latn')?.flag).toBeUndefined();
		expect(flagOf('en-GB')).toBe('🇬🇧');
	});

	it('leaves out an endonym that only repeats the English name', () => {
		expect(languageOption('en')?.endonym).toBeUndefined();
		expect(languageOption('ja')?.endonym).toBe('日本語');
	});

	it('is undefined for a code the runtime cannot name', () => {
		expect(languageOption('qqq')).toBeUndefined();
		expect(languageOption(undefined)).toBeUndefined();
	});
});

describe('languageOptions', () => {
	it('names every curated code, once each', () => {
		const tags = languageOptions().map((option) => option.tag);
		expect(new Set(tags).size).toBe(tags.length);
		expect(tags.length).toBe(LANGUAGE_CODES.length);
	});

	it('sorts a variant straight after its base language', () => {
		const tags = languageOptions().map((option) => option.tag);
		const dutch = tags.indexOf('nl');
		expect(tags.slice(dutch, dutch + 3)).toEqual(['nl', 'nl-NL', 'nl-BE']);
	});
});

describe('searchLanguages', () => {
	it('returns everything for an empty query', () => {
		expect(searchLanguages('  ')).toHaveLength(languageOptions().length);
	});

	it('finds a language by English name, endonym or code', () => {
		expect(searchLanguages('flemish')[0].tag).toBe('nl-BE');
		expect(searchLanguages('vlaams')[0].tag).toBe('nl-BE');
		expect(searchLanguages('nl-be')[0].tag).toBe('nl-BE');
		expect(searchLanguages('日本')[0].tag).toBe('ja');
	});

	it('is accent- and case-insensitive', () => {
		expect(searchLanguages('ESPANOL')[0].tag).toBe('es');
		expect(searchLanguages('francais')[0].tag).toBe('fr');
	});

	it('ranks an exact match over a prefix over a loose subsequence', () => {
		const german = languageOption('de')!;
		expect(scoreLanguage(german, 'german')).toBeGreaterThan(scoreLanguage(german, 'germ'));
		expect(scoreLanguage(german, 'germ')).toBeGreaterThan(scoreLanguage(german, 'grmn'));
		expect(scoreLanguage(german, 'grmn')).toBeGreaterThan(0);
		expect(scoreLanguage(german, 'xyz')).toBe(0);
	});

	it('tolerates a skipped letter', () => {
		expect(searchLanguages('portugese').map((option) => option.tag)).toContain('pt');
	});

	it('finds nothing for nonsense', () => {
		expect(searchLanguages('zzzzqqq')).toEqual([]);
	});
});
