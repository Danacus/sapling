/**
 * `applyOverturn` is the one database-touching engine function worth a test:
 * it decides what happens to a learner's SRS card when a dispute is won, and
 * getting it wrong silently corrupts scheduling.
 *
 * IndexedDB does not exist in the node test environment, so `$lib/db` is
 * replaced with an in-memory stand-in here — which is also why this lives in
 * its own file rather than in `engine.test.ts`, whose subject is the pure half
 * and which must keep talking to the real module graph.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Grade, newCardState } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';

const NOW = 1_700_000_000_000;

/** The fake item table `$lib/db` is mocked onto. */
const items = new Map<string, KnowledgeItem>();

vi.mock('$lib/db', () => ({
	getItem: async (id: string) => items.get(id),
	updateItemAfterReview: async (
		id: string,
		fsrsCard: unknown,
		entry: { at: number; grade: number }
	) => {
		const item = items.get(id);
		if (!item) return false;
		items.set(id, { ...item, fsrsCard, history: [...item.history, entry] });
		return true;
	},
	// Imported by engine.ts at module load; never called from this test.
	addResult: async () => undefined,
	addXp: async () => undefined,
	enqueueChallenges: async () => undefined,
	getAllItems: async () => [...items.values()],
	getChallengesByIds: async () => [],
	markChallengeDone: async () => undefined,
	queuedCount: async () => 0,
	recentResults: async () => [],
	upsertItems: async () => undefined
}));

const { applyOverturn } = await import('./engine');

function seed(id: string): KnowledgeItem {
	const item: KnowledgeItem = {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: newCardState(NOW),
		introducedAt: NOW,
		history: []
	};
	items.set(id, item);
	return item;
}

const cloze: Challenge = {
	id: 'c1',
	type: 'cloze',
	direction: 'toTarget',
	sentence: 'Yo ___ un libro.',
	acceptedAnswers: ['leo'],
	translationHint: 'I read a book.',
	itemIds: ['i1', 'i2']
};

describe('applyOverturn', () => {
	beforeEach(() => items.clear());

	it('writes one Good review per item on the challenge', async () => {
		seed('i1');
		seed('i2');

		await applyOverturn(cloze, NOW);

		for (const id of ['i1', 'i2']) {
			const item = items.get(id);
			expect(item?.history).toEqual([{ at: NOW, grade: Grade.Good }]);
			// A Good review schedules the card into the future.
			expect((item?.fsrsCard as FsrsCardState).due).toBeGreaterThan(NOW);
			expect((item?.fsrsCard as FsrsCardState).reps).toBe(1);
		}
	});

	it('stacks on top of the Again review the wrong answer already wrote', async () => {
		const item = seed('i1');
		// What `applyResult` leaves behind for a wrong answer.
		items.set('i1', {
			...item,
			history: [{ at: NOW - 1000, grade: Grade.Again }]
		});

		await applyOverturn({ ...cloze, itemIds: ['i1'] }, NOW);

		// The lapse is not rewritten — the compensating review is appended to it.
		expect(items.get('i1')?.history).toEqual([
			{ at: NOW - 1000, grade: Grade.Again },
			{ at: NOW, grade: Grade.Good }
		]);
	});

	it('skips items that no longer exist, and match-pairs rounds entirely', async () => {
		seed('i1');

		await applyOverturn({ ...cloze, itemIds: ['i1', 'gone'] }, NOW);
		expect(items.get('i1')?.history).toHaveLength(1);
		expect(items.has('gone')).toBe(false);

		const match: Challenge = {
			id: 'm1',
			type: 'match-pairs',
			direction: 'toNative',
			itemIds: ['i1'],
			pairs: [
				{ a: 'el perro', b: 'the dog' },
				{ a: 'leer', b: 'to read' }
			]
		};
		await applyOverturn(match, NOW);
		// Still just the one review from the cloze above.
		expect(items.get('i1')?.history).toHaveLength(1);
	});
});
