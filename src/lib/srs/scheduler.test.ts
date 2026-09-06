import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import {
	Grade,
	dueAt,
	gradeFromResult,
	isDue,
	retrievabilityOf,
	selectSessionItems,
	strengthOf
} from './scheduler';

/** Fixed instant: 2026-01-01T00:00:00.000Z. Every test computes off this. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/**
 * An item as a `Backend` read returns it: the derived schedule attached, the
 * card left opaque. Nothing here builds a card — the core owns that shape, and
 * the numbers under test are the ones it hands down.
 */
function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
	return {
		id: 'id',
		kind: 'vocab',
		term: 'term',
		meaning: 'meaning',
		fsrsCard: null,
		introducedAt: NOW,
		history: [],
		...overrides
	};
}

/** An item due at `due`, as read back. */
function dueItem(id: string, due: number): KnowledgeItem {
	return item({ id, srs: { due, retrievability: 1, strength: 0.5 } });
}

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

describe('reading the derived schedule', () => {
	it('isDue is a plain comparison against the caller’s now', () => {
		expect(isDue(dueItem('a', NOW - 1), NOW)).toBe(true);
		expect(isDue(dueItem('a', NOW), NOW)).toBe(true);
		expect(isDue(dueItem('a', NOW + 1), NOW)).toBe(false);
	});

	it('answers against this instant, not the one the row was read at', () => {
		// The whole reason `isDue` stayed on this side: a session holds one `now`
		// and every question it asks has to be answered against that one.
		const word = dueItem('a', NOW + DAY);
		expect(isDue(word, NOW)).toBe(false);
		expect(isDue(word, NOW + 2 * DAY)).toBe(true);
	});

	it('treats an item with no derived schedule as owed now', () => {
		// A word the assistant just minted, or one restored from an import: it was
		// introduced and never scheduled, which is the bottom of the queue.
		const fresh = item({ id: 'fresh' });
		expect(dueAt(fresh, NOW)).toBe(NOW);
		expect(isDue(fresh, NOW)).toBe(true);
		expect(strengthOf(fresh)).toBe(0);
		expect(retrievabilityOf(fresh)).toBe(0);
	});

	it('reads strength and retrievability straight off the item', () => {
		const word = item({ srs: { due: NOW, retrievability: 0.82, strength: 0.41 } });
		expect(strengthOf(word)).toBe(0.41);
		expect(retrievabilityOf(word)).toBe(0.82);
	});
});

describe('selectSessionItems', () => {
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

	it('builds a lesson out of never-scheduled words alone', () => {
		// A word added yesterday by the assistant: no derived schedule, so due now.
		const items = [item({ id: 'fresh' })];
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
