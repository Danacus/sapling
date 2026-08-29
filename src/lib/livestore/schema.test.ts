/**
 * SPIKE — does a LiveStore store run under this repo's node-environment
 * vitest?
 *
 * This is the test-side half of step 1. Today `vite.config.ts` runs
 * `src/**\/*.test.ts` in `environment: 'node'` with the standing rule "pure
 * logic only — no IndexedDB, no WASM, no network", and DB-dependent logic is
 * covered by mocking `$lib/db` per file. LiveStore would change that: the
 * store *is* WASM SQLite, so either these tests run WASM or the data layer
 * goes untested.
 *
 * The upside if it works: `apply.test.ts` currently asserts that a hand-written
 * merge reproduces what the write path did. Against a real store there is only
 * one path to test.
 */
import { makeAdapter } from '@livestore/adapter-node';
import { createStorePromise } from '@livestore/livestore';
import { describe, expect, it } from 'vitest';

import { events, schema, tables } from './schema';

const store = () =>
	createStorePromise({
		adapter: makeAdapter({ storage: { type: 'in-memory' } }),
		schema,
		storeId: 'spike'
	});

describe('livestore spike', () => {
	it('materializes an added item', async () => {
		const s = await store();
		s.commit(
			events.itemAdded({
				id: 'i1',
				kind: 'vocab',
				term: '银行',
				meaning: 'bank',
				romanization: 'yínháng',
				introducedAt: 1000
			})
		);

		expect(s.query(tables.items)).toMatchObject([{ id: 'i1', term: '银行', meaning: 'bank' }]);
	});

	it('collapses a review the app submits twice instead of killing the store', async () => {
		const s = await store();
		s.commit(
			events.itemAdded({
				id: 'i1',
				kind: 'vocab',
				term: '书',
				meaning: 'book',
				introducedAt: 1000
			})
		);

		const review = { id: 'r1', itemId: 'i1', at: 2000, grade: 3, device: 'dev-a' };
		s.commit(events.itemReviewed(review));

		// NB: these are two *distinct* events — LiveStore mints its own event id
		// per commit, so `id` here is only a payload field. This is the
		// double-submit case (a retried write, a replayed outbox), not eventlog
		// replay, and without `.onConflict` it is fatal rather than merely wrong:
		// the materializer throws and the store shuts down for good.
		s.commit(events.itemReviewed(review));

		expect(s.query(tables.reviews)).toHaveLength(1);
	});

	it('derives history in order, which is what the FSRS fold consumes', async () => {
		const s = await store();
		s.commit(
			events.itemAdded({ id: 'i1', kind: 'vocab', term: '水', meaning: 'water', introducedAt: 0 })
		);
		// Committed out of order on purpose: ordering is the query's job.
		s.commit({ ...events.itemReviewed({ id: 'r2', itemId: 'i1', at: 3000, grade: 1 }) });
		s.commit({ ...events.itemReviewed({ id: 'r1', itemId: 'i1', at: 2000, grade: 3 }) });

		const history = s.query(tables.reviews.where({ itemId: 'i1' }).orderBy('at', 'asc'));
		expect(history.map((r) => r.at)).toEqual([2000, 3000]);
	});

	it('a tombstone removes the item and its reviews', async () => {
		const s = await store();
		s.commit(
			events.itemAdded({ id: 'i1', kind: 'vocab', term: '火', meaning: 'fire', introducedAt: 0 })
		);
		s.commit(events.itemReviewed({ id: 'r1', itemId: 'i1', at: 2000, grade: 3 }));
		s.commit(events.itemDeleted({ id: 'i1' }));

		expect(s.query(tables.items)).toHaveLength(0);
		expect(s.query(tables.reviews)).toHaveLength(0);
	});
});
