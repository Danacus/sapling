import { describe, expect, it } from 'vitest';
import type { FetchLike } from './client';
import { LlmError } from './client';
import {
	ROMANIZE_SCHEMA_NAME,
	buildRomanizePrompt,
	fillRomanizations,
	parseRomanizations
} from './romanize';

const items = [
	{ id: 'i1', term: '菜单' },
	{ id: 'i2', term: '买单' }
];

const args = { items, targetLanguage: 'Mandarin Chinese' };

/** Replies with one canned completion, and records what was sent. */
function scriptedFetch(content: string): {
	fetchFn: FetchLike;
	body: () => Record<string, unknown>;
} {
	let sent: Record<string, unknown> = {};
	const fetchFn: FetchLike = async (_url, init) => {
		sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 120, completion_tokens: 30 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return { fetchFn, body: () => sent };
}

const callOpts = (fetchFn: FetchLike) => ({ fetchFn, apiKey: 'sk-or-test', model: 'test/model' });

describe('buildRomanizePrompt', () => {
	it('names the scheme per language so tones are not silently dropped', () => {
		const [system] = buildRomanizePrompt(args);
		expect(system.content).toContain('pinyin WITH tone marks');
		expect(system.content).toContain('romaji');
		expect(system.content).toContain('revised romanization');
	});

	it('sends the language and the id/term pairs, and nothing else', () => {
		const [, user] = buildRomanizePrompt(args);
		expect(JSON.parse(user.content)).toEqual({
			language: 'Mandarin Chinese',
			items: [
				{ id: 'i1', t: '菜单' },
				{ id: 'i2', t: '买单' }
			]
		});
	});
});

describe('parseRomanizations', () => {
	const ids = ['i1', 'i2'];

	it('reads a clean reply, fences and all', () => {
		const map = parseRomanizations(
			'```json\n{"readings":[{"id":"i1","romanization":" càidān "},{"id":"i2","romanization":"mǎidān"}]}\n```',
			ids
		);
		expect([...map]).toEqual([
			['i1', 'càidān'],
			['i2', 'mǎidān']
		]);
	});

	it('ignores ids that were never asked about', () => {
		const map = parseRomanizations(
			'{"readings":[{"id":"i1","romanization":"càidān"},{"id":"ghost","romanization":"nonsense"}]}',
			ids
		);
		expect(map.get('i1')).toBe('càidān');
		expect(map.has('ghost')).toBe(false);
		expect(map.size).toBe(1);
	});

	it('drops blank readings and keeps the first answer for a repeated id', () => {
		const map = parseRomanizations(
			'{"readings":[{"id":"i1","romanization":"  "},{"id":"i2","romanization":"mǎidān"},{"id":"i2","romanization":"maidan"}]}',
			ids
		);
		expect(map.has('i1')).toBe(false);
		expect(map.get('i2')).toBe('mǎidān');
	});

	it('rejects a reply that is not JSON, or not the envelope asked for', () => {
		expect(() => parseRomanizations('Sure, here you go!', ids)).toThrow(LlmError);
		expect(() => parseRomanizations('{"readings":{"i1":"càidān"}}', ids)).toThrow(LlmError);
		try {
			parseRomanizations('{"words":[]}', ids);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect((error as LlmError).kind).toBe('bad-response');
		}
	});
});

describe('fillRomanizations', () => {
	it('returns the readings and the usage from one structured call', async () => {
		const { fetchFn, body } = scriptedFetch(
			'{"readings":[{"id":"i1","romanization":"càidān"},{"id":"i2","romanization":"mǎidān"}]}'
		);

		const result = await fillRomanizations(args, callOpts(fetchFn));

		expect(result.readings.get('i1')).toBe('càidān');
		expect(result.readings.get('i2')).toBe('mǎidān');
		expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 30 });

		const format = body().response_format as { json_schema?: { name?: string } } | undefined;
		expect(format?.json_schema?.name).toBe(ROMANIZE_SCHEMA_NAME);
		expect(body().temperature).toBe(0);
	});

	it('leaves words the model skipped alone rather than guessing', async () => {
		const { fetchFn } = scriptedFetch('{"readings":[{"id":"i1","romanization":"càidān"}]}');
		const result = await fillRomanizations(args, callOpts(fetchFn));
		expect([...result.readings.keys()]).toEqual(['i1']);
	});

	it('throws bad-response on a malformed reply', async () => {
		const { fetchFn } = scriptedFetch('I am not able to transliterate these.');
		await expect(fillRomanizations(args, callOpts(fetchFn))).rejects.toMatchObject({
			kind: 'bad-response'
		});
	});

	it('spends nothing when there is nothing to ask about', async () => {
		let called = false;
		const fetchFn: FetchLike = async () => {
			called = true;
			return new Response('{}', { status: 200 });
		};

		const result = await fillRomanizations(
			{ items: [{ id: 'i1', term: '   ' }], targetLanguage: 'Mandarin Chinese' },
			callOpts(fetchFn)
		);

		expect(called).toBe(false);
		expect(result.readings.size).toBe(0);
		expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
	});
});
