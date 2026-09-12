/**
 * Adaptive native-language hints: whether a served challenge shows the line
 * the model wrote in the learner's own language — a cloze's translation, a
 * word-order's prompt, a spot-error's intended meaning.
 *
 * The line is always *stored*: the model emits content, never presentation,
 * and whether the learner sees a bridge is presentation. It has to be decided
 * here rather than at generation because a row is written once and played for
 * weeks while the word's rung moves — a hint baked into the row at rung 2 is
 * still on screen at rung 4, and a row written bare at rung 3 has no hint to
 * offer when a lapse drops the word back to rung 1.
 *
 * Same shape as the romanization ramp in `./romanization`, and asked of the same
 * word: the **weakest** one the challenge exercises (`weakestWordStrength`), since
 * a sentence is only as readable as its hardest part. Unlike the readings it is
 * a step, not a coin flip: the hint shows on the two early rungs and is gone
 * from rung 3 — the rung at which the target-language sentence is meant to
 * carry the meaning on its own — so there is nothing to roll and nothing to
 * memoise. Pure and deterministic: no rng, no clock, no DB.
 */

import type { Challenge, KnowledgeItem } from '$lib/types';
import { levelForStrength, weakestWordStrength, type DifficultyLevel } from './progression';

/**
 * The last rung at which the native line still shows. Rung 2 is the floor
 * word-order, spot-error and a banked cloze are first planned at
 * (`PLANNABLE_KINDS.levels`), so a learner meets each format with the
 * sentence's meaning beside it and loses it one rung later.
 */
export const HINT_CEILING_LEVEL: DifficultyLevel = 2;

/**
 * Whether this served challenge shows its native-language line.
 *
 * True while the challenge's weakest word sits at or below
 * {@link HINT_CEILING_LEVEL}. An `itemId` that no longer resolves counts as
 * strength 0 (the weakest word there is), and so does a challenge citing no
 * items at all — a hint is the safe default, since hiding one from a learner
 * who needed it is a wall, and showing one to a learner who did not is only a
 * line they can ignore.
 */
export function showNativeHint(challenge: Challenge, items: KnowledgeItem[]): boolean {
	return levelForStrength(weakestWordStrength(challenge, items)) <= HINT_CEILING_LEVEL;
}
