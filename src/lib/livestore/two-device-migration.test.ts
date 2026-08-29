/**
 * Two devices, already synced under the old system, migrating independently.
 *
 * This is the scenario step 4b exists for, and it is not hypothetical: anyone
 * who used the old sync service has exactly this shape. Each device carries its
 * *own* Dexie database across, producing its *own* eventlog describing the same
 * library. When a LiveStore sync backend arrives those logs merge, and every
 * migrated event is applied a second time on the other device.
 *
 * Nothing here needs a sync backend to test. Materializing a merged log is
 * precisely "commit both devices' events into one store", and rebasing only
 * decides *which* interleaving happens — so asserting over several interleavings
 * covers what a real merge could produce.
 *
 * The two devices deliberately disagree about everything device-local: Dexie
 * autoincrement keys, and the order rows come back in. Anything that leaks into
 * an id from there shows up here as a duplicate.
 */
import { describe, expect, it } from 'vitest';

import type { ChallengeRow } from '$lib/db/database';
import type { LegacySnapshot } from '$lib/db/legacy-snapshot';
import type { KnowledgeItem, Profile } from '$lib/types';

import { serveStats } from './derive';
import { events, tables } from './schema';
import { migrationEvents } from './migrate-dexie';
import { makeTestStore } from './store.testing';

type Event = ReturnType<typeof migrationEvents>[number];

const profile: Profile = {
	nativeLanguage: 'nl',
	targetLanguage: 'Mandarin Chinese',
	level: 'beginner',
	interests: ['food'],
	model: 'mock',
	createdAt: 1000
};

/**
 * The shared library, as both devices hold it after syncing.
 *
 * Two words, one with history recorded before sync (no `device`) and one with
 * history recorded after (carrying a device), because those take different
 * paths through the review identity.
 */
const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
	id: 'i1',
	kind: 'vocab',
	term: '书',
	meaning: 'book',
	fsrsCard: null,
	introducedAt: 1000,
	history: [],
	...over
});

const challenge = (over: Partial<ChallengeRow>): ChallengeRow =>
	({
		id: 'c1',
		type: 'multiple-choice',
		prompt: 'book?',
		options: ['书', '水', '火', '土'],
		answerIndex: 0,
		direction: 'toTarget',
		itemIds: ['i1'],
		generatedAt: 5000,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	}) as unknown as ChallengeRow;

const items: KnowledgeItem[] = [
	item({ id: 'i1', history: [{ at: 2000, grade: 3 }] }),
	item({
		id: 'i2',
		term: '水',
		meaning: 'water',
		history: [{ at: 3000, grade: 4, device: 'phone' }]
	})
];

const pool: ChallengeRow[] = [
	challenge({ id: 'c1', timesServed: 2, lastServedAt: 9000 }),
	challenge({ id: 'c2', reported: true, lastServedAt: null })
];

const answers = [
	{ challengeId: 'c1', verdict: 'correct' as const, answerGiven: '书', at: 100 },
	{ challengeId: 'c1', verdict: 'wrong' as const, answerGiven: '水', at: 200 }
];

/** Device A's Dexie: its own autoincrement keys, its own row order. */
const deviceA: LegacySnapshot = {
	profile,
	items,
	pool,
	results: answers.map((a, i) => ({ ...a, seq: 7 + i }))
};

/**
 * Device B's Dexie: the *same* library, stored differently.
 *
 * Different `seq` values and the reverse row order throughout — everything a
 * second device is free to differ on while holding identical synced data.
 */
const deviceB: LegacySnapshot = {
	profile,
	items: [...items].reverse(),
	pool: [...pool].reverse(),
	results: [...answers].reverse().map((a, i) => ({ ...a, seq: 55 + i }))
};

/** Materializes one interleaving of two migrated logs and snapshots the state. */
async function merge(...logs: Event[][]) {
	const store = await makeTestStore();
	for (const log of logs) for (const event of log) store.commit(event);
	return {
		items: store.query(tables.items.orderBy('id', 'asc')),
		reviews: store.query(tables.reviews.orderBy('id', 'asc')),
		challenges: store.query(tables.challenges.orderBy('id', 'asc')),
		serves: store.query(tables.serves.orderBy('id', 'asc')),
		results: store.query(tables.results.orderBy('id', 'asc'))
	};
}

