/**
 * The Dexie migration, asserted twice over.
 *
 * `migrationEvents` is pure, so most of this is plain assertions on the event
 * list. But the questions that actually matter — does a reported challenge
 * survive, does running it twice double anything — are about what the
 * *materializers* do with that list, so those go through a real store.
 */
import { describe, expect, it } from 'vitest';

import type { LegacySnapshot } from '$lib/db/legacy-snapshot';
import type { ChallengeRow } from '$lib/db/database';
import type { KnowledgeItem, Profile } from '$lib/types';

import { serveStats, sortHistory } from './derive';
import { migrationEvents, MIGRATION_DEVICE } from './migrate-dexie';
import { tables } from './schema';
import { makeTestStore } from './store.testing';

const empty: LegacySnapshot = { profile: null, items: [], pool: [], results: [] };

const profile: Profile = {
	nativeLanguage: 'nl',
	targetLanguage: 'Mandarin Chinese',
	level: 'beginner',
	interests: ['food'],
	model: 'mock',
	createdAt: 1000
};

const item = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
	id: 'i1',
	kind: 'vocab',
	term: '书',
	meaning: 'book',
	fsrsCard: null,
	introducedAt: 1000,
	history: [],
	...over
});

const challenge = (over: Partial<ChallengeRow> = {}): ChallengeRow =>
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

/** Commits a whole migration into a fresh store. */
const migrateInto = async (snapshot: LegacySnapshot) => {
	const store = await makeTestStore();
	for (const event of migrationEvents(snapshot)) store.commit(event);
	return store;
};

describe('migrationEvents', () => {
	it('emits nothing for an empty database', () => {
		expect(migrationEvents(empty)).toEqual([]);
	});

	it('emits the profile before anything else', () => {
		const events = migrationEvents({ ...empty, profile, items: [item()] });
		expect(events[0].name).toBe('v1.ProfileUpdated');
	});

	it('omits an absent optional rather than sending undefined', () => {
		const [added] = migrationEvents({ ...empty, items: [item()] });
		expect(added.args).not.toHaveProperty('romanization');
		expect(added.args).not.toHaveProperty('notes');
	});

	it('carries an item with no history as a single add', () => {
		const events = migrationEvents({ ...empty, items: [item()] });
		expect(events.map((e) => e.name)).toEqual(['v1.ItemAdded']);
	});

	it('puts every review after the item it belongs to', () => {
		const events = migrationEvents({
			...empty,
			items: [
				item({
					history: [
						{ at: 2000, grade: 3 },
						{ at: 3000, grade: 4 }
					]
				})
			]
		});
		expect(events.map((e) => e.name)).toEqual([
			'v1.ItemAdded',
			'v1.ItemReviewed',
			'v1.ItemReviewed'
		]);
	});

	it('attributes a pre-sync history entry to a constant, not the device id', () => {
		const [, reviewed] = migrationEvents({
			...empty,
			items: [item({ history: [{ at: 2000, grade: 3 }] })]
		});
		// A localStorage-derived id here would change every reviewKey whenever
		// storage is cleared, and a second run would double the whole history.
		expect(reviewed.args).toMatchObject({ device: MIGRATION_DEVICE });
	});

	it('keeps a device a history entry already carries', () => {
		const [, reviewed] = migrationEvents({
			...empty,
			items: [item({ history: [{ at: 2000, grade: 3, device: 'dev-a' }] })]
		});
		expect(reviewed.args).toMatchObject({ device: 'dev-a' });
	});

	it('expands timesServed into that many distinct serve events', () => {
		const events = migrationEvents({
			...empty,
			pool: [challenge({ timesServed: 3, lastServedAt: 9000 })]
		});
		const serves = events.filter((e) => e.name === 'v1.ChallengeServed');
		expect(serves).toHaveLength(3);
		expect(new Set(serves.map((s) => (s.args as { eventId: string }).eventId)).size).toBe(3);
		expect(serves.every((s) => (s.args as { at: number }).at === 9000)).toBe(true);
	});

	it('stamps serves at generatedAt when the row was never served', () => {
		const events = migrationEvents({
			...empty,
			pool: [challenge({ timesServed: 1, lastServedAt: null, generatedAt: 5000 })]
		});
		const [serve] = events.filter((e) => e.name === 'v1.ChallengeServed');
		expect(serve.args).toMatchObject({ at: 5000 });
	});

	it('puts the report after the challenge that it reports', () => {
		// The ordering this asserts is the one an `at` sort would get wrong:
		// `lastServedAt` is null, so genesis stamped both at `generatedAt` and
		// broke the tie on a random UUID.
		const events = migrationEvents({
			...empty,
			pool: [challenge({ reported: true, lastServedAt: null })]
		});
		expect(events.map((e) => e.name)).toEqual(['v1.ChallengeAdded', 'v1.ChallengeReported']);
	});

	it('gives each result a stable id derived from its Dexie key', () => {
		const events = migrationEvents({
			...empty,
			results: [
				{ seq: 7, challengeId: 'c1', verdict: 'correct', answerGiven: '书', at: 100 },
				{ seq: 8, challengeId: 'c1', verdict: 'wrong', answerGiven: '水', at: 200 }
			]
		});
		expect(events.map((e) => (e.args as { eventId: string }).eventId)).toEqual([
			'dexie:result:7',
			'dexie:result:8'
		]);
	});

	it('keeps two byte-identical results apart', () => {
		const one = { challengeId: 'c1', verdict: 'correct' as const, answerGiven: '书', at: 100 };
		const events = migrationEvents({
			...empty,
			results: [
				{ ...one, seq: 1 },
				{ ...one, seq: 2 }
			]
		});
		const ids = events.map((e) => (e.args as { eventId: string }).eventId);
		expect(new Set(ids).size).toBe(2);
	});

	it('is deterministic: the same database yields the same events twice', () => {
		const snapshot: LegacySnapshot = {
			profile,
			items: [item({ history: [{ at: 2000, grade: 3 }] })],
			pool: [challenge({ timesServed: 2, lastServedAt: 9000, reported: true })],
			results: [{ seq: 1, challengeId: 'c1', verdict: 'correct', answerGiven: '书', at: 100 }]
		};
		expect(migrationEvents(snapshot)).toEqual(migrationEvents(snapshot));
	});
});

