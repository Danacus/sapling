/**
 * Spaced repetition, as the frontend sees it.
 *
 * **There is no FSRS here.** The one implementation lives in
 * `crates/sapling-core/src/srs.rs`, which runs the `fsrs` crate beside SQLite:
 * it folds the review log into the stored card, and it derives the numbers a
 * screen reads — `due`, `retrievability`, `strength` — attaching them to every
 * item a `Backend` read returns as {@link KnowledgeItem.srs}. What is left on
 * this side is the vocabulary a caller needs to *speak* to it (grades and the
 * verdict mapping), the accessors that read those derived numbers off an item,
 * and one selection over them.
 *
 * That is the whole point of the split: a review is filed as `{at, grade}` and
 * the card comes back from the store. Nothing here predicts one, so nothing here
 * can disagree with what was written.
 *
 * Every function is pure and deterministic. Where a comparison needs the clock,
 * callers pass `now` (epoch ms) explicitly — that stays true for {@link isDue},
 * which is a date comparison and nothing more. The numbers it compares against
 * were computed when the row was fetched, so a view held open across a due date
 * needs a refetch to notice, not a re-render.
 */

import type { KnowledgeItem, Verdict } from '$lib/types';

export type { ItemSrs } from '$lib/types';

/**
 * FSRS `Rating` values (minus `Manual`) — the grades a review is filed under.
 */
export const Grade = {
	Again: 1,
	Hard: 2,
	Good: 3,
	Easy: 4
} as const;

export type Grade = (typeof Grade)[keyof typeof Grade];

/**
 * FSRS `State` values. Read only by the words ledger, which shows a word's
 * state as a tag and filters on it.
 */
export const CardState = {
	New: 0,
	Learning: 1,
	Review: 2,
	Relearning: 3
} as const;

export type CardState = (typeof CardState)[keyof typeof CardState];

/**
 * The stored card's shape — **owned by the core**, mirrored here only so the
 * words ledger can name the fields it puts in columns.
 *
 * Nothing in the app computes one, and nothing but that ledger should read one:
 * the derived numbers every other screen wants are on
 * {@link KnowledgeItem.srs}. Dates are epoch-ms numbers (`null` in place of
 * `undefined` for `last_review`) so the whole thing stays plain-JSON-safe across
 * `postMessage`, the export file and the sync log.
 */
export interface FsrsCardState {
	due: number;
	stability: number;
	difficulty: number;
	/** @deprecated kept only because the FSRS `Card` shape still has it. */
	elapsed_days: number;
	scheduled_days: number;
	learning_steps: number;
	reps: number;
	lapses: number;
	state: CardState;
	last_review: number | null;
}

/**
 * Maps a validation verdict onto an FSRS grade.
 *
 * - `'wrong'` → Again
 * - `'almost'` → Hard
 * - `'correct'` → Good
 *
 * Note what is missing: nothing here ever returns Easy. It used to be inferred
 * from a sub-4s response time, capped for answers the learner merely picked off
 * a list — but both halves were guesses at a thing the learner can simply be
 * asked. A fast answer can be a lucky one, a slow one can be a certain one
 * typed carefully, and Easy stretches the next interval further than any other
 * grade, so a wrong guess is expensive. Easy is now only ever assigned by the
 * learner's own post-answer assessment; see `amendResult` in
 * `$lib/session/engine`.
 */
export function gradeFromResult(verdict: Verdict): Grade {
	switch (verdict) {
		case 'wrong':
			return Grade.Again;
		case 'almost':
			return Grade.Hard;
		case 'correct':
			return Grade.Good;
	}
}

/**
 * When the schedule next owes this word.
 *
 * An item with no derived schedule was built by hand rather than read back —
 * the assistant's freshly minted word, an import — and it is owed *now*: it was
 * introduced and never scheduled, which is exactly what the bottom of the queue
 * means. Hence `now` as the fallback rather than an epoch.
 */
export function dueAt(item: KnowledgeItem, now: number): number {
	return item.srs?.due ?? now;
}

/**
 * True when the card is due at (or before) `now`.
 *
 * A date comparison, not a scheduling decision — which is why it stayed on this
 * side when everything else went into the core: the session's `now` is explicit
 * and this has to answer against *that* instant, not against whatever the clock
 * said when the row was fetched.
 */
export function isDue(item: KnowledgeItem, now: number): boolean {
	return dueAt(item, now) <= now;
}

/**
 * How well a word is known, 0..1 — the number behind the strength bars, and the
 * axis `$lib/session/progression` slices into demand tiers and difficulty rungs.
 *
 * Zero for a word with nothing derived, for the same reason {@link dueAt} answers
 * `now`: never scheduled is the bottom of the range.
 */
export function strengthOf(item: KnowledgeItem): number {
	return item.srs?.strength ?? 0;
}

/** Probability of recall (0..1), as of the read. Zero for a word never scheduled. */
export function retrievabilityOf(item: KnowledgeItem): number {
	return item.srs?.retrievability ?? 0;
}

/**
 * Picks the vocabulary a generated batch is written about: what the schedule
 * owes now, topped up with what it will owe soonest.
 *
 * Generation never introduces vocabulary — new words reach the learner through
 * the assistant and conversation mode, never through a lesson — so this list is
 * the *only* material a batch has to build from, and stopping at the due items
 * would mean a learner who is caught up asks for a lesson and hands the model
 * nothing to write about. Hence the two tiers: due items first, most overdue
 * first, capped at `maxItems` (default 12); then, while there is room left, the
 * soonest-due items that are not due yet.
 *
 * That is the same degradation `planSession` performs on the play side — a
 * session runs out of due work and continues into review-ahead rather than into
 * nothing — applied one step earlier, to what gets *written* rather than to
 * what gets served. Early review is native to FSRS: a review is graded whenever
 * it happens, it simply banks a smaller stability gain.
 *
 * Pure selection over `srs.due` and `now`: no model, no weights, no clock of
 * its own.
 */
export function selectSessionItems(
	items: KnowledgeItem[],
	opts: { now: number; maxItems?: number }
): { reviewItems: KnowledgeItem[] } {
	const maxItems = opts.maxItems ?? 12;
	const byDue = (a: KnowledgeItem, b: KnowledgeItem) => dueAt(a, opts.now) - dueAt(b, opts.now);
	const dueNow = (item: KnowledgeItem) => isDue(item, opts.now);

	const owed = items.filter(dueNow).sort(byDue);
	const ahead = items.filter((item) => !dueNow(item)).sort(byDue);

	// The two tiers spelled out rather than folded into one sort over everything
	// (which would give the same list): the boundary between them is the thing
	// worth being able to see, and the second tier only ever fills what the first
	// left over.
	const reviewItems = [...owed, ...ahead].slice(0, maxItems);

	return { reviewItems };
}
