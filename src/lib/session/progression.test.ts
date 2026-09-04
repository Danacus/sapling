/**
 * Tests for the strength-gated challenge-type progression.
 *
 * Two halves, and they are tested separately on purpose: *what a challenge
 * asks* (the demand tier, a fact about the row) and *what a word can bear* (the
 * floors, a fact about the card). The first is exhaustive over `ChallengeType`
 * via a mapped-type table, so a seventh member of the union fails here as well
 * as at the registry; the second is a boundary test on two numbers.
 */

import { describe, expect, it } from 'vitest';
import { demandOf } from '$lib/challenges/demand';
import { CardState, newCardState, wordStrength, type FsrsCardState } from '$lib/srs';
import type { Challenge, ChallengeType, KnowledgeItem } from '$lib/types';
import {
	CONSTRAINED_PRODUCTION_FLOOR,
	FREE_PRODUCTION_FLOOR,
	LEVEL_3_FLOOR,
	LEVEL_5_FLOOR,
	LEVEL_BANDS,
	bearable,
	bearableDemand,
	difficultyLevelOf,
	levelBandCentre,
	levelForStrength,
	maturityOf,
	weakestWordStrength,
	type DifficultyLevel,
	type Maturity
} from './progression';

/** Fixed instant: 2026-01-01T00:00:00.000Z. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * A reviewed card of the given stability, last seen just now — with elapsed time
 * at zero, retrievability is 1 and `wordStrength` collapses to the log-stability
 * term, which is the only knob these tests need to turn.
 */
function reviewedCard(stabilityDays: number): FsrsCardState {
	return {
		due: NOW + stabilityDays * DAY,
		stability: stabilityDays,
		difficulty: 5,
		elapsed_days: 0,
		scheduled_days: stabilityDays,
		learning_steps: 0,
		reps: 5,
		lapses: 0,
		state: CardState.Review,
		last_review: NOW
	};
}

function item(id: string, fsrsCard: FsrsCardState | null): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: id,
		meaning: `meaning of ${id}`,
		fsrsCard,
		introducedAt: NOW,
		history: []
	};
}

/* Cards either side of each floor, verified against `wordStrength` below. */
/** Never reviewed: strength 0, the weakest word there is. */
const BRAND_NEW = newCardState(NOW);
/** Under {@link CONSTRAINED_PRODUCTION_FLOOR}: recognition only. */
const SHAKY = reviewedCard(0.5);
/** Over the first floor, under the second: tiles and word banks, no free recall. */
const LEARNED = reviewedCard(2);
/** Over {@link FREE_PRODUCTION_FLOOR}: anything the app can ask. */
const OWNED = reviewedCard(10);

const items = [
	item('brand-new', BRAND_NEW),
	item('shaky', SHAKY),
	item('learned', LEARNED),
	item('owned', OWNED)
];

/** Every stored type, in a shape `demandOf` accepts, with the fields it reads. */
const samples = {
	'multiple-choice': [
		{
			type: 'multiple-choice',
			direction: 'toTarget',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		},
		{
			type: 'multiple-choice',
			direction: 'toNative',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		}
	],
	'spot-error': [{ type: 'spot-error', direction: 'toTarget', correctIndex: 1 }],
	'match-pairs': [{ type: 'match-pairs', direction: 'toNative', pairs: [] }],
	'word-order': [{ type: 'word-order', direction: 'toTarget', answer: 'a b' }],
	cloze: [
		{ type: 'cloze', direction: 'toTarget', wordBank: ['a', 'b'] },
		{ type: 'cloze', direction: 'toTarget' },
		{ type: 'cloze', direction: 'toTarget', wordBank: [] }
	],
	'typed-translation': [
		{ type: 'typed-translation', direction: 'toTarget' },
		{ type: 'typed-translation', direction: 'toNative' }
	]
} satisfies { [T in ChallengeType]: Partial<Extract<Challenge, { type: T }>>[] };

/** One of the samples above as a challenge over `itemIds`. */
function challenge(sample: object, itemIds: string[] = ['owned']): Challenge {
	return { id: 'c1', itemIds, ...sample } as Challenge;
}

const [mcToTarget, mcToNative] = samples['multiple-choice'];
const [clozeBanked, clozeBankless, clozeEmptyBank] = samples.cloze;
const [typedToTarget, typedToNative] = samples['typed-translation'];

/* -------------------------------------------------------------------------- */

