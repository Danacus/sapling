/**
 * The top-up planner: what the pool is missing, walked over the whole
 * collection in urgency order.
 *
 * Pure, so every case is a pool, a collection and a clock. The kinds are read
 * back through `$lib/llm`'s `PLANNABLE_KINDS`, so the demand tiers asserted on
 * here are the ones the registry test pins against the resolvers.
 */

import { describe, expect, it } from 'vitest';
import type { ChallengeRow } from '$lib/db';
import { PLANNABLE_KINDS, kindKey } from '$lib/llm';
import type { ChallengeKind, Want } from '$lib/llm';
import type { KnowledgeItem } from '$lib/types';
import { RESERVE_GAP, SESSION_LENGTH } from './pool';
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
		fsrsCard: null,
		srs: { due: NOW + dueOffset, retrievability: 0, strength: 0 },
		introducedAt: NOW - 10 * DAY,
		history: []
	};
}

/** A word the learner owns: every demand tier bearable, level 5. */
function strong(id: string, dueOffset = -DAY): KnowledgeItem {
	return {
		...item(id, dueOffset),
		srs: { due: NOW + dueOffset, retrievability: 1, strength: 0.9 }
	};
}

/** A level-3 word: constrained production is available, free production is not. */
function developing(id: string, dueOffset = -DAY): KnowledgeItem {
	return {
		...item(id, dueOffset),
		srs: { due: NOW + dueOffset, retrievability: 1, strength: 0.3 }
	};
}

