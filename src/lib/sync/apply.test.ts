/**
 * The merge rules of `docs/sync.md` §4, as executable statements.
 *
 * Every test here is really one of two properties in disguise — *idempotent*
 * (applying an event twice is applying it once) and *commutative across
 * batches* (how the event set is split into pulls cannot change the outcome).
 * Where a rule needs bookkeeping to hold those properties, the test that forces
 * the bookkeeping to exist is the one that splits the events into two calls.
 *
 * Event ids are readable strings rather than UUIDs: `applyEvents` never
 * validates the envelope (the server and the HTTP client do), it only sorts by
 * `(at, device, id)` and dedupes on id. They are zero-padded so the lexicographic
 * tie-break stays intuitive.
 */

import { describe, expect, it } from 'vitest';

import { Grade, newCardState, reviewCard } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { ChallengeResult, KnowledgeItem, Profile } from '$lib/types';

import { applyEvents } from './apply';
import { EVENT_TYPES, type SyncEvent, type SyncEventType, type SyncPayloads } from './events';
import { emptyBookkeeping, type PoolRow, type SyncSnapshot } from './snapshot';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

let idCounter = 0;

function ev<T extends SyncEventType>(
	type: T,
	payload: SyncPayloads[T],
	at: number,
	device = 'devA'
): SyncEvent {
	idCounter += 1;
	return { id: `e${`${idCounter}`.padStart(4, '0')}`, device, at, type, payload };
}

function emptySnapshot(): SyncSnapshot {
	return {
		items: [],
		pool: [],
		results: [],
		profile: null,
		bookkeeping: emptyBookkeeping()
	};
}

/** An item whose card is the honest fold of its own history — as the app writes it. */
function makeItem(
	id: string,
	introducedAt: number,
	history: { at: number; grade: number; device?: string }[] = []
): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: replay(introducedAt, history),
		introducedAt,
		history: history.map((entry) => ({ ...entry }))
	};
}

/** Direct FSRS replay, the thing the apply engine's refold has to reproduce. */
function replay(introducedAt: number, history: { at: number; grade: number }[]): FsrsCardState {
	let card = newCardState(introducedAt);
	for (const entry of history) card = reviewCard(card, entry.grade as Grade, entry.at);
	return card;
}

function withItems(...items: KnowledgeItem[]): SyncSnapshot {
	return { ...emptySnapshot(), items };
}

const challenge = {
	id: 'c1',
	type: 'typed-translation',
	direction: 'toTarget',
	prompt: 'hello',
	acceptedAnswers: ['hola'],
	itemIds: ['i1']
} as SyncPayloads['challenge-added']['challenge'];

const profile = (createdAt: number, targetLanguage: string): Profile => ({
	nativeLanguage: 'en',
	targetLanguage,
	level: 'beginner',
	interests: ['food'],
	model: 'test/model',
	createdAt
});

/* -------------------------------------------------------------------------- */
/* Items and cards                                                             */
/* -------------------------------------------------------------------------- */

