import { describe, expect, it } from 'vitest';
import type { ItemSrs, KnowledgeItem } from '$lib/types';
import { CardState, Grade, type FsrsCardState } from '$lib/srs';
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

/**
 * A stored card as the core writes one. Built by hand rather than scheduled:
 * this page is the one place that opens the card, and what it opens is a plain
 * record of fields — nothing here computes an FSRS anything.
 */
function newCard(due = NOW): FsrsCardState {
	return {
		due,
		stability: 0,
		difficulty: 0,
		elapsed_days: 0,
		scheduled_days: 0,
		learning_steps: 0,
		reps: 0,
		lapses: 0,
		state: CardState.New,
		last_review: null
	};
}

/** A mature, reviewed card at a given stability. */
function mature(stability: number, reviewedAt: number): FsrsCardState {
	return {
		...newCard(reviewedAt + stability * DAY),
		stability,
		difficulty: 5,
		scheduled_days: stability,
		state: CardState.Review,
		reps: 4,
		last_review: reviewedAt
	};
}

/**
 * One word as a read returns it. `srs` defaults to the card's own `due` with
 * nothing recalled, so a test that cares about strength or the curve says so.
 */
function item(
	overrides: Partial<KnowledgeItem> & { fsrsCard: FsrsCardState; srs?: ItemSrs }
): KnowledgeItem {
	return {
		id: 'id',
		kind: 'vocab',
		term: 'term',
		meaning: 'meaning',
		introducedAt: NOW,
		history: [],
		srs: { due: overrides.fsrsCard.due, retrievability: 0, strength: 0 },
		...overrides
	};
}

const baseQuery: WordQuery = { search: '', sort: 'alpha', dir: 'asc', filter: 'all' };

describe('toWordRow', () => {
	it('takes state and lastReviewAt off the card, strength and the curve off srs', () => {
		const card = mature(30, NOW - DAY);
		const row = toWordRow(
			item({ fsrsCard: card, srs: { due: card.due, retrievability: 0.94, strength: 0.87 } }),
			NOW
		);
		expect(row.card).toBe(card);
		expect(row.state).toBe(CardState.Review);
		expect(row.due).toBe(card.due <= NOW);
		expect(row.strength).toBe(0.87);
		expect(row.retrievability).toBe(0.94);
		expect(row.lastReviewAt).toBe(card.last_review);
	});

	it('reports accuracy as null when history is empty', () => {
		const row = toWordRow(item({ fsrsCard: newCard(), history: [] }), NOW);
		expect(row.accuracy).toBeNull();
	});

	it('computes accuracy as the fraction of Good-or-better entries', () => {
		const row = toWordRow(
			item({
				fsrsCard: newCard(),
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
		const dueRow = toWordRow(item({ fsrsCard: newCard(NOW - MINUTE) }), NOW);
		const notDueRow = toWordRow(item({ fsrsCard: newCard(NOW + MINUTE) }), NOW);
		expect(dueRow.due).toBe(true);
		expect(notDueRow.due).toBe(false);
	});
});

describe('queryWords: filter', () => {
	function stateItem(id: string, state: CardState, due: number): KnowledgeItem {
		const fsrsCard: FsrsCardState =
			state === CardState.New ? newCard(due) : { ...mature(1, NOW - DAY), state, due };
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
			fsrsCard: newCard()
		}),
		item({
			id: 'b',
			term: '猫',
			meaning: 'cat (jp)',
			romanization: 'neko',
			fsrsCard: newCard()
		}),
		item({ id: 'c', term: 'Hund', meaning: 'dog', fsrsCard: newCard() })
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
			item({ id: 'weak', term: 'weak', fsrsCard: newCard() }),
			item({
				id: 'strong',
				term: 'strong',
				fsrsCard: mature(30, NOW),
				srs: { due: NOW + 30 * DAY, retrievability: 1, strength: 1 }
			})
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['weak', 'strong']);
		const desc = queryWords(items, { ...baseQuery, sort: 'strength', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['strong', 'weak']);
	});

	it('sorts by due timestamp', () => {
		const items = [
			item({ id: 'later', term: 'later', fsrsCard: newCard(NOW + DAY) }),
			item({ id: 'sooner', term: 'sooner', fsrsCard: newCard(NOW - DAY) })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'due', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['sooner', 'later']);
		const desc = queryWords(items, { ...baseQuery, sort: 'due', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['later', 'sooner']);
	});

	it('sorts accuracy with null (never reviewed) always last, in either direction', () => {
		const items = [
			item({ id: 'never', term: 'never', fsrsCard: newCard(), history: [] }),
			item({
				id: 'high',
				term: 'high',
				fsrsCard: newCard(),
				history: [{ at: NOW - DAY, grade: Grade.Good }]
			}),
			item({
				id: 'low',
				term: 'low',
				fsrsCard: newCard(),
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
			item({ id: 'z', term: 'zebra', fsrsCard: newCard() }),
			item({ id: 'a', term: 'apple', fsrsCard: newCard() }),
			item({ id: 'm', term: 'mango', fsrsCard: newCard() })
		];
		const asc = queryWords(items, { ...baseQuery, sort: 'alpha', dir: 'asc' }, NOW);
		expect(asc.map((r) => r.item.id)).toEqual(['a', 'm', 'z']);
		const desc = queryWords(items, { ...baseQuery, sort: 'alpha', dir: 'desc' }, NOW);
		expect(desc.map((r) => r.item.id)).toEqual(['z', 'm', 'a']);
	});

	it('breaks ties deterministically by term then id, regardless of dir', () => {
		const items = [
			item({ id: 'b', term: 'same', fsrsCard: newCard() }),
			item({ id: 'a', term: 'same', fsrsCard: newCard() })
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
