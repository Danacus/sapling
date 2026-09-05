import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import {
	CardState,
	Grade,
	gradeFromResult,
	isDue,
	newCardState,
	retrievability,
	reviewCard,
	selectSessionItems,
	wordStrength,
	type FsrsCardState
} from './scheduler';

/** Fixed instant: 2026-01-01T00:00:00.000Z. Every test computes off this. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function item(overrides: Partial<KnowledgeItem> & { fsrsCard: FsrsCardState }): KnowledgeItem {
	return {
		id: 'id',
		kind: 'vocab',
		term: 'term',
		meaning: 'meaning',
		introducedAt: NOW,
		history: [],
		...overrides
	};
}

describe('newCardState', () => {
	it('is due immediately', () => {
		const state = newCardState(NOW);
		expect(isDue(state, NOW)).toBe(true);
		expect(state.due).toBeLessThanOrEqual(NOW);
	});

	it('starts in the New state with no reps', () => {
		const state = newCardState(NOW);
		expect(state.state).toBe(0);
		expect(state.reps).toBe(0);
		expect(state.last_review).toBeNull();
	});
});

describe('reviewCard', () => {
	it('Again re-dues the card sooner than Good, which re-dues sooner than Easy', () => {
		const base = newCardState(NOW);
		const again = reviewCard(base, Grade.Again, NOW);
		const good = reviewCard(base, Grade.Good, NOW);
		const easy = reviewCard(base, Grade.Easy, NOW);

		// Again/Good land in short (~minutes) learning steps; Easy graduates
		// straight to the Review state with a multi-day interval.
		expect(again.due).toBeLessThan(good.due);
		expect(good.due).toBeLessThan(easy.due);
		expect(again.due - NOW).toBeLessThan(DAY);
		expect(good.due - NOW).toBeLessThan(DAY);
		expect(easy.due - NOW).toBeGreaterThanOrEqual(DAY);
	});

	it('increments reps and sets last_review', () => {
		const base = newCardState(NOW);
		const next = reviewCard(base, Grade.Good, NOW);
		expect(next.reps).toBe(1);
		expect(next.last_review).toBe(NOW);
	});

	it('accumulates lapses when a card in Review state is forgotten', () => {
		const base = newCardState(NOW);
		// Easy graduates a new card straight to the Review state.
		const graduated = reviewCard(base, Grade.Easy, NOW);
		expect(graduated.state).toBe(CardState.Review);
		const afterLapse = reviewCard(graduated, Grade.Again, graduated.due);
		expect(afterLapse.lapses).toBe(1);
		expect(afterLapse.state).toBe(CardState.Relearning);
	});

	it('is deterministic: same inputs produce the same outputs', () => {
		const base = newCardState(NOW);
		const a = reviewCard(base, Grade.Good, NOW);
		const b = reviewCard(base, Grade.Good, NOW);
		expect(a).toEqual(b);
	});
});

describe('JSON round trip', () => {
	it('state survives JSON.stringify/parse and keeps scheduling deterministic', () => {
		const base = newCardState(NOW);
		const reviewed = reviewCard(base, Grade.Good, NOW);
		const roundTripped = JSON.parse(JSON.stringify(reviewed)) as FsrsCardState;

		expect(roundTripped).toEqual(reviewed);

		const laterNow = reviewed.due;
		const fromOriginal = reviewCard(reviewed, Grade.Good, laterNow);
		const fromRoundTripped = reviewCard(roundTripped, Grade.Good, laterNow);
		expect(fromRoundTripped).toEqual(fromOriginal);
	});

	it('round-trips a never-reviewed (last_review: null) card', () => {
		const base = newCardState(NOW);
		const roundTripped = JSON.parse(JSON.stringify(base)) as FsrsCardState;
		expect(roundTripped).toEqual(base);
		expect(roundTripped.last_review).toBeNull();
	});
});

describe('gradeFromResult', () => {
	it('maps wrong to Again', () => {
		expect(gradeFromResult('wrong')).toBe(Grade.Again);
	});

	it('maps almost to Hard', () => {
		expect(gradeFromResult('almost')).toBe(Grade.Hard);
	});

	it('maps correct to Good', () => {
		expect(gradeFromResult('correct')).toBe(Grade.Good);
	});

	it('never assigns Easy — only the learner can (see amendResult)', () => {
		const verdicts = ['wrong', 'almost', 'correct'] as const;
		for (const verdict of verdicts) expect(gradeFromResult(verdict)).not.toBe(Grade.Easy);
	});
});

describe('retrievability', () => {
	it('decreases as now advances past the review', () => {
		const base = newCardState(NOW);
		const reviewed = reviewCard(base, Grade.Good, NOW);

		const soon = retrievability(reviewed, reviewed.last_review! + DAY);
		const later = retrievability(reviewed, reviewed.last_review! + 30 * DAY);

		expect(soon).toBeGreaterThan(0);
		expect(soon).toBeLessThanOrEqual(1);
		expect(later).toBeLessThan(soon);
	});

	it('is at its maximum right at the moment of review', () => {
		const base = newCardState(NOW);
		const reviewed = reviewCard(base, Grade.Good, NOW);
		const atReview = retrievability(reviewed, reviewed.last_review!);
		const muchLater = retrievability(reviewed, reviewed.last_review! + 100 * DAY);
		expect(atReview).toBeGreaterThan(muchLater);
	});
});

describe('wordStrength', () => {
	/** A card of a given stability, reviewed at `reviewedAt`. */
	function mature(stability: number, reviewedAt: number): FsrsCardState {
		return {
			...newCardState(NOW),
			stability,
			difficulty: 5,
			state: CardState.Review,
			reps: 4,
			last_review: reviewedAt,
			due: reviewedAt + stability * DAY
		};
	}

	it('scores a freshly created card low', () => {
		expect(wordStrength(newCardState(NOW), NOW)).toBeLessThan(0.35);
	});

	it('scores a mature card just reviewed at (nearly) full strength', () => {
		expect(wordStrength(mature(30, NOW), NOW)).toBeCloseTo(1, 2);
		expect(wordStrength(mature(90, NOW), NOW)).toBeCloseTo(1, 2);
	});

	it('sags for an overdue card at the same stability', () => {
		const stability = 20;
		const fresh = wordStrength(mature(stability, NOW), NOW);
		const overdue = wordStrength(mature(stability, NOW - 120 * DAY), NOW);
		expect(overdue).toBeLessThan(fresh);
	});

	it('separates a young card from a mature one, where retrievability would not', () => {
		const young = wordStrength(mature(1, NOW), NOW);
		const old = wordStrength(mature(30, NOW), NOW);
		expect(young).toBeLessThan(old);
		// The point of the change: both are perfectly recallable right now.
		expect(retrievability(mature(1, NOW), NOW)).toBeCloseTo(
			retrievability(mature(30, NOW), NOW),
			3
		);
	});
});