describe('items', () => {
	it('creates on item-added and ignores a second one for the same id', () => {
		const added = ev(
			EVENT_TYPES.itemAdded,
			{ id: 'i1', kind: 'vocab', term: 'hola', meaning: 'hello', introducedAt: T0 },
			T0
		);
		const state = applyEvents(emptySnapshot(), [added, added]);

		expect(state.items).toHaveLength(1);
		expect(state.items[0].term).toBe('hola');
		expect(state.items[0].history).toEqual([]);
		expect(state.items[0].fsrsCard).toEqual(newCardState(T0));
	});

	it('folds concurrent reviews from two devices into the replay of their union', () => {
		const base = withItems(makeItem('i1', T0));
		const fromA = ev(
			EVENT_TYPES.itemReviewed,
			{ itemId: 'i1', at: T0 + MINUTE, grade: Grade.Good },
			T0 + MINUTE,
			'devA'
		);
		const fromB = ev(
			EVENT_TYPES.itemReviewed,
			{ itemId: 'i1', at: T0 + 2 * MINUTE, grade: Grade.Again },
			T0 + 2 * MINUTE,
			'devB'
		);

		const together = applyEvents(base, [fromA, fromB]);
		const reversed = applyEvents(base, [fromB, fromA]);
		const split = applyEvents(applyEvents(base, [fromB]), [fromA]);

		const expected = replay(T0, [
			{ at: T0 + MINUTE, grade: Grade.Good },
			{ at: T0 + 2 * MINUTE, grade: Grade.Again }
		]);

		expect(together.items[0].fsrsCard).toEqual(expected);
		expect(reversed).toEqual(together);
		expect(split).toEqual(together);
		expect(together.items[0].history).toEqual([
			{ at: T0 + MINUTE, grade: Grade.Good, device: 'devA' },
			{ at: T0 + 2 * MINUTE, grade: Grade.Again, device: 'devB' }
		]);
	});

	it('keeps same-millisecond reviews from different devices apart', () => {
		const base = withItems(makeItem('i1', T0));
		const at = T0 + MINUTE;
		const state = applyEvents(base, [
			ev(EVENT_TYPES.itemReviewed, { itemId: 'i1', at, grade: Grade.Good }, at, 'devA'),
			ev(EVENT_TYPES.itemReviewed, { itemId: 'i1', at, grade: Grade.Hard }, at, 'devB')
		]);

		expect(state.items[0].history).toHaveLength(2);
	});

	it('drops a duplicate review with the same (itemId, at, device)', () => {
		const base = withItems(makeItem('i1', T0));
		const at = T0 + MINUTE;
		const review = ev(EVENT_TYPES.itemReviewed, { itemId: 'i1', at, grade: Grade.Good }, at);

		const once = applyEvents(base, [review]);
		const twice = applyEvents(once, [review]);

		expect(once.items[0].history).toHaveLength(1);
		expect(twice).toEqual(once);
	});

	it('ignores a review of an item it has never seen', () => {
		const state = applyEvents(emptySnapshot(), [
			ev(EVENT_TYPES.itemReviewed, { itemId: 'ghost', at: T0, grade: Grade.Good }, T0)
		]);
		expect(state.items).toEqual([]);
	});
});

describe('review-amended', () => {
	const at = T0 + MINUTE;
	const amendedAt = at + 5_000;

	const review = ev(EVENT_TYPES.itemReviewed, { itemId: 'i1', at, grade: Grade.Good }, at);
	const amend = ev(
		EVENT_TYPES.reviewAmended,
		{ itemId: 'i1', at: amendedAt, grade: Grade.Easy, replaces: at },
		amendedAt
	);
	const base = withItems(makeItem('i1', T0));

	const expectedHistory = [{ at: amendedAt, grade: Grade.Easy, device: 'devA' }];
	const expectedCard = replay(T0, [{ at: amendedAt, grade: Grade.Easy }]);

	it('replaces the original when it arrives after it', () => {
		const state = applyEvents(applyEvents(base, [review]), [amend]);
		expect(state.items[0].history).toEqual(expectedHistory);
		expect(state.items[0].fsrsCard).toEqual(expectedCard);
	});

	it('still wins when it arrives before the review it replaces', () => {
		const state = applyEvents(applyEvents(base, [amend]), [review]);
		expect(state.items[0].history).toEqual(expectedHistory);
		expect(state.items[0].fsrsCard).toEqual(expectedCard);
	});

	it('lands identically however the two are batched', () => {
		const inOne = applyEvents(base, [review, amend]);
		const after = applyEvents(applyEvents(base, [review]), [amend]);
		const before = applyEvents(applyEvents(base, [amend]), [review]);

		expect(after).toEqual(inOne);
		expect(before).toEqual(inOne);
	});

	it('is idempotent under re-delivery of both events', () => {
		const once = applyEvents(base, [review, amend]);
		expect(applyEvents(once, [review, amend])).toEqual(once);
	});
});

describe('item-updated', () => {
	const base = withItems(makeItem('i1', T0));
	const early = ev(
		EVENT_TYPES.itemUpdated,
		{ itemId: 'i1', fields: { meaning: 'early' } },
		T0 + MINUTE
	);
	const late = ev(
		EVENT_TYPES.itemUpdated,
		{ itemId: 'i1', fields: { meaning: 'late' } },
		T0 + 2 * MINUTE
	);

	it('takes the latest patch whichever order it arrives in', () => {
		expect(applyEvents(base, [early, late]).items[0].meaning).toBe('late');
		expect(applyEvents(base, [late, early]).items[0].meaning).toBe('late');
		expect(applyEvents(applyEvents(base, [late]), [early]).items[0].meaning).toBe('late');
		expect(applyEvents(applyEvents(base, [early]), [late]).items[0].meaning).toBe('late');
	});

	it('leaves fields the patch does not mention alone', () => {
		const state = applyEvents(base, [
			ev(EVENT_TYPES.itemUpdated, { itemId: 'i1', fields: { romanization: 'ni hao' } }, T0 + 1)
		]);
		expect(state.items[0]).toMatchObject({ meaning: 'meaning-i1', romanization: 'ni hao' });
	});
});

