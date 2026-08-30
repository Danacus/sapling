/**
 * The offline path. What is worth testing here is not the fixtures but that
 * they arrive through the *real* parsers — the mock is only useful if a reader
 * built against it is a reader that works against a paid call.
 */

import { describe, expect, it } from 'vitest';

import type { BatchProfile } from '$lib/llm';
import {
	MOCK_GLOSSARY_WORDS,
	mockAnnotatedText,
	mockGeneratedText,
	mockLookedUpWord
} from './mock';

const spanish: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: []
};

const mandarin: BatchProfile = { ...spanish, targetLanguage: 'Chinese' };

describe('mockGeneratedText', () => {
	it('writes a Latin-script text with no readings by default', async () => {
		const text = await mockGeneratedText({ profile: spanish, vocabulary: [], focus: [] });

		expect(text.sentences).toHaveLength(6);
		expect(text.sentences.every((sentence) => sentence.reading === undefined)).toBe(true);
		expect(text.sentences.every((sentence) => sentence.translation)).toBe(true);
		expect(text.glossary.length).toBeGreaterThanOrEqual(4);
		expect(text.glossary.every((entry) => entry.reading === undefined)).toBe(true);
	});

	it('switches to the pinyin fixtures for a Chinese learner', async () => {
		const text = await mockGeneratedText({ profile: mandarin, vocabulary: [], focus: [] });

		expect(text.title).toBe('一张两个人的桌子');
		expect(text.sentences).toHaveLength(6);
		expect(text.sentences.every((sentence) => sentence.reading)).toBe(true);
		expect(text.glossary.every((entry) => entry.reading)).toBe(true);
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

describe('mockAnnotatedText', () => {
	const sentences = ['Fuimos al restaurante.', 'Pedí sopa.', 'La cuenta no era cara.'];

	it('annotates the learner text in place, one translation per line', async () => {
		const text = await mockAnnotatedText({ profile: spanish, vocabulary: [], sentences });

		expect(text.sentences.map((sentence) => sentence.text)).toEqual(sentences);
		expect(text.sentences.map((sentence) => sentence.translation)).toEqual([
			'(translation of sentence 1)',
			'(translation of sentence 2)',
			'(translation of sentence 3)'
		]);
		expect(text.sentences.every((sentence) => sentence.reading === undefined)).toBe(true);
	});

	it('glosses the first few distinct words of the text', async () => {
		const text = await mockAnnotatedText({ profile: spanish, vocabulary: [], sentences });

		expect(text.glossary).toHaveLength(MOCK_GLOSSARY_WORDS);
		expect(text.glossary.map((entry) => entry.term)).toEqual([
			'Fuimos',
			'al',
			'restaurante',
			'Pedí',
			'sopa'
		]);
	});

	it('splits an unspaced text the way the reader will', async () => {
		const text = await mockAnnotatedText({
			profile: mandarin,
			vocabulary: [],
			sentences: ['我们去了饭馆。']
		});
		expect(text.glossary.map((entry) => entry.term)).toEqual(['我们', '去了', '饭馆']);
	});

	it('takes the learner title, and falls back to the opening words', async () => {
		const named = await mockAnnotatedText({
			profile: spanish,
			vocabulary: [],
			sentences,
			title: 'Mi texto'
		});
		expect(named.title).toBe('Mi texto');

		const unnamed = await mockAnnotatedText({ profile: spanish, vocabulary: [], sentences });
		expect(unnamed.title).toBe('Fuimos al restaurante.');
	});
});

describe('mockLookedUpWord', () => {
	it('looks one word up, deterministically, through the real parser', async () => {
		const args = { profile: spanish, term: ' cuenta ', sentence: 'La cuenta no era cara.' };
		const once = await mockLookedUpWord(args);
		const twice = await mockLookedUpWord(args);

		// Trimmed, and the `null` reading normalized to absent — the two things a
		// paid reply goes through on its way into the glossary.
		expect(once).toEqual({ term: 'cuenta', meaning: '(meaning of "cuenta")' });
		expect(once).toEqual(twice);
	});

	it('is worded as one of the offline annotator rows, because it becomes one', async () => {
		const text = await mockAnnotatedText({
			profile: spanish,
			vocabulary: [],
			sentences: ['Pedí sopa.']
		});
		const looked = await mockLookedUpWord({
			profile: spanish,
			term: 'sopa',
			sentence: 'Pedí sopa.'
		});
		expect(text.glossary).toContainEqual(looked);
	});
});