describe('selectSessionItems', () => {
	function dueItem(id: string, due: number): KnowledgeItem {
		return item({
			id,
			fsrsCard: { ...newCardState(NOW), due }
		});
	}

	it('orders due items most-overdue-first', () => {
		const items = [
			dueItem('a', NOW - 1 * DAY),
			dueItem('b', NOW - 5 * DAY),
			dueItem('c', NOW - 2 * DAY)
		];
		const { reviewItems } = selectSessionItems(items, { now: NOW });
		expect(reviewItems.map((i) => i.id)).toEqual(['b', 'c', 'a']);
	});

	it('puts due work ahead of everything not yet due', () => {
		const items = [dueItem('future', NOW + DAY), dueItem('due', NOW - DAY)];
		const { reviewItems } = selectSessionItems(items, { now: NOW });
		expect(reviewItems.map((i) => i.id)).toEqual(['due', 'future']);
	});

	it('tops up with the soonest-due items when the schedule owes less than maxItems', () => {
		// Generation introduces no vocabulary, so a learner who is caught up would
		// otherwise hand the model nothing to write a lesson about.
		const items = [
			dueItem('later', NOW + 9 * DAY),
			dueItem('soon', NOW + 1 * DAY),
			dueItem('owed', NOW - DAY)
		];
		const { reviewItems } = selectSessionItems(items, { now: NOW, maxItems: 2 });
		expect(reviewItems.map((i) => i.id)).toEqual(['owed', 'soon']);
	});

	it('builds a lesson out of never-reviewed words alone', () => {
		// A word added yesterday by the assistant: card due now, no history.
		const items = [item({ id: 'fresh', fsrsCard: newCardState(NOW), history: [] })];
		const { reviewItems } = selectSessionItems(items, { now: NOW });
		expect(reviewItems.map((i) => i.id)).toEqual(['fresh']);
	});

	it('caps review items at maxItems (default 12)', () => {
		const items = Array.from({ length: 15 }, (_, i) => dueItem(`item-${i}`, NOW - (i + 1) * DAY));
		const { reviewItems } = selectSessionItems(items, { now: NOW });
		expect(reviewItems).toHaveLength(12);
		// the 12 most-overdue items (largest offset = item-14 .. item-3)
		expect(reviewItems.map((i) => i.id)).toEqual(
			Array.from({ length: 12 }, (_, i) => `item-${14 - i}`)
		);
	});

	it('honors an explicit maxItems', () => {
		const items = Array.from({ length: 5 }, (_, i) => dueItem(`item-${i}`, NOW - (i + 1) * DAY));
		const { reviewItems } = selectSessionItems(items, { now: NOW, maxItems: 2 });
		expect(reviewItems).toHaveLength(2);
	});

	it('returns nothing at all for an empty collection', () => {
		// The honest answer, and the reason the learn screen has a "no words yet"
		// message: there is no lesson to build.
		expect(selectSessionItems([], { now: NOW }).reviewItems).toEqual([]);
	});
});
