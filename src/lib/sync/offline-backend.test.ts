/**
 * The "sync is off" backend, exercised against a real store.
 *
 * This suite exists because of a bug it now prevents. A backend whose `pull`
 * *fails* — which reads as the honest encoding of "there is no server" — hangs
 * store creation outright: the leader waits on that stream forever and the app
 * never boots. Nothing about the types says so, and no other test would have
 * caught it, because every other suite builds a store with no sync at all.
 *
 * So the assertion that matters is the boring one: a store configured this way
 * *starts*, and keeps working afterwards. Everything here runs on the node
 * adapter with in-memory storage, so it needs no network and belongs in the
 * ordinary suite.
 */
import { makeAdapter } from '@livestore/adapter-node';
import { createStorePromise } from '@livestore/livestore';
import { describe, expect, it } from 'vitest';

import { events, schema, tables } from '$lib/livestore/schema';

import { offlineSyncBackend } from './offline-backend';

const makeOfflineStore = (clientId: string) =>
	createStorePromise({
		adapter: makeAdapter({
			storage: { type: 'in-memory' },
			clientId,
			sync: { backend: offlineSyncBackend, onSyncError: 'ignore' }
		}),
		schema,
		storeId: 'sapling'
	});

const item = (id: string, introducedAt: number) =>
	events.itemAdded({
		id,
		kind: 'vocab' as const,
		term: `词${id}`,
		meaning: `word ${id}`,
		introducedAt
	});

describe('offlineSyncBackend', () => {
	it('lets a store boot at all', async () => {
		// The regression. If `pull` ever goes back to failing, this never resolves
		// and the suite times out here rather than in whatever ran next.
		const store = await makeOfflineStore('offline-boot');
		expect(store.query(tables.items.select())).toHaveLength(0);
	});

	it('reads and writes normally, and stays healthy once pushes have been refused', async () => {
		const store = await makeOfflineStore('offline-writes');

		for (let i = 0; i < 25; i++) store.commit(item(`item-${i}`, i));
		expect(store.query(tables.items.select())).toHaveLength(25);

		// Long enough for the sync processor to have tried, and failed, to push
		// that batch. A store that only worked until its first refused push would
		// be worse than no sync at all.
		await new Promise((resolve) => setTimeout(resolve, 1500));

		store.commit(item('item-late', 99));
		expect(store.query(tables.items.select())).toHaveLength(26);
	});
});
