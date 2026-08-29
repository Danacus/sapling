/**
 * The JSON escape hatch, against LiveStore.
 *
 * `exportData`/`importData` matter more than usual during a storage migration:
 * they are the learner's only way to move data by hand, and the one route by
 * which a file written by the *old* Dexie build can still arrive. So this
 * asserts both directions, including an envelope of the shape the old build
 * produced — items carrying a stored `fsrsCard`, which the new import must
 * ignore in favour of replaying `history`.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { exportData, getAllItems, getProfile, importData } from '$lib/db';
import { events } from '$lib/livestore/schema';
import { setStoreForTesting } from '$lib/livestore/store';
import { makeTestStore } from '$lib/livestore/store.testing';
import { newCardState, reviewCard } from '$lib/srs';
import type { Profile } from '$lib/types';

let store: Awaited<ReturnType<typeof makeTestStore>>;

beforeEach(async () => {
	store = await makeTestStore();
	setStoreForTesting(store);
});

const profile: Profile = {
	nativeLanguage: 'nl',
	targetLanguage: 'Mandarin Chinese',
	level: 'beginner',
	interests: ['food'],
	model: 'mock',
	createdAt: 1000
};

describe('export / import', () => {
	it('round-trips profile and items through LiveStore', async () => {
		store.commit(events.profileUpdated(profile));
		store.commit(
			events.itemAdded({
				id: 'i1',
				kind: 'vocab',
				term: '书',
				meaning: 'book',
				romanization: 'shū',
				introducedAt: 1000
			})
		);
		store.commit(events.itemReviewed({ device: 'dev-a', at: 2000, itemId: 'i1', grade: 3 }));

		const json = await exportData();

		// A different store entirely — this is the restore-onto-a-new-device case.
		const fresh = await makeTestStore();
		setStoreForTesting(fresh);
		await importData(json);

		expect(await getProfile()).toMatchObject({ targetLanguage: 'Mandarin Chinese' });
		const [item] = await getAllItems();
		expect(item).toMatchObject({ id: 'i1', term: '书', romanization: 'shū' });
		expect(item.history.map((h) => [h.at, h.grade])).toEqual([[2000, 3]]);
	});

	it('accepts a v2 envelope written by the old Dexie build', async () => {
		// The old build stored a card alongside history. The new one derives the
		// card, so the stored one must be ignored rather than trusted — and the
		// derived result must still reflect the review that produced it.
		const stored = reviewCard(newCardState(1000), 3, 2000);
		const legacy = JSON.stringify({
			version: 2,
			exportedAt: 9999,
			profile,
			items: [
				{
					id: 'i1',
					kind: 'vocab',
					term: '书',
					meaning: 'book',
					fsrsCard: stored,
					introducedAt: 1000,
					history: [{ at: 2000, grade: 3 }]
				}
			]
		});

		await importData(legacy);

		const [item] = await getAllItems();
		expect(item.history.map((h) => [h.at, h.grade])).toEqual([[2000, 3]]);
		// Derived from the same history through the same pure function, so it
		// agrees with what the old build had stored.
		expect(item.fsrsCard).toEqual(stored);
	});

	it('replaces existing items rather than merging into them', async () => {
		store.commit(
			events.itemAdded({
				id: 'old',
				kind: 'vocab',
				term: '旧',
				meaning: 'old',
				introducedAt: 1
			})
		);

		await importData(
			JSON.stringify({
				version: 2,
				exportedAt: 1,
				profile: null,
				items: [{ id: 'new', kind: 'vocab', term: '新', meaning: 'new', introducedAt: 2 }]
			})
		);

		expect((await getAllItems()).map((i) => i.id)).toEqual(['new']);
	});

	it('rejects an unsupported envelope version', async () => {
		await expect(importData(JSON.stringify({ version: 99, items: [] }))).rejects.toThrow(
			/unsupported export version/
		);
	});
});
