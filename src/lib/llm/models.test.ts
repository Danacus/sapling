import { describe, expect, it, vi } from 'vitest';

import { fetchModels, modelDetail, parseModels, searchModels, type ModelInfo } from './models';

const OPENROUTER_REPLY = {
	data: [
		{
			id: 'google/gemini-3.7-flash',
			name: 'Google: Gemini 3.7 Flash',
			context_length: 1048576,
			pricing: { prompt: '0.0000003', completion: '0.0000025' }
		},
		{ id: 'openai/gpt-5-nano', name: 'OpenAI: GPT-5 Nano', context_length: 400000 },
		{ id: 'meta/free', pricing: { prompt: '0', completion: '0' } }
	]
};

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('parseModels', () => {
	it('reads the OpenRouter shape', () => {
		expect(parseModels(OPENROUTER_REPLY)[0]).toEqual({
			id: 'google/gemini-3.7-flash',
			name: 'Google: Gemini 3.7 Flash',
			contextLength: 1048576,
			promptPrice: 0.0000003,
			completionPrice: 0.0000025
		});
	});

	it('reads a bare OpenAI-compatible list', () => {
		expect(parseModels({ object: 'list', data: [{ id: 'qwen', object: 'model' }] })).toEqual([
			{ id: 'qwen' }
		]);
	});

	it('skips entries without an id, duplicates and bad numbers', () => {
		const models = parseModels({
			data: [
				null,
				{ name: 'no id' },
				{ id: 'a', context_length: 'lots', pricing: { prompt: '-1', completion: 'x' } },
				{ id: 'a' }
			]
		});
		expect(models).toEqual([{ id: 'a' }]);
	});

	it('answers empty for anything else', () => {
		expect(parseModels(null)).toEqual([]);
		expect(parseModels({ data: 'nope' })).toEqual([]);
		expect(parseModels([])).toEqual([]);
	});
});

describe('fetchModels', () => {
	it('fetches {baseUrl}/models, OpenRouter when blank, with the key as Bearer', async () => {
		const fetchFn = vi.fn(async () => reply(OPENROUTER_REPLY));
		const models = await fetchModels(undefined, ' sk-test ', fetchFn);
		expect(models.map((model) => model.id)).toHaveLength(3);
		expect(fetchFn).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
			headers: { Authorization: 'Bearer sk-test' }
		});
	});

	it('sends no Authorization without a key and trims a trailing slash', async () => {
		const fetchFn = vi.fn(async () => reply(OPENROUTER_REPLY));
		await fetchModels('https://keyless.example/v1/', undefined, fetchFn);
		expect(fetchFn).toHaveBeenCalledWith('https://keyless.example/v1/models', { headers: {} });
	});

	it('memoises one promise per endpoint', async () => {
		const fetchFn = vi.fn(async () => reply(OPENROUTER_REPLY));
		const first = fetchModels('https://memo.example/v1', undefined, fetchFn);
		const second = fetchModels('https://memo.example/v1/', undefined, fetchFn);
		expect(second).toBe(first);
		await first;
		await fetchModels('https://memo.example/v1', undefined, fetchFn);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		await fetchModels('https://other.example/v1', undefined, fetchFn);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('resolves empty on a rejection, a bad status or a bad body, and retries next time', async () => {
		const failing = [
			vi.fn(async () => {
				throw new TypeError('offline');
			}),
			vi.fn(async () => reply({ error: 'nope' }, 404)),
			vi.fn(async () => new Response('<html>', { status: 200 }))
		];
		for (const [index, fetchFn] of failing.entries()) {
			const base = `https://fail-${index}.example/v1`;
			await expect(fetchModels(base, undefined, fetchFn)).resolves.toEqual([]);
			const ok = vi.fn(async () => reply(OPENROUTER_REPLY));
			await expect(fetchModels(base, undefined, ok)).resolves.toHaveLength(3);
		}
	});
});

describe('searchModels', () => {
	const models: ModelInfo[] = parseModels({
		data: [
			{ id: 'openai/gpt-5-nano', name: 'OpenAI: GPT-5 Nano' },
			{ id: 'google/gemini-3.7-flash', name: 'Google: Gemini 3.7 Flash' },
			{ id: 'google/gemini-3.7-flash-lite', name: 'Google: Gemini 3.7 Flash Lite' }
		]
	});
	const ids = (query: string) => searchModels(models, query).map((choice) => choice.id);

	it('lists everything for a blank query, with no typed entry', () => {
		expect(ids('  ')).toEqual(models.map((model) => model.id));
	});

	it('matches every token against the id or the name, case-insensitively', () => {
		expect(ids('flash LITE')).toEqual(['google/gemini-3.7-flash-lite', 'flash LITE']);
		expect(ids('openai nano')).toEqual(['openai/gpt-5-nano', 'openai nano']);
	});

	it('ranks the exact id first and offers no typed entry for it', () => {
		expect(ids('google/gemini-3.7-flash')).toEqual([
			'google/gemini-3.7-flash',
			'google/gemini-3.7-flash-lite'
		]);
	});

	it('ranks id prefixes before other matches', () => {
		expect(ids('gemini')).toEqual([
			'google/gemini-3.7-flash',
			'google/gemini-3.7-flash-lite',
			'gemini'
		]);
		expect(ids('google/')[0]).toBe('google/gemini-3.7-flash');
	});

	it('offers the typed id as-is, marked by having no model', () => {
		expect(searchModels(models, ' my/custom-model ')).toEqual([{ id: 'my/custom-model' }]);
		expect(searchModels([], 'anything')).toEqual([{ id: 'anything' }]);
	});
});

describe('modelDetail', () => {
	it('prices per 1M tokens and states the context', () => {
		const [gemini, nano, free] = parseModels(OPENROUTER_REPLY);
		expect(modelDetail(gemini)).toBe('$0.30 / $2.50 per 1M · 1M context');
		expect(modelDetail(nano)).toBe('400K context');
		expect(modelDetail(free)).toBe('Free');
		expect(modelDetail({ id: 'x', promptPrice: 0.00000002, completionPrice: 0 })).toBe(
			'$0.02 / $0 per 1M'
		);
		expect(modelDetail({ id: 'bare' })).toBe('');
	});
});
