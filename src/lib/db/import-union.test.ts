/**
 * Importing a v3 file is a **union**, not a restore.
 *
 * The file is a log, so its events are merged in by id and the read model is
 * rebuilt from the result. That is what makes an import safe to repeat and safe
 * to run on a device that has kept living since the file was written: a word
 * deleted since stays deleted, and a profile edited since is not reverted.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	deleteItem,
	getAllItems,
	getDailyActivity,
	getPool,
	getProfile,
	importData,
	saveProfile
} from '$lib/db';
import type { SyncEvent } from './events';
import { setStoreForTesting } from './store';
import { makeTestStore } from './store.testing';

beforeEach(async () => {
	setStoreForTesting(await makeTestStore());
});

const events: SyncEvent[] = [
	{
		id: 'e-profile',
		type: 'profileUpdated',
		at: 1000,
		device: 'devA',
		payload: {
			nativeLanguage: 'nl',
			targetLanguage: 'Mandarin Chinese',
			level: 'beginner',
			interests: ['food'],
			model: 'old-model',
			createdAt: 1000
		}
	},
	{
		id: 'e-add',
		type: 'itemAdded',
		at: 1000,
		device: 'devA',
		payload: { id: 'i1', kind: 'vocab', term: '书', meaning: 'book', introducedAt: 1000 }
	},
	{
		id: 'e-review',
		type: 'itemReviewed',
		at: 2000,
		device: 'devA',
		payload: { device: 'devA', at: 2000, itemId: 'i1', grade: 3 }
	},
	{
		id: 'e-challenge',
		type: 'challengeAdded',
		at: 3000,
		device: 'devA',
		payload: {
			challenge: { id: 'c1', type: 'cloze', direction: 'toTarget', itemIds: ['i1'] },
			generatedAt: 3000
		}
	},
	{
		id: 'e-result',
		type: 'resultLogged',
		at: 5000,
		device: 'devA',
		payload: { challengeId: 'c1', verdict: 'correct', answerGiven: '书', at: 5000 }
	}
];

function file(list: SyncEvent[]): string {
	return JSON.stringify({ version: 3, exportedAt: 9999, events: list });
}

/** The same history as it would look in another device's log: different ids. */
function foreign(list: SyncEvent[]): SyncEvent[] {
	return list.map((event) => ({ ...event, id: `${event.id}-B`, device: 'devB' }));
}

async function readModel() {
	return {
		items: await getAllItems(),
		pool: await getPool(),
		profile: await getProfile(),
		activity: await getDailyActivity()
	};
}

describe('v3 import', () => {
	it('lands two devices on the same state from the same file', async () => {
		await importData(file(events));
		const first = await readModel();

		setStoreForTesting(await makeTestStore());
		await importData(file(events));

		expect(await readModel()).toEqual(first);
	});

	it('is idempotent — importing the same file twice changes nothing', async () => {
		await importData(file(events));
		const once = await readModel();
		await importData(file(events));
		expect(await readModel()).toEqual(once);
	});

	it('keeps a word deleted after the export deleted', async () => {
		await importData(file(events));
		await deleteItem('i1');

		// Another device's copy of the same word — a different event id, so the
		// union genuinely has something to add. The tombstone still outranks it.
		await importData(file(foreign(events)));

		expect(await getAllItems()).toEqual([]);
	});

	it('does not let an older imported profile revert a newer edit', async () => {
		await importData(file(events));
		await saveProfile({
			nativeLanguage: 'nl',
			targetLanguage: 'Mandarin Chinese',
			level: 'intermediate',
			interests: ['music'],
			model: 'new-model',
			createdAt: 1000
		});

		await importData(file(foreign(events)));

		expect((await getProfile())?.model).toBe('new-model');
	});
});
