/**
 * Adaptive romanization: whether a served challenge shows its readings.
 *
 * The reading (pinyin, romaji, ...) is a crutch, and the honest thing about a
 * crutch is that it has to be taken away eventually — a learner who reads the
 * pinyin never reads the hanzi. But taking it away on a schedule ("after two
 * weeks") punishes the words they met yesterday along with the ones they own,
 * so the decision is made per challenge, from how well that challenge's own
 * words are known.
 *
 * Pure and deterministic like `$lib/srs`: `now` is always passed in, the coin
 * flip is an injectable `rng`, and nothing here reads the clock or the DB. The
 * caller rolls **once, when the challenge is served**, and keeps the answer for
 * that challenge's lifetime — a reading that blinked in and out mid-challenge
 * would read as a bug, and re-rolling per token would show half a sentence.
 */

import { wordStrength, type FsrsCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';
import type { RomanizationMode } from '$lib/ui/prefs';

/**
 * Below this strength the reading always shows: the word is still being
 * learned, and hiding the reading there is not a challenge, it is a wall.
 */
export const HIDE_READING_FLOOR = 0.35;

/**
 * At or above this strength the reading never shows: the word is owned, and
 * the crutch is now the only thing being read.
 */
export const HIDE_READING_CEILING = 0.85;

/**
 * Probability (0..1) that a word of the given strength has its reading hidden.
 *
 * Linear between {@link HIDE_READING_FLOOR} and {@link HIDE_READING_CEILING}
 * rather than a step at some threshold: a ramp fades the crutch out over many
 * encounters, so the learner meets the bare script while the word is still
 * comfortable instead of the day it crosses a line.
 */
export function hideReadingProbability(strength: number): number {
	const span = HIDE_READING_CEILING - HIDE_READING_FLOOR;
	const ramped = (strength - HIDE_READING_FLOOR) / span;
	return Math.min(1, Math.max(0, ramped));
}

/**
 * The strength that decides a challenge's readings: the **weakest** of the
 * words it exercises.
 *
 * The minimum, not the average — a sentence carries its hardest word, and one
 * shaky word is enough to make a bare-script prompt unanswerable. An `itemId`
 * that no longer resolves counts as 0 for the same reason: an unknown word is
 * the weakest word there is.
 */
export function challengeReadingStrength(
	challenge: Challenge,
	items: KnowledgeItem[],
	now: number
): number {
	if (challenge.itemIds.length === 0) return 0;

	const byId = new Map(items.map((item) => [item.id, item]));

	let weakest = 1;
	for (const id of challenge.itemIds) {
		const card = byId.get(id)?.fsrsCard as FsrsCardState | null | undefined;
		const strength = card ? wordStrength(card, now) : 0;
		if (strength < weakest) weakest = strength;
	}
	return weakest;
}

/**
 * Whether this challenge should render its readings, under the learner's mode.
 *
 * `'on'`/`'off'` are the learner's explicit answer and ignore everything else;
 * only `'adaptive'` consults the words and the coin.
 */
export function shouldShowReading(
	mode: RomanizationMode,
	challenge: Challenge,
	items: KnowledgeItem[],
	now: number,
	rng: () => number = Math.random
): boolean {
	if (mode === 'on') return true;
	if (mode === 'off') return false;
	return rng() >= hideReadingProbability(challengeReadingStrength(challenge, items, now));
}
