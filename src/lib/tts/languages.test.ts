import { describe, expect, it } from 'vitest';

import {
	DEFAULT_MANDARIN_SPEAKER,
	kokoroSpeakerFor,
	kokoroSupports,
	MANDARIN_SPEAKERS,
	sherpaSupports,
	sherpaVoiceFor
} from './languages';

describe('sherpaVoiceFor', () => {
	it('routes Cantonese to the single-speaker VITS model', () => {
		for (const language of ['yue', 'yue-HK']) {
			expect(sherpaVoiceFor(language), language).toMatchObject({
				model: 'cantonese',
				id: 0
			});
			expect(sherpaSupports(language), language).toBe(true);
		}
	});

	it('keeps Mandarin and English on Kokoro', () => {
		expect(sherpaVoiceFor('zh-CN')?.model).toBe('kokoro');
		expect(sherpaVoiceFor('en')?.model).toBe('kokoro');
	});
});

describe('kokoroSpeakerFor', () => {
	// Kokoro v1.1-zh under sherpa-onnx genuinely speaks Mandarin and English
	// (3 English voices + 100 Mandarin ones). Everything else must route to the
	// Web Speech API instead of being read aloud with the wrong frontend.
	it('picks an English voice for English', () => {
		expect(kokoroSpeakerFor('en', 'auto')?.name).toBe('af_maple');
		expect(kokoroSpeakerFor('en-US', 'auto')?.name).toBe('af_maple');
		expect(kokoroSpeakerFor('en-GB', 'auto')?.name).toBe('bf_vale');
	});

	it('picks a Mandarin voice for every way of writing Mandarin', () => {
		for (const language of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-Hans-CN']) {
			expect(kokoroSpeakerFor(language, 'auto'), language).toEqual(DEFAULT_MANDARIN_SPEAKER);
			expect(kokoroSupports(language), language).toBe(true);
		}
		expect(DEFAULT_MANDARIN_SPEAKER.name).toBe('zf_001');
	});

	it('honours the chosen Mandarin voice, and only for Mandarin', () => {
		expect(kokoroSpeakerFor('zh-CN', 'zm_010')?.id).toBe(59);
		expect(kokoroSpeakerFor('zh-CN', 'zf_018')?.id).toBe(12);
		// An English phrase must not come out of a Chinese speaker.
		expect(kokoroSpeakerFor('en', 'zm_010')?.name).toBe('af_maple');
	});

	it('refuses every language Kokoro cannot actually pronounce', () => {
		for (const language of [
			'es',
			'fr',
			'ja',
			'hi',
			'pt-BR',
			// Kokoro v1.1-zh is Mandarin in Simplified script.
			'yue',
			'zh-TW',
			'zh-HK',
			'zh-Hant'
		]) {
			expect(kokoroSpeakerFor(language, 'auto'), language).toBeUndefined();
			expect(kokoroSupports(language), language).toBe(false);
		}
	});

	it('claims nothing for an unresolved language', () => {
		expect(kokoroSupports(undefined)).toBe(false);
		expect(sherpaSupports(undefined)).toBe(false);
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
