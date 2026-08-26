import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import { CardState, Grade, newCardState, reviewCard, type FsrsCardState } from '$lib/srs';
import {
	STATE_LABELS,
	formatDays,
	formatRelative,
	queryWords,
	toWordRow,
	type WordQuery
} from './view';

/** Fixed instant: 2026-01-01T00:00:00.000Z. Every test computes off this. */
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

/** A mature, reviewed card at a given stability. */
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

const baseQuery: WordQuery = { search: '', sort: 'alpha', dir: 'asc', filter: 'all' };

describe('toWordRow', () => {
	it('derives state, due, strength and retrievability from the fsrsCard', () => {
		const card = mature(30, NOW - DAY);
		const row = toWordRow(item({ fsrsCard: card }), NOW);
		expect(row.card).toBe(card);
		expect(row.state).toBe(CardState.Review);
		expect(row.due).toBe(card.due <= NOW);
		expect(row.strength).toBeGreaterThan(0);
		expect(row.strength).toBeLessThanOrEqual(1);
		expect(row.retrievability).toBeGreaterThan(0);
		expect(row.retrievability).toBeLessThanOrEqual(1);
		expect(row.lastReviewAt).toBe(card.last_review);
	});

	it('reports accuracy as null when history is empty', () => {
		const row = toWordRow(item({ fsrsCard: newCardState(NOW), history: [] }), NOW);
		expect(row.accuracy).toBeNull();
	});

	it('computes accuracy as the fraction of Good-or-better entries', () => {
		const row = toWordRow(
			item({
				fsrsCard: newCardState(NOW),
				history: [
					{ at: NOW - DAY, grade: Grade.Good },
					{ at: NOW - DAY, grade: Grade.Easy },
					{ at: NOW - DAY, grade: Grade.Again },
					{ at: NOW - DAY, grade: Grade.Hard }
				]
			}),
			NOW
		);
		expect(row.accuracy).toBeCloseTo(0.5);
	});

	it('is due exactly when isDue would say so', () => {
		const dueRow = toWordRow(item({ fsrsCard: { ...newCardState(NOW), due: NOW - MINUTE } }), NOW);
		const notDueRow = toWordRow(
			item({ fsrsCard: { ...newCardState(NOW), due: NOW + MINUTE } }),
			NOW
		);
		expect(dueRow.due).toBe(true);
		expect(notDueRow.due).toBe(false);
	});
});

describe('queryWords: filter', () => {
	function stateItem(id: string, state: CardState, due: number): KnowledgeItem {
		const fsrsCard: FsrsCardState =
			state === CardState.New
				? { ...newCardState(NOW), due }
				: { ...mature(1, NOW - DAY), state, due };
		return item({ id, term: id, fsrsCard });
	}

	const items = [
		stateItem('new', CardState.New, NOW - DAY),
		stateItem('learning', CardState.Learning, NOW + DAY),
		stateItem('review', CardState.Review, NOW - DAY),
		stateItem('relearning', CardState.Relearning, NOW + DAY)
	];

	it("'all' keeps everything", () => {
		const rows = queryWords(items, { ...baseQuery, filter: 'all' }, NOW);
		expect(rows.map((r) => r.item.id).sort()).toEqual(['learning', 'new', 'relearning', 'review']);
	});

	it("'due' keeps only rows currently due", () => {
		const rows = queryWords(items, { ...baseQuery, filter: 'due' }, NOW);
		expect(rows.map((r) => r.item.id).sort()).toEqual(['new', 'review']);
	});

	it('a CardState keeps only rows in that state', () => {
		const rows = queryWords(items, { ...baseQuery, filter: CardState.Learning }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['learning']);
	});
});

describe('queryWords: search', () => {
	const items = [
		item({
			id: 'a',
			term: 'Katze',
			meaning: 'cat',
			romanization: undefined,
			fsrsCard: newCardState(NOW)
		}),
		item({
			id: 'b',
			term: '猫',
			meaning: 'cat (jp)',
			romanization: 'neko',
			fsrsCard: newCardState(NOW)
		}),
		item({ id: 'c', term: 'Hund', meaning: 'dog', fsrsCard: newCardState(NOW) })
	];

	it('empty search matches everything', () => {
		const rows = queryWords(items, { ...baseQuery, search: '' }, NOW);
		expect(rows).toHaveLength(3);
	});

	it('matches against term', () => {
		const rows = queryWords(items, { ...baseQuery, search: 'Katze' }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['a']);
	});

	it('matches against meaning', () => {
		const rows = queryWords(items, { ...baseQuery, search: 'dog' }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['c']);
	});

	it('matches against romanization', () => {
		const rows = queryWords(items, { ...baseQuery, search: 'neko' }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['b']);
	});

	it('is case-insensitive', () => {
		const rows = queryWords(items, { ...baseQuery, search: 'KATZE' }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['a']);
	});

	it('is trimmed', () => {
		const rows = queryWords(items, { ...baseQuery, search: '  katze  ' }, NOW);
		expect(rows.map((r) => r.item.id)).toEqual(['a']);
	});

	it('treats a missing romanization as empty rather than matching', () => {
		const rows = queryWords(items, { ...baseQuery, search: 'undefined' }, NOW);
		expect(rows).toHaveLength(0);
	});
});

