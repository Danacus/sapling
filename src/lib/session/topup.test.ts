/**
 * The top-up planner: what the pool is missing for the words coming up.
 *
 * Pure, so every case is a pool, a collection and a clock. The kinds are read
 * back through `$lib/llm`'s `PLANNABLE_KINDS`, so the demand tiers asserted on
 * here are the ones the registry test pins against the resolvers.
 */

import { describe, expect, it } from 'vitest';
import type { ChallengeRow } from '$lib/db';
import { PLANNABLE_KINDS, kindKey } from '$lib/llm';
import type { ChallengeKind, Want } from '$lib/llm';
import { CardState, newCardState } from '$lib/srs';
import type { KnowledgeItem } from '$lib/types';
import { RESERVE_GAP } from './pool';
import { MAX_TOPUP_WANTS, WANT_PER_WORD, planTopUp, topUpCoverage } from './topup';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A brand-new word: strength 0, level 1, recognition only. */
function item(id: string, dueOffset = -DAY): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: { ...newCardState(NOW), due: NOW + dueOffset },
		introducedAt: NOW - 10 * DAY,
		history: []
	};
}

/** A word the learner owns: every demand tier bearable, level 5. */
function strong(id: string, dueOffset = -DAY): KnowledgeItem {
	return {
		...item(id, dueOffset),
		fsrsCard: {
			...newCardState(NOW),
			due: NOW + dueOffset,
			stability: 10,
			scheduled_days: 10,
			reps: 5,
			state: CardState.Review,
			last_review: NOW
		}
	};
}

/** A pooled row of the given kind about the given words. */
function pooled(
	id: string,
	kind: ChallengeKind,
	itemIds: string[],
	over: Partial<ChallengeRow> = {}
): ChallengeRow {
	const base = {
		id,
		itemIds,
		generatedAt: NOW - DAY,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	};
	switch (kind.type) {
		case 'recognize-mc':
		case 'produce-mc':
			return {
				...base,
				type: 'multiple-choice',
				direction: kind.type === 'recognize-mc' ? 'toNative' : 'toTarget',
				prompt: 'p',
				options: ['a', 'b', 'c', 'd'],
				correctIndex: 0
			} as ChallengeRow;
		case 'translate-to-native':
		case 'translate-to-target':
			return {
				...base,
				type: 'typed-translation',
				direction: kind.type === 'translate-to-native' ? 'toNative' : 'toTarget',
				prompt: 'p',
				acceptedAnswers: ['a']
			} as ChallengeRow;
		case 'cloze':
			return {
				...base,
				type: 'cloze',
				direction: 'toTarget',
				sentence: 'a ___ b',
				acceptedAnswers: ['x'],
				...(kind.bank ? { wordBank: ['x', 'y', 'z'] } : {})
			} as ChallengeRow;
		case 'word-order':
			return {
				...base,
				type: 'word-order',
				direction: 'toTarget',
				prompt: 'p',
				tiles: ['a', 'b'],
				answerTokens: ['a', 'b'],
				answer: 'a b'
			} as ChallengeRow;
		case 'spot-error':
			return {
				...base,
				type: 'spot-error',
				direction: 'toNative',
				tokens: ['a', 'b'],
				correctIndex: 0,
				intendedWord: 'c',
				correctedSentence: 'c b',
				meaning: 'm'
			} as ChallengeRow;
	}
}

const RECOGNITION = PLANNABLE_KINDS.filter((kind) => kind.demand === 0);
const CONSTRAINED = PLANNABLE_KINDS.filter((kind) => kind.demand === 1);
const FREE = PLANNABLE_KINDS.filter((kind) => kind.demand === 2);

const demandOfKind = (kind: ChallengeKind): number =>
	PLANNABLE_KINDS.find((k) => kindKey(k) === kindKey(kind))?.demand ?? -1;

const keysOf = (wants: Want[]) => wants.map((want) => kindKey(want.kind));

/** A deterministic rng that walks a fixed cycle rather than sitting on one value. */
function cyclingRng(): () => number {
	const values = [0.13, 0.71, 0.42, 0.97, 0.05, 0.6];
	let n = 0;
	return () => values[n++ % values.length];
}