describe('demandOf', () => {
	it('reads recognition off both directions of multiple choice', () => {
		// Picking a target word off a list is still picking: the answer is on
		// screen either way round.
		expect(demandOf(challenge(mcToTarget))).toBe(0);
		expect(demandOf(challenge(mcToNative))).toBe(0);
	});

	it('reads spot-error and match-pairs as recognition', () => {
		expect(demandOf(challenge(samples['spot-error'][0]))).toBe(0);
		expect(demandOf(challenge(samples['match-pairs'][0]))).toBe(0);
	});

	it('reads word-order as constrained production: the tiles are given', () => {
		expect(demandOf(challenge(samples['word-order'][0]))).toBe(1);
	});

	it('splits cloze on the word bank', () => {
		expect(demandOf(challenge(clozeBanked))).toBe(1);
		expect(demandOf(challenge(clozeBankless))).toBe(2);
		// An empty bank is no bank — the learner types it either way.
		expect(demandOf(challenge(clozeEmptyBank))).toBe(2);
	});

	it('splits typed translation on direction, not on the keyboard', () => {
		expect(demandOf(challenge(typedToTarget))).toBe(2);
		// Typing in your own language demands nothing of target-language recall.
		expect(demandOf(challenge(typedToNative))).toBe(0);
	});

	it('answers for every member of the union', () => {
		// The compile-time half is the registry's mapped type; this is its runtime
		// echo, and it fails if a new type is added to `samples` without a def.
		for (const variants of Object.values(samples)) {
			for (const sample of variants) {
				expect([0, 1, 2]).toContain(demandOf(challenge(sample)));
			}
		}
	});
});

/* -------------------------------------------------------------------------- */

