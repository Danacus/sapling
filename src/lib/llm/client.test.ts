import { describe, expect, it } from 'vitest';
import { APP_REFERER, APP_TITLE, LlmError, OPENROUTER_BASE_URL, chatCompletion } from './client';
import type { FetchLike } from './client';

const KEY = 'sk-or-test';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function okCompletion(content = 'hello') {
	return {
		model: 'test/model',
		choices: [{ message: { content } }],
		usage: { prompt_tokens: 11, completion_tokens: 7 }
	};
}

interface Call {
	url: string;
	init: RequestInit;
	body: Record<string, unknown>;
}

/** Records every request and replies with the queued responses in order. */
function recordingFetch(responses: (() => Response)[]): { fetchFn: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	let n = 0;
	const fetchFn: FetchLike = async (url, init) => {
		calls.push({
			url,
			init: init ?? {},
			body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
		});
		const next = responses[Math.min(n++, responses.length - 1)];
		return next();
	};
	return { fetchFn, calls };
}

describe('chatCompletion', () => {
	const messages = [{ role: 'user' as const, content: 'hi' }];

	it('posts to OpenRouter with auth and attribution headers', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		const result = await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'test/model',
			fetchFn
		});

		expect(result.content).toBe('hello');
		expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(headers['HTTP-Referer']).toBe(APP_REFERER);
		expect(headers['X-Title']).toBe(APP_TITLE);
		expect(calls[0].body.model).toBe('test/model');
	});

	it('posts to a custom base URL when one is given, without a trailing slash', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'Qwen/Qwen3.6-35B-A3B-FP8',
			baseUrl: 'https://inference.hetzner.com/api/v1/',
			fetchFn
		});

		expect(calls[0].url).toBe('https://inference.hetzner.com/api/v1/chat/completions');
	});

	it('sends a strict json_schema response_format when a schema is given', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion('{}'))]);
		await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'm',
			fetchFn,
			responseFormat: { name: 'thing', schema: { type: 'object' } }
		});

		expect(calls[0].body.response_format).toEqual({
			type: 'json_schema',
			json_schema: { name: 'thing', strict: true, schema: { type: 'object' } }
		});
	});

	it('retries once without response_format when the model rejects it', async () => {
		const { fetchFn, calls } = recordingFetch([
			() =>
				jsonResponse(
					{ error: { message: 'Provider does not support response_format=json_schema' } },
					400
				),
			() => jsonResponse(okCompletion('{"ok":true}'))
		]);

		const result = await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'm',
			fetchFn,
			responseFormat: { name: 'thing', schema: { type: 'object' } }
		});

		expect(calls).toHaveLength(2);
		expect(calls[0].body.response_format).toBeDefined();
		expect(calls[1].body.response_format).toBeUndefined();
		expect(result.schemaDropped).toBe(true);
		expect(result.content).toBe('{"ok":true}');
	});

	it('does not retry a 400 unrelated to response_format', async () => {
		const { fetchFn, calls } = recordingFetch([
			() => jsonResponse({ error: { message: 'model not found' } }, 400)
		]);

		await expect(
			chatCompletion({
				messages,
				apiKey: KEY,
				model: 'm',
				fetchFn,
				responseFormat: { name: 'thing', schema: {} }
			})
		).rejects.toMatchObject({ kind: 'bad-response' });
		expect(calls).toHaveLength(1);
	});

	it('maps 401 to an auth error', async () => {
		const { fetchFn } = recordingFetch([
			() => jsonResponse({ error: { message: 'No auth credentials found' } }, 401)
		]);
		const error = await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn }).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('auth');
		expect((error as LlmError).status).toBe(401);
		expect((error as LlmError).message).toMatch(/Settings/);
	});

	it('maps 429 and 5xx', async () => {
		const rate = recordingFetch([() => jsonResponse({}, 429)]);
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn: rate.fetchFn })
		).rejects.toMatchObject({ kind: 'rate-limit' });

		const server = recordingFetch([() => jsonResponse({}, 503)]);
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn: server.fetchFn })
		).rejects.toMatchObject({ kind: 'server' });
	});

	it('maps a thrown fetch to a network error', async () => {
		const fetchFn: FetchLike = async () => {
			throw new TypeError('Failed to fetch');
		};
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn })
		).rejects.toMatchObject({ kind: 'network' });
	});

	it('fails with no-key when nothing is configured', async () => {
		const { fetchFn } = recordingFetch([() => jsonResponse(okCompletion())]);
		// No apiKey argument and no localStorage in node.
		await expect(chatCompletion({ messages, model: 'm', fetchFn })).rejects.toMatchObject({
			kind: 'no-key'
		});
	});

	it('rejects an empty or malformed completion body', async () => {
		const empty = recordingFetch([() => jsonResponse({ choices: [] })]);
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn: empty.fetchFn })
		).rejects.toMatchObject({ kind: 'bad-response' });

		const notJson = recordingFetch([() => new Response('<html>502</html>', { status: 200 })]);
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn: notJson.fetchFn })
		).rejects.toMatchObject({ kind: 'bad-response' });
	});
});