describe('two devices migrating independently', () => {
	const a = () => migrationEvents(deviceA);
	const b = () => migrationEvents(deviceB);

	it('mints identical ids on both devices', () => {
		// The root property everything else rests on: an id is a function of
		// synced content, so two devices describing the same library describe it
		// with the same names. `seq` and row order differ; ids must not.
		const idsOf = (log: Event[]) =>
			log
				.map((e) => JSON.stringify({ name: e.name, args: e.args }))
				.sort()
				.join('\n');
		expect(idsOf(b())).toEqual(idsOf(a()));
	});

	it('converges to one library, whichever device syncs first', async () => {
		const aThenB = await merge(a(), b());
		const bThenA = await merge(b(), a());
		expect(bThenA).toEqual(aThenB);

		// And it is the *right* library, not merely a consistent one.
		expect(aThenB.items.map((i) => i.id)).toEqual(['i1', 'i2']);
		expect(aThenB.challenges.map((c) => c.id)).toEqual(['c1', 'c2']);
	});

	it('does not double a review that both devices carried across', async () => {
		const merged = await merge(a(), b());
		// One entry per history entry in the shared library, not two. A doubled
		// history silently doubles the FSRS fold.
		expect(merged.reviews).toHaveLength(2);
		expect(merged.reviews.filter((r) => r.itemId === 'i1')).toHaveLength(1);
		expect(merged.reviews.filter((r) => r.itemId === 'i2')).toHaveLength(1);
	});

	it('neither duplicates nor drops a result', async () => {
		const merged = await merge(a(), b());
		// The regression: ids used to come from Dexie's local autoincrement, so
		// these two answers merged as four rows — or as one, when two different
		// answers happened to collide on a key and `onConflict` dropped one.
		expect(merged.results).toHaveLength(2);
		expect(merged.results.map((r) => r.answerGiven).sort()).toEqual(['书', '水']);
	});

	it('counts each serve once', async () => {
		const merged = await merge(a(), b());
		const c1 = merged.serves.filter((s) => s.challengeId === 'c1');
		expect(serveStats(c1)).toEqual({ timesServed: 2, lastServedAt: 9000 });
	});

	it('keeps a challenge reported on both devices', async () => {
		const merged = await merge(a(), b());
		expect(merged.challenges.find((c) => c.id === 'c2')?.reported).toBe(true);
	});

	it('leaves a word deleted on one device deleted after the other migrates', async () => {
		// The tombstone case, and the reason step 3's reasoning was reopened.
		// The phone migrates, the learner deletes a word, the laptop is opened a
		// week later and migrates *then* — its `item-added` is causally unrelated
		// to the delete and simply arrives after it.
		const store = await makeTestStore();
		for (const event of a()) store.commit(event);
		store.commit(events.itemDeleted({ itemId: 'i1' }));
		for (const event of b()) store.commit(event);

		expect(store.query(tables.items).map((i) => i.id)).toEqual(['i2']);
		// And it stays gone however many times the laptop replays its log.
		for (const event of b()) store.commit(event);
		expect(store.query(tables.items).map((i) => i.id)).toEqual(['i2']);
	});

	it('still deletes normally when the delete is the last word on the subject', async () => {
		// Guarding the guard: a tombstone must not make deletion itself sticky in
		// some way that breaks the ordinary single-device path.
		const store = await makeTestStore();
		for (const event of a()) store.commit(event);
		expect(store.query(tables.items)).toHaveLength(2);
		store.commit(events.itemDeleted({ itemId: 'i2' }));
		expect(store.query(tables.items).map((i) => i.id)).toEqual(['i1']);
		expect(store.query(tables.reviews).filter((r) => r.itemId === 'i2')).toHaveLength(0);
	});
});
