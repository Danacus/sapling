/**
 * Spaced repetition, backed by ts-fsrs.
 *
 * The rest of the app never imports ts-fsrs directly: it goes through this
 * module so the `fsrsCard: unknown` field on `KnowledgeItem` is cast in exactly
 * one place. Every function here is pure and deterministic: callers always
 * pass `now` (epoch ms) explicitly, nothing reads the system clock.
 */

import { createEmptyCard, fsrs, type Card, type Grade as FsrsGrade } from 'ts-fsrs';
import type { KnowledgeItem, Verdict } from '$lib/types';

/**
 * ts-fsrs `Rating` values (minus `Manual`). Mirrored here so callers don't
 * need to import ts-fsrs directly.
 */
export const Grade = {
	Again: 1,
	Hard: 2,
	Good: 3,
	Easy: 4
} as const;

export type Grade = (typeof Grade)[keyof typeof Grade];

/**
 * ts-fsrs `State` values, mirrored for the same reason as `Grade`.
 */
export const CardState = {
	New: 0,
	Learning: 1,
	Review: 2,
	Relearning: 3
} as const;

export type CardState = (typeof CardState)[keyof typeof CardState];

/**
 * A JSON/IndexedDB-serializable representation of a ts-fsrs `Card`.
 *
 * ts-fsrs' own `Card` type stores dates as `Date` objects, which don't
 * round-trip through `structuredClone`/IndexedDB or `JSON.stringify` cleanly
 * across all storage backends. This type stores the same fields with dates
 * as epoch-ms numbers (`null` in place of `undefined` for `last_review`, so
 * the shape stays plain-JSON-safe).
 */
export interface FsrsCardState {
	due: number;
	stability: number;
	difficulty: number;
	/** @deprecated kept only because ts-fsrs' `Card` still has it. */
	elapsed_days: number;
	scheduled_days: number;
	learning_steps: number;
	reps: number;
	lapses: number;
	state: CardState;
	last_review: number | null;
}

/** Converts our serializable state to a ts-fsrs `Card`. */
export function toFsrsCard(state: FsrsCardState): Card {
	return {
		due: new Date(state.due),
		stability: state.stability,
		difficulty: state.difficulty,
		elapsed_days: state.elapsed_days,
		scheduled_days: state.scheduled_days,
		learning_steps: state.learning_steps,
		reps: state.reps,
		lapses: state.lapses,
		state: state.state,
		last_review: state.last_review === null ? undefined : new Date(state.last_review)
	};
}

/** Converts a ts-fsrs `Card` to our serializable state. */
export function fromFsrsCard(card: Card): FsrsCardState {
	return {
		due: card.due.getTime(),
		stability: card.stability,
		difficulty: card.difficulty,
		elapsed_days: card.elapsed_days,
		scheduled_days: card.scheduled_days,
		learning_steps: card.learning_steps,
		reps: card.reps,
		lapses: card.lapses,
		state: card.state,
		last_review: card.last_review ? card.last_review.getTime() : null
	};
}

/** State for a freshly introduced item, due immediately. */
export function newCardState(now: number): FsrsCardState {
	return fromFsrsCard(createEmptyCard(new Date(now)));
}

/**
 * Maps a validation verdict (+ optional response time) onto an FSRS grade.
 *
 * - `'wrong'` → Again
 * - `'almost'` → Hard
 * - `'correct'`, answered in under 4000ms (when `responseMs` is known) → Easy
 * - `'correct'`, otherwise → Good
 */
export function gradeFromResult(verdict: Verdict, responseMs?: number): Grade {
	switch (verdict) {
		case 'wrong':
			return Grade.Again;
		case 'almost':
			return Grade.Hard;
		case 'correct':
			return responseMs !== undefined && responseMs < 4000 ? Grade.Easy : Grade.Good;
	}
}

/** Runs ts-fsrs scheduling for a review and returns the new serializable state. */
export function reviewCard(state: FsrsCardState, grade: Grade, now: number): FsrsCardState {
	const scheduler = fsrs();
	const card = toFsrsCard(state);
	const { card: nextCard } = scheduler.next(card, new Date(now), grade as FsrsGrade);
	return fromFsrsCard(nextCard);
}

/** True when the card is due at (or before) `now`. */
export function isDue(state: FsrsCardState, now: number): boolean {
	return state.due <= now;
}

/**
 * Probability of recall (0..1) at `now`, for UI strength bars. Backed by
 * ts-fsrs' own forgetting-curve calculation (`get_retrievability`), which
 * derives it from stability and elapsed time since the last review.
 */
export function retrievability(state: FsrsCardState, now: number): number {
	const scheduler = fsrs();
	const card = toFsrsCard(state);
	return scheduler.get_retrievability(card, new Date(now), false);
}

/**
 * Picks what to show in a review session: which existing items are due, and
 * how many brand-new items the LLM batch should introduce.
 *
 * Policy:
 * - Due items are sorted most-overdue-first (earliest `due` timestamp
 *   first) and capped at `maxItems` (default 12).
 * - `newItemSlots` paces new-item introduction off `recentAccuracy`:
 *   - unknown accuracy (undefined) → 3
 *   - accuracy ≥ 0.85 (doing well) → 5
 *   - accuracy ≤ 0.6 (struggling) → 1
 *   - anything in between → 3 (the base rate)
 *   This keeps struggling learners from being buried in new material while
 *   letting learners who are keeping up absorb more of it.
 * - Finally `newItemSlots` is reduced (never increased) so that
 *   `reviewItems.length + newItemSlots <= maxItems + 3` — a review-heavy
 *   session leaves little room for new items, but we always allow a small
 *   overflow above `maxItems` so a light review day still introduces
 *   something.
 */
export function selectSessionItems(
	items: KnowledgeItem[],
	opts: { now: number; maxItems?: number; recentAccuracy?: number }
): { reviewItems: KnowledgeItem[]; newItemSlots: number } {
	const maxItems = opts.maxItems ?? 12;

	const due = items
		.filter((item) => isDue(item.fsrsCard as FsrsCardState, opts.now))
		.sort((a, b) => (a.fsrsCard as FsrsCardState).due - (b.fsrsCard as FsrsCardState).due);

	const reviewItems = due.slice(0, maxItems);

	let base: number;
	if (opts.recentAccuracy === undefined) {
		base = 3;
	} else if (opts.recentAccuracy >= 0.85) {
		base = 5;
	} else if (opts.recentAccuracy <= 0.6) {
		base = 1;
	} else {
		base = 3;
	}

	const budget = Math.max(0, maxItems + 3 - reviewItems.length);
	const newItemSlots = Math.min(base, budget);

	return { reviewItems, newItemSlots };
}

/**
 * Recent-accuracy helper: fraction of reviews in the trailing `window` ms
 * (default 7 days) up to `now` that were graded Good or better. Feed the
 * result into `selectSessionItems`' `recentAccuracy` option. Returns
 * `undefined` when there's no review history in the window, matching
 * `selectSessionItems`' "unknown accuracy" case.
 */
export function accuracyFromHistory(
	items: KnowledgeItem[],
	opts: { now: number; window?: number }
): number | undefined {
	const window = opts.window ?? 7 * 24 * 60 * 60 * 1000;
	const cutoff = opts.now - window;

	let total = 0;
	let correct = 0;
	for (const item of items) {
		for (const entry of item.history) {
			if (entry.at >= cutoff && entry.at <= opts.now) {
				total++;
				if (entry.grade >= Grade.Good) correct++;
			}
		}
	}

	return total === 0 ? undefined : correct / total;
}
