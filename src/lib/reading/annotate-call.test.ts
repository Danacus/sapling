/**
 * The annotate call, whose whole job is index alignment: the sentences on
 * screen are the learner's own, and an annotation under the wrong one is worse
 * than none.
 */

import { describe, expect, it } from 'vitest';

import { LlmError } from '$lib/llm';
import type { BatchProfile, FetchLike } from '$lib/llm';
import {
	MAX_IMPORT_CHARS,
	MAX_IMPORT_TOTAL_CHARS,
	annotatedSentences,
	buildAnnotatePrompt,
	parseAnnotatedText,
	requestAnnotatedText,
	resolveTitle
} from './annotate-call';
import type { AnnotateTextArgs } from './annotate-call';

const profile: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'intermediate',
	interests: []
};

const SENTENCES = ['Fuimos al restaurante.', 'Pedí sopa.', 'La cuenta no era cara.'];

const args: AnnotateTextArgs = { profile, vocabulary: ['sopa'], sentences: SENTENCES };

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
				usage: { prompt_tokens: 90, completion_tokens: 60 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return { fetchFn, calls };
}

function annotationJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		title: 'En el restaurante',
		sentences: [
			{ reading: null, translation: 'We went to the restaurant.' },
			{ reading: null, translation: 'I ordered soup.' },
			{ reading: null, translation: 'The bill was not expensive.' }
		],
		glossary: [{ term: 'cuenta', reading: null, meaning: 'the bill' }],
		...overrides
	});
}

describe('the import limits', () => {
	it('budgets one call, and caps the import at several of them', () => {
		expect(MAX_IMPORT_CHARS).toBe(4000);
		expect(MAX_IMPORT_TOTAL_CHARS).toBe(40000);
		expect(MAX_IMPORT_TOTAL_CHARS % MAX_IMPORT_CHARS).toBe(0);
	});
});

describe('buildAnnotatePrompt', () => {
	it('numbers the sentences and says how many there are', () => {
		const [system, user] = buildAnnotatePrompt(args);
		const payload = JSON.parse(user.content) as Record<string, unknown>;

		expect(system.content).toContain('one entry per numbered sentence');
		expect(payload.sentenceCount).toBe(3);
		expect(payload.sentences).toEqual([
			{ n: 1, text: 'Fuimos al restaurante.' },
			{ n: 2, text: 'Pedí sopa.' },
			{ n: 3, text: 'La cuenta no era cara.' }
		]);
	});

	it('passes the learner title through and omits a blank one', () => {
		const withTitle = buildAnnotatePrompt({ ...args, title: '  Mi texto  ' });
		expect(JSON.parse(withTitle[1].content).title).toBe('Mi texto');
		expect(
			JSON.parse(buildAnnotatePrompt({ ...args, title: '   ' })[1].content)
		).not.toHaveProperty('title');
	});

	it('keeps the system message free of learner facts, so it caches', () => {
		const [mine] = buildAnnotatePrompt(args);
		const [theirs] = buildAnnotatePrompt({
			...args,
			profile: { ...profile, targetLanguage: 'Japanese' }
		});
		expect(mine.content).toBe(theirs.content);
	});
});

describe('parseAnnotatedText', () => {
	it('reads index-aligned annotations, null normalized away', () => {
		expect(parseAnnotatedText(annotationJson(), 3)).toEqual({
			title: 'En el restaurante',
			sentences: [
				{ translation: 'We went to the restaurant.' },
				{ translation: 'I ordered soup.' },
				{ translation: 'The bill was not expensive.' }
			],
			glossary: [{ term: 'cuenta', meaning: 'the bill' }]
		});
	});

	it('drops every annotation when the array does not line up, and keeps the glossary', () => {
		const short = parseAnnotatedText(
			annotationJson({ sentences: [{ reading: null, translation: 'We went.' }] }),
			3
		);
		expect(short.sentences).toEqual([]);
		expect(short.glossary).toEqual([{ term: 'cuenta', meaning: 'the bill' }]);
	});

	it('leaves the title absent when the model declines it', () => {
		expect(parseAnnotatedText(annotationJson({ title: null }), 3)).not.toHaveProperty('title');
	});

	it('throws only on an unusable envelope', () => {
		expect(() => parseAnnotatedText('nope', 3)).toThrow(LlmError);
		expect(() => parseAnnotatedText(JSON.stringify({ sentences: [] }), 3)).toThrow(LlmError);
	});
});

describe('annotatedSentences', () => {
	it('marries the model annotations to the local text', () => {
		const parsed = parseAnnotatedText(annotationJson(), 3);
		expect(annotatedSentences(SENTENCES, parsed)).toEqual([
			{ text: 'Fuimos al restaurante.', translation: 'We went to the restaurant.' },
			{ text: 'Pedí sopa.', translation: 'I ordered soup.' },
			{ text: 'La cuenta no era cara.', translation: 'The bill was not expensive.' }
		]);
	});

	it('still returns the learner text when the alignment was dropped', () => {
		const parsed = parseAnnotatedText(annotationJson({ sentences: [] }), 3);
		expect(annotatedSentences(SENTENCES, parsed)).toEqual(SENTENCES.map((text) => ({ text })));
	});
});

describe('resolveTitle', () => {
	it("prefers the learner's own, then the model's, then the opening words", () => {
		const parsed = parseAnnotatedText(annotationJson(), 3);
		expect(resolveTitle({ ...args, title: ' Mi texto ' }, parsed)).toBe('Mi texto');
		expect(resolveTitle(args, parsed)).toBe('En el restaurante');
		expect(resolveTitle(args, { ...parsed, title: undefined })).toBe('Fuimos al restaurante.');
	});

	it('truncates a long opening sentence rather than titling a page with it', () => {
		const long = 'a'.repeat(200);
		const title = resolveTitle({ ...args, sentences: [long] }, { sentences: [], glossary: [] });
		expect(title.length).toBeLessThan(50);
		expect(title.endsWith('…')).toBe(true);
	});
});

describe('requestAnnotatedText', () => {
	it('pins the envelope and returns the learner text wearing its annotations', async () => {
		const { fetchFn, calls } = fakeOpenRouter(annotationJson());

		const result = await requestAnnotatedText(args, { apiKey: 'test', fetchFn });

		expect(calls[0].response_format?.json_schema?.name).toBe('reading_annotation');
		expect(result).toEqual({
			title: 'En el restaurante',
			sentences: [
				{ text: 'Fuimos al restaurante.', translation: 'We went to the restaurant.' },
				{ text: 'Pedí sopa.', translation: 'I ordered soup.' },
				{ text: 'La cuenta no era cara.', translation: 'The bill was not expensive.' }
			],
			glossary: [{ term: 'cuenta', meaning: 'the bill' }],
			usage: { promptTokens: 90, completionTokens: 60 }
		});
	});

	it('survives a misaligned reply with the text and glossary intact', async () => {
		const { fetchFn } = fakeOpenRouter(annotationJson({ sentences: [{ translation: 'One.' }] }));

		const result = await requestAnnotatedText(args, { apiKey: 'test', fetchFn });
		expect(result.sentences).toEqual(SENTENCES.map((text) => ({ text })));
		expect(result.glossary).toHaveLength(1);
	});
});
