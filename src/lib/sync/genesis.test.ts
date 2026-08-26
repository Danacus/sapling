/**
 * Genesis (`docs/sync.md` §5) has exactly one property worth testing, and it is
 * a strong one: **synthesize from a state, apply onto nothing, get the state
 * back.** If that holds, a device with months of history can join a sync
 * without any snapshot format, bootstrap endpoint or special case — the log
 * really is the only mechanism.
 *
 * The one documented approximation — serve timestamps collapsing onto
 * `lastServedAt` — is asserted for what it must preserve (the count) rather
 * than for the spacing it cannot.
 */

import { describe, expect, it } from 'vitest';

import { Grade, newCardState, reviewCard } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { ChallengeResult, KnowledgeItem, Profile } from '$lib/types';

import { applyEvents } from './apply';
import { EVENT_TYPES } from './events';
import { synthesizeGenesis } from './genesis';
import { emptyBookkeeping, type GenesisState, type PoolRow, type SyncSnapshot } from './snapshot';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;
const DEVICE = 'devA';

/** Deterministic ids, so a synthesis can be compared against itself. */
function idFactory(): () => string {
	let n = 0;
	return () => `g${`${(n += 1)}`.padStart(4, '0')}`;
}

function replay(introducedAt: number, history: { at: number; grade: number }[]): FsrsCardState {
	let card = newCardState(introducedAt);
	for (const entry of history) card = reviewCard(card, entry.grade as Grade, entry.at);
	return card;
}

function makeItem(
	id: string,
	introducedAt: number,
	history: { at: number; grade: number }[]
): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		romanization: `rom-${id}`,
		fsrsCard: replay(introducedAt, history),
		introducedAt,
		history: history.map((entry) => ({ ...entry }))
	};
}

const poolRow = (
	id: string,
	generatedAt: number,
	extra: Partial<PoolRow> = {}
): PoolRow =>
	({
		id,
		type: 'typed-translation',
		direction: 'toTarget',
		prompt: `prompt-${id}`,
		acceptedAnswers: [`answer-${id}`],
		itemIds: ['i1'],
		generatedAt,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...extra
	}) as PoolRow;

const profile: Profile = {
	nativeLanguage: 'en',
	targetLanguage: 'es',
	level: 'elementary',
	interests: ['cooking', 'cycling'],
	about: 'A test learner.',
	model: 'test/model',
	createdAt: T0 - DAY
};

const results: ChallengeResult[] = [
	{ challengeId: 'c1', verdict: 'correct', answerGiven: 'answer-c1', at: T0 + MINUTE },
	{ challengeId: 'c2', verdict: 'wrong', answerGiven: 'nope', at: T0 + 2 * MINUTE }
];

function state(): GenesisState {
	return {
		items: [
			makeItem('i1', T0 - DAY, [
				{ at: T0 - DAY + MINUTE, grade: Grade.Good },
				{ at: T0 + MINUTE, grade: Grade.Hard }
			]),
			makeItem('i2', T0, [])
		],
		pool: [
			poolRow('c1', T0, { timesServed: 2, lastServedAt: T0 + 3 * MINUTE, topic: 'food' }),
			poolRow('c2', T0 + 1, { timesServed: 1, lastServedAt: T0 + 2 * MINUTE, reported: true }),
			poolRow('c3', T0 + 2)
		],
		results,
		profile
	};
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

/** Histories come back stamped with the emitting device; compare the domain half. */
function bare(item: KnowledgeItem) {
	return { ...item, history: item.history.map(({ at, grade }) => ({ at, grade })) };
}

describe('synthesizeGenesis', () => {
	it('emits one event per fact, in (at, device, id) order', () => {
		const events = synthesizeGenesis(state(), DEVICE, idFactory());
		const counts = events.reduce<Record<string, number>>((acc, event) => {
			acc[event.type] = (acc[event.type] ?? 0) + 1;
			return acc;
		}, {});

		expect(counts).toEqual({
			[EVENT_TYPES.itemAdded]: 2,
			[EVENT_TYPES.itemReviewed]: 2,
			[EVENT_TYPES.challengeAdded]: 3,
			// two serves for c1, one for c2 — `timesServed` events each
			[EVENT_TYPES.challengeServed]: 3,
			[EVENT_TYPES.challengeReported]: 1,
			[EVENT_TYPES.resultLogged]: 2,
			[EVENT_TYPES.profileUpdated]: 1
		});
		expect(events.every((event) => event.device === DEVICE)).toBe(true);
		expect([...events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))).toEqual(events);
	});

	it('is deterministic given the id factory', () => {
		expect(synthesizeGenesis(state(), DEVICE, idFactory())).toEqual(
			synthesizeGenesis(state(), DEVICE, idFactory())
		);
	});

	it('emits nothing for an empty device', () => {
		expect(
			synthesizeGenesis(
				{ items: [], pool: [], results: [], profile: null },
				DEVICE,
				idFactory()
			)
		).toEqual([]);
	});

	it('round-trips: applying it to an empty device reproduces the state', () => {
		const original = state();
		const events = synthesizeGenesis(original, DEVICE, idFactory());
		const rebuilt = applyEvents(emptySnapshot(), events);

		expect(rebuilt.items.map(bare)).toEqual(original.items);
		expect(rebuilt.pool).toEqual(original.pool);
		expect(rebuilt.results).toEqual(original.results);
		expect(rebuilt.profile).toEqual(original.profile);
	});

	it('reproduces every card exactly, by refolding the replayed history', () => {
		const original = state();
		const rebuilt = applyEvents(emptySnapshot(), synthesizeGenesis(original, DEVICE, idFactory()));

		for (const item of original.items) {
			const mirror = rebuilt.items.find((candidate) => candidate.id === item.id);
			expect(mirror?.fsrsCard).toEqual(item.fsrsCard);
		}
	});

	it('is idempotent when the same genesis log is delivered twice', () => {
		const events = synthesizeGenesis(state(), DEVICE, idFactory());
		const once = applyEvents(emptySnapshot(), events);
		expect(applyEvents(once, events)).toEqual(once);
	});

	it('applies the same however the log is split into pulls', () => {
		const events = synthesizeGenesis(state(), DEVICE, idFactory());
		const whole = applyEvents(emptySnapshot(), events);

		const half = Math.floor(events.length / 2);
		const piecewise = applyEvents(
			applyEvents(emptySnapshot(), events.slice(0, half)),
			events.slice(half)
		);

		expect(piecewise).toEqual(whole);
	});
});
