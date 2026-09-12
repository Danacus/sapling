/**
 * Tests for the strength-gated challenge-type progression.
 *
 * Two halves, and they are tested separately on purpose: *what a challenge
 * asks* (the demand tier, a fact about the row) and *what a word can bear* (the
 * floors, a fact about the word's strength). The first is exhaustive over
 * `ChallengeType` via a mapped-type table, so a seventh member of the union
 * fails here as well as at the registry; the second is a boundary test on two
 * numbers.
 *
 * The strengths are set on the items directly, because that is how they arrive:
 * the core derives `srs.strength` when the row is read, and this module does
 * arithmetic on the number rather than on a card. What produces the number —
 * log-stability × retrievability, and how it sags as a word is left alone — is
 * pinned in `crates/sapling-core/src/srs.rs`.
 */

import { describe, expect, it } from 'vitest';
import { demandOf } from '$lib/challenges/demand';
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

/**
 * One word as a read returns it. `strength` of `null` is a word with no derived
 * schedule at all — built by hand, never scheduled.
 */
function item(id: string, strength: number | null): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: id,
		meaning: `meaning of ${id}`,
		fsrsCard: null,
		...(strength === null ? {} : { srs: { due: NOW, retrievability: 1, strength } }),
		introducedAt: NOW,
		history: []
	};
}

/* Strengths either side of each floor. The stabilities in brackets are what the
 * core's `word_strength` folds to these numbers on a card reviewed just now. */
