/**
 * Zod schemas for everything the model returns.
 *
 * The LLM is untrusted input: nothing from a completion reaches the rest of the
 * app without passing through a schema here. These schemas are also the source
 * of truth for the JSON schema handed to OpenRouter, via {@link batchJsonSchema}.
 *
 * Two shapes live here:
 *
 * - `challengeSchema` mirrors the `Challenge` union in `$lib/types` exactly
 *   (ids assigned, `match-pairs` included). It validates what the layer *emits*.
 * - `generatedBatchSchema` describes what the model is asked to *produce*: the
 *   same challenges minus `id` (assigned locally) and minus `match-pairs`
 *   (built locally for free — see `makeMatchPairsChallenge`), wrapped in an
 *   envelope alongside the new vocabulary the batch introduces.
 *
 * Optional string fields are declared `.nullish()` rather than `.optional()`:
 * models emit `null` for "not applicable" far more often than they omit a key,
 * and the resolver normalizes `null` back to `undefined`.
 */

import { z } from 'zod';
import type { Challenge } from '$lib/types';

const nonEmpty = z.string().min(1);

export const directionSchema = z.enum(['toTarget', 'toNative']);

/**
 * A reference to a `KnowledgeItem`: either an existing id, or `new:<index>`
 * pointing at an entry of the batch's `newItems` array.
 */
export const itemRefSchema = nonEmpty;

/** `new:0`, `new:12`, ... */
export const NEW_ITEM_REF = /^new:(\d+)$/;

// --------------------------------------------------------------------------
// What the model generates (no `id`, no `match-pairs`).
// --------------------------------------------------------------------------

const generatedBase = {
	direction: directionSchema,
	explanation: z.string().nullish(),
	itemIds: z.array(itemRefSchema).min(1)
};

export const generatedMultipleChoiceSchema = z.object({
	type: z.literal('multiple-choice'),
	prompt: nonEmpty,
	promptRomanization: z.string().nullish(),
	/**
	 * Exactly four options. Declared as a length-constrained array rather than a
	 * tuple: tuples emit `prefixItems`, which several structured-output
	 * implementations reject. The resolver narrows it back to a 4-tuple.
	 */
	options: z.array(nonEmpty).length(4),
	/**
	 * Deliberately *not* length-constrained: a misaligned romanization array is a
	 * cosmetic defect, and rejecting the whole challenge over it would throw away
	 * a challenge we already paid for. The resolver keeps it only when it lines
	 * up with `options` one-for-one, and drops it silently otherwise.
	 */
	optionsRomanization: z.array(nonEmpty).nullish(),
	correctIndex: z.int().min(0).max(3),
	...generatedBase
});

export const generatedClozeSchema = z.object({
	type: z.literal('cloze'),
	/** Must carry the `___` blank the UI renders as an input. */
	sentence: nonEmpty.refine((s) => s.includes('___'), {
		message: 'sentence must contain a ___ blank'
	}),
	/** Romanization of the whole sentence; not required to carry the blank. */
	sentenceRomanization: z.string().nullish(),
	acceptedAnswers: z.array(nonEmpty).min(1),
	wordBank: z.array(nonEmpty).nullish(),
	translationHint: nonEmpty,
	...generatedBase
});

export const generatedTypedTranslationSchema = z.object({
	type: z.literal('typed-translation'),
	prompt: nonEmpty,
	promptRomanization: z.string().nullish(),
	acceptedAnswers: z.array(nonEmpty).min(1),
	...generatedBase
});

export const generatedChallengeSchema = z.discriminatedUnion('type', [
	generatedMultipleChoiceSchema,
	generatedClozeSchema,
	generatedTypedTranslationSchema
]);

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

export type GeneratedChallenge = z.infer<typeof generatedChallengeSchema>;
export type GeneratedItem = z.infer<typeof generatedItemSchema>;
export type GeneratedBatch = z.infer<typeof generatedBatchSchema>;

// --------------------------------------------------------------------------
// What the app stores (mirrors `$lib/types`, `match-pairs` included).
// --------------------------------------------------------------------------

const storedBase = {
	id: nonEmpty,
	direction: directionSchema,
	explanation: z.string().optional(),
	itemIds: z.array(nonEmpty)
};

export const multipleChoiceChallengeSchema = z.object({
	type: z.literal('multiple-choice'),
	prompt: nonEmpty,
	promptRomanization: z.string().optional(),
	options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
	/** Index-aligned with `options` when present; the resolver guarantees the length. */
	optionsRomanization: z.array(z.string()).length(4).optional(),
	correctIndex: z.int().min(0).max(3),
	...storedBase
});

export const clozeChallengeSchema = z.object({
	type: z.literal('cloze'),
	sentence: nonEmpty,
	sentenceRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	wordBank: z.array(z.string()).optional(),
	translationHint: z.string(),
	...storedBase
});

export const typedTranslationChallengeSchema = z.object({
	type: z.literal('typed-translation'),
	prompt: nonEmpty,
	promptRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	...storedBase
});

export const matchPairsChallengeSchema = z.object({
	type: z.literal('match-pairs'),
	pairs: z
		.array(
			z.object({
				a: nonEmpty,
				b: nonEmpty,
				aRom: z.string().optional(),
				bRom: z.string().optional()
			})
		)
		.min(2),
	...storedBase
});

/** Mirrors the `Challenge` union in `$lib/types`. */
export const challengeSchema = z.discriminatedUnion('type', [
	multipleChoiceChallengeSchema,
	clozeChallengeSchema,
	typedTranslationChallengeSchema,
	matchPairsChallengeSchema
]);

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
 * The JSON schema sent as `response_format.json_schema.schema`.
 *
 * `$defs`/`$ref` are inlined (`cycles`/`reused` both set to inline where the
 * generator allows it) because several cheap models choke on references.
 */
export function batchJsonSchema(): JsonObject {
	const schema = z.toJSONSchema(generatedBatchSchema, {
		target: 'draft-2020-12',
		reused: 'inline',
		unrepresentable: 'any',
		io: 'input'
	}) as JsonObject;
	delete schema.$schema;
	tighten(schema);
	return schema;
}

/** Name used for the structured-output schema. */
export const BATCH_SCHEMA_NAME = 'lesson_batch';
