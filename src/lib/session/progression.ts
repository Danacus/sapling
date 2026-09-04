/**
 * Strength-gated challenge-type progression: which *kind* of question a word is
 * ready for.
 *
 * Challenge types differ sharply in difficulty. "Write this sentence in
 * Chinese" and "which of these four means *dog*" can exercise the very same
 * word and are barely the same activity, and a word met yesterday put through
 * the first one produces a wrong answer that says nothing about the word — only
 * that the format was too early. The fix could have gone in one of two places,
 * and the choice matters:
 *
 * **Not in grading.** Per-type grade fudging — half credit for a hard format, a
 * stricter bar for an easy one — would corrupt the one signal FSRS has. A
 * verdict is evidence about the *word*, and evidence has to mean the same thing
 * whatever question produced it. Grading stays type-blind (`$lib/challenges/check`).
 *
 * **In the question stream instead.** A word earns its early reviews through
 * recognition, and production arrives once the word can bear it: comprehension
 * precedes production. The demand tier is a fact about the challenge
 * (`$lib/challenges/demand`); the floors below are the session's half of the
 * pairing, and this module is where the two meet.
 *
 * Same machinery, and the same philosophy, as the adaptive-romanization ramp in
 * `./romanization`: both read the *weakest* word a challenge exercises, both
 * fade a support out as that word grows, and both are preferences the planner may
 * spend rather than rules it must obey. {@link weakestWordStrength} is the shared
 * computation, and lives here because it is neutral between them —
 * `challengeReadingStrength` over there is now this function under its own name.
 *
 * Pure and deterministic like `$lib/srs`: `now` is always passed in, nothing
 * reads the clock or the database.
 *
 * ## Calibration
 *
 * `wordStrength` is log-stability × retrievability, so real ts-fsrs numbers put
 * a word answered Good at each due date at ~0 before its first review, ~0.35
 * after one, ~0.32 after two (the second review lands with stability unchanged
 * and a day of decay behind it) and ~0.65 after three. The floors sit under
 * those steps: tier 1 unlocks on the first successful review, tier 2 on the
 * third. Deliberately *low* — this is a preference the planner spends the moment
 * a due word has nothing else to offer, so an over-tight gate would not starve
 * anyone, it would just stop shaping anything.
 *
 * ## The five-rung ladder
 *
 * {@link difficultyLevelOf} slices the same axis into five rungs instead of
 * three, for callers that want a gradient rather than a step function (the
 * per-slot `difficulty` a lesson is written at, and the planner's preference for
 * the challenge whose difficulty best matches a word's own strength). It is
 * built on exactly the two floors above plus two more between them, so the
 * three-bucket {@link maturityOf} and the five-rung ladder can never disagree
 * about where a tier boundary falls — `maturityOf` is now just
 * {@link difficultyLevelOf} read at coarser resolution (level 1 → `'new'`,
 * 2–3 → `'young'`, 4–5 → `'solid'`).
 */

