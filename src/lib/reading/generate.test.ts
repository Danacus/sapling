/**
 * The write call: what the model is told, what the app accepts back, and the
 * caps that keep one prompt from depending on how many words the learner has.
 */

import { describe, expect, it } from 'vitest';

import { LlmError } from '$lib/llm';
import type { BatchProfile, FetchLike } from '$lib/llm';
import { buildAnnotatePrompt } from './annotate-call';
import {
	GLOSSARY_RULES,
	MAX_FOCUS_WORDS,
	MAX_VOCABULARY_TERMS,
	SENTENCES_BY_LEVEL,
	buildGeneratePrompt,
	parseGeneratedText,
	requestGeneratedText,
	sentenceCountFor
} from './generate';

const profile: BatchProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'elementary',
	interests: ['cooking']
};

interface Call {
	messages: { role: string; content: string }[];
	max_tokens?: number;
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
				usage: { prompt_tokens: 120, completion_tokens: 340 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return { fetchFn, calls };
}

function textJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		title: 'Una mesa para dos',
		sentences: [
			{ text: 'Fuimos al restaurante.', reading: null, translation: 'We went to the restaurant.' },
			{ text: 'Pedí sopa.', reading: null, translation: 'I ordered soup.' }
		],
		glossary: [{ term: 'sopa', reading: null, meaning: 'soup' }],
		...overrides
	});
}

/** The user message of a built prompt, parsed back. */
function payloadOf(args: Parameters<typeof buildGeneratePrompt>[0]): Record<string, unknown> {
	const [, user] = buildGeneratePrompt(args);
	return JSON.parse(user.content) as Record<string, unknown>;
}

describe('buildGeneratePrompt', () => {
	it('keeps the system message free of learner facts, so it caches', () => {
		const [mine] = buildGeneratePrompt({ profile, vocabulary: ['mesa'], focus: [] });
		const [theirs] = buildGeneratePrompt({
			profile: { ...profile, targetLanguage: 'Chinese', level: 'advanced' },
			vocabulary: ['桌子'],
			focus: []
		});
		expect(mine.content).toBe(theirs.content);
		expect(mine.content).not.toContain('Spanish');
	});

	it('carries the languages, the level and the sentence count in the user message', () => {
		expect(payloadOf({ profile, vocabulary: ['mesa'], focus: [] })).toMatchObject({
			native: 'English',
			target: 'Spanish',
			level: 'elementary',
			sentenceCount: SENTENCES_BY_LEVEL.elementary,
			interests: ['cooking']
		});
	});

	it('lengthens the text with the level', () => {
		expect(sentenceCountFor('beginner')).toBe(6);
		expect(sentenceCountFor('advanced')).toBe(12);
		expect(
			payloadOf({ profile: { ...profile, level: 'advanced' }, vocabulary: [], focus: [] })
		).toHaveProperty('sentenceCount', 12);
	});

	it('caps the vocabulary, dropping blanks and duplicates first', () => {
		const vocabulary = ['  mesa  ', 'mesa', '', ...Array.from({ length: 600 }, (_, i) => `w${i}`)];
		const payload = payloadOf({ profile, vocabulary, focus: [] });
		const terms = payload.vocabulary as string[];
		expect(terms).toHaveLength(MAX_VOCABULARY_TERMS);
		expect(terms[0]).toBe('mesa');
		expect(terms[1]).toBe('w0');
	});

	it('caps the focus list, which every text has to work in', () => {
		const focus = Array.from({ length: 30 }, (_, i) => ({ term: `t${i}`, meaning: `m${i}` }));
		expect(payloadOf({ profile, vocabulary: [], focus }).focus).toHaveLength(MAX_FOCUS_WORDS);
	});

	it('caps a topic long enough to be a prompt of its own, and omits a blank one', () => {
		const long = payloadOf({ profile, vocabulary: [], focus: [], topic: 'x'.repeat(500) });
		expect((long.topic as string).length).toBeLessThan(200);
		expect(payloadOf({ profile, vocabulary: [], focus: [], topic: '  ' })).not.toHaveProperty(
			'topic'
		);
	});

	it("caps the learner's self-description like every other call does", () => {
		const payload = payloadOf({
			profile: { ...profile, about: 'y'.repeat(2000) },
			vocabulary: [],
			focus: []
		});
		expect((payload.about as string).length).toBe(500);
	});
});

