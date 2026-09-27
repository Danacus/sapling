/**
 * The public surface: the mock/real dispatch.
 *
 * Node tests are always in mock mode (no key, no `localStorage`), so calling
 * either entry point here exercises exactly the offline path a developer with
 * no API key gets.
 */

import { describe, expect, it } from 'vitest';

import { isMockMode } from '$lib/llm';
import type { BatchProfile } from '$lib/llm';
import { generateReadingText, lookUpWord, translateLine } from './index';

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

	it('generateReadingText returns a whole draft of untimed segments', async () => {
		const text = await generateReadingText({ profile, vocabulary: ['mesa'], focus: [] });

		expect(text.title).toBeTruthy();
		expect(text.segments.length).toBeGreaterThan(0);
		expect(text.segments.every((segment) => segment.start === undefined)).toBe(true);
	});

	it('lookUpWord returns one gloss for the word it was given', async () => {
		const entry = await lookUpWord({
			profile,
			term: 'cuenta',
			sentence: 'La cuenta no era cara.',
			title: 'En el restaurante'
		});

		// The term echoes the tap exactly: the page matches it against the token
		// by key.
		expect(entry.term).toBe('cuenta');
		expect(entry.meaning).toBeTruthy();
	});

	it('translateLine returns one translation for the line it was given', async () => {
		const translation = await translateLine({ profile, text: 'La cuenta no era cara.' });
		expect(translation).toContain('La cuenta no era cara.');
	});
});
