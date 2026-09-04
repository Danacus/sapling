import { describe, expect, it } from 'vitest';
import { APP_REFERER, APP_TITLE, LlmError, OPENROUTER_BASE_URL, chatCompletion } from './client';
import type { ChatMessage, FetchLike, ToolDef } from './client';

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
		// CORS: non-OpenRouter endpoints reject the attribution headers in preflight.
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers['HTTP-Referer']).toBeUndefined();
		expect(headers['X-Title']).toBeUndefined();
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	it('opts in to browser CORS on the Anthropic endpoint', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'claude-sonnet-4-6',
			baseUrl: 'https://api.anthropic.com/v1',
			fetchFn
		});

		expect(calls[0].url).toBe('https://api.anthropic.com/v1/chat/completions');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
		expect(headers['HTTP-Referer']).toBeUndefined();
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

	it('lets an abort through as an abort, not as a network failure', async () => {
		// A lesson is several concurrent completions on one signal (see
		// `generate.ts`); if a cancelled call came back as `LlmError('network')`,
		// quitting a refill would look to the learner like the network died.
		const controller = new AbortController();
		const fetchFn: FetchLike = async (_url, init) => {
			controller.abort();
			const error = new Error('aborted');
			error.name = 'AbortError';
			void init;
			throw error;
		};
		const error = await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'm',
			fetchFn,
			signal: controller.signal
		}).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(LlmError);
		expect((error as Error).name).toBe('AbortError');
	});

	it('forwards the caller signal to every fetch, retry included', async () => {
		const controller = new AbortController();
		const { fetchFn, calls } = recordingFetch([
			() => jsonResponse({ error: { message: 'response_format unsupported' } }, 400),
			() => jsonResponse(okCompletion())
		]);
		await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'm',
			fetchFn,
			responseFormat: 'json',
			signal: controller.signal
		});

		expect(calls).toHaveLength(2);
		for (const call of calls) expect(call.init.signal).toBe(controller.signal);
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

	it('serializes plain messages without tool fields', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		const result = await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn });

		expect(calls[0].body.messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(calls[0].body.tools).toBeUndefined();
		expect(result.toolCalls).toEqual([]);
	});
});

const ADD_WORD: ToolDef = {
	name: 'add_word',
	description: 'Add a word to the list',
	parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] }
};

function toolCallCompletion(toolCalls: unknown, content: unknown = undefined) {
	return {
		model: 'test/model',
		choices: [
			{ message: { ...(content === undefined ? {} : { content }), tool_calls: toolCalls } }
		],
		usage: { prompt_tokens: 3, completion_tokens: 2 }
	};
}

describe('chatCompletion tool calling', () => {
	const messages = [{ role: 'user' as const, content: 'add "hond"' }];

	it('serializes tools to the OpenAI function shape', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn, tools: [ADD_WORD] });

		expect(calls[0].body.tools).toEqual([
			{
				type: 'function',
				function: {
					name: 'add_word',
					description: 'Add a word to the list',
					parameters: ADD_WORD.parameters
				}
			}
		]);
		// Default (auto) tool choice; we never pin one.
		expect(calls[0].body.tool_choice).toBeUndefined();
	});

	it('omits tools when the array is empty', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion())]);
		await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn, tools: [] });

		expect(calls[0].body.tools).toBeUndefined();
	});

	it('sends tools on the response_format retry too', async () => {
		const { fetchFn, calls } = recordingFetch([
			() => jsonResponse({ error: { message: 'response_format unsupported' } }, 400),
			() => jsonResponse(okCompletion('{}'))
		]);
		await chatCompletion({
			messages,
			apiKey: KEY,
			model: 'm',
			fetchFn,
			tools: [ADD_WORD],
			responseFormat: 'json'
		});

		expect(calls).toHaveLength(2);
		expect(calls[1].body.response_format).toBeUndefined();
		expect(calls[1].body.tools).toBeDefined();
	});

	it('round-trips an assistant tool call and its result to the wire shape', async () => {
		const { fetchFn, calls } = recordingFetch([() => jsonResponse(okCompletion('done'))]);
		const exchange: ChatMessage[] = [
			{ role: 'user', content: 'add "hond"' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 'call_1', name: 'add_word', arguments: '{"term":"hond"}' }]
			},
			{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' }
		];
		await chatCompletion({ messages: exchange, apiKey: KEY, model: 'm', fetchFn });

		expect(calls[0].body.messages).toEqual([
			{ role: 'user', content: 'add "hond"' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'add_word', arguments: '{"term":"hond"}' }
					}
				]
			},
			{ role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' }
		]);
	});

	it('parses tool calls from a response with no content', async () => {
		const { fetchFn } = recordingFetch([
			() =>
				jsonResponse(
					toolCallCompletion([
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'add_word', arguments: '{"term":"hond"}' }
						}
					])
				)
		]);
		const result = await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn });

		expect(result.content).toBe('');
		expect(result.toolCalls).toEqual([
			{ id: 'call_1', name: 'add_word', arguments: '{"term":"hond"}' }
		]);
		expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
	});

	it('keeps content that arrives alongside tool calls', async () => {
		const { fetchFn } = recordingFetch([
			() =>
				jsonResponse(
					toolCallCompletion(
						[{ id: 'call_1', function: { name: 'add_word', arguments: '{}' } }],
						'Adding it now.'
					)
				)
		]);
		const result = await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn });

		expect(result.content).toBe('Adding it now.');
		expect(result.toolCalls).toHaveLength(1);
	});

	it('skips malformed tool call entries and defaults missing arguments', async () => {
		const { fetchFn } = recordingFetch([
			() =>
				jsonResponse(
					toolCallCompletion([
						{ function: { name: 'add_word', arguments: '{}' } }, // no id
						{ id: 'call_2' }, // no function
						{ id: 'call_3', function: { name: '' } }, // empty name
						{ id: 'call_4', function: { name: 'list_words' } }, // no arguments
						{ id: 'call_5', function: { name: 'list_words', arguments: { term: 'x' } } },
						'nonsense'
					])
				)
		]);
		const result = await chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn });

		expect(result.toolCalls).toEqual([
			{ id: 'call_4', name: 'list_words', arguments: '{}' },
			{ id: 'call_5', name: 'list_words', arguments: '{}' }
		]);
	});

	it('still rejects a response with neither content nor usable tool calls', async () => {
		const { fetchFn } = recordingFetch([
			() => jsonResponse(toolCallCompletion([{ function: { name: 'add_word' } }]))
		]);
		await expect(
			chatCompletion({ messages, apiKey: KEY, model: 'm', fetchFn })
		).rejects.toMatchObject({ kind: 'bad-response' });
	});
});