describe('the glossary rules', () => {
	it('are word for word the same in both prompts, so one edit cannot drift', () => {
		const write = buildGeneratePrompt({ profile, vocabulary: [], focus: [] })[0].content;
		const annotate = buildAnnotatePrompt({ profile, vocabulary: [], sentences: ['Hola.'] })[0]
			.content;

		for (const rule of GLOSSARY_RULES) {
			expect(write).toContain(rule);
			expect(annotate).toContain(rule);
		}
	});

	it('pin the term to the form the text uses and "in vocabulary" to an identical term', () => {
		// The two defects that leave a genuinely new word `plain`: a gloss written
		// for the base form matches no token, and a model that reads 学 in the
		// vocabulary as covering 学习 never writes the entry at all.
		const rules = GLOSSARY_RULES.join('\n');
		expect(rules).toContain('never a base or dictionary form');
		expect(rules).toContain('only when the identical term is listed');
	});
});

describe('parseGeneratedText', () => {
	it('reads a text and normalizes null annotations to absent', () => {
		expect(parseGeneratedText(textJson())).toEqual({
			title: 'Una mesa para dos',
			sentences: [
				{ text: 'Fuimos al restaurante.', translation: 'We went to the restaurant.' },
				{ text: 'Pedí sopa.', translation: 'I ordered soup.' }
			],
			glossary: [{ term: 'sopa', meaning: 'soup' }]
		});
	});

	it('keeps a reading when there is one', () => {
		const parsed = parseGeneratedText(
			JSON.stringify({
				title: '一张桌子',
				sentences: [
					{ text: '我们去了饭馆。', reading: 'wǒ men qù le fàn guǎn.', translation: null }
				],
				glossary: [{ term: '饭馆', reading: 'fàn guǎn', meaning: 'restaurant' }]
			})
		);
		expect(parsed.sentences[0]).toEqual({
			text: '我们去了饭馆。',
			reading: 'wǒ men qù le fàn guǎn.'
		});
		expect(parsed.glossary[0]).toEqual({
			term: '饭馆',
			reading: 'fàn guǎn',
			meaning: 'restaurant'
		});
	});

	it('strips the fences models keep reaching for', () => {
		expect(parseGeneratedText('```json\n' + textJson() + '\n```').title).toBe('Una mesa para dos');
	});

	it('dedupes the glossary by term', () => {
		const parsed = parseGeneratedText(
			textJson({
				glossary: [
					{ term: 'sopa', meaning: 'soup' },
					{ term: 'Sopa', meaning: 'soup, again' }
				]
			})
		);
		expect(parsed.glossary).toHaveLength(1);
	});

	it('keeps both readings of a homograph, and still folds a repeat of one', () => {
		// The dedupe is by card, not by spelling: a text that uses 长 twice in two
		// senses needs two glosses, and `./annotate` picks between them.
		const parsed = parseGeneratedText(
			textJson({
				glossary: [
					{ term: '长', reading: 'cháng', meaning: 'long' },
					{ term: '长', reading: 'zhǎng', meaning: 'to grow' },
					{ term: '长', reading: 'cháng', meaning: 'lengthy' }
				]
			})
		);
		expect(parsed.glossary.map((entry) => entry.meaning)).toEqual(['long', 'to grow']);
	});

	it('throws on anything that is not a text', () => {
		expect(() => parseGeneratedText('sorry, I cannot')).toThrow(LlmError);
		expect(() => parseGeneratedText(JSON.stringify({ title: 'T' }))).toThrow(LlmError);
		expect(() => parseGeneratedText(textJson({ sentences: [] }))).toThrow(LlmError);
	});
});

describe('requestGeneratedText', () => {
	it('pins the envelope, sets no token cap and returns the usage', async () => {
		const { fetchFn, calls } = fakeOpenRouter(textJson());

		const result = await requestGeneratedText(
			{ profile, vocabulary: ['mesa'], focus: [{ term: 'sopa', meaning: 'soup' }] },
			{ apiKey: 'test', fetchFn }
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].response_format?.json_schema?.name).toBe('reading_text');
		expect(calls[0].max_tokens).toBeUndefined();
		expect(result.title).toBe('Una mesa para dos');
		expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 340 });
	});
});
