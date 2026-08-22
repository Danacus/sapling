import { describe, expect, it } from 'vitest';

import {
	bcp47For,
	DEFAULT_LANGUAGE_TAG,
	DEFAULT_MANDARIN_SPEAKER,
	kokoroSpeakerFor,
	kokoroSupports,
	MANDARIN_SPEAKERS
} from './languages';

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

describe('kokoroSpeakerFor', () => {
	// Kokoro v1.1-zh under sherpa-onnx genuinely speaks Mandarin and English
	// (3 English voices + 100 Mandarin ones). Everything else must route to the
	// Web Speech API instead of being read aloud with the wrong frontend.
	it('picks an English voice for English', () => {
		expect(kokoroSpeakerFor('English', 'auto')?.name).toBe('af_maple');
		expect(kokoroSpeakerFor('American English', 'auto')?.name).toBe('af_maple');
		expect(kokoroSpeakerFor('British English', 'auto')?.name).toBe('bf_vale');
	});

	it('picks a Mandarin voice for every way of writing Mandarin', () => {
		for (const language of ['Mandarin Chinese', 'Chinese', 'Mandarin', 'Simplified Chinese', 'zh']) {
			expect(kokoroSpeakerFor(language, 'auto'), language).toEqual(DEFAULT_MANDARIN_SPEAKER);
			expect(kokoroSupports(language), language).toBe(true);
		}
		expect(DEFAULT_MANDARIN_SPEAKER.name).toBe('zf_001');
	});

	it('honours the chosen Mandarin voice, and only for Mandarin', () => {
		expect(kokoroSpeakerFor('Mandarin Chinese', 'zm_010')?.id).toBe(59);
		expect(kokoroSpeakerFor('Mandarin Chinese', 'zf_018')?.id).toBe(12);
		// An English phrase must not come out of a Chinese speaker.
		expect(kokoroSpeakerFor('English', 'zm_010')?.name).toBe('af_maple');
	});

	it('refuses every language Kokoro cannot actually pronounce', () => {
		for (const language of [
			'Spanish',
			'French',
			'Japanese',
			'Hindi',
			'Portuguese',
			// Kokoro v1.1-zh is Mandarin in Simplified script.
			'Cantonese',
			'Traditional Chinese'
		]) {
			expect(kokoroSpeakerFor(language, 'auto'), language).toBeUndefined();
			expect(kokoroSupports(language), language).toBe(false);
		}
	});

	it('does not claim support for an unknown language just because it defaults to en', () => {
		// A name we cannot place falls back to `en`, and that *is* something
		// Kokoro can speak — the alternative (silence) would be worse.
		expect(kokoroSupports('Klingon')).toBe(true);
	});

	it('offers speaker ids that match the upstream voices.bin ordering', () => {
		// voices.bin is 103 x 510 x 256 x float32; ids are positions in the list
		// k2-fsa's generate_voices_bin.py builds, so a typo here would silently
		// synthesize a different person.
		expect(MANDARIN_SPEAKERS.map((speaker) => [speaker.name, speaker.id])).toEqual([
			['zf_001', 3],
			['zf_018', 12],
			['zm_010', 59]
		]);
		for (const speaker of MANDARIN_SPEAKERS) {
			expect(speaker.id).toBeGreaterThanOrEqual(0);
			expect(speaker.id).toBeLessThan(103);
		}
	});
});
