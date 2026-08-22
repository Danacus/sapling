/**
 * Spaced repetition, backed by ts-fsrs.
 *
 * The rest of the app never imports ts-fsrs directly: it goes through this
 * module so the `fsrsCard: unknown` field on `KnowledgeItem` is cast in exactly
 * one place.
 */

import type { KnowledgeItem, Verdict } from '$lib/types';

/**
 * ts-fsrs `Rating` values. Mirrored here so callers don't need the import.
 * TODO: assert these stay in sync with ts-fsrs' enum in a unit test.
 */
export const Grade = {
	Again: 1,
	Hard: 2,
	Good: 3,
	Easy: 4
} as const;

export type Grade = (typeof Grade)[keyof typeof Grade];

/** Maps a validation verdict onto an FSRS grade. */
export function verdictToGrade(_verdict: Verdict): Grade {
	throw new Error('TODO: verdictToGrade');
}

/** A brand-new card for a freshly introduced item. TODO: `createEmptyCard()`. */
export function newCard(_now?: Date): unknown {
	throw new Error('TODO: newCard');
}

/** Applies a review and returns the item with an updated `fsrsCard` + history. */
export function review(_item: KnowledgeItem, _grade: Grade, _now?: Date): KnowledgeItem {
	throw new Error('TODO: review');
}

/** Epoch ms at which the item is next due. */
export function dueAt(_item: KnowledgeItem): number {
	throw new Error('TODO: dueAt');
}

/** True when the item is due at (or before) `now`. */
export function isDue(_item: KnowledgeItem, _now?: number): boolean {
	throw new Error('TODO: isDue');
}
