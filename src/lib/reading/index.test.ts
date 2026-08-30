/**
 * The public surface: the mock/real dispatch, and the promise the module
 * makes about what it does not touch.
 *
 * Node tests are always in mock mode (no key, no `localStorage`), so calling
 * either entry point here exercises exactly the offline path a developer with
 * no API key gets.
 */

import { describe, expect, it } from 'vitest';

import { isMockMode } from '$lib/llm';
import type { BatchProfile } from '$lib/llm';
import { annotateReadingText, generateReadingText, splitSentences } from './index';

const profile: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: []
};

describe('the reading entry points', () => {
	it('runs in mock mode with no key configured', () => {
		expect(isMockMode()).toBe(true);
	});

	it('generateReadingText returns a whole draft', async () => {
		const text = await generateReadingText({ profile, vocabulary: ['mesa'], focus: [] });

		expect(text.title).toBeTruthy();
		expect(text.sentences.length).toBeGreaterThan(0);
		expect(text.glossary.length).toBeGreaterThan(0);
	});

	it('annotateReadingText annotates a locally split text without changing it', async () => {
		const pasted = 'Fuimos al restaurante. Pedí sopa.\nLa cuenta no era cara.';
		const sentences = splitSentences(pasted);

		const text = await annotateReadingText({ profile, vocabulary: [], sentences });

		expect(text.sentences.map((sentence) => sentence.text)).toEqual(sentences);
		expect(text.sentences.every((sentence) => sentence.translation)).toBe(true);
	});
});
