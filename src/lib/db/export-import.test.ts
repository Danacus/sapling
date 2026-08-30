/**
 * The JSON escape hatch.
 *
 * `exportData` writes the log itself (`{version: 3, exportedAt, events}`), so a
 * dump is complete — pool, serves and results included — and importing one is a
 * union rather than a replacement. v1/v2 envelopes predate the log and still
 * restore, because they are the only route by which a file written by the old
 * Dexie build can arrive.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	addResult,
	addToPool,
	deleteItem,
	exportData,
	getAllItems,
	getDailyActivity,
	getItem,
	getPool,
	getProfile,
	importData,
	recordServe,
	saveProfile,
	updateItemAfterReview,
	upsertItems,
	type ExportEnvelope
} from '$lib/db';
import { newCardState, reviewCard } from '$lib/srs';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import { setStoreForTesting, type Store } from './store';
import { makeTestStore } from './store.testing';

let store: Store;

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

const challenge = {
	id: 'c1',
	type: 'multiple-choice',
	direction: 'toTarget',
	itemIds: ['i1'],
	prompt: 'book?',
	options: ['书', '水'],
	answerIndex: 0
} as unknown as Challenge;

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

/** Seeds one write of every kind, through the repositories that produce them. */
async function seedOneOfEach(): Promise<void> {
	await saveProfile(profile);
	await upsertItems([item('i1', '书', 1000), item('i2', '旧', 1500)]);
	await updateItemAfterReview('i1', (card) => card, { at: 2000, grade: 3 });
	await deleteItem('i2');
	await addToPool([challenge], 3000);
	await recordServe('c1', 4000);
	await addResult({ challengeId: 'c1', verdict: 'correct', answerGiven: '书', at: 5000 });
}

describe('export', () => {
	it('writes the whole log, one event per write', async () => {
		await seedOneOfEach();

		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		expect(envelope.version).toBe(3);
		expect(envelope.events.map((event) => event.type).sort()).toEqual([
			'challengeAdded',
			'challengeServed',
			'itemAdded',
			'itemAdded',
			'itemDeleted',
			'itemReviewed',
			'profileUpdated',
			'resultLogged'
		]);
	});

	it('produces identical events across two consecutive exports', async () => {
		await seedOneOfEach();

		const first = (JSON.parse(await exportData()) as ExportEnvelope).events;
		const second = (JSON.parse(await exportData()) as ExportEnvelope).events;

		expect(second).toEqual(first);
	});

	it('round-trips the whole read model into a fresh store', async () => {
		// The pool is the sharp end: a whole action's events share a millisecond,
		// so a replay ordered by `at` could put the serve before the challenge it
		// stamps and silently lose it. The file carries the causal order instead.
		await seedOneOfEach();
		const dump = await exportData();
		const before = {
			items: await getAllItems(),
			pool: await getPool(),
			profile: await getProfile(),
			activity: await getDailyActivity()
		};

		setStoreForTesting(await makeTestStore());
		await importData(dump);

		expect(await getAllItems()).toEqual(before.items);
		expect(await getPool()).toEqual(before.pool);
		expect(await getProfile()).toEqual(before.profile);
		expect(await getDailyActivity()).toEqual(before.activity);
	});

	it('skips an event it cannot parse and keeps the rest', async () => {
		await seedOneOfEach();
		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		envelope.events.push({ id: 'junk', type: 'itemAdded', at: 1, device: 'devA', payload: {} });

		setStoreForTesting(await makeTestStore());
		await importData(JSON.stringify(envelope));

		expect((await getAllItems()).map((row) => row.id)).toEqual(['i1']);
	});
});

describe('legacy import', () => {
	it('accepts a v2 envelope written by the old Dexie build', async () => {
		// The old build stored a card alongside history. The new one folds the card
		// from the reviews, so the stored one is ignored rather than trusted — and
		// the result must still be the card the old build had.
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

		const restored = await getItem('i1');
		expect(restored?.history.map((entry) => [entry.at, entry.grade])).toEqual([[2000, 3]]);
		expect(restored?.fsrsCard).toEqual(stored);
		expect(restored).toMatchObject({ reviewCount: 1, correctCount: 1 });
	});

	it('replaces existing items rather than merging into them', async () => {
		await upsertItems([item('old', '旧', 1)]);

		await importData(
			JSON.stringify({
				version: 2,
				exportedAt: 1,
				profile: null,
				items: [{ id: 'new', kind: 'vocab', term: '新', meaning: 'new', introducedAt: 2 }]
			})
		);

		expect((await getAllItems()).map((row) => row.id)).toEqual(['new']);
	});

	it('rejects an unsupported envelope version', async () => {
		await expect(importData(JSON.stringify({ version: 99, items: [] }))).rejects.toThrow(
			/unsupported export version/
		);
	});

	it('rejects a file that is not JSON', async () => {
		await expect(importData('not json')).rejects.toThrow(/not valid JSON/);
	});
});