describe('planTopUp', () => {
	it('wants two recognition kinds for a brand-new word with nothing in the pool', () => {
		const wants = planTopUp([], [item('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(WANT_PER_WORD);
		for (const want of wants) {
			expect(want.item).toEqual({ id: 'a', term: 'term-a', meaning: 'meaning-a' });
			expect(want.difficulty).toBe(1);
			expect(demandOfKind(want.kind)).toBe(0);
		}
		expect(new Set(keysOf(wants)).size).toBe(WANT_PER_WORD);
	});

	it('wants one recognition and one production kind for a word that can bear production', () => {
		const wants = planTopUp([], [strong('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(WANT_PER_WORD);
		// Both wants carry the word's own rung, and a strong word sits high on it.
		expect(wants[1].difficulty).toBe(wants[0].difficulty);
		expect(wants[0].difficulty).toBeGreaterThanOrEqual(4);
		expect(demandOfKind(wants[0].kind)).toBe(0);
		expect(demandOfKind(wants[1].kind)).toBeGreaterThan(0);
	});

	it('never asks a new word for a kind it cannot bear', () => {
		// Whatever the rng draws, a level-1 word is only ever offered demand-0
		// kinds — the session would decline to serve anything else for weeks.
		for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
			const wants = planTopUp([], [item('a')], NOW, { rng: () => seed });
			for (const want of wants) expect(demandOfKind(want.kind)).toBe(0);
		}
	});

	it('wants nothing for a word the pool already covers', () => {
		const pool = [pooled('r', RECOGNITION[0], ['a']), pooled('p', FREE[0], ['a'])];
		expect(planTopUp(pool, [strong('a')], NOW)).toEqual([]);
	});

	it('asks only for the production kind when the recognition side is covered', () => {
		const pool = [pooled('r', RECOGNITION[0], ['a'])];
		const wants = planTopUp(pool, [strong('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(1);
		expect(demandOfKind(wants[0].kind)).toBeGreaterThan(0);
	});

	it('asks only for the recognition kind when the production side is covered', () => {
		const pool = [pooled('p', CONSTRAINED[0], ['a'])];
		const wants = planTopUp(pool, [strong('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(1);
		expect(demandOfKind(wants[0].kind)).toBe(0);
	});

	it('does not count a challenge the word cannot bear as coverage', () => {
		// A free-production row about a level-1 word: the session would never
		// serve it, so it covers nothing, and the word still wants its two
		// recognition kinds.
		const pool = [pooled('p', FREE[0], ['a'])];
		const wants = planTopUp(pool, [item('a')], NOW, { rng: cyclingRng() });
		expect(wants).toHaveLength(WANT_PER_WORD);
	});

	it('does not count a resting challenge as coverage, but remembers the word had that kind', () => {
		// Served yesterday: not rested, so a recognition want is still owed — but
		// it goes to a kind the word has *never* had, not back to the same one.
		const pool = [pooled('r', RECOGNITION[0], ['a'], { timesServed: 1, lastServedAt: NOW - DAY })];
		const wants = planTopUp(pool, [item('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(WANT_PER_WORD);
		expect(keysOf(wants)).not.toContain(kindKey(RECOGNITION[0]));
	});

	it('counts a challenge as rested again once the gap has passed', () => {
		const pool = [
			pooled('r', RECOGNITION[0], ['a'], { timesServed: 1, lastServedAt: NOW - RESERVE_GAP })
		];
		const wants = planTopUp(pool, [item('a')], NOW, { rng: cyclingRng() });
		// One recognition kind covered, one still wanted.
		expect(wants).toHaveLength(WANT_PER_WORD - 1);
		expect(keysOf(wants)).not.toContain(kindKey(RECOGNITION[0]));
	});

	it('prefers a kind the word has never had over one it has, and only then repeats', () => {
		// Every recognition kind but one has been served and is resting: the one
		// never seen wins the first want whatever the rng says; the second has to
		// repeat something, since nothing fresh is left.
		const had = RECOGNITION.slice(1);
		const pool = had.map((kind, i) =>
			pooled(`r${i}`, kind, ['a'], { timesServed: 1, lastServedAt: NOW - DAY })
		);
		for (const seed of [0, 0.5, 0.999]) {
			const wants = planTopUp(pool, [item('a')], NOW, { rng: () => seed });
			expect(keysOf(wants)[0]).toBe(kindKey(RECOGNITION[0]));
			expect(wants).toHaveLength(WANT_PER_WORD);
			expect(new Set(keysOf(wants)).size).toBe(WANT_PER_WORD);
		}
	});

	it('ignores reported rows and rows about a word that no longer exists', () => {
		const pool = [
			pooled('flagged', RECOGNITION[0], ['a'], { reported: true }),
			pooled('orphan', RECOGNITION[1], ['a', 'gone'])
		];
		const wants = planTopUp(pool, [item('a')], NOW, { rng: cyclingRng() });
		expect(wants).toHaveLength(WANT_PER_WORD);
	});

	it('walks the words most overdue first, then review-ahead, and caps the list', () => {
		const items = Array.from({ length: 20 }, (_, i) => item(`w${i}`, (i - 10) * DAY));
		const wants = planTopUp([], items, NOW, { rng: cyclingRng(), maxItems: 20 });

		expect(wants).toHaveLength(MAX_TOPUP_WANTS);
		// Most overdue first: w0 is due ten days ago, w9 yesterday, w10 today...
		expect(wants[0].item.id).toBe('w0');
		expect(wants[1].item.id).toBe('w0');
		expect(wants[2].item.id).toBe('w1');
		// ...and the cap cuts the least urgent words, not the most.
		expect(wants.map((want) => want.item.id)).not.toContain('w19');
	});

	it('honours maxItems', () => {
		const items = [item('a', -3 * DAY), item('b', -2 * DAY), item('c', -DAY)];
		const wants = planTopUp([], items, NOW, { rng: cyclingRng(), maxItems: 2 });
		expect(new Set(wants.map((want) => want.item.id))).toEqual(new Set(['a', 'b']));
	});

	it('never gives one word the same kind twice', () => {
		const items = [item('a'), strong('b')];
		for (const seed of [0, 0.5, 0.999]) {
			const wants = planTopUp([], items, NOW, { rng: () => seed });
			const pairs = wants.map((want) => `${want.item.id}|${kindKey(want.kind)}`);
			expect(new Set(pairs).size).toBe(pairs.length);
		}
	});

	it('is deterministic given the rng, and varies with it', () => {
		const items = [item('a'), strong('b'), item('c')];
		const once = planTopUp([], items, NOW, { rng: cyclingRng() });
		const again = planTopUp([], items, NOW, { rng: cyclingRng() });
		expect(again).toEqual(once);

		const kinds = new Set(
			[0, 0.3, 0.6, 0.9].map((seed) =>
				keysOf(planTopUp([], items, NOW, { rng: () => seed })).join(',')
			)
		);
		expect(kinds.size).toBeGreaterThan(1);
	});

	it('depends on now: a challenge rests as the clock moves', () => {
		const pool = [pooled('r', RECOGNITION[0], ['a'], { timesServed: 1, lastServedAt: NOW - DAY })];
		const items = [item('a')];
		const soon = planTopUp(pool, items, NOW, { rng: cyclingRng() });
		const later = planTopUp(pool, items, NOW + RESERVE_GAP, { rng: cyclingRng() });
		expect(soon).toHaveLength(WANT_PER_WORD);
		expect(later).toHaveLength(WANT_PER_WORD - 1);
	});

	it('skips a word with no term or no meaning to write about', () => {
		const blank = { ...item('a'), meaning: '  ' };
		expect(planTopUp([], [blank], NOW)).toEqual([]);
	});

	it('has nothing to want with no words at all', () => {
		expect(planTopUp([], [], NOW)).toEqual([]);
	});

	it('is pure: it does not mutate the pool or the items', () => {
		const items = [item('a'), strong('b')];
		const pool = [pooled('r', RECOGNITION[0], ['a'])];
		const snapshot = structuredClone({ items, pool });
		planTopUp(pool, items, NOW, { rng: cyclingRng() });
		expect({ items, pool }).toEqual(snapshot);
	});
});

describe('topUpCoverage', () => {
	it('counts a fully covered vocabulary as covered, with nothing to write', () => {
		const pool = [pooled('r', RECOGNITION[0], ['a']), pooled('p', FREE[0], ['a'])];
		expect(topUpCoverage(pool, [strong('a')], NOW)).toEqual({
			upcoming: 1,
			covered: 1,
			wants: 0
		});
	});

	it('counts a word short of one kind as uncovered, and the want it would write', () => {
		const pool = [pooled('r', RECOGNITION[0], ['a'])];
		expect(topUpCoverage(pool, [strong('a'), item('b')], NOW)).toEqual({
			upcoming: 2,
			covered: 0,
			wants: 3
		});
	});

	it('reports exactly what planTopUp would write', () => {
		const items = [item('a'), strong('b'), item('c')];
		const pool = [pooled('r', RECOGNITION[0], ['a']), pooled('r2', RECOGNITION[1], ['a'])];
		const coverage = topUpCoverage(pool, items, NOW);
		expect(coverage.wants).toBe(planTopUp(pool, items, NOW).length);
		expect(coverage.covered).toBe(1);
	});

	it('does not depend on the rng: the roll picks kinds, never whether a gap exists', () => {
		const items = [item('a'), strong('b'), item('c')];
		const pool = [pooled('r', RECOGNITION[0], ['a'])];
		const seeds = [0, 0.25, 0.5, 0.75, 0.999];
		const seen = new Set(
			seeds.map((seed) => JSON.stringify(topUpCoverage(pool, items, NOW, { rng: () => seed })))
		);
		expect(seen.size).toBe(1);
	});

	it('caps the wants but not the coverage', () => {
		const items = Array.from({ length: 20 }, (_, i) => item(`w${i}`, (i - 10) * DAY));
		const coverage = topUpCoverage([], items, NOW, { maxItems: 20 });
		expect(coverage.wants).toBe(MAX_TOPUP_WANTS);
		expect(coverage).toMatchObject({ upcoming: 20, covered: 0 });
	});

	it('leaves a word with nothing to write about out of both counts', () => {
		const blank = { ...item('a'), meaning: '  ' };
		expect(topUpCoverage([], [blank, item('b')], NOW)).toEqual({
			upcoming: 1,
			covered: 0,
			wants: WANT_PER_WORD
		});
	});

	it('is all zeros with no words', () => {
		expect(topUpCoverage([], [], NOW)).toEqual({ upcoming: 0, covered: 0, wants: 0 });
	});
});
