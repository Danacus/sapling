/**
 * Does a LiveStore store run under this repo's node-environment vitest, and do
 * the basic materializers do what they say?
 *
 * The step-1 spike's infrastructure question, kept: `vite.config.ts` runs
 * `src/**\/*.test.ts` in `environment: 'node'` under a standing "pure logic
 * only — no WASM" rule, and these tests deliberately break it. They pass, and
 * the whole suite still runs in about two seconds, which is the evidence for
 * changing that rule rather than working around it.
 *
 * The merge rules of `docs/sync.md` §4 are asserted next door in `merge.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { events, tables } from './schema';
import { makeTestStore } from './store.testing';

describe('livestore schema', () => {
	it('materializes an added item', async () => {
		const store = await makeTestStore();
		store.commit(
			events.itemAdded({
				id: 'i1',
				kind: 'vocab',
				term: '银行',
				meaning: 'bank',
				romanization: 'yínháng',
				introducedAt: 1000
			})
		);

		expect(store.query(tables.items)).toMatchObject([
			{ id: 'i1', term: '银行', meaning: 'bank', romanization: 'yínháng' }
		]);
	});

	it('leaves an absent optional field null rather than undefined', async () => {
		const store = await makeTestStore();
		store.commit(
			events.itemAdded({ id: 'i1', kind: 'vocab', term: '书', meaning: 'book', introducedAt: 1 })
		);

		expect(store.query(tables.items)[0]).toMatchObject({ romanization: null, notes: null });
	});

	it('collapses a review the app submits twice instead of killing the store', async () => {
		const store = await makeTestStore();
		store.commit(
			events.itemAdded({ id: 'i1', kind: 'vocab', term: '书', meaning: 'book', introducedAt: 1000 })
		);

		const review = { itemId: 'i1', at: 2000, grade: 3, device: 'dev-a' };
		store.commit(events.itemReviewed({ ...review }));
		// A distinct event carrying the same `(itemId, at, device)` identity — a
		// retried write, or a replayed outbox. Without `.onConflict` this is not
		// merely wrong, it is fatal: the materializer throws and the store shuts
		// down for good.
		store.commit(events.itemReviewed({ ...review }));

		expect(store.query(tables.reviews)).toHaveLength(1);
		// The store is still alive, which is the half that actually mattered.
		expect(store.query(tables.items)).toHaveLength(1);
	});

	it('orders history by at, which is what the FSRS fold consumes', async () => {
		const store = await makeTestStore();
		store.commit(
			events.itemAdded({ id: 'i1', kind: 'vocab', term: '水', meaning: 'water', introducedAt: 0 })
		);
		// Committed newest-first on purpose: ordering is the query's job.
		store.commit(events.itemReviewed({ itemId: 'i1', at: 3000, grade: 1, device: 'dev-a' }));
		store.commit(events.itemReviewed({ itemId: 'i1', at: 2000, grade: 3, device: 'dev-a' }));

		const history = store.query(tables.reviews.where({ itemId: 'i1' }).orderBy('at', 'asc'));
		expect(history.map((row) => row.at)).toEqual([2000, 3000]);
	});
});
