/**
 * The offline path.
 *
 * The reply is canned, so what is worth testing is the half that is not: a
 * recognized message goes through the real `add_words` executor and the word it
 * names is genuinely stored, with a real card, exactly as the paid path would
 * store it. Anything the tiny parser does not recognize must change nothing at
 * all — an offline demo that quietly writes to the learner's list on a stray
 * colon would be worse than one that does nothing.
 */

import { describe, expect, it } from 'vitest';

import type { KnowledgeItem } from '$lib/types';
import { OFFLINE_REPLY, mockChat, parseWordLines } from './mock';
import type { ToolContext } from './tools';

const NOW = 1_700_000_000_000;

const profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner' as const,
	interests: [],
	model: 'test/model',
	createdAt: NOW
};

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
			deleteItem: async () => undefined,
			newId: () => `new-${++minted}`,
			now: () => NOW
		}
	};
}

function word(term: string): KnowledgeItem {
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

describe('parseWordLines', () => {
	it('reads the three separators, one pair per line', () => {
		expect(parseWordLines('hola = hello\nadiós - goodbye\nadd gato: cat')).toEqual([
			{ term: 'hola', meaning: 'hello' },
			{ term: 'adiós', meaning: 'goodbye' },
			{ term: 'gato', meaning: 'cat' }
		]);
	});

	it('ignores lines with no pair in them', () => {
		expect(parseWordLines('what can you do?\njust checking')).toEqual([]);
	});
});

describe('mockChat', () => {
	it('adds a word through the real executor', async () => {
		const store = fakeDeps();
		const turn = await mockChat([], 'hola = hello', profile, {
			deps: store.deps
		});

		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({
			term: 'hola',
			meaning: 'hello',
			kind: 'vocab'
		});
		expect(store.items[0].fsrsCard).not.toBeNull();
		expect(turn.actions).toEqual([{ tool: 'add_words', summary: 'Added 1 word: hola', ok: true }]);
		expect(turn.text).toContain('Added 1 word: hola');
	});

	it('reports a word the learner already has instead of adding it twice', async () => {
		const store = fakeDeps([word('hola')]);
		const turn = await mockChat([], 'add hola = hello', profile, {
			deps: store.deps
		});

		expect(store.items).toHaveLength(1);
		expect(turn.actions[0].summary).toContain('Nothing added');
	});

	it('reads the list back when asked what is in it', async () => {
		const store = fakeDeps([word('hola'), word('gato')]);
		const turn = await mockChat([], 'which words do I know?', profile, {
			deps: store.deps
		});

		expect(turn.actions[0].tool).toBe('list_words');
		expect(turn.text).toContain('hola');
		expect(store.items).toHaveLength(2);
	});

	it('falls back to one canned sentence and touches nothing', async () => {
		const store = fakeDeps();
		const turn = await mockChat([], 'buenos días!', profile, {
			deps: store.deps
		});

		expect(turn).toEqual({
			role: 'assistant',
			text: OFFLINE_REPLY,
			actions: []
		});
		expect(store.items).toEqual([]);
	});
});
