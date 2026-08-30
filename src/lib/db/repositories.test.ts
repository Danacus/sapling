/**
 * Repository-level query shape: the things worth pinning down are that a lean
 * read stays lean (`poolSize`, `getAllItems`'s default column list) and that a
 * narrower `WHERE` still tells the truth (`upsertItems`'s add-vs-update split).
 *
 * Runs against a real store — the same WASM SQLite the browser runs, in
 * memory — so what is asserted is the query's actual behaviour.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getAllItems, getItem, poolSize, upsertItems } from '$lib/db';
import { setStoreForTesting, type Store } from './store';
import { makeTestStore } from './store.testing';
import { newCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';

let store: Store;

beforeEach(async () => {
	store = await makeTestStore();
	setStoreForTesting(store);
});

function item(id: string, term: string, introducedAt: number): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term,
		meaning: 'book',
		introducedAt,
		fsrsCard: newCardState(introducedAt),
		history: []
	};
}

const challenge = {
	id: 'c1',
	type: 'multiple-choice',
	direction: 'toTarget',
	itemIds: ['i1'],
	prompt: 'book?',
	options: ['书', '水'],
	answerIndex: 0
} as unknown as Challenge;

describe('poolSize', () => {
	it('counts the pool without reading its rows', async () => {
		expect(await poolSize()).toBe(0);

		await store.commit('challengeAdded', { challenge, generatedAt: 1000 });
		expect(await poolSize()).toBe(1);
	});

	it('excludes reported challenges, same as getPool', async () => {
		await store.commit('challengeAdded', { challenge, generatedAt: 1000 });
		await store.commit('challengeReported', { challengeId: 'c1' });

		expect(await poolSize()).toBe(0);
	});
});

describe('getAllItems', () => {
	it('omits recentGrades by default', async () => {
		await upsertItems([item('i1', '书', 1000)]);
		await store.commit('itemReviewed', { device: 'dev', at: 2000, itemId: 'i1', grade: 3 });

		const [loaded] = await getAllItems();
		expect(loaded.recentGrades).toBeUndefined();
		// The aggregates that are single columns still come along.
		expect(loaded.reviewCount).toBe(1);
		expect(loaded.correctCount).toBe(1);
		expect(loaded.history).toEqual([]);
	});

	it('carries recentGrades when asked for it, matching getItem', async () => {
		await upsertItems([item('i1', '书', 1000)]);
		await store.commit('itemReviewed', { device: 'dev', at: 2000, itemId: 'i1', grade: 3 });

		const [loaded] = await getAllItems({ withRecentGrades: true });
		const alone = await getItem('i1');

		expect(loaded.recentGrades).toEqual([{ at: 2000, grade: 3 }]);
		expect(loaded.recentGrades).toEqual(alone?.recentGrades);
	});
});

describe('upsertItems', () => {
	it('adds a new id and updates a known one, in the same call', async () => {
		await upsertItems([item('i1', '书', 1000)]);

		// i1 already exists; i2 is new. One call, two different fact types.
		await upsertItems([item('i1', '書', 1000), item('i2', '旧', 1500)]);

		const updated = await getItem('i1');
		const added = await getItem('i2');

		// itemUpdated never touches introducedAt or the card — only itemAdded does
		// — so a wrong add/update split would show up here as a clobbered date.
		expect(updated?.term).toBe('書');
		expect(updated?.introducedAt).toBe(1000);
		expect(added?.term).toBe('旧');
		expect(added?.introducedAt).toBe(1500);
	});

	it('still tells add from update when more ids are known than are passed', async () => {
		// Several existing items, so the fix (WHERE id IN (...) over the passed
		// ids) is actually exercised rather than degenerating to "the only row".
		await upsertItems([item('i1', 'a', 1), item('i2', 'b', 2), item('i3', 'c', 3)]);

		await upsertItems([item('i2', 'b2', 2), item('i4', 'd', 4)]);

		expect((await getItem('i2'))?.term).toBe('b2');
		expect((await getItem('i2'))?.introducedAt).toBe(2);
		expect((await getItem('i4'))?.introducedAt).toBe(4);
	});
});