import { demandOf, type Demand } from '$lib/challenges/demand';
import { wordStrength, type FsrsCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';

/**
 * Weakest-word strength at which constrained production (demand 1 — word-order
 * tiles, a cloze with a word bank) becomes preferable: roughly one successful
 * review. The material is all on screen; what the learner supplies is the
 * arrangement, which is the smallest step past recognition there is.
 */
export const CONSTRAINED_PRODUCTION_FLOOR = 0.15;

/**
 * Weakest-word strength at which free production (demand 2 — a typed
 * translation into the target language, a bankless cloze) becomes preferable:
 * two to three successful reviews in, by the calibration above. Producing a word
 * from nothing is the last thing a learner can do with it, so it is the last
 * thing asked.
 */
export const FREE_PRODUCTION_FLOOR = 0.45;

/**
 * Weakest-word strength at which {@link difficultyLevelOf} steps from level 2
 * to level 3 — the ladder's own rung, sitting between the two floors above with
 * no `demandForStrength` boundary of its own.
 */
export const LEVEL_3_FLOOR = 0.3;

/**
 * Weakest-word strength at which {@link difficultyLevelOf} steps from level 4
 * to level 5 — comfortably past {@link FREE_PRODUCTION_FLOOR}, so level 5 is a
 * word that has been free-producible for a while rather than one that only just
 * crossed into it.
 */
export const LEVEL_5_FLOOR = 0.7;

/**
 * The strength that decides what a challenge may ask: the **weakest** of the
 * words it exercises.
 *
 * The minimum, not the average — a sentence is carried by its hardest word, and
 * one shaky word is enough to make a production prompt unanswerable however
 * well the rest are known. An `itemId` that no longer resolves counts as 0 for
 * the same reason: an unknown word is the weakest word there is.
 *
 * Re-exported by `./romanization` as `challengeReadingStrength`, which is what
 * it was called when the reading ramp was its only caller.
 */
export function weakestWordStrength(
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

/** The demand tier `strength` can bear. The floors, and nothing else. */
function demandForStrength(strength: number): Demand {
	if (strength >= FREE_PRODUCTION_FLOOR) return 2;
	if (strength >= CONSTRAINED_PRODUCTION_FLOOR) return 1;
	return 0;
}

/**
 * The highest demand tier the weakest word this challenge exercises can bear
 * right now, 0..2.
 *
 * Inclusive at the floors (`>=`), so a word sitting exactly on one has already
 * cleared it — the floors are calibration points, not thresholds anything
 * balances on.
 */
export function bearableDemand(challenge: Challenge, items: KnowledgeItem[], now: number): Demand {
	return demandForStrength(weakestWordStrength(challenge, items, now));
}

/**
 * True when this challenge's demand fits its weakest word's strength.
 *
 * A **preference**, not permission. `planSession` prefers a bearable challenge
 * where it has the choice and takes an unbearable one where it does not: a due
 * word whose only material is a typed translation still gets the typed
 * translation, because a hard exercise beats a skipped review. Nothing in the
 * app refuses to serve a challenge on this answer.
 */
export function bearable(challenge: Challenge, items: KnowledgeItem[], now: number): boolean {
	return demandOf(challenge) <= bearableDemand(challenge, items, now);
}

/** How far along a word is, in the three steps the generation prompt can act on. */
export type Maturity = 'new' | 'young' | 'solid';

/**
 * How far along a word is, on a five-rung ladder: 1 is a word met for the first
 * time, 5 one the learner owns outright. Finer than {@link Maturity}, for
 * callers that want a gradient rather than a step function — a lesson's
 * per-slot `difficulty`, and the planner's preference for the challenge that
 * best matches a word's current strength.
 */
export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

/**
 * A word's place on the five-rung ladder, from `wordStrength`.
 *
 * Anchored on the same two floors {@link bearableDemand} gates *serving* on
 * (`CONSTRAINED_PRODUCTION_FLOOR`, `FREE_PRODUCTION_FLOOR`) plus two more
 * between them ({@link LEVEL_3_FLOOR}, {@link LEVEL_5_FLOOR}), so the ladder and
 * the three-tier demand floors can never disagree about where a boundary falls:
 * level 1 is exactly tier-0 strength, levels 2–3 are exactly tier-1, levels 4–5
 * exactly tier-2. A word with no card at all is level 1 — introduced but never
 * scheduled is exactly what the bottom rung means.
 */
export function difficultyLevelOf(item: KnowledgeItem, now: number): DifficultyLevel {
	const card = (item.fsrsCard as FsrsCardState | null | undefined) ?? null;
	const strength = card ? wordStrength(card, now) : 0;
	if (strength >= LEVEL_5_FLOOR) return 5;
	if (strength >= FREE_PRODUCTION_FLOOR) return 4;
	if (strength >= LEVEL_3_FLOOR) return 3;
	if (strength >= CONSTRAINED_PRODUCTION_FLOOR) return 2;
	return 1;
}

/**
 * A word's maturity bucket, for the generation prompt's type hints.
 *
 * The same floors as {@link bearableDemand}, on purpose: the planner shapes what
 * is served out of the pool and the prompt shapes what enters it, and if the two
 * disagreed the planner would spend every session declining to serve what the
 * model had just been asked to write. `'new'` gets recognition written for it,
 * `'solid'` gets production, `'young'` sits between.
 *
 * Now just {@link difficultyLevelOf} read at coarser resolution — level 1 is
 * `'new'`, 2–3 `'young'`, 4–5 `'solid'` — so the two views of the same axis
 * cannot drift apart.
 */
export function maturityOf(item: KnowledgeItem, now: number): Maturity {
	const level = difficultyLevelOf(item, now);
	return level >= 4 ? 'solid' : level >= 2 ? 'young' : 'new';
}
