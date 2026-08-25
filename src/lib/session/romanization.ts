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
 *
 * ## One decision, or one per word
 *
 * The original decision was per *challenge*, from its weakest word, and it had
 * to be: a single LLM-written `reading` string covers a whole sentence, so the
 * only honest choices are all of it or none of it. And the weakest word is the
 * right one to ask, because a sentence is only as readable as its hardest part.
 *
 * With a local romanizer (`$lib/romanize`) the readings are per *token*, and
 * the all-or-nothing question stops being the interesting one — under adaptive
 * mode a sentence practically always contains one young word, so the whole-
 * challenge roll almost never hid anything. {@link planReadings} therefore
 * carries both answers: `sentence` for callers stuck with one flat string, and
 * `byTerm` for tokenized rendering, where each vocabulary word fades out on its
 * own schedule and the learner ends up reading the words they own bare while
 * the new one in the same sentence keeps its crutch. Both are rolled in the
 * same single serve-time call, so the plan is as stable as the boolean was.
 */

import type { RomanizedToken } from '$lib/romanize';
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
 * One weighted coin flip: does a word of this strength keep its reading?
 *
 * The single place the roll is spelled out, so the whole-challenge answer and
 * the per-word ones cannot drift apart on the comparison. `>=` rather than `>`
 * matters at the ends: a probability of 1 hides for every roll in `[0, 1)`, and
 * a probability of 0 shows for all of them.
 */
function rollShow(strength: number, rng: () => number): boolean {
	return rng() >= hideReadingProbability(strength);
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
	return rollShow(challengeReadingStrength(challenge, items, now), rng);
}

/** Which readings a served challenge shows — one answer for the whole, one per word. */
export interface ReadingPlan {
	/**
	 * The whole-challenge decision, exactly {@link shouldShowReading}'s answer.
	 *
	 * What a caller renders when it has nothing finer to go on: a stored
	 * sentence-wide LLM `reading` (no local romanizer for this language), or a
	 * token whose text matches no tracked word.
	 */
	sentence: boolean;
	/**
	 * Per-word decisions for tokenized (ruby) rendering, keyed by the knowledge
	 * item's `term` — the same string a {@link RomanizedToken}'s `text` carries
	 * when the romanizer grouped it around that vocabulary word, which is what
	 * makes the lookup a plain map hit rather than a search.
	 *
	 * Empty under `'on'`/`'off'`: the learner asked for one answer everywhere,
	 * and an empty map means every token falls through to `sentence`.
	 */
	byTerm: ReadonlyMap<string, boolean>;
}

/** No per-word entries — `sentence` decides everything. */
const NO_TERMS: ReadonlyMap<string, boolean> = new Map();

/**
 * The learner's romanization preference, resolved for one served challenge.
 *
 * Rolled **once, at serve time**, by the session screen; see the module note
 * for why. Under `'adaptive'` each word the challenge exercises gets its *own*
 * independent flip from its *own* strength — so an owned word can lose its
 * pinyin in the very sentence where a word met yesterday keeps it, which is the
 * whole point of fading a crutch per word rather than per screen. An `itemId`
 * that no longer resolves contributes no entry: there is no term to key it by,
 * and any token it would have covered falls back to `sentence` (which counted
 * it as unknown, so that fallback shows the reading).
 */
export function planReadings(
	mode: RomanizationMode,
	challenge: Challenge,
	items: KnowledgeItem[],
	now: number,
	rng: () => number = Math.random
): ReadingPlan {
	if (mode === 'on') return { sentence: true, byTerm: NO_TERMS };
	if (mode === 'off') return { sentence: false, byTerm: NO_TERMS };

	// The whole-challenge roll first, so it draws the same number from an
	// injected `rng` that `shouldShowReading` would have on its own.
	const sentence = shouldShowReading(mode, challenge, items, now, rng);

	const byId = new Map(items.map((item) => [item.id, item]));
	const byTerm = new Map<string, boolean>();
	for (const id of challenge.itemIds) {
		const item = byId.get(id);
		if (!item) continue;
		const card = item.fsrsCard as FsrsCardState | null | undefined;
		byTerm.set(item.term, rollShow(card ? wordStrength(card, now) : 0, rng));
	}

	return { sentence, byTerm };
}

/**
 * The plan, applied to a romanizer's tokens: every token whose reading the plan
 * hides comes back with `reading: null`.
 *
 * The one rule, in one place, so all six challenge components hide readings the
 * same way: a token keeps its reading iff `byTerm.get(token.text) ?? sentence`.
 * A token the romanizer grouped around a tracked vocabulary word follows that
 * word's own roll; the glue between them — particles, punctuation, words the
 * learner is not studying — follows the whole-challenge roll, because there is
 * no per-word strength to ask about. Tokens that never had a reading (Latin
 * runs, the cloze gap) stay `null` either way; nothing here can *add* one.
 *
 * Returns a new array and never mutates the input: tokens come straight out of
 * a romanizer that may hand back cached or shared structures.
 */
export function applyPlan(tokens: RomanizedToken[], plan: ReadingPlan): RomanizedToken[] {
	return tokens.map((token) =>
		(plan.byTerm.get(token.text) ?? plan.sentence) ? token : { text: token.text, reading: null }
	);
}
