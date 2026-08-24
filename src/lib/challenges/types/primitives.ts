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
