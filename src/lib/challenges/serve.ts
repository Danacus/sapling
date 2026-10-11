/**
 * Generic display-only challenge helpers. Type-specific served screens live
 * in the registered plugins and cross through `plugin.ts`.
 */

import type { KnowledgeItem } from '$lib/types';
import type { Maturity } from '$lib/db/generated/index';
import { strengthOf } from '$lib/srs';
import { callChallenges } from './core';

export type { Maturity };

/** Which readings a served challenge shows — one answer for the whole, and per-word overrides. */
export interface ReadingPlan {
	/** The whole-challenge decision: the help level's reading shown or hidden. */
	sentence: boolean;
	/**
	 * Per-word overrides keyed by the item's `term`. Serving leaves it empty —
	 * a help level decides the whole challenge — and the shape stays so a
	 * component reads one plan whoever made it.
	 */
	byTerm: ReadonlyMap<string, boolean>;
}

/** Readings on everywhere: the default a component gets with no plan. */
export const ALL_READINGS: ReadingPlan = { sentence: true, byTerm: new Map() };

/** How far along a word is, in three coarse steps. */
export function maturityOf(item: KnowledgeItem): Maturity {
	return callChallenges('maturityOf', { strength: strengthOf(item) });
}

/** The chance the reader hides a word's reading at this strength, under `'adaptive'`. */
export function hideReadingProbability(strength: number): number {
	return callChallenges('hideReadingProbability', { strength });
}
