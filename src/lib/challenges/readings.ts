/**
 * A served {@link ReadingPlan}, applied to what a component renders: the one
 * rule every challenge component hides readings by. The plan is rolled once,
 * at serve time (`./serve`); this is the per-slot lookup, so it stays beside
 * the romanizer's tokens rather than crossing into the core for each one.
 *
 * A token keeps its reading iff `byTerm.get(token.text) ?? sentence`: a token
 * the romanizer grouped around a tracked word follows that word's roll, and
 * the glue between follows the whole-challenge roll. Nothing here can add a
 * reading a token never had.
 */

import type { RomanizedToken } from '$lib/romanize';
import type { ReadingPlan } from './serve';

/** The tokens with every hidden reading set to `null`; never mutates its input. */
export function applyPlan(tokens: RomanizedToken[], plan: ReadingPlan): RomanizedToken[] {
	return tokens.map((token) =>
		(plan.byTerm.get(token.text) ?? plan.sentence) ? token : { text: token.text, reading: null }
	);
}

/**
 * Ruby tokens for a target-language slot, with the plan applied — or `null`
 * for a language with no local romanizer, where the stored reading is used.
 */
export function rubyFor(
	tokenize: ((text: string) => RomanizedToken[]) | null,
	readings: ReadingPlan
): (text: string) => RomanizedToken[] | null {
	if (!tokenize) return () => null;
	return (text) => applyPlan(tokenize(text), readings);
}

/**
 * A stored, sentence-wide reading line gated by the whole-challenge roll: a
 * flat line spans many words, so there is no one term to look up. `''` when
 * hidden or absent.
 */
export function storedReading(readings: ReadingPlan, stored: string | undefined | null): string {
	return (readings.sentence ? stored : '') ?? '';
}

/**
 * A single word rendered on its own — a bank chip, a tile — gated by that
 * word's own roll, falling back to the whole-challenge roll.
 */
export function termReading(
	readings: ReadingPlan,
	term: string,
	stored: string | undefined | null
): string {
	return (readings.byTerm.get(term) ?? readings.sentence) ? (stored ?? '') : '';
}

/**
 * One target-text slot, decided: ruby tokens when this language has a local
 * romanizer, and the stored fallback reading, both gated per word.
 */
export function readingSlot(
	tokenize: ((text: string) => RomanizedToken[]) | null,
	readings: ReadingPlan,
	text: string,
	stored: string | undefined | null
): { tokens: RomanizedToken[] | null; reading: string } {
	return {
		tokens: tokenize ? applyPlan(tokenize(text), readings) : null,
		reading: termReading(readings, text, stored)
	};
}
