import { describe, expect, it } from 'vitest';
import { CardState, newCardState, wordStrength, type FsrsCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';
import type { RomanizedToken } from '$lib/romanize';
import {
	HIDE_READING_CEILING,
	HIDE_READING_FLOOR,
	applyPlan,
	challengeReadingStrength,
	hideReadingProbability,
	planReadings,
	shouldShowReading,
	type ReadingPlan
} from './romanization';

/** Fixed instant: 2026-01-01T00:00:00.000Z. Every test computes off this. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * A reviewed card of the given stability, last seen just now — the only knob
 * that moves `wordStrength` far enough to matter here.
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

function item(id: string, fsrsCard: FsrsCardState): KnowledgeItem {
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

function challenge(itemIds: string[]): Challenge {
	return {
		id: 'c1',
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: '猫',
		options: ['cat', 'dog', 'bird', 'fish'],
		correctIndex: 0,
		itemIds
	};
}

/** A card the learner owns: mature stability, reviewed today. */
const OWNED = reviewedCard(60);
/** A card mid-ramp — strength strictly between floor and ceiling. */
const MIDDLING = reviewedCard(7);

describe('hideReadingProbability', () => {
	it('never hides below the floor', () => {
		expect(hideReadingProbability(0)).toBe(0);
		expect(hideReadingProbability(HIDE_READING_FLOOR)).toBe(0);
		expect(hideReadingProbability(-1)).toBe(0);
	});

	it('always hides at or above the ceiling', () => {
		expect(hideReadingProbability(HIDE_READING_CEILING)).toBe(1);
		expect(hideReadingProbability(1)).toBe(1);
		expect(hideReadingProbability(2)).toBe(1);
	});

	it('ramps linearly in between', () => {
		const midpoint = (HIDE_READING_FLOOR + HIDE_READING_CEILING) / 2;
		expect(hideReadingProbability(midpoint)).toBeCloseTo(0.5, 10);
		expect(hideReadingProbability(HIDE_READING_FLOOR + 0.125)).toBeCloseTo(0.25, 10);
	});

	it('is monotonic', () => {
		let previous = -1;
		for (let strength = 0; strength <= 1; strength += 0.05) {
			const probability = hideReadingProbability(strength);
			expect(probability).toBeGreaterThanOrEqual(previous);
			previous = probability;
		}
	});
});

describe('challengeReadingStrength', () => {
	it('takes the weakest word, not the average', () => {
		const items = [item('strong', OWNED), item('weak', newCardState(NOW))];
		const strength = challengeReadingStrength(challenge(['strong', 'weak']), items, NOW);
		expect(strength).toBeCloseTo(wordStrength(newCardState(NOW), NOW), 10);
		expect(strength).toBeLessThan(wordStrength(OWNED, NOW));
	});

	it('counts an unresolved itemId as unknown', () => {
		const items = [item('strong', OWNED)];
		expect(challengeReadingStrength(challenge(['strong', 'gone']), items, NOW)).toBe(0);
	});

	it('is 0 when the challenge exercises nothing', () => {
		expect(challengeReadingStrength(challenge([]), [item('strong', OWNED)], NOW)).toBe(0);
	});

	it('is the word strength itself for a single-word challenge', () => {
		const items = [item('strong', OWNED)];
		expect(challengeReadingStrength(challenge(['strong']), items, NOW)).toBeCloseTo(
			wordStrength(OWNED, NOW),
			10
		);
	});

	it('sags as an owned word goes unreviewed', () => {
		const items = [item('strong', OWNED)];
		const fresh = challengeReadingStrength(challenge(['strong']), items, NOW);
		const stale = challengeReadingStrength(challenge(['strong']), items, NOW + 90 * DAY);
		expect(stale).toBeLessThan(fresh);
	});
});

describe('shouldShowReading', () => {
	const owned = [item('strong', OWNED)];
	const rigged = (value: number) => () => value;

	it("'on' shows regardless of strength or the roll", () => {
		expect(shouldShowReading('on', challenge(['strong']), owned, NOW, rigged(0))).toBe(true);
		expect(shouldShowReading('on', challenge(['strong']), owned, NOW, rigged(1))).toBe(true);
	});

	it("'off' hides regardless of strength or the roll", () => {
		const unknown = [item('weak', newCardState(NOW))];
		expect(shouldShowReading('off', challenge(['weak']), unknown, NOW, rigged(0))).toBe(false);
		expect(shouldShowReading('off', challenge(['weak']), unknown, NOW, rigged(1))).toBe(false);
	});

	it("'adaptive' always shows for a word the learner just met", () => {
		const unknown = [item('weak', newCardState(NOW))];
		expect(wordStrength(newCardState(NOW), NOW)).toBeCloseTo(0, 6);
		for (const roll of [0, 0.5, 0.999]) {
			expect(shouldShowReading('adaptive', challenge(['weak']), unknown, NOW, rigged(roll))).toBe(
				true
			);
		}
	});

	it("'adaptive' always hides for a word the learner owns", () => {
		expect(wordStrength(OWNED, NOW)).toBeGreaterThanOrEqual(HIDE_READING_CEILING);
		for (const roll of [0, 0.5, 0.999]) {
			expect(shouldShowReading('adaptive', challenge(['strong']), owned, NOW, rigged(roll))).toBe(
				false
			);
		}
	});

	it("'adaptive' splits on the roll mid-ramp", () => {
		const items = [item('mid', MIDDLING)];
		const strength = wordStrength(MIDDLING, NOW);
		expect(strength).toBeGreaterThan(HIDE_READING_FLOOR);
		expect(strength).toBeLessThan(HIDE_READING_CEILING);

		const hideChance = hideReadingProbability(strength);
		const target = challenge(['mid']);
		expect(shouldShowReading('adaptive', target, items, NOW, rigged(hideChance - 0.01))).toBe(false);
		expect(shouldShowReading('adaptive', target, items, NOW, rigged(hideChance + 0.01))).toBe(true);
	});

	it("'adaptive' follows the weakest word of a mixed challenge", () => {
		const items = [item('strong', OWNED), item('weak', newCardState(NOW))];
		expect(
			shouldShowReading('adaptive', challenge(['strong', 'weak']), items, NOW, rigged(0))
		).toBe(true);
	});
});

describe('planReadings', () => {
	const rigged = (value: number) => () => value;
	/** Draws the given rolls in order, then repeats the last one forever. */
	const sequence = (...rolls: number[]) => {
		let at = 0;
		return () => rolls[Math.min(at++, rolls.length - 1)];
	};

	it("'on' shows everything, with nothing to decide per word", () => {
		const items = [item('strong', OWNED)];
		const plan = planReadings('on', challenge(['strong']), items, NOW, rigged(0));
		expect(plan.sentence).toBe(true);
		expect(plan.byTerm.size).toBe(0);
	});

	it("'off' hides everything, with nothing to decide per word", () => {
		const items = [item('weak', newCardState(NOW))];
		const plan = planReadings('off', challenge(['weak']), items, NOW, rigged(1));
		expect(plan.sentence).toBe(false);
		expect(plan.byTerm.size).toBe(0);
	});

	it("'adaptive' agrees with shouldShowReading on the sentence", () => {
		const items = [item('strong', OWNED), item('weak', newCardState(NOW))];
		for (const ids of [['strong'], ['weak'], ['strong', 'weak'], []]) {
			const target = challenge(ids);
			expect(planReadings('adaptive', target, items, NOW, rigged(0.5)).sentence).toBe(
				shouldShowReading('adaptive', target, items, NOW, rigged(0.5))
			);
		}
	});

	it("'adaptive' decides each word from its own strength, not the challenge's", () => {
		const items = [item('strong', OWNED), item('weak', newCardState(NOW))];
		// One rigged roll for every flip: the words still disagree, because it is
		// the *strength* that differs, not the coin.
		const plan = planReadings('adaptive', challenge(['strong', 'weak']), items, NOW, rigged(0.5));

		expect(plan.byTerm.get('strong')).toBe(false);
		expect(plan.byTerm.get('weak')).toBe(true);
		// The weakest word still owns the whole-sentence fallback.
		expect(plan.sentence).toBe(true);
	});

	it("'adaptive' draws an independent roll per word", () => {
		const items = [item('mid-a', MIDDLING), item('mid-b', MIDDLING)];
		const hideChance = hideReadingProbability(wordStrength(MIDDLING, NOW));
		// Draw order: the sentence roll, then one per itemId.
		const rolls = sequence(hideChance + 0.01, hideChance - 0.01, hideChance + 0.01);

		const plan = planReadings('adaptive', challenge(['mid-a', 'mid-b']), items, NOW, rolls);

		expect(plan.sentence).toBe(true);
		expect(plan.byTerm.get('mid-a')).toBe(false);
		expect(plan.byTerm.get('mid-b')).toBe(true);
	});

	it('keys per-word decisions by term, not by item id', () => {
		const worded: KnowledgeItem = { ...item('i1', OWNED), term: '猫' };
		const plan = planReadings('adaptive', challenge(['i1']), [worded], NOW, rigged(0.5));
		expect([...plan.byTerm.keys()]).toEqual(['猫']);
	});

	it('contributes no entry for an itemId that no longer resolves', () => {
		const items = [item('strong', OWNED)];
		const plan = planReadings('adaptive', challenge(['strong', 'gone']), items, NOW, rigged(0.5));
		expect([...plan.byTerm.keys()]).toEqual(['strong']);
		// The vanished word still counts as unknown for the sentence fallback.
		expect(plan.sentence).toBe(true);
	});
});

describe('applyPlan', () => {
	const tokens: RomanizedToken[] = [
		{ text: '我', reading: 'wǒ' },
		{ text: '喜欢', reading: 'xǐ huān' },
		{ text: '___', reading: null },
		{ text: '。', reading: null }
	];
	const plan = (sentence: boolean, byTerm: [string, boolean][] = []): ReadingPlan => ({
		sentence,
		byTerm: new Map(byTerm)
	});

	it('keeps every reading when the whole sentence shows', () => {
		expect(applyPlan(tokens, plan(true))).toEqual(tokens);
	});

	it('drops every reading when the whole sentence hides', () => {
		expect(applyPlan(tokens, plan(false))).toEqual([
			{ text: '我', reading: null },
			{ text: '喜欢', reading: null },
			{ text: '___', reading: null },
			{ text: '。', reading: null }
		]);
	});

	it('lets a tracked term overrule the sentence in both directions', () => {
		const hidden = applyPlan(tokens, plan(true, [['喜欢', false]]));
		expect(hidden.map((token) => token.reading)).toEqual(['wǒ', null, null, null]);

		const shown = applyPlan(tokens, plan(false, [['喜欢', true]]));
		expect(shown.map((token) => token.reading)).toEqual([null, 'xǐ huān', null, null]);
	});

	it('falls back to the sentence for a token no term covers', () => {
		// 我 is glue here — not a word this challenge is exercising.
		expect(applyPlan(tokens, plan(true, [['喜欢', false]]))[0].reading).toBe('wǒ');
		expect(applyPlan(tokens, plan(false, [['喜欢', true]]))[0].reading).toBe(null);
	});

	it('never invents a reading for a token that had none', () => {
		const gap = [{ text: '___', reading: null }];
		expect(applyPlan(gap, plan(true, [['___', true]]))).toEqual(gap);
	});

	it('does not mutate the tokens it was given', () => {
		const input: RomanizedToken[] = [{ text: '猫', reading: 'māo' }];
		applyPlan(input, plan(false));
		expect(input[0].reading).toBe('māo');
	});
});
