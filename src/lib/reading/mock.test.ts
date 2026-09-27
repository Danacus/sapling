/**
 * The offline path. What is worth testing here is not the fixtures but that
 * they arrive through the *real* parsers — the mock is only useful if a reader
 * built against it is a reader that works against a paid call.
 */

import { describe, expect, it } from 'vitest';

import type { BatchProfile } from '$lib/llm';
import { mockGeneratedText, mockLineTranslation, mockLookedUpWord } from './mock';

const spanish: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: []
};

const mandarin: BatchProfile = { ...spanish, targetLanguage: 'Chinese' };

describe('mockGeneratedText', () => {
	it('writes a text as untimed segments, one per paragraph, and nothing else', async () => {
		const text = await mockGeneratedText({ profile: spanish, vocabulary: [], focus: [] });

		expect(text.segments).toHaveLength(4);
		for (const segment of text.segments) {
			expect(Object.keys(segment)).toEqual(['text']);
			expect(segment.text).toBe(segment.text.trim());
		}
	});

	it('switches to the Mandarin fixture for a Chinese learner', async () => {
		const text = await mockGeneratedText({ profile: mandarin, vocabulary: [], focus: [] });

		expect(text.title).toBe('一张两个人的桌子');
		expect(text.segments[0].text).toBe('星期六下午我们去了路口的饭馆。');
	});

	it('spends nothing, and says so', async () => {
		const text = await mockGeneratedText({ profile: spanish, vocabulary: [], focus: [] });
		expect(text.usage).toBeUndefined();
	});

	it('threads the learner topic into the title, deterministically', async () => {
		const args = { profile: spanish, vocabulary: [], focus: [], topic: ' el mercado ' };
		const once = await mockGeneratedText(args);
		const twice = await mockGeneratedText(args);

		expect(once.title).toContain('el mercado');
		expect(once).toEqual(twice);
	});
});

describe('mockLookedUpWord', () => {
	it('looks one word up, deterministically, through the real parser', async () => {
		const args = { profile: spanish, term: ' cuenta ', sentence: 'La cuenta no era cara.' };
		const once = await mockLookedUpWord(args);
		const twice = await mockLookedUpWord(args);

		// Trimmed, and the `null` reading normalized to absent — the two things a
		// paid reply goes through on its way to the card.
		expect(once).toEqual({
			term: 'cuenta',
			meaning: '(meaning of "cuenta")',
			explanation: '(how "cuenta" is used in this sentence)'
		});
		expect(once).toEqual(twice);
	});
});

describe('mockLineTranslation', () => {
	it('translates one line, deterministically, through the real parser', async () => {
		const args = { profile: spanish, text: ' La cuenta no era cara. ' };
		const once = await mockLineTranslation(args);
		const twice = await mockLineTranslation(args);

		// Trimmed by the parser, as a paid reply is.
		expect(once).toBe('(translation of "La cuenta no era cara.")');
		expect(once).toBe(twice);
	});
});
