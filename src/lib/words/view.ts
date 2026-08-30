/**
 * Derived, read-only view of the knowledge base for the words/vocabulary
 * ledger page (`src/routes/words`). Everything here is pure and takes `now`
 * explicitly — the same discipline as `$lib/srs` — so the page can compute a
 * fresh view on every render without smuggling a clock into the model.
 */

import type { KnowledgeItem } from '$lib/types';
import {
	CardState,
	Grade,
	isDue,
	retrievability,
	wordStrength,
	type FsrsCardState
} from '$lib/srs';

/** One word with everything the ledger shows about it, derived once per render. */
export interface WordRow {
	item: KnowledgeItem;
	card: FsrsCardState;
	state: CardState;
	due: boolean;
	strength: number;
	retrievability: number;
	/** Fraction of reviews graded Good or better; `null` when never reviewed. */
	accuracy: number | null;
	lastReviewAt: number | null;
}

export function toWordRow(item: KnowledgeItem, now: number): WordRow {
	const card = item.fsrsCard as FsrsCardState;

	// Counters, not the history: the ledger renders every word the learner has,
	// and `getAllItems` deliberately does not carry their review entries.
	const reviews = item.reviewCount ?? item.history.length;
	const correct =
		item.correctCount ?? item.history.filter((entry) => entry.grade >= Grade.Good).length;
	const accuracy = reviews === 0 ? null : correct / reviews;

	return {
		item,
		card,
		state: card.state,
		due: isDue(card, now),
		strength: wordStrength(card, now),
		retrievability: retrievability(card, now),
		accuracy,
		lastReviewAt: card.last_review
	};
}

export type SortKey =
	| 'strength'
	| 'due'
	| 'stability'
	| 'difficulty'
	| 'retrievability'
	| 'lapses'
	| 'reps'
	| 'accuracy'
	| 'introduced'
	| 'alpha';

export type SortDir = 'asc' | 'desc';

export type StateFilter = 'all' | 'due' | CardState;

export interface WordQuery {
	search: string;
	sort: SortKey;
	dir: SortDir;
	filter: StateFilter;
}

/** The metric a sort key pulls out of a row; `null` only ever occurs for `accuracy`. */
function sortValue(row: WordRow, key: SortKey): number | null {
	switch (key) {
		case 'strength':
			return row.strength;
		case 'due':
			return row.card.due;
		case 'stability':
			return row.card.stability;
		case 'difficulty':
			return row.card.difficulty;
		case 'retrievability':
			return row.retrievability;
		case 'lapses':
			return row.card.lapses;
		case 'reps':
			return row.card.reps;
		case 'accuracy':
			return row.accuracy;
		case 'introduced':
			return row.item.introducedAt;
		case 'alpha':
			// alpha compares by term text, not a number; handled directly in the
			// comparator below rather than shoehorned through this numeric slot.
			return null;
	}
}

/**
 * Builds the total-order comparator for one query: primary key per `sort`
 * (nulls — only possible for `accuracy`, a word never reviewed — always sort
 * last, regardless of `dir`), then term, then id, so ties never reorder
 * between renders.
 */
function compareRows(query: WordQuery): (a: WordRow, b: WordRow) => number {
	const sign = query.dir === 'asc' ? 1 : -1;

	return (a, b) => {
		if (query.sort === 'alpha') {
			const byTerm = a.item.term.localeCompare(b.item.term) * sign;
			if (byTerm !== 0) return byTerm;
		} else {
			const av = sortValue(a, query.sort);
			const bv = sortValue(b, query.sort);
			if (av === null && bv === null) {
				// fall through to the tie-break below
			} else if (av === null) {
				return 1;
			} else if (bv === null) {
				return -1;
			} else if (av !== bv) {
				return (av - bv) * sign;
			}
		}

		const byTerm = a.item.term.localeCompare(b.item.term);
		if (byTerm !== 0) return byTerm;
		return a.item.id.localeCompare(b.item.id);
	};
}

function matchesFilter(row: WordRow, filter: StateFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'due') return row.due;
	return row.state === filter;
}

function matchesSearch(row: WordRow, needle: string): boolean {
	if (needle === '') return true;
	const haystack =
		`${row.item.term} ${row.item.meaning} ${row.item.romanization ?? ''}`.toLowerCase();
	return haystack.includes(needle);
}

/**
 * Filter + search + sort over rows that have already been derived.
 *
 * Split from {@link queryWords} because the page needs the *unfiltered* rows
 * anyway for its summary tiles, and `toWordRow` folds FSRS retrievability and
 * strength per word — deriving them once for the tiles and again for the table
 * meant doing that work twice over the whole collection on every render.
 */
export function filterWords(rows: WordRow[], query: WordQuery): WordRow[] {
	const needle = query.search.trim().toLowerCase();

	return rows
		.filter((row) => matchesFilter(row, query.filter))
		.filter((row) => matchesSearch(row, needle))
		.sort(compareRows(query));
}

/** Derive + filter + search + sort, for callers that have no rows in hand. */
export function queryWords(items: KnowledgeItem[], query: WordQuery, now: number): WordRow[] {
	return filterWords(
		items.map((item) => toWordRow(item, now)),
		query
	);
}

/** UI names for the four FSRS card states. */
export const STATE_LABELS: Record<CardState, string> = {
	[CardState.New]: 'New',
	[CardState.Learning]: 'Learning',
	[CardState.Review]: 'Review',
	[CardState.Relearning]: 'Relearning'
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/** Coarse relative time for due/last-review cells: 'just now', '2 h ago', 'in 3 d', 'in 4 mo', ... */
export function formatRelative(ts: number, now: number): string {
	const delta = ts - now;
	const abs = Math.abs(delta);

	if (abs < MINUTE) return 'just now';

	let value: number;
	let unit: string;
	if (abs < HOUR) {
		value = Math.round(abs / MINUTE);
		unit = 'min';
	} else if (abs < DAY) {
		value = Math.round(abs / HOUR);
		unit = 'h';
	} else if (abs < MONTH) {
		value = Math.round(abs / DAY);
		unit = 'd';
	} else if (abs < YEAR) {
		value = Math.round(abs / MONTH);
		unit = 'mo';
	} else {
		value = Math.round(abs / YEAR);
		unit = 'yr';
	}

	const text = `${value} ${unit}`;
	return delta < 0 ? `${text} ago` : `in ${text}`;
}

/** Days with one sensible unit for stability: '<0.1 d', '0.4 d', '12 d', '3.2 mo', '1.5 yr'. */
export function formatDays(days: number): string {
	if (days < 0.1) return '<0.1 d';
	if (days < 1) return `${days.toFixed(1)} d`;
	if (days < 60) return `${Math.round(days)} d`;
	if (days < 365) return `${(days / 30.44).toFixed(1)} mo`;
	return `${(days / 365.25).toFixed(1)} yr`;
}
