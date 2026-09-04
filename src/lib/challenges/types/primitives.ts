/**
 * The zod building blocks every *stored* challenge type is assembled from.
 *
 * This is the bottom of the challenge layer: it imports zod and nothing else, so
 * the import chain runs primitives → the def modules → `./index` → its consumers
 * (`../display`, `../check`, `$lib/llm/schemas`) with no way back up.
 *
 * It deliberately does not reuse `$lib/llm/challenge-types/primitives`, which
 * says the same thing about `nonEmpty`. The stored half of the union is what the
 * *app* holds — the pool, the sync payloads, the components — and the generation
 * layer is downstream of it: `$lib/llm/schemas` composes `challengeSchema` out of
 * these defs. One shared constant is a cheap price for keeping that arrow
 * pointing one way.
 *
 * Optional fields here are `.optional()`, not `.nullish()`: `null` is a wire-side
 * fact, and the resolvers have already normalized it to absent by the time a
 * challenge is stored.
 */

import { z } from 'zod';

/** A string that must actually be filled in. */
export const nonEmpty = z.string().min(1);

/**
 * Which way round a challenge is exercised: into the target language, or back
 * into the learner's own.
 *
 * Re-exported from `$lib/llm/schemas`, which is where the rest of the app has
 * always imported it from.
 */
export const directionSchema = z.enum(['toTarget', 'toNative']);

/**
 * The four fields every stored type carries, spread into each def's own object
 * so they stay ordinary properties rather than an intersection zod would have to
 * re-derive — and, more to the point, so `z.discriminatedUnion` still sees a
 * plain object with a literal `type` to discriminate on.
 */
export const storedBase = {
	id: nonEmpty,
	direction: directionSchema,
	explanation: z.string().optional(),
	itemIds: z.array(nonEmpty)
};

/**
 * Folds `value` into `[0, 1]`. Every def's `difficulty` ends with this: a
 * structural count (words, tiles, pairs) is unbounded, and the registry's
 * contract is a number on the same closed scale every other type reports on.
 */
export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * The prose-length scale **every** type's length knob is measured on: a single
 * word at the bottom, a long sentence at the top.
 *
 * One scale, shared, because `difficulty` is compared *across* types — the
 * planner asks "which of these rows best fits this word", and the rows are not
 * all the same type. Each type normalising its own length against its own
 * ceiling made those numbers incomparable: at eight words a multiple-choice
 * prompt read as maximally hard and a spot-error sentence as barely more than
 * half, so a four-option recognition question outranked reading a whole
 * sentence and finding the error in it. The per-type ordering that survives
 * that is expressed as a base offset instead (see the defs' `difficulty`),
 * which is a claim about the *format*, and length then moves each type over the
 * remainder of its range.
 */
export const SHORTEST_PROMPT_WORDS = 1;
export const LONGEST_PROMPT_WORDS = 12;

/** Where `words` sits on the shared {@link LONGEST_PROMPT_WORDS} scale, 0..1. */
export function lengthKnob(words: number): number {
	return clamp01((words - SHORTEST_PROMPT_WORDS) / (LONGEST_PROMPT_WORDS - SHORTEST_PROMPT_WORDS));
}

/**
 * A def's `difficulty` answer: its own floor within its demand tier, plus
 * whatever its structural knobs add over the remainder.
 *
 * `base` is the type's standing relative to the others *in its tier* before any
 * field is read — how much work the format itself is, at the same length. It is
 * a fraction of the tier's span, so the result stays in `[0, 1]` and
 * `$lib/challenges/difficulty` can still scale it into the tier without a
 * lower-demand row ever outranking a higher-demand one.
 */
export function withBase(base: number, knob: number): number {
	const floor = clamp01(base);
	return clamp01(floor + (1 - floor) * clamp01(knob));
}
