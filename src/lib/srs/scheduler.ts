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
 * A JSON-serializable representation of a ts-fsrs `Card`.
 *
 * ts-fsrs' own `Card` type stores dates as `Date` objects, which don't
 * round-trip through `structuredClone` or `JSON.stringify` cleanly across all
 * storage backends. This type stores the same fields with dates
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

/** Stability (in days) treated as "this word is mature" by {@link wordStrength}. */
const MATURE_STABILITY_DAYS = 30;

/**
 * How well a word is known, 0..1 — the number behind the dashboard's strength
 * bars.
 *
 * {@link retrievability} alone is the wrong axis, tempting as it looks: the
 * scheduler's whole job is to keep it pinned in 0.9–1.0, so a learner who is on
 * schedule sees every bar full and the display tells them nothing. Stability —
 * the days it takes recall to decay to 90% — is the quantity that actually
 * spans their range: a word met this morning sits under a day, a word they own
 * sits at weeks. {@link MATURE_STABILITY_DAYS} is taken as the top of that
 * range, and the log scale spends the bar's width where the movement is (the
 * first fortnight) instead of squashing it against zero.
 *
 * Multiplying by retrievability is what keeps the bar honest about *now*: a
 * mature word left unreviewed for a month visibly sags below the same word
 * reviewed yesterday, which is exactly the word the learner should go find.
 */
export function wordStrength(state: FsrsCardState, now: number): number {
	const maturity = Math.min(
		1,
		Math.log1p(Math.max(0, state.stability)) / Math.log1p(MATURE_STABILITY_DAYS)
	);
	return maturity * retrievability(state, now);
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
 */
export function selectSessionItems(
	items: KnowledgeItem[],
	opts: { now: number; maxItems?: number }
): { reviewItems: KnowledgeItem[] } {
	const maxItems = opts.maxItems ?? 12;
	const byDue = (a: KnowledgeItem, b: KnowledgeItem) =>
		(a.fsrsCard as FsrsCardState).due - (b.fsrsCard as FsrsCardState).due;
	const dueNow = (item: KnowledgeItem) => isDue(item.fsrsCard as FsrsCardState, opts.now);

	const owed = items.filter(dueNow).sort(byDue);
	const ahead = items.filter((item) => !dueNow(item)).sort(byDue);

	// The two tiers spelled out rather than folded into one sort over everything
	// (which would give the same list): the boundary between them is the thing
	// worth being able to see, and the second tier only ever fills what the first
	// left over.
	const reviewItems = [...owed, ...ahead].slice(0, maxItems);

	return { reviewItems };
}

/**
 * Recent-accuracy helper: fraction of reviews in the trailing `window` ms
 * (default 7 days) up to `now` that were graded Good or better. Returns
 * `undefined` when there's no review history in the window — day one, where
 * there is nothing to calibrate on.
 *
 * It paces nothing here, and it never reaches the model either: it travels as
 * `BatchArgs.recentAccuracy` for `$lib/llm/slots`, which reads it locally to
 * size the lesson's production share and to shift every slot's difficulty. That
 * is where "how is this learner doing" now changes what a lesson looks like.
 *
 * Reads `recentGrades` — the trailing slice the store keeps on each item — and
 * falls back to `history` for items assembled in memory. A window this narrow
 * only ever looks at the tail anyway, so the two agree; taking the stored one is
 * what lets the caller work from a `getAllItems()` that carries no entries.
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
		for (const entry of item.recentGrades ?? item.history) {
			if (entry.at >= cutoff && entry.at <= opts.now) {
				total++;
				if (entry.grade >= Grade.Good) correct++;
			}
		}
	}

	return total === 0 ? undefined : correct / total;
}
