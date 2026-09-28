/**
 * The assistant through the wasm build's `llm` export, in mock mode, with its
 * tools writing to a real in-memory store: the Rust loop and executors, the
 * `ToolHost` bridge and the repositories' shapes, end to end.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { makeTestBackend, loadWasmCore } from '$lib/db/backend.testing';
import type { TestBackend } from '$lib/db/backend.testing';
import type { LearnerProfile, ToolContext } from '$lib/llm';
import { addWords, sendChatMessage } from './index';
import type { ChatTurn } from './index';

beforeAll(loadWasmCore);

const profile: LearnerProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: []
};

function over(backend: TestBackend): ToolContext {
	return {
		getAllItems: () => backend.getAllItems(),
		upsertItems: (items) => backend.upsertItems(items),
		deleteItem: (id) => backend.deleteItem(id),
		newId: () => crypto.randomUUID(),
		now: () => 1_700_000_000_000
	};
}

describe('sendChatMessage', () => {
	it('adds words through the real tool, once', async () => {
		const backend = await makeTestBackend();
		const tools = over(backend);
		const history: ChatTurn[] = [
			{ role: 'user', text: 'hi' },
			{ role: 'assistant', text: 'hello', actions: [] }
		];

		const turn = await sendChatMessage(history, 'hola = hello\ngato = cat', profile, { tools });
		expect(turn.role).toBe('assistant');
		expect(turn.text).toMatch(/^Added hola, gato\./);
		expect(turn.actions).toEqual([
			{ tool: 'add_words', summary: 'Added 2 words: hola, gato', ok: true }
		]);

		const items = await backend.getAllItems();
		expect(items.map((item) => item.term).sort()).toEqual(['gato', 'hola']);
		expect(items[0].introducedAt).toBe(1_700_000_000_000);
		expect(items[0].srs).toBeDefined();

		const again = await sendChatMessage([], 'Hola = hi', profile, { tools });
		expect(again.actions[0].summary).toBe('Nothing added: 1 word already in the list');
		expect(await backend.getAllItems()).toHaveLength(2);
	});

	it('reads the list back', async () => {
		const backend = await makeTestBackend();
		const tools = over(backend);
		await addWords([{ term: 'perro', meaning: 'dog' }], { tools });

		const turn = await sendChatMessage([], 'what words do I know?', profile, { tools });
		expect(turn.text).toMatch(/^Your list holds 1: perro\./);
		expect(turn.actions[0].tool).toBe('list_words');
	});

	it('rejects with the store failure, not a turn', async () => {
		const tools: ToolContext = {
			getAllItems: async () => {
				throw new Error('store is gone');
			},
			upsertItems: async () => {},
			deleteItem: async () => {},
			newId: () => 'x',
			now: () => 0
		};
		await expect(sendChatMessage([], 'hi', profile, { tools })).rejects.toThrow('store is gone');
	});
});

describe('addWords', () => {
	it('keeps two readings of a homograph as two cards', async () => {
		const backend = await makeTestBackend();
		const tools = over(backend);
		const outcome = await addWords(
			[
				{ term: '长', meaning: 'long', romanization: 'cháng' },
				{ term: '长', meaning: 'to grow', romanization: 'zhǎng' },
				{ term: '长', meaning: 'bare' }
			],
			{ tools }
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.summary).toBe('Added 2 words: 长, 长; skipped 1 already in the list');
		expect(await backend.getAllItems()).toHaveLength(2);
	});
});
