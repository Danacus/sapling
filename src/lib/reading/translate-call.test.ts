/**
 * The translate call: one segment, into the native language. What matters is
 * that the request stays minimal and static where it can cache, and that an
 * unusable reply throws rather than putting a blank line under the text.
 */

import { describe, expect, it } from 'vitest';

import { LlmError } from '$lib/llm';
import type { BatchProfile, FetchLike } from '$lib/llm';
import {
	buildTranslatePrompt,
	parseLineTranslation,
	requestLineTranslation
} from './translate-call';
import type { TranslateLineArgs } from './translate-call';

const profile: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'intermediate',
	interests: []
};

const args: TranslateLineArgs = {
	profile,
	text: ' La cuenta no era cara, así que dejamos una propina. ',
	title: 'En el restaurante'
};

interface Call {
	messages: { role: string; content: string }[];
	response_format?: { json_schema?: { name?: string } };
}

function fakeOpenRouter(content: string): { fetchFn: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const fetchFn: FetchLike = async (_url, init) => {
		calls.push(JSON.parse(String(init?.body ?? '{}')) as Call);
		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 40, completion_tokens: 15 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return { fetchFn, calls };
}

describe('buildTranslatePrompt', () => {
	it('sends the two languages, the line trimmed and the title — and nothing else', () => {
		const [, user] = buildTranslatePrompt(args);
		expect(JSON.parse(user.content)).toEqual({
			native: 'English',
			target: 'Spanish',
			text: 'La cuenta no era cara, así que dejamos una propina.',
			title: 'En el restaurante'
		});
	});

	it('omits a title nobody gave it', () => {
		const [, user] = buildTranslatePrompt({ profile, text: 'Hola.' });
		expect(JSON.parse(user.content)).not.toHaveProperty('title');
	});

	it('asks for the native language and only the translation', () => {
		const [system] = buildTranslatePrompt(args);
		expect(system.content).toContain('NATIVE language');
		expect(system.content).toContain('no notes');
	});

	it('keeps the system message free of learner facts, so it caches', () => {
		const [mine] = buildTranslatePrompt(args);
		const [theirs] = buildTranslatePrompt({
			profile: { ...profile, targetLanguage: 'Chinese' },
			text: '我点了汤。'
		});
		expect(mine.content).toBe(theirs.content);
	});
});

describe('parseLineTranslation', () => {
	it('reads the translation, trimmed', () => {
		expect(parseLineTranslation(JSON.stringify({ translation: ' The bill was cheap. ' }))).toBe(
			'The bill was cheap.'
		);
	});

	it('strips the fences models keep reaching for', () => {
		expect(parseLineTranslation('```json\n{"translation":"Hello."}\n```')).toBe('Hello.');
	});

	it('throws on a reply with nothing to show', () => {
		expect(() => parseLineTranslation('sorry, I cannot')).toThrow(LlmError);
		expect(() => parseLineTranslation(JSON.stringify({}))).toThrow(LlmError);
		expect(() => parseLineTranslation(JSON.stringify({ translation: '   ' }))).toThrow(LlmError);
	});
});

describe('requestLineTranslation', () => {
	it('pins the envelope and returns the translated line', async () => {
		const { fetchFn, calls } = fakeOpenRouter(
			JSON.stringify({ translation: 'The bill was not expensive, so we left a tip.' })
		);

		const translation = await requestLineTranslation(args, { apiKey: 'test', fetchFn });

		expect(calls[0].response_format?.json_schema?.name).toBe('reading_translation');
		expect(translation).toBe('The bill was not expensive, so we left a tip.');
	});
});
