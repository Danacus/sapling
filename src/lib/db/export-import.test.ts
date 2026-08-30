/**
 * The JSON escape hatch, against LiveStore.
 *
 * `exportData` now writes the v3 envelope (`{version: 3, exportedAt, events}`)
 * that the next Sapling build reads back — this build only needs to produce
 * it. `importData` still restores v1/v2 dumps, the one route by which a file
 * written by the old Dexie build can arrive.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { exportData, getAllItems, importData } from '$lib/db';
import type { ExportEnvelope } from '$lib/db';
import { events } from '$lib/livestore/schema';
import { setStoreForTesting } from '$lib/livestore/store';
import { makeTestStore } from '$lib/livestore/store.testing';
import { reviewKey } from '$lib/livestore/tables';
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

/** Seeds one row of every kind `exportData` walks, including a reported challenge. */
function seedOneOfEach(): void {
	store.commit(events.profileUpdated(profile));
	store.commit(
		events.itemAdded({ id: 'i1', kind: 'vocab', term: '书', meaning: 'book', introducedAt: 1000 })
	);
	store.commit(events.itemReviewed({ device: 'dev-a', at: 2000, itemId: 'i1', grade: 3 }));
	store.commit(
		events.itemAdded({ id: 'i2', kind: 'vocab', term: '旧', meaning: 'old', introducedAt: 1500 })
	);
	store.commit(events.itemDeleted({ itemId: 'i2' }));
	store.commit(
		events.challengeAdded({
			challenge: { id: 'c1', type: 'multiple-choice' },
			generatedAt: 3000
		})
	);
	store.commit(events.challengeReported({ challengeId: 'c1' }));
	store.commit(events.challengeServed({ eventId: 'serve-1', challengeId: 'c1', at: 4000 }));
	store.commit(
		events.resultLogged({
			eventId: 'result-1',
			challengeId: 'c1',
			verdict: 'correct',
			answerGiven: '书',
			at: 5000
		})
	);
}

describe('export / import', () => {
	it('turns every table row into exactly one event with a deterministic id', async () => {
		seedOneOfEach();

		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		expect(envelope.version).toBe(3);

		const byId = new Map(envelope.events.map((event) => [event.id, event]));
		expect(byId.get('profile')).toMatchObject({ type: 'profileUpdated', at: 1000 });
		expect(byId.get('item:i1')).toMatchObject({ type: 'itemAdded', at: 1000 });
		expect(byId.get('item:i2')).toBeUndefined();
		expect(byId.get(`review:${reviewKey('i1', 2000, 'dev-a')}`)).toMatchObject({
			type: 'itemReviewed',
			at: 2000,
			device: 'dev-a'
		});
		expect(byId.get('tombstone:i2')).toMatchObject({ type: 'itemDeleted', at: 0 });
		expect(byId.get('challenge:c1')).toMatchObject({ type: 'challengeAdded', at: 3000 });
		expect(byId.get('reported:c1')).toMatchObject({ type: 'challengeReported', at: 3000 });
		expect(byId.get('serve-1')).toMatchObject({ type: 'challengeServed', at: 4000 });
		expect(byId.get('result-1')).toMatchObject({ type: 'resultLogged', at: 5000 });
		expect(envelope.events).toHaveLength(8);
	});

	it('produces identical events across two consecutive exports', async () => {
		seedOneOfEach();

		const first = (JSON.parse(await exportData()) as ExportEnvelope).events;
		const second = (JSON.parse(await exportData()) as ExportEnvelope).events;

		expect(second).toEqual(first);
	});

	it('rejects a v3 export', async () => {
		const v3 = JSON.stringify({ version: 3, exportedAt: 1, events: [] });
		await expect(importData(v3)).rejects.toThrow(
			'v3 exports are read by the next version of Sapling'
		);
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