/** A level-4 word: all production formats are available, recognition is not. */
function advanced(id: string, dueOffset = -DAY): KnowledgeItem {
	return {
		...item(id, dueOffset),
		srs: { due: NOW + dueOffset, retrievability: 1, strength: 0.6 }
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
		case 'context-mc':
			return {
				...base,
				type: 'multiple-choice',
				direction: 'toTarget',
				promptIsTarget: true,
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
		case 'multi-cloze':
			return {
				...base,
				type: 'multi-cloze',
				direction: 'toTarget',
				passage: '___1___ lee. ___2___ bebe.',
				gaps: [
					{ itemId: itemIds[0] ?? 'i1', acceptedAnswers: ['Yo'] },
					{ itemId: itemIds[1] ?? 'i2', acceptedAnswers: ['Ella'] }
				],
				wordBank: ['Yo', 'Ella', 'Tú', 'nosotros', 'ellos']
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
const SPOT_ERROR = RECOGNITION.find((kind) => kind.type === 'spot-error')!;
const CONTEXT_MC = RECOGNITION.find((kind) => kind.type === 'context-mc')!;
const MULTI_CLOZE = CONSTRAINED.find((kind) => kind.type === 'multi-cloze')!;

const demandOfKind = (kind: ChallengeKind): number =>
	PLANNABLE_KINDS.find((k) => kindKey(k) === kindKey(kind))?.demand ?? -1;

const keysOf = (wants: Want[]) => wants.map((want) => kindKey(want.kind));
const wordsOf = (wants: Want[]) => [...new Set(wants.map((want) => want.item.id))];

/** `count` brand-new words, all overdue, `w0` the most overdue of them. */
const overdueWords = (count: number) =>
	Array.from({ length: count }, (_, i) => item(`w${i}`, (i - count) * DAY));

/** Two rested recognition rows about `id` — everything a level-1 word wants. */
const coverNew = (id: string) => [
	pooled(`${id}-r0`, RECOGNITION[0], [id]),
	pooled(`${id}-r1`, RECOGNITION[1], [id])
];

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

	it('wants two distinct production kinds at the top rung', () => {
		const wants = planTopUp([], [strong('a')], NOW, { rng: cyclingRng() });

		// At level 5 only multi-cloze and bankless cloze are active; the old
		// recognition formats have deliberately aged out, but variety remains.
		expect(wants).toHaveLength(WANT_PER_WORD);
		expect(wants.every((want) => want.difficulty === 5)).toBe(true);
		expect(new Set(keysOf(wants))).toEqual(new Set([kindKey(MULTI_CLOZE), kindKey(FREE[0])]));
		expect(wants.every((want) => demandOfKind(want.kind) > 0)).toBe(true);
	});

	it('keeps two distinct production kinds at level 4 when recognition has ended', () => {
		const wants = planTopUp([], [advanced('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(WANT_PER_WORD);
		expect(wants.every((want) => want.difficulty === 4)).toBe(true);
		expect(wants.every((want) => demandOfKind(want.kind) > 0)).toBe(true);
		expect(new Set(keysOf(wants)).size).toBe(WANT_PER_WORD);
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
		const pool = [pooled('p', FREE[0], ['a']), pooled('m', MULTI_CLOZE, ['a'])];
		expect(planTopUp(pool, [strong('a')], NOW)).toEqual([]);
	});

	it('asks only for the production kind when the recognition side is covered', () => {
		const pool = [pooled('r', SPOT_ERROR, ['a'])];
		const wants = planTopUp(pool, [developing('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(1);
		expect(demandOfKind(wants[0].kind)).toBeGreaterThan(0);
	});

	it('asks only for the recognition kind when the production side is covered', () => {
		const pool = [pooled('p', CONSTRAINED[0], ['a'])];
		const wants = planTopUp(pool, [developing('a')], NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(1);
		expect(demandOfKind(wants[0].kind)).toBe(0);
		// A level-3 word's recognition side now has two available kinds
		// (spot-error and context-mc, both demand-0 at that rung), neither ever
		// served: the first cyclingRng() draw picks between them.
		expect(kindKey(wants[0].kind)).toBe(kindKey(CONTEXT_MC));
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

	it('walks the words most overdue first and caps the list', () => {
		const wants = planTopUp([], overdueWords(20), NOW, { rng: cyclingRng() });

		expect(wants).toHaveLength(MAX_TOPUP_WANTS);
		// w0 is due twenty days ago, w19 yesterday.
		expect(wants[0].item.id).toBe('w0');
		expect(wants[1].item.id).toBe('w0');
		expect(wants[2].item.id).toBe('w1');
		// ...and the cap cuts the least urgent words, not the most.
		expect(wordsOf(wants)).toHaveLength(MAX_TOPUP_WANTS / WANT_PER_WORD);
		expect(wordsOf(wants)).not.toContain('w19');
	});

	it('walks past the due line into words that are not due yet', () => {
		// No window: once the schedule is paid off the walk keeps going, soonest
		// due first, exactly as `planSession` does on the play side.
		const items = [item('ahead', +5 * DAY), item('owed', -DAY), item('later', +9 * DAY)];
		const wants = planTopUp([], items, NOW, { rng: cyclingRng() });
		expect(wordsOf(wants)).toEqual(['owed', 'ahead', 'later']);
	});

	it('steps over covered words, so the next press reaches the words below them', () => {
		const items = overdueWords(20);
		const first = planTopUp([], items, NOW, { rng: cyclingRng() });
		const reached = wordsOf(first);
		expect(reached).toEqual(Array.from({ length: 12 }, (_, i) => `w${i}`));

		// Everything that press covered is now waiting in the pool.
		const pool = reached.flatMap(coverNew);
		const second = planTopUp(pool, items, NOW, { rng: cyclingRng() });
		expect(wordsOf(second)).toEqual(Array.from({ length: 8 }, (_, i) => `w${i + 12}`));
		expect(second).toHaveLength(8 * WANT_PER_WORD);
	});

	it('runs dry only once the whole collection is covered', () => {
		const items = overdueWords(3);
		const pool = ['w0', 'w1', 'w2'].flatMap(coverNew);
		expect(planTopUp(pool, items, NOW, { rng: cyclingRng() })).toEqual([]);
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

	it('does not depend on the order the store handed the words back', () => {
		const items = overdueWords(6);
		const shuffled = [items[3], items[0], items[5], items[1], items[4], items[2]];
		expect(planTopUp([], shuffled, NOW, { rng: cyclingRng() })).toEqual(
			planTopUp([], items, NOW, { rng: cyclingRng() })
		);
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
		const pool = [pooled('m', MULTI_CLOZE, ['a']), pooled('p', FREE[0], ['a'])];
		expect(topUpCoverage(pool, [strong('a')], NOW)).toEqual({
			upcoming: 1,
			covered: 1,
			wants: 0,
			due: true
		});
	});

	it('counts a word short of one kind as uncovered, and the want it would write', () => {
		const pool = [pooled('m', MULTI_CLOZE, ['a'])];
		expect(topUpCoverage(pool, [strong('a'), item('b')], NOW)).toEqual({
			upcoming: 2,
			covered: 0,
			wants: 3,
			due: true
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
		const coverage = topUpCoverage([], overdueWords(20), NOW);
		expect(coverage.wants).toBe(MAX_TOPUP_WANTS);
		expect(coverage).toMatchObject({ upcoming: 20, covered: 0, due: true });
	});

	it('is the due words when the schedule owes any, however many there are', () => {
		const items = [...overdueWords(3), item('later', +2 * DAY), item('latest', +4 * DAY)];
		expect(topUpCoverage([], items, NOW)).toMatchObject({ upcoming: 3, due: true });
	});

	it('is the next SESSION_LENGTH words when nothing is due', () => {
		const items = Array.from({ length: 25 }, (_, i) => item(`w${i}`, (i + 1) * DAY));
		const coverage = topUpCoverage([], items, NOW);
		expect(coverage).toMatchObject({ upcoming: SESSION_LENGTH, covered: 0, due: false });
		expect(coverage.wants).toBe(MAX_TOPUP_WANTS);
	});

	it('still has wants to write once every due word is covered — the button writes ahead', () => {
		// The figure is about the session; the count is about the button. One due
		// word, fully covered, and one word the schedule does not owe yet.
		const items = [item('due'), item('ahead', +3 * DAY)];
		const pool = coverNew('due');
		expect(topUpCoverage(pool, items, NOW)).toEqual({
			upcoming: 1,
			covered: 1,
			wants: WANT_PER_WORD,
			due: true
		});
	});

	it('leaves a word with nothing to write about out of both counts', () => {
		const blank = { ...item('a'), meaning: '  ' };
		expect(topUpCoverage([], [blank, item('b')], NOW)).toEqual({
			upcoming: 1,
			covered: 0,
			wants: WANT_PER_WORD,
			due: true
		});
	});

	it('is all zeros with no words', () => {
		expect(topUpCoverage([], [], NOW)).toEqual({
			upcoming: 0,
			covered: 0,
			wants: 0,
			due: false
		});
	});
});
