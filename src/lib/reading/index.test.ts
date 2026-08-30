/**
 * The public surface: the mock/real dispatch, and the promise the module
 * makes about what it does not touch.
 *
 * Node tests are always in mock mode (no key, no `localStorage`), so calling
 * either entry point here exercises exactly the offline path a developer with
 * no API key gets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { clearApiKey, setApiKey } from '$lib/db/settings';
import { isMockMode } from '$lib/llm';
import type { BatchProfile, FetchLike } from '$lib/llm';
import { MAX_IMPORT_CHARS } from './annotate-call';
import {
	annotateReadingText,
	generateReadingText,
	importCallCount,
	lookUpWord,
	splitSentences
} from './index';

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

	it('lookUpWord returns one gloss for the word it was given', async () => {
		const entry = await lookUpWord({
			profile,
			term: 'cuenta',
			sentence: 'La cuenta no era cara.',
			title: 'En el restaurante'
		});

		// The term echoes the tap exactly: the page merges this into the glossary
		// and the annotator matches it against the token character for character.
		expect(entry.term).toBe('cuenta');
		expect(entry.meaning).toBeTruthy();
	});

	it('chunks a long import in mock mode too, so the offline path is the real one', async () => {
		const sentences = longSentences(6);
		const text = await annotateReadingText({ profile, vocabulary: [], sentences });

		expect(importCallCount(sentences)).toBe(3);
		expect(text.sentences.map((sentence) => sentence.text)).toEqual(sentences);
		expect(text.sentences.every((sentence) => sentence.translation)).toBe(true);
		// The mock spends nothing, so there is no usage to sum.
		expect(text.usage).toBeUndefined();
	});
});

/** Sentences of 1500 characters, so `MAX_IMPORT_CHARS` packs two to a chunk. */
function longSentences(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${i}`.padEnd(1499, 'a') + '.');
}

describe('importCallCount', () => {
	it('is one call for anything that fits, and one more for every budget past it', () => {
		expect(importCallCount([])).toBe(0);
		expect(importCallCount(['Corto.'])).toBe(1);
		expect(importCallCount(longSentences(2))).toBe(1);
		expect(importCallCount(longSentences(6))).toBe(3);
		expect(importCallCount(['x'.repeat(MAX_IMPORT_CHARS * 3)])).toBe(1);
	});
});

interface Payload {
	title?: string;
	sentences: { n: number; text: string }[];
}

/**
 * A fake OpenRouter that answers every chunk in turn, so the orchestration can
 * be watched: how many calls it makes, what went in each one, and in what
 * order.
 */
function fakeChunkedOpenRouter(reply: (call: number, payload: Payload) => unknown = defaultReply): {
	fetchFn: FetchLike;
	payloads: Payload[];
} {
	const payloads: Payload[] = [];
	const fetchFn: FetchLike = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? '{}')) as {
			messages: { content: string }[];
		};
		const payload = JSON.parse(body.messages[1].content) as Payload;
		payloads.push(payload);

		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [{ message: { content: JSON.stringify(reply(payloads.length, payload)) } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return { fetchFn, payloads };
}

function defaultReply(call: number, payload: Payload) {
	return {
		title: `Chunk ${call}`,
		sentences: payload.sentences.map((_, i) => ({
			reading: null,
			translation: `call ${call} line ${i + 1}`
		})),
		// The same word in every chunk — which is the common case, and the reason
		// the merge dedupes.
		glossary: [{ term: call === 1 ? 'sopa' : ' Sopa ', reading: null, meaning: `sense ${call}` }]
	};
}

/**
 * The chunked annotate path, which only exists off the mock: a long import is
 * several calls, made in order, merged into one text.
 *
 * Node has no `localStorage`, so the module is in mock mode by default. A shim
 * plus a key is what puts it on the paid path — nothing here reaches the
 * network, since every call goes through the injected `fetchFn`.
 */
describe('annotateReadingText over several chunks', () => {
	const sentences = longSentences(6);
	const args = { profile, vocabulary: [], sentences };

	beforeAll(() => {
		const store = new Map<string, string>();
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key)
			}
		});
		setApiKey('test-key');
	});

	afterAll(() => {
		clearApiKey();
		Reflect.deleteProperty(globalThis, 'localStorage');
	});

	it('is off the mock once a key is configured', () => {
		expect(isMockMode()).toBe(false);
	});

	it('makes one call per chunk and concatenates the sentences in order', async () => {
		const { fetchFn, payloads } = fakeChunkedOpenRouter();

		const text = await annotateReadingText(args, { fetchFn });

		expect(payloads).toHaveLength(3);
		expect(payloads.map((payload) => payload.sentences.length)).toEqual([2, 2, 2]);
		expect(text.sentences.map((sentence) => sentence.text)).toEqual(sentences);
		expect(text.sentences.map((sentence) => sentence.translation)).toEqual([
			'call 1 line 1',
			'call 1 line 2',
			'call 2 line 1',
			'call 2 line 2',
			'call 3 line 1',
			'call 3 line 2'
		]);
	});

	it('loses only the misaligned chunk, not the whole text', async () => {
		const { fetchFn } = fakeChunkedOpenRouter((call, payload) =>
			call === 2
				? { ...defaultReply(call, payload), sentences: [{ reading: null, translation: 'one' }] }
				: defaultReply(call, payload)
		);

		const text = await annotateReadingText(args, { fetchFn });

		expect(text.sentences.map((sentence) => sentence.translation)).toEqual([
			'call 1 line 1',
			'call 1 line 2',
			undefined,
			undefined,
			'call 3 line 1',
			'call 3 line 2'
		]);
		// The glossary is index-free, so the botched chunk still paid for itself.
		expect(text.glossary).toHaveLength(1);
	});

	it('dedupes the glossary by word key across chunks, first sense winning', async () => {
		const { fetchFn } = fakeChunkedOpenRouter();
		const text = await annotateReadingText(args, { fetchFn });

		expect(text.glossary).toEqual([{ term: 'sopa', meaning: 'sense 1' }]);
	});

	it('sums the usage of every call', async () => {
		const { fetchFn } = fakeChunkedOpenRouter();
		const text = await annotateReadingText(args, { fetchFn });

		expect(text.usage).toEqual({ promptTokens: 30, completionTokens: 15 });
	});

	it('names the text after the first chunk, and sends the learner title only there', async () => {
		const { fetchFn, payloads } = fakeChunkedOpenRouter();

		const text = await annotateReadingText({ ...args, title: 'Mi artículo' }, { fetchFn });

		expect(text.title).toBe('Mi artículo');
		expect(payloads.map((payload) => payload.title)).toEqual(['Mi artículo', undefined, undefined]);
	});

	it("falls back to the first chunk's title when the learner named nothing", async () => {
		const { fetchFn } = fakeChunkedOpenRouter();
		expect((await annotateReadingText(args, { fetchFn })).title).toBe('Chunk 1');
	});

	it('reports progress once per chunk', async () => {
		const { fetchFn } = fakeChunkedOpenRouter();
		const seen: [number, number][] = [];

		await annotateReadingText(args, {
			fetchFn,
			onProgress: (done, total) => seen.push([done, total])
		});

		expect(seen).toEqual([
			[1, 3],
			[2, 3],
			[3, 3]
		]);
	});

	it('stops at the first failure rather than paying for the rest', async () => {
		let calls = 0;
		const fetchFn: FetchLike = async () => {
			calls++;
			return new Response('nope', { status: 500 });
		};

		await expect(annotateReadingText(args, { fetchFn })).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