describe('queryWords: sort', () => {
	it('sorts by strength, flipping with dir', () => {
		const items = [
			item({ id: 'weak', term: 'weak', fsrsCard: newCardState(NOW) }),
			item({ id: 'strong', term: 'strong', fsrsCard: mature(30, NOW) })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['weak', 'strong']);
		const desc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['strong', 'weak']);
	});

	it('sorts by due timestamp', () => {
		const items = [
			item({ id: 'later', term: 'later', fsrsCard: { ...newCardState(NOW), due: NOW + DAY } }),
			item({ id: 'sooner', term: 'sooner', fsrsCard: { ...newCardState(NOW), due: NOW - DAY } })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'due', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['sooner', 'later']);
		const desc = queryWords(items, { ...baseQuery, sort: 'due', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['later', 'sooner']);
	});

	it('sorts accuracy with null (never reviewed) always last, in either direction', () => {
		const items = [
			item({ id: 'never', term: 'never', fsrsCard: newCardState(NOW), history: [] }),
			item({
				id: 'high',
				term: 'high',
				fsrsCard: newCardState(NOW),
				history: [{ at: NOW - DAY, grade: Grade.Good }]
			}),
			item({
				id: 'low',
				term: 'low',
				fsrsCard: newCardState(NOW),
				history: [{ at: NOW - DAY, grade: Grade.Again }]
			})
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'accuracy', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['low', 'high', 'never']);
		const desc = queryWords(items, { ...baseQuery, sort: 'accuracy', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['high', 'low', 'never']);
	});

	it('sorts alpha by term via localeCompare, flipping with dir', () => {
		const items = [
			item({ id: 'z', term: 'zebra', fsrsCard: newCardState(NOW) }),
			item({ id: 'a', term: 'apple', fsrsCard: newCardState(NOW) }),
			item({ id: 'm', term: 'mango', fsrsCard: newCardState(NOW) })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'alpha', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['a', 'm', 'z']);
		const desc = queryWords(items, { ...baseQuery, sort: 'alpha', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['z', 'm', 'a']);
	});

	it('breaks ties deterministically by term then id, regardless of dir', () => {
		const items = [
			item({ id: 'b', term: 'same', fsrsCard: newCardState(NOW) }),
			item({ id: 'a', term: 'same', fsrsCard: newCardState(NOW) })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['a', 'b']);
		const desc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['a', 'b']);
	});
});

describe('STATE_LABELS', () => {
	it('names all four states', () => {
		expect(STATE_LABELS[CardState.New]).toBe('New');
		expect(STATE_LABELS[CardState.Learning]).toBe('Learning');
		expect(STATE_LABELS[CardState.Review]).toBe('Review');
		expect(STATE_LABELS[CardState.Relearning]).toBe('Relearning');
	});
});

describe('formatRelative', () => {
	it('is "just now" within +/- 60s', () => {
		expect(formatRelative(NOW, NOW)).toBe('just now');
		expect(formatRelative(NOW + 30 * 1000, NOW)).toBe('just now');
		expect(formatRelative(NOW - 30 * 1000, NOW)).toBe('just now');
	});

	it('formats past times as "X ago"', () => {
		expect(formatRelative(NOW - 2 * HOUR, NOW)).toBe('2 h ago');
		expect(formatRelative(NOW - 3 * DAY, NOW)).toBe('3 d ago');
	});

	it('formats future times as "in X"', () => {
		expect(formatRelative(NOW + 2 * HOUR, NOW)).toBe('in 2 h');
		expect(formatRelative(NOW + 3 * DAY, NOW)).toBe('in 3 d');
	});

	it('switches units at each boundary', () => {
		expect(formatRelative(NOW + 5 * MINUTE, NOW)).toBe('in 5 min');
		expect(formatRelative(NOW + 25 * HOUR, NOW)).toBe('in 1 d');
		expect(formatRelative(NOW + 45 * DAY, NOW)).toBe('in 1 mo');
		expect(formatRelative(NOW + 400 * DAY, NOW)).toBe('in 1 yr');
	});
});

describe('formatDays', () => {
	it('shows <0.1 d for very small values', () => {
		expect(formatDays(0.05)).toBe('<0.1 d');
		expect(formatDays(0)).toBe('<0.1 d');
	});

	it('shows one decimal under a day', () => {
		expect(formatDays(0.4)).toBe('0.4 d');
	});

	it('shows a rounded integer of days under 60', () => {
		expect(formatDays(12)).toBe('12 d');
		expect(formatDays(59)).toBe('59 d');
	});

	it('shows months with one decimal between 60 and 365 days', () => {
		expect(formatDays(60)).toBe('2.0 mo');
		expect(formatDays(97)).toBe('3.2 mo');
	});

	it('shows years with one decimal at 365 days and beyond', () => {
		expect(formatDays(365)).toBe('1.0 yr');
		expect(formatDays(548)).toBe('1.5 yr');
	});
});
