/**
 * The lookup call: one word, in the sentence it stands in. What matters here is
 * that the term comes back exactly as it was sent — the entry is about to be
 * matched against a token character for character — and that an unusable reply
 * throws rather than yielding a card with nothing on it.
 */

import { describe, expect, it } from 'vitest';

import { LlmError } from '$lib/llm';
import type { BatchProfile, FetchLike } from '$lib/llm';
import { buildLookupPrompt, parseLookedUpWord, requestLookedUpWord } from './lookup-call';
import type { LookupWordArgs } from './lookup-call';

const profile: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'intermediate',
	interests: []
};

const args: LookupWordArgs = {
	profile,
	term: 'cuenta',
	sentence: 'La cuenta no era cara.',
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

function glossJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({ term: 'cuenta', reading: null, meaning: 'the bill', ...overrides });
}

describe('buildLookupPrompt', () => {
	it('sends the word, the sentence around it and the title', () => {
		const [, user] = buildLookupPrompt(args);
		expect(JSON.parse(user.content)).toEqual({
			native: 'English',
			target: 'Spanish',
			level: 'intermediate',
			term: 'cuenta',
			sentence: 'La cuenta no era cara.',
			title: 'En el restaurante'
		});
	});

	it('omits a title nobody gave it', () => {
		const [, user] = buildLookupPrompt({ profile, term: 'sopa', sentence: 'Pedí sopa.' });
		expect(JSON.parse(user.content)).not.toHaveProperty('title');
	});

	it('states the meaning is this sentence, in the native language', () => {
		const [system] = buildLookupPrompt(args);
		expect(system.content).toContain('in this sentence');
		expect(system.content).toContain('NATIVE language');
	});

	it('keeps the system message free of learner facts, so it caches', () => {
		const [mine] = buildLookupPrompt(args);
		const [theirs] = buildLookupPrompt({
			...args,
			profile: { ...profile, targetLanguage: 'Chinese' },
			term: '小朋友'
		});
		expect(mine.content).toBe(theirs.content);
	});
});

describe('parseLookedUpWord', () => {
	it('reads one gloss, null reading normalized away', () => {
		expect(parseLookedUpWord(glossJson(), 'cuenta')).toEqual({
			term: 'cuenta',
			meaning: 'the bill'
		});
	});

	it('keeps a reading when the script has one', () => {
		expect(
			parseLookedUpWord(
				JSON.stringify({ term: '小朋友', reading: 'xiǎo péng yǒu', meaning: 'child' }),
				'小朋友'
			)
		).toEqual({ term: '小朋友', reading: 'xiǎo péng yǒu', meaning: 'child' });
	});

	it('strips the fences models keep reaching for', () => {
		expect(parseLookedUpWord('```json\n' + glossJson() + '\n```', 'cuenta').meaning).toBe(
			'the bill'
		);
	});

	it('keeps the term that was asked about, not the one the model echoed', () => {
		// The whole point: a base form matches no token, so the reply's `term` is
		// never trusted over the word the reader actually tapped.
		const entry = parseLookedUpWord(glossJson({ term: 'contar' }), 'cuenta');
		expect(entry.term).toBe('cuenta');
	});

	it('throws on a reply with nothing to render', () => {
		expect(() => parseLookedUpWord('sorry, I cannot', 'cuenta')).toThrow(LlmError);
		expect(() => parseLookedUpWord(JSON.stringify({ term: 'cuenta' }), 'cuenta')).toThrow(LlmError);
		expect(() => parseLookedUpWord(glossJson({ meaning: '   ' }), 'cuenta')).toThrow(LlmError);
	});
});

describe('requestLookedUpWord', () => {
	it('pins the envelope and returns one glossary row', async () => {
		const { fetchFn, calls } = fakeOpenRouter(glossJson());

		const entry = await requestLookedUpWord(args, { apiKey: 'test', fetchFn });

		expect(calls[0].response_format?.json_schema?.name).toBe('reading_lookup');
		expect(entry).toEqual({ term: 'cuenta', meaning: 'the bill' });
	});
});