/** Never reviewed: the weakest word there is. */
const BRAND_NEW = 0;
/** Under {@link CONSTRAINED_PRODUCTION_FLOOR} (~half a day): recognition only. */
const SHAKY = 0.118;
/** Over the first floor, under the second (~two days): tiles and word banks. */
const LEARNED = 0.32;
/** Over {@link FREE_PRODUCTION_FLOOR} (~ten days): anything the app can ask. */
const OWNED = 0.698;

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
	'multi-cloze': [{ type: 'multi-cloze', direction: 'toTarget', gaps: [], wordBank: [] }],
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
		expect(weakestWordStrength(challenge(mcToNative, ['owned', 'shaky']), items)).toBe(SHAKY);
	});

	it('counts an id that no longer resolves as the weakest word there is', () => {
		expect(weakestWordStrength(challenge(mcToNative, ['owned', 'gone']), items)).toBe(0);
	});

	it('counts a word with no derived schedule at all as zero', () => {
		const cardless = [item('cardless', null)];
		expect(weakestWordStrength(challenge(mcToNative, ['cardless']), cardless)).toBe(0);
	});

	it('is zero for a challenge that exercises nothing', () => {
		expect(weakestWordStrength(challenge(mcToNative, []), items)).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */

describe('bearableDemand', () => {
	it('gives a never-reviewed word recognition and nothing else', () => {
		expect(bearableDemand(challenge(mcToNative, ['brand-new']), items)).toBe(0);
	});

	it('climbs a tier at each floor', () => {
		expect(bearableDemand(challenge(mcToNative, ['shaky']), items)).toBe(0);
		expect(bearableDemand(challenge(mcToNative, ['learned']), items)).toBe(1);
		expect(bearableDemand(challenge(mcToNative, ['owned']), items)).toBe(2);
	});

	it('includes the floors themselves', () => {
		// `>=`, so a word sitting exactly on a floor has already cleared it.
		const onFloors = [item('c1', CONSTRAINED_PRODUCTION_FLOOR), item('f1', FREE_PRODUCTION_FLOOR)];
		expect(bearableDemand(challenge(mcToNative, ['c1']), onFloors)).toBe(1);
		expect(bearableDemand(challenge(mcToNative, ['f1']), onFloors)).toBe(2);
	});

	it('is decided by the weakest word, however strong the rest are', () => {
		expect(bearableDemand(challenge(mcToNative, ['owned', 'brand-new']), items)).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */

describe('bearable', () => {
	it('lets a brand-new word have recognition only', () => {
		const on = (sample: object) => bearable(challenge(sample, ['brand-new']), items);
		expect(on(mcToTarget)).toBe(true);
		expect(on(typedToNative)).toBe(true);
		expect(on(samples['word-order'][0])).toBe(false);
		expect(on(clozeBanked)).toBe(false);
		expect(on(typedToTarget)).toBe(false);
	});

	it('opens constrained production once a word has been recalled', () => {
		const on = (sample: object) => bearable(challenge(sample, ['learned']), items);
		expect(on(samples['word-order'][0])).toBe(true);
		expect(on(clozeBanked)).toBe(true);
		// Still not free production.
		expect(on(clozeBankless)).toBe(false);
		expect(on(typedToTarget)).toBe(false);
	});

	it('opens everything for a word the learner owns', () => {
		const on = (sample: object) => bearable(challenge(sample, ['owned']), items);
		expect(on(typedToTarget)).toBe(true);
		expect(on(clozeBankless)).toBe(true);
		expect(on(samples['word-order'][0])).toBe(true);
		expect(on(mcToTarget)).toBe(true);
	});

	it('refuses production for a challenge whose words are gone', () => {
		// An unresolvable id is tier 0, so only recognition fits — the same answer
		// the reading ramp gives, for the same reason.
		expect(bearable(challenge(typedToTarget, ['gone']), items)).toBe(false);
		expect(bearable(challenge(mcToTarget, ['gone']), items)).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

describe('difficultyLevelOf', () => {
	it('is level 1 below the first floor', () => {
		expect(difficultyLevelOf(item('a', BRAND_NEW))).toBe(1);
		expect(difficultyLevelOf(item('a', SHAKY))).toBe(1);
	});

	it('calls a word with no derived schedule at all level 1', () => {
		expect(difficultyLevelOf(item('a', null))).toBe(1);
	});

	it('climbs one rung at each of the four floors, inclusive', () => {
		const boundaries: [number, number][] = [
			[CONSTRAINED_PRODUCTION_FLOOR, 2],
			[LEVEL_3_FLOOR, 3],
			[FREE_PRODUCTION_FLOOR, 4],
			[LEVEL_5_FLOOR, 5]
		];
		for (const [floor, level] of boundaries) {
			expect(difficultyLevelOf(item('x', floor))).toBe(level);
		}
	});

	it('never disagrees with the demand floors about a tier boundary', () => {
		// Levels 2-3 are exactly tier 1 (CONSTRAINED_PRODUCTION_FLOOR..FREE_PRODUCTION_FLOOR)
		// and 4-5 exactly tier 2 (FREE_PRODUCTION_FLOOR..1) — the whole point of
		// anchoring the ladder on the same two floors.
		expect(difficultyLevelOf(item('a', SHAKY))).toBe(1);
		expect(difficultyLevelOf(item('a', LEARNED))).toBeGreaterThanOrEqual(2);
		expect(difficultyLevelOf(item('a', LEARNED))).toBeLessThanOrEqual(3);
		expect(difficultyLevelOf(item('a', OWNED))).toBeGreaterThanOrEqual(4);
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
		expect(maturityOf(item('a', BRAND_NEW))).toBe('new');
		expect(maturityOf(item('a', SHAKY))).toBe('new');
		expect(maturityOf(item('a', LEARNED))).toBe('young');
		expect(maturityOf(item('a', OWNED))).toBe('solid');
	});

	it('calls a word with no derived schedule at all new', () => {
		expect(maturityOf(item('a', null))).toBe('new');
	});

	it('agrees with difficultyLevelOf at every level', () => {
		const expected: Record<number, Maturity> = {
			1: 'new',
			2: 'young',
			3: 'young',
			4: 'solid',
			5: 'solid'
		};
		for (const strength of [BRAND_NEW, SHAKY, LEARNED, OWNED]) {
			const sample = item('a', strength);
			expect(maturityOf(sample)).toBe(expected[difficultyLevelOf(sample)]);
		}
	});

	it('sags with the strength, so a word left unreviewed stops being solid', () => {
		// Retrievability is the other half of the strength the core derives: a word
		// left alone long enough falls back a bucket, and the planner should stop
		// asking for it to be produced from nothing. What makes the number fall is
		// the forgetting curve, pinned in the core; what this asserts is that the
		// bucket follows it. A ten-day-stability word takes about a year to get
		// here.
		expect(maturityOf(item('a', OWNED))).toBe('solid');
		expect(maturityOf(item('a', OWNED / 2))).toBe('young');
	});
});