describe('item-deleted', () => {
	const at = T0 + MINUTE;
	const remove = ev(EVENT_TYPES.itemDeleted, { itemId: 'i1' }, at);
	const review = ev(
		EVENT_TYPES.itemReviewed,
		{ itemId: 'i1', at: at + MINUTE, grade: Grade.Good },
		at + MINUTE,
		'devB'
	);
	const readd = ev(
		EVENT_TYPES.itemAdded,
		{ id: 'i1', kind: 'vocab', term: 'again', meaning: 'again', introducedAt: at + 2 * MINUTE },
		at + 2 * MINUTE,
		'devB'
	);

	it('beats a concurrent review and a later re-add, in any batching', () => {
		const base = withItems(makeItem('i1', T0));
		for (const state of [
			applyEvents(base, [remove, review, readd]),
			applyEvents(applyEvents(base, [remove]), [review, readd]),
			applyEvents(applyEvents(base, [review]), [remove, readd]),
			applyEvents(applyEvents(applyEvents(base, [review]), [readd]), [remove])
		]) {
			expect(state.items).toEqual([]);
			expect(state.bookkeeping.tombstones).toEqual(['i1']);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Challenge pool                                                              */
/* -------------------------------------------------------------------------- */

describe('challenges', () => {
	const added = ev(
		EVENT_TYPES.challengeAdded,
		{ challenge, generatedAt: T0, topic: 'greetings' },
		T0
	);

	it('counts distinct serve events exactly, under duplicate delivery', () => {
		const serves = [T0 + MINUTE, T0 + 2 * MINUTE, T0 + 3 * MINUTE].map((at) =>
			ev(EVENT_TYPES.challengeServed, { challengeId: 'c1' }, at)
		);

		const once = applyEvents(emptySnapshot(), [added, ...serves]);
		const twice = applyEvents(once, [added, ...serves]);
		const split = applyEvents(applyEvents(emptySnapshot(), [added, serves[2]]), [
			serves[0],
			serves[1],
			serves[2]
		]);

		expect(once.pool[0].timesServed).toBe(3);
		expect(once.pool[0].lastServedAt).toBe(T0 + 3 * MINUTE);
		expect(twice).toEqual(once);
		expect(split.pool[0].timesServed).toBe(3);
		expect(split.pool[0].lastServedAt).toBe(T0 + 3 * MINUTE);
	});

	it('keeps the pool row content of the first add and its topic', () => {
		const state = applyEvents(emptySnapshot(), [
			added,
			ev(
				EVENT_TYPES.challengeAdded,
				{ challenge: { ...challenge, prompt: 'overwritten' }, generatedAt: T0 + DAY },
				T0 + DAY
			)
		]);

		expect(state.pool).toHaveLength(1);
		expect(state.pool[0]).toMatchObject({ generatedAt: T0, topic: 'greetings' });
		expect((state.pool[0] as PoolRow & { prompt: string }).prompt).toBe('hello');
	});

	it('makes a report sticky against re-adds and later serves', () => {
		const reported = ev(EVENT_TYPES.challengeReported, { challengeId: 'c1' }, T0 + MINUTE);
		const state = applyEvents(emptySnapshot(), [
			added,
			reported,
			reported,
			ev(EVENT_TYPES.challengeServed, { challengeId: 'c1' }, T0 + 2 * MINUTE),
			ev(EVENT_TYPES.challengeAdded, { challenge, generatedAt: T0 + DAY }, T0 + DAY)
		]);

		expect(state.pool[0].reported).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* Results and profile                                                         */
/* -------------------------------------------------------------------------- */

describe('results', () => {
	it('unions by event id, keeping genuinely identical answers apart', () => {
		const result: ChallengeResult = {
			challengeId: 'c1',
			verdict: 'correct',
			answerGiven: 'hola',
			at: T0
		};
		const first = ev(EVENT_TYPES.resultLogged, result, T0, 'devA');
		const second = ev(EVENT_TYPES.resultLogged, result, T0, 'devB');

		const state = applyEvents(emptySnapshot(), [first, second, first]);
		expect(state.results).toEqual([result, result]);
		expect(applyEvents(state, [first, second])).toEqual(state);
	});
});

describe('profile', () => {
	it('is last-write-wins by at, in either order and either batching', () => {
		const older = ev(EVENT_TYPES.profileUpdated, profile(T0, 'es'), T0 + MINUTE);
		const newer = ev(EVENT_TYPES.profileUpdated, profile(T0, 'zh'), T0 + 2 * MINUTE, 'devB');

		expect(applyEvents(emptySnapshot(), [older, newer]).profile?.targetLanguage).toBe('zh');
		expect(applyEvents(emptySnapshot(), [newer, older]).profile?.targetLanguage).toBe('zh');
		expect(
			applyEvents(applyEvents(emptySnapshot(), [newer]), [older]).profile?.targetLanguage
		).toBe('zh');
	});
});

/* -------------------------------------------------------------------------- */
/* Cross-cutting                                                               */
/* -------------------------------------------------------------------------- */

describe('applyEvents', () => {
	it("skips this device's own events, which were applied at write time", () => {
		const base = withItems(makeItem('i1', T0));
		const mine = ev(
			EVENT_TYPES.itemReviewed,
			{ itemId: 'i1', at: T0 + MINUTE, grade: Grade.Good },
			T0 + MINUTE,
			'devA'
		);
		const mineToo = ev(
			EVENT_TYPES.resultLogged,
			{ challengeId: 'c1', verdict: 'correct', answerGiven: 'hola', at: T0 },
			T0,
			'devA'
		);

		const state = applyEvents(base, [mine, mineToo], 'devA');

		expect(state.items).toBe(base.items);
		expect(state.results).toBe(base.results);
	});

	it('drops events of an unknown type, and events whose payload does not validate, and applies the rest', () => {
		const base = withItems(makeItem('i1', T0));
		const junk: SyncEvent = {
			id: 'e-junk',
			device: 'devB',
			at: T0 + MINUTE,
			type: EVENT_TYPES.itemReviewed,
			payload: { itemId: 'i1', grade: 'good' }
		};
		const unknown: SyncEvent = {
			id: 'e-future',
			device: 'devB',
			at: T0 + MINUTE,
			type: 'item-hyperlearned',
			payload: {}
		};
		const good = ev(
			EVENT_TYPES.itemReviewed,
			{ itemId: 'i1', at: T0 + 2 * MINUTE, grade: Grade.Good },
			T0 + 2 * MINUTE,
			'devB'
		);

		// `xp-banked` is a *retired* type: old server logs still hold these, and
		// they must be dropped exactly like a type from the future.
		const retired: SyncEvent = {
			id: 'e-retired',
			device: 'devB',
			at: T0 + MINUTE,
			type: 'xp-banked',
			payload: { day: '2026-08-23', amount: 40 }
		};

		const state = applyEvents(base, [junk, unknown, retired, good]);
		expect(state.items[0].history).toHaveLength(1);
	});

	it('is idempotent over a mixed batch', () => {
		const base = withItems(makeItem('i1', T0));
		const batch = [
			ev(
				EVENT_TYPES.itemAdded,
				{ id: 'i2', kind: 'grammar', term: 'ser', meaning: 'to be', introducedAt: T0 },
				T0,
				'devB'
			),
			ev(
				EVENT_TYPES.itemReviewed,
				{ itemId: 'i1', at: T0 + MINUTE, grade: Grade.Hard },
				T0 + MINUTE,
				'devB'
			),
			ev(EVENT_TYPES.challengeAdded, { challenge, generatedAt: T0 }, T0, 'devB'),
			ev(EVENT_TYPES.challengeServed, { challengeId: 'c1' }, T0 + MINUTE, 'devB'),
			ev(
				EVENT_TYPES.resultLogged,
				{ challengeId: 'c1', verdict: 'almost', answerGiven: 'ola', at: T0 + MINUTE },
				T0 + MINUTE,
				'devB'
			),
			ev(EVENT_TYPES.profileUpdated, profile(T0, 'es'), T0 + MINUTE, 'devB')
		];

		const once = applyEvents(base, batch);
		expect(applyEvents(once, batch)).toEqual(once);
		expect(applyEvents(once, [...batch].reverse())).toEqual(once);
	});

	it('reuses untouched rows by reference so the writer can diff cheaply', () => {
		const base = withItems(makeItem('i1', T0), makeItem('i2', T0));
		const state = applyEvents(base, [
			ev(
				EVENT_TYPES.itemReviewed,
				{ itemId: 'i2', at: T0 + MINUTE, grade: Grade.Good },
				T0 + MINUTE,
				'devB'
			)
		]);

		expect(state.items[0]).toBe(base.items[0]);
		expect(state.items[1]).not.toBe(base.items[1]);
	});
});
