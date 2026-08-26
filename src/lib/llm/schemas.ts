/**
 * Zod schemas for everything the model returns.
 *
 * The LLM is untrusted input: nothing from a completion reaches the rest of the
 * app without passing through a schema here. These schemas are also the source
 * of truth for the JSON schema handed to OpenRouter, via {@link batchJsonSchema}.
 *
 * Two shapes meet here, and they are deliberately *not* the same shape:
 *
 * - `challengeSchema` mirrors the `Challenge` union in `$lib/types` exactly
 *   (ids assigned, `match-pairs` included). It validates what the layer *emits*,
 *   and it is *composed* below from the stored-type registry in
 *   `$lib/challenges/types`, where each member sits next to that type's grading
 *   and presentation rules.
 * - `generatedChallengeSchema` describes the wire format the model is asked to
 *   *produce*: pure content, no presentation. There is no `direction` flag, no
 *   `correctIndex`, no `___` placement and no free-floating romanization array —
 *   the direction is implied by the challenge type, and everything positional is
 *   assembled locally by `resolveBatch`. Anything the model cannot express, it
 *   cannot get wrong.
 *
 * Neither half is written out here any more. Each wire type owns its own zod
 * member in `./challenge-types/<type>.ts`, next to the prompt line that
 * describes it and the resolver that consumes it; each stored type owns its own
 * in `$lib/challenges/types/<type>.ts`, next to the grading rule and the four
 * presentation facts for that type. Both unions are projected from their
 * registries — so a schema, a prompt spec and a resolver cannot drift apart, and
 * neither can a schema, a grading rule and a feedback banner, because each set
 * is one edit. This module re-exports the lot: it stays the single import site
 * for the rest of the app, which never needs to know how many modules the two
 * unions are spread across.
 *
 * The primitive that makes the wire format work is {@link targetTextSchema}: one
 * piece of target-language text with its own Latin reading attached. Every slot
 * in every wire type is *unconditionally* either a `TargetText` or a plain
 * native-language string, so no field's language depends on a flag, and a
 * reading can never end up under the wrong string — or under a string the
 * learner has not answered yet.
 *
 * Optional string fields are declared `.nullish()` rather than `.optional()`:
 * models emit `null` for "not applicable" far more often than they omit a key,
 * and the resolver normalizes `null` back to `undefined`.
 */

import { z } from 'zod';
import type { Challenge } from '$lib/types';
// The generated union, imported so `generatedBatchSchema` can wrap it; it is
// also re-exported below, since this module is the façade for the wire format.
import { generatedChallengeSchema } from './challenge-types';
import { toJsonSchema } from './json-schema';
import { nonEmpty } from './challenge-types/primitives';
// The stored half, imported so `challengeSchema` can be composed from it. Those
// modules are leaves — zod, `$lib/types` and the string matchers — so importing
// *down* into them from here closes no cycle.
import { storedChallengeSchemas } from '$lib/challenges/types';

/** `new:0`, `new:12`, ... */
export const NEW_ITEM_REF = /^new:(\d+)$/;

// --------------------------------------------------------------------------
// What the model generates: content only, direction implied by the type.
// Defined per type in `./challenge-types`, re-exported here as the façade.
// --------------------------------------------------------------------------

export {
	clozePartSchema,
	generatedChallengeSchema,
	generatedClozeSchema,
	generatedProduceMcSchema,
	generatedRecognizeMcSchema,
	generatedSpotErrorSchema,
	generatedTranslateToNativeSchema,
	generatedTranslateToTargetSchema,
	generatedWordOrderSchema,
	itemRefSchema,
	targetTextSchema
} from './challenge-types';
export type {
	GeneratedChallenge,
	GeneratedCloze,
	GeneratedProduceMc,
	GeneratedRecognizeMc,
	GeneratedSpotError,
	GeneratedTranslateToNative,
	GeneratedTranslateToTarget,
	GeneratedWordOrder,
	TargetText
} from './challenge-types';