describe('weakestWordStrength', () => {
	it('takes the minimum, not the average', () => {
		const weakest = weakestWordStrength(challenge(mcToNative, ['owned', 'shaky']), items, NOW);
		expect(weakest).toBeCloseTo(wordStrength(SHAKY, NOW), 10);
	});

	it('counts an id that no longer resolves as the weakest word there is', () => {
		expect(weakestWordStrength(challenge(mcToNative, ['owned', 'gone']), items, NOW)).toBe(0);
	});

	it('counts a word with no card at all as zero', () => {
		const cardless = [item('cardless', null)];
		expect(weakestWordStrength(challenge(mcToNative, ['cardless']), cardless, NOW)).toBe(0);
	});

	it('is zero for a challenge that exercises nothing', () => {
		expect(weakestWordStrength(challenge(mcToNative, []), items, NOW)).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */

describe('bearableDemand', () => {
	it('gives a never-reviewed word recognition and nothing else', () => {
		expect(bearableDemand(challenge(mcToNative, ['brand-new']), items, NOW)).toBe(0);
	});

	it('climbs a tier at each floor', () => {
		expect(bearableDemand(challenge(mcToNative, ['shaky']), items, NOW)).toBe(0);
		expect(bearableDemand(challenge(mcToNative, ['learned']), items, NOW)).toBe(1);
		expect(bearableDemand(challenge(mcToNative, ['owned']), items, NOW)).toBe(2);
	});

	it('includes the floors themselves', () => {
		// `>=`, so a word sitting exactly on a floor has already cleared it. The
		// cards are solved backwards from `wordStrength` so the boundary is exact
		// rather than approached.
		const at = (strength: number) => reviewedCard(Math.expm1(strength * Math.log1p(30)));
		const onFloors = [
			item('c1', at(CONSTRAINED_PRODUCTION_FLOOR)),
			item('f1', at(FREE_PRODUCTION_FLOOR))
		];
		expect(wordStrength(onFloors[0].fsrsCard as FsrsCardState, NOW)).toBeCloseTo(
			CONSTRAINED_PRODUCTION_FLOOR,
			10
		);

		expect(bearableDemand(challenge(mcToNative, ['c1']), onFloors, NOW)).toBe(1);
		expect(bearableDemand(challenge(mcToNative, ['f1']), onFloors, NOW)).toBe(2);
	});

	it('is decided by the weakest word, however strong the rest are', () => {
		expect(bearableDemand(challenge(mcToNative, ['owned', 'brand-new']), items, NOW)).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */

describe('bearable', () => {
	it('lets a brand-new word have recognition only', () => {
		const on = (sample: object) => bearable(challenge(sample, ['brand-new']), items, NOW);
		expect(on(mcToTarget)).toBe(true);
		expect(on(typedToNative)).toBe(true);
		expect(on(samples['word-order'][0])).toBe(false);
		expect(on(clozeBanked)).toBe(false);
		expect(on(typedToTarget)).toBe(false);
	});

	it('opens constrained production once a word has been recalled', () => {
		const on = (sample: object) => bearable(challenge(sample, ['learned']), items, NOW);
		expect(on(samples['word-order'][0])).toBe(true);
		expect(on(clozeBanked)).toBe(true);
		// Still not free production.
		expect(on(clozeBankless)).toBe(false);
		expect(on(typedToTarget)).toBe(false);
	});

	it('opens everything for a word the learner owns', () => {
		const on = (sample: object) => bearable(challenge(sample, ['owned']), items, NOW);
		expect(on(typedToTarget)).toBe(true);
		expect(on(clozeBankless)).toBe(true);
		expect(on(samples['word-order'][0])).toBe(true);
		expect(on(mcToTarget)).toBe(true);
	});

	it('refuses production for a challenge whose words are gone', () => {
		// An unresolvable id is tier 0, so only recognition fits — the same answer
		// the reading ramp gives, for the same reason.
		expect(bearable(challenge(typedToTarget, ['gone']), items, NOW)).toBe(false);
		expect(bearable(challenge(mcToTarget, ['gone']), items, NOW)).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

describe('difficultyLevelOf', () => {
	/** A card solved backwards from `wordStrength` so a boundary is exact rather than approached. */
	const at = (strength: number) => reviewedCard(Math.expm1(strength * Math.log1p(30)));

	it('is level 1 below the first floor', () => {
		expect(difficultyLevelOf(item('a', BRAND_NEW), NOW)).toBe(1);
		expect(difficultyLevelOf(item('a', SHAKY), NOW)).toBe(1);
	});

	it('calls a word with no card at all level 1', () => {
		expect(difficultyLevelOf(item('a', null), NOW)).toBe(1);
	});

	it('climbs one rung at each of the four floors, inclusive', () => {
		const boundaries: [number, number][] = [
			[CONSTRAINED_PRODUCTION_FLOOR, 2],
			[LEVEL_3_FLOOR, 3],
			[FREE_PRODUCTION_FLOOR, 4],
			[LEVEL_5_FLOOR, 5]
		];
		for (const [floor, level] of boundaries) {
			const onFloor = item('x', at(floor));
			expect(wordStrength(onFloor.fsrsCard as FsrsCardState, NOW)).toBeCloseTo(floor, 10);
			expect(difficultyLevelOf(onFloor, NOW)).toBe(level);
		}
	});

	it('never disagrees with the demand floors about a tier boundary', () => {
		// Levels 2-3 are exactly tier 1 (CONSTRAINED_PRODUCTION_FLOOR..FREE_PRODUCTION_FLOOR)
		// and 4-5 exactly tier 2 (FREE_PRODUCTION_FLOOR..1) — the whole point of
		// anchoring the ladder on the same two floors.
		expect(difficultyLevelOf(item('a', SHAKY), NOW)).toBe(1);
		expect(difficultyLevelOf(item('a', LEARNED), NOW)).toBeGreaterThanOrEqual(2);
		expect(difficultyLevelOf(item('a', LEARNED), NOW)).toBeLessThanOrEqual(3);
		expect(difficultyLevelOf(item('a', OWNED), NOW)).toBeGreaterThanOrEqual(4);
	});
});

describe('LEVEL_BANDS', () => {
	const LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5];

	it('tiles [0, 1] with no gap and no overlap', () => {
		expect(LEVEL_BANDS[1][0]).toBe(0);
		expect(LEVEL_BANDS[5][1]).toBe(1);
		for (const level of [2, 3, 4, 5] as DifficultyLevel[]) {
			expect(LEVEL_BANDS[level][0]).toBe(LEVEL_BANDS[(level - 1) as DifficultyLevel][1]);
		}
	});

	it('agrees with difficultyLevelOf about where every band starts', () => {
		// One geometry, read two ways: `levelForStrength` walks the floors down,
		// `LEVEL_BANDS` states the spans between them. A drift here would put the
		// planner's target in a different band from the word it is about.
		for (const level of LEVELS) {
			expect(levelForStrength(LEVEL_BANDS[level][0])).toBe(level);
		}
	});

	it('puts every band centre strictly inside its own band', () => {
		for (const level of LEVELS) {
			const centre = levelBandCentre(level);
			const [start, end] = LEVEL_BANDS[level];
			expect(centre).toBeGreaterThan(start);
			expect(centre).toBeLessThan(end);
			expect(levelForStrength(centre)).toBe(level);
		}
	});

	it('rises with the level, so a stronger word is aimed higher', () => {
		const centres = LEVELS.map(levelBandCentre);
		expect(centres).toEqual([...centres].sort((a, b) => a - b));
		expect(new Set(centres).size).toBe(centres.length);
	});
});

describe('maturityOf', () => {
	it('buckets on the same floors the planner gates on', () => {
		expect(maturityOf(item('a', BRAND_NEW), NOW)).toBe('new');
		expect(maturityOf(item('a', SHAKY), NOW)).toBe('new');
		expect(maturityOf(item('a', LEARNED), NOW)).toBe('young');
		expect(maturityOf(item('a', OWNED), NOW)).toBe('solid');
	});

	it('calls a word with no card at all new', () => {
		expect(maturityOf(item('a', null), NOW)).toBe('new');
	});

	it('agrees with difficultyLevelOf at every level', () => {
		const expected: Record<number, Maturity> = {
			1: 'new',
			2: 'young',
			3: 'young',
			4: 'solid',
			5: 'solid'
		};
		for (const card of [BRAND_NEW, SHAKY, LEARNED, OWNED]) {
			const sample = item('a', card);
			expect(maturityOf(sample, NOW)).toBe(expected[difficultyLevelOf(sample, NOW)]);
		}
	});

	it('sags as a word is left unreviewed', () => {
		// Retrievability is the other half of `wordStrength`: a word left alone
		// long enough stops being solid, and the prompt should stop asking for it
		// to be produced from nothing. Slowly, though — a ten-day-stability word
		// takes about a year to fall back to 'young', which is the forgetting curve
		// being honest rather than this module being lenient.
		expect(maturityOf(item('a', OWNED), NOW)).toBe('solid');
		expect(maturityOf(item('a', OWNED), NOW + 365 * DAY)).toBe('young');
	});
});