describe('migrating into a real store', () => {
	const full: LegacySnapshot = {
		profile,
		items: [
			item({
				id: 'i1',
				history: [
					{ at: 2000, grade: 3 },
					{ at: 3000, grade: 4 }
				]
			}),
			item({ id: 'i2', term: '水', meaning: 'water', romanization: 'shuǐ', history: [] })
		],
		pool: [
			challenge({ id: 'c1', timesServed: 2, lastServedAt: 9000 }),
			challenge({ id: 'c2', reported: true, lastServedAt: null })
		],
		results: [{ seq: 1, challengeId: 'c1', verdict: 'correct', answerGiven: '书', at: 100 }]
	};

	it('lands every table', async () => {
		const store = await migrateInto(full);
		expect(store.query(tables.items)).toHaveLength(2);
		expect(store.query(tables.reviews)).toHaveLength(2);
		expect(store.query(tables.challenges)).toHaveLength(2);
		expect(store.query(tables.serves)).toHaveLength(2);
		expect(store.query(tables.results)).toHaveLength(1);
		expect(store.query(tables.profile)).toHaveLength(1);
	});

	it('keeps the report, which an at-ordered log would have dropped', async () => {
		const store = await migrateInto(full);
		const reported = store.query(tables.challenges.where({ id: 'c2' }));
		expect(reported[0]).toMatchObject({ reported: true });
	});

	it('reproduces timesServed and lastServedAt exactly', async () => {
		const store = await migrateInto(full);
		const serves = store.query(tables.serves.where({ challengeId: 'c1' }));
		expect(serveStats(serves)).toEqual({ timesServed: 2, lastServedAt: 9000 });
	});

	it('reproduces review history in order', async () => {
		const store = await migrateInto(full);
		const history = sortHistory(store.query(tables.reviews.where({ itemId: 'i1' })));
		expect(history.map((row) => [row.at, row.grade])).toEqual([
			[2000, 3],
			[3000, 4]
		]);
	});

	it('doubles nothing when the whole migration runs twice', async () => {
		const store = await migrateInto(full);
		// Exactly what a cleared `localStorage` would cause on the next boot.
		for (const event of migrationEvents(full)) store.commit(event);

		expect(store.query(tables.items)).toHaveLength(2);
		expect(store.query(tables.reviews)).toHaveLength(2);
		expect(store.query(tables.challenges)).toHaveLength(2);
		expect(store.query(tables.serves)).toHaveLength(2);
		expect(store.query(tables.results)).toHaveLength(1);
		expect(store.query(tables.profile)).toHaveLength(1);
		expect(serveStats(store.query(tables.serves.where({ challengeId: 'c1' })))).toEqual({
			timesServed: 2,
			lastServedAt: 9000
		});
	});
});