export const generatedItemSchema = z.object({
	term: nonEmpty,
	meaning: nonEmpty,
	/** Latin-script reading of `term`; null for Latin-script target languages. */
	romanization: z.string().nullish(),
	notes: z.string().nullish()
});

/** The full envelope the model is asked for. */
export const generatedBatchSchema = z.object({
	challenges: z.array(generatedChallengeSchema),
	newItems: z.array(generatedItemSchema)
});

/**
 * Permissive envelope used for salvage: the wrapper must be right, but each
 * entry is validated separately so one malformed challenge does not cost us
 * the whole (already paid for) batch.
 */
export const looseBatchSchema = z.object({
	challenges: z.array(z.unknown()).optional(),
	newItems: z.array(z.unknown()).optional()
});

export type GeneratedItem = z.infer<typeof generatedItemSchema>;
export type GeneratedBatch = z.infer<typeof generatedBatchSchema>;

// --------------------------------------------------------------------------
// What the app stores (mirrors `$lib/types`, `match-pairs` included).
// Defined per type in `$lib/challenges/types`, re-exported here as the façade.
// --------------------------------------------------------------------------

export {
	clozeChallengeSchema,
	directionSchema,
	matchPairsChallengeSchema,
	multipleChoiceChallengeSchema,
	spotErrorChallengeSchema,
	typedTranslationChallengeSchema,
	wordOrderChallengeSchema
} from '$lib/challenges/types';

/**
 * Mirrors the `Challenge` union in `$lib/types`.
 *
 * Projected from the stored-type registry, in its declared order, exactly as
 * `generatedChallengeSchema` is projected from the wire registry: a stored type
 * that is not registered over there is not part of this union, and the compiler
 * says so at the registry rather than here.
 */
export const challengeSchema = z.discriminatedUnion('type', storedChallengeSchemas);

// Compile-time check that the schema really does mirror the domain type.
type SchemaChallenge = z.infer<typeof challengeSchema>;
const _challengeParity: (c: SchemaChallenge) => Challenge = (c) => c;
void _challengeParity;

// --------------------------------------------------------------------------
// JSON schema for OpenRouter structured outputs.
// --------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/**
 * Makes the emitted JSON schema palatable to `strict: true` structured outputs
 * (OpenAI's flavour, which OpenRouter forwards):
 *
 * - every object must list *all* its properties in `required` and set
 *   `additionalProperties: false`; optional keys stay expressible as `null`,
 *   which the resolver treats as absent;
 * - `oneOf` is not supported, `anyOf` is (the union is discriminated by `type`
 *   anyway, so the two are equivalent here);
 * - `minLength` is dropped: it is the weakest constraint in the schema, costs
 *   prompt tokens on every call, and zod re-checks it on our side regardless.
 */
function tighten(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) tighten(child);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const schema = node as JsonObject;

	if (Array.isArray(schema.oneOf)) {
		schema.anyOf = schema.oneOf;
		delete schema.oneOf;
	}
	delete schema.minLength;

	for (const key of ['anyOf', 'allOf', 'prefixItems'] as const) {
		if (Array.isArray(schema[key])) tighten(schema[key]);
	}
	if (schema.items) tighten(schema.items);

	const properties = schema.properties as JsonObject | undefined;
	if (properties && typeof properties === 'object') {
		for (const value of Object.values(properties)) tighten(value);
		schema.required = Object.keys(properties);
		schema.additionalProperties = false;
	}
}

/**
 * The JSON schema sent as `response_format.json_schema.schema`: the shared
 * `toJsonSchema` conversion (which is where the ref-inlining lives, and why)
 * plus the `required`-everything pass strict structured outputs want.
 */
export function batchJsonSchema(): JsonObject {
	const schema = toJsonSchema(generatedBatchSchema) as JsonObject;
	tighten(schema);
	return schema;
}

/** Name used for the structured-output schema. */
export const BATCH_SCHEMA_NAME = 'lesson_batch';
