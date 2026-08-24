/**
 * The real chat loop, driven against a fake OpenRouter.
 *
 * What matters here is the exchange, not the prose: that the tools are offered
 * on every request, that a tool call is executed and its result fed back under
 * the id the model used (the API rejects anything else), that the executed call
 * surfaces as an `ActionNote` on the returned turn, and that the loop always
 * terminates — on prose, on a failed call, or on the round cap.
 *
 * Node has no API key, so `sendChatMessage` would dispatch to the offline mock;
 * these tests call {@link runChat} directly with an injected key, fetch and tool
 * context, which is the same path production takes.
 */

import { describe, expect, it } from 'vitest';

import type { FetchLike } from '$lib/llm';
import type { KnowledgeItem, Profile } from '$lib/types';
import { MAX_TOOL_ROUNDS, ROUND_LIMIT_REPLY, runChat } from './chat';
import type { ToolContext } from './tools';

const NOW = 1_700_000_000_000;

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: [],
	dailyGoalXp: 50,
	model: 'test/model',
	createdAt: NOW
};

interface WireMessage {
	role: string;
	content: string;
	tool_call_id?: string;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

interface Call {
	messages: WireMessage[];
	tools?: { function: { name: string } }[];
}

/** Replies with the queued completions in order, repeating the last one. */
function fakeOpenRouter(payloads: unknown[]): {
	fetchFn: FetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	let n = 0;
	const fetchFn: FetchLike = async (_url, init) => {
		calls.push(JSON.parse(String(init?.body ?? '{}')) as Call);
		const payload = payloads[Math.min(n++, payloads.length - 1)];
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	};
	return { fetchFn, calls };
}

function saying(content: string) {
	return {
		model: 'test/model',
		choices: [{ message: { content } }],
		usage: { prompt_tokens: 10, completion_tokens: 5 }
	};
}

function calling(name: string, args: string, id = 'call-1') {
	return {
		model: 'test/model',
		choices: [
			{
				message: {
					content: '',
					tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
				}
			}
		],
		usage: { prompt_tokens: 10, completion_tokens: 5 }
	};
}

function fakeDeps(seed: KnowledgeItem[] = []): {
	deps: Partial<ToolContext>;
	items: KnowledgeItem[];
} {
	const items = [...seed];
	let minted = 0;
	return {
		items,
		deps: {
			getAllItems: async () => [...items],
			upsertItems: async (rows) => {
				for (const row of rows) items.push(row);
			},
			deleteItem: async (id) => {
				const at = items.findIndex((row) => row.id === id);
				if (at >= 0) items.splice(at, 1);
			},
			newId: () => `new-${++minted}`,
			now: () => NOW
		}
	};
}

function knownWord(term: string): KnowledgeItem {
	return {
		id: `seed-${term}`,
		kind: 'vocab',
		term,
		meaning: 'x',
		fsrsCard: {},
		introducedAt: NOW,
		history: []
	};
}

describe('runChat', () => {
	it('runs a tool call and feeds its result back to the model', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[{"term":"hola","meaning":"hello"}]}'),
			saying('Added hola for you.')
		]);
		const store = fakeDeps();

		const turn = await runChat([], 'add hola', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(turn).toEqual({
			role: 'assistant',
			text: 'Added hola for you.',
			actions: [{ tool: 'add_words', summary: 'Added 1 word: hola', ok: true }]
		});
		expect(store.items.map((row) => row.term)).toEqual(['hola']);

		expect(calls).toHaveLength(2);
		expect(calls[0].tools?.map((tool) => tool.function.name)).toContain('add_words');
		expect(calls[0].messages[0].role).toBe('system');

		// The follow-up carries the assistant's tool call and the answer to it,
		// keyed by the id the model used.
		const second = calls[1].messages;
		expect(second[second.length - 2].tool_calls?.[0].id).toBe('call-1');
		const toolMessage = second[second.length - 1];
		expect(toolMessage.role).toBe('tool');
		expect(toolMessage.tool_call_id).toBe('call-1');
		expect(JSON.parse(toolMessage.content)).toEqual({
			added: ['hola'],
			skipped: []
		});
	});

	it('states the learner and their word count in the system prompt', async () => {
		const { fetchFn, calls } = fakeOpenRouter([saying('Hi.')]);
		const store = fakeDeps([knownWord('hola'), knownWord('gato')]);

		await runChat(
			[
				{ role: 'user', text: 'earlier' },
				{ role: 'assistant', text: 'ok', actions: [] }
			],
			'and now?',
			profile,
			{
				apiKey: 'test',
				fetchFn,
				deps: store.deps
			}
		);

		const [system, ...rest] = calls[0].messages;
		expect(system.content).toContain('Spanish');
		expect(system.content).toContain('English');
		expect(system.content).toContain('2 words');
		// History travels as prose only: no tool plumbing is replayed.
		expect(rest).toEqual([
			{ role: 'user', content: 'earlier' },
			{ role: 'assistant', content: 'ok' },
			{ role: 'user', content: 'and now?' }
		]);
	});

	it('returns prose with no actions when the model calls nothing', async () => {
		const { fetchFn, calls } = fakeOpenRouter([saying('"gato" means cat.')]);
		const store = fakeDeps();

		const turn = await runChat([], 'what does gato mean?', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(turn.text).toBe('"gato" means cat.');
		expect(turn.actions).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it('answers malformed arguments with an error result and keeps going', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[{"term":'),
			saying('Sorry, I could not add that.')
		]);
		const store = fakeDeps();

		const turn = await runChat([], 'add something', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(turn.text).toBe('Sorry, I could not add that.');
		expect(turn.actions).toHaveLength(1);
		expect(turn.actions[0].ok).toBe(false);
		expect(store.items).toEqual([]);

		const fed = calls[1].messages[calls[1].messages.length - 1];
		expect(JSON.parse(fed.content)).toMatchObject({
			error: expect.stringContaining('JSON')
		});
	});

	it('stops at the round cap when the model never stops calling tools', async () => {
		const { fetchFn, calls } = fakeOpenRouter([calling('list_words', '{}')]);
		const store = fakeDeps([knownWord('hola')]);

		const turn = await runChat([], 'keep going', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(turn.actions).toHaveLength(MAX_TOOL_ROUNDS);
		expect(turn.text).toBe(ROUND_LIMIT_REPLY);
	});
});
