/**
 * `runDexieMigration` end to end, including the once-only marker.
 *
 * The marker is the half that cannot be asserted on the pure function: it lives
 * in the store, as a client-only document in the same OPFS database as the data
 * it describes. That placement is the fix step 4b exists for — it used to be a
 * `localStorage` key, in a bucket that can be cleared independently of the one
 * holding the migrated events.
 *
 * The Dexie read is mocked because vitest runs in node with no IndexedDB. That
 * is the whole reason `migrationEvents` is pure and this wrapper is thin: only
 * the wrapper needs a mock, and it has almost nothing in it to get wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LegacySnapshot } from '$lib/db/legacy-snapshot';
import type { KnowledgeItem, Profile } from '$lib/types';

import { runDexieMigration } from './migrate-dexie';
import { MIGRATION_STATE_ID, tables } from './schema';
import { makeTestStore } from './store.testing';

const profile: Profile = {
	nativeLanguage: 'nl',
	targetLanguage: 'Mandarin Chinese',
	level: 'beginner',
	interests: ['food'],
	model: 'mock',
	createdAt: 1000
};

const item: KnowledgeItem = {
	id: 'i1',
	kind: 'vocab',
	term: '书',
	meaning: 'book',
	fsrsCard: null,
	introducedAt: 1000,
	history: [{ at: 2000, grade: 3 }]
};

const emptySnapshot: LegacySnapshot = { profile: null, items: [], pool: [], results: [] };
let snapshot: LegacySnapshot = emptySnapshot;

vi.mock('$lib/db/legacy-snapshot', () => ({
	readLegacySnapshot: () => Promise.resolve(snapshot),
	isEmptySnapshot: (s: LegacySnapshot) =>
		s.profile === null && s.items.length === 0 && s.pool.length === 0 && s.results.length === 0
}));

const migratedAt = (store: Awaited<ReturnType<typeof makeTestStore>>) =>
	store.query(tables.migrationState.get(MIGRATION_STATE_ID)).dexieMigratedAt;

describe('runDexieMigration', () => {
	beforeEach(() => {
		snapshot = { profile, items: [item], pool: [], results: [] };
	});

	it('carries the library across and records that it did', async () => {
		const store = await makeTestStore();
		expect(migratedAt(store)).toBe(0);

		const committed = await runDexieMigration(store);

		expect(committed).toBeGreaterThan(0);
		expect(store.query(tables.items).map((i) => i.id)).toEqual(['i1']);
		expect(migratedAt(store)).toBeGreaterThan(0);
	});

	it('is a no-op the second time, without re-reading Dexie', async () => {
		const store = await makeTestStore();
		await runDexieMigration(store);

		// If the marker were not read from the store, this would append the whole
		// library to the eventlog again — every boot, for ever, since the log is
		// append-only and the materializers would quietly ignore every event.
		expect(await runDexieMigration(store)).toBe(0);
		expect(store.query(tables.items)).toHaveLength(1);
		expect(store.query(tables.reviews)).toHaveLength(1);
	});

	it('marks an empty legacy database so a fresh install stops looking', async () => {
		snapshot = emptySnapshot;
		const store = await makeTestStore();

		expect(await runDexieMigration(store)).toBe(0);
		expect(migratedAt(store)).toBeGreaterThan(0);
		expect(await runDexieMigration(store)).toBe(0);
	});

	it('survives a store that has already been migrated into by hand', async () => {
		// The marker travels with the data, so a store restored from an eventlog
		// that already contains a migration does not run one again.
		const store = await makeTestStore();
		await runDexieMigration(store);
		const first = migratedAt(store);

		await runDexieMigration(store);
		expect(migratedAt(store)).toBe(first);
	});
});
