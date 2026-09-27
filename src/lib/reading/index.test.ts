/**
 * The public surface, through the wasm build's `llm` export.
 *
 * Node tests are always in mock mode (no key, no `localStorage`), so calling
 * an entry point here exercises exactly the offline path a developer with no
 * API key gets: the Rust fixtures through the Rust parsers.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadWasmCore } from '$lib/db/backend.testing';
import { isMockMode } from '$lib/llm';
import type { LearnerProfile } from '$lib/llm';
import { generateReadingText, lookUpWord, translateLine } from './index';

beforeAll(loadWasmCore);

const profile: LearnerProfile = {
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
		expect(translation).toBe('(translation of "La cuenta no era cara.")');
	});
});
