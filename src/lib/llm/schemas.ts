/**
 * Zod schemas for everything the model returns.
 *
 * The LLM is untrusted input: nothing from a completion reaches the rest of the
 * app without passing through a schema here. Keep the schemas the source of
 * truth for the JSON-schema sent to OpenRouter as well.
 *
 * TODO: flesh these out so they mirror the `Challenge` union in `$lib/types`,
 * then assert the correspondence with `satisfies`/type-level tests.
 */

import { z } from 'zod';

/** Placeholder. TODO: replace with the real discriminated-union schema. */
export const challengeSchema = z.unknown();

/** A generated batch: the new items introduced plus the challenges using them. */
export const challengeBatchSchema = z.object({
	items: z.array(z.unknown()),
	challenges: z.array(challengeSchema)
});

export type ChallengeBatchInput = z.input<typeof challengeBatchSchema>;
export type ChallengeBatchOutput = z.output<typeof challengeBatchSchema>;

/** JSON schema handed to OpenRouter for structured output. TODO. */
export function challengeBatchJsonSchema(): unknown {
	throw new Error('TODO: challengeBatchJsonSchema');
}
