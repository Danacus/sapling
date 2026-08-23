/**
 * Zod schemas for everything the model returns.
 *
 * The LLM is untrusted input: nothing from a completion reaches the rest of the
 * app without passing through a schema here. These schemas are also the source
 * of truth for the JSON schema handed to OpenRouter, via {@link batchJsonSchema}.
 *
 * Two shapes live here, and they are deliberately *not* the same shape:
 *
 * - `challengeSchema` mirrors the `Challenge` union in `$lib/types` exactly
 *   (ids assigned, `match-pairs` included). It validates what the layer *emits*.
 * - `generatedChallengeSchema` describes the wire format the model is asked to
 *   *produce*: pure content, no presentation. There is no `direction` flag, no
 *   `correctIndex`, no `___` placement and no free-floating romanization array —
 *   the direction is implied by the challenge type, and everything positional is
 *   assembled locally by `resolveBatch`. Anything the model cannot express, it
 *   cannot get wrong.
 *
 * The primitive that makes that work is {@link targetTextSchema}: one piece of
 * target-language text with its own Latin reading attached. Every slot in every
 * wire type is *unconditionally* either a `TargetText` or a plain native-language
 * string, so no field's language depends on a flag, and a reading can never end
 * up under the wrong string — or under a string the learner has not answered yet.
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
// What the model generates: content only, direction implied by the type.
// --------------------------------------------------------------------------

/**
 * One string of the target language, carrying its own Latin-script reading.
 *
 * `reading` is pinyin with tone marks for Mandarin, romaji for Japanese, and so
 * on; it is `null` for target languages already written in the Latin script, so
 * those lessons pay nothing for a field they cannot use. Because the reading
 * travels *with* the text it reads, the two can never be paired up wrongly.
 */
export const targetTextSchema = z.object({
	text: nonEmpty,
	reading: z.string().nullish()
});

/**
 * The halves of a cloze sentence either side of the blank. Same shape as
 * {@link targetTextSchema} but the text may be empty: a sentence is allowed to
 * begin or end with the blank.
 */
const clozePartSchema = z.object({
	text: z.string(),
	reading: z.string().nullish()
});

const generatedBase = {
	explanation: z.string().nullish(),
	itemIds: z.array(itemRefSchema).min(1)
};

/**
 * Exactly three distractors. Declared as a length-constrained array rather than
 * a tuple: tuples emit `prefixItems`, which several structured-output
 * implementations reject.
 */
const threeOf = <T extends z.ZodType>(schema: T) => z.array(schema).length(3);

/** Target text shown, native meaning chosen. */
export const generatedRecognizeMcSchema = z.object({
	type: z.literal('recognize-mc'),
	shown: targetTextSchema,
	correctMeaning: nonEmpty,
	distractors: threeOf(nonEmpty),
	/** Heading above the prompt; null when the UI's default heading fits. */
	instruction: z.string().nullish(),
	...generatedBase
});

/** Native prompt shown, target text chosen. */
export const generatedProduceMcSchema = z.object({
	type: z.literal('produce-mc'),
	promptNative: nonEmpty,
	correct: targetTextSchema,
	distractors: threeOf(targetTextSchema),
	instruction: z.string().nullish(),
	...generatedBase
});

/**
 * A target-language word missing from a target-language sentence.
 *
 * The model supplies the sentence in three pieces rather than one string with a
 * marker in it: the blank is then placed by the app, always exactly once, and
 * the answer's reading sits in a field of its own that the pre-answer view never
 * touches.
 */
export const generatedClozeSchema = z.object({
	type: z.literal('cloze'),
	before: clozePartSchema,
	answer: targetTextSchema,
	after: clozePartSchema,
	hintNative: nonEmpty,
	/**
	 * Three to five wrong candidates turn the challenge into a word bank; null
	 * means the learner types the answer. Deliberately *not* length-constrained:
	 * a bank of the wrong size is a cosmetic defect, and rejecting a challenge we
	 * already paid for over it would be a poor trade. The resolver decides what
	 * survives.
	 */
	distractorWords: z.array(targetTextSchema).nullish(),
	...generatedBase
});

/** Type the target language. Multiple `answers` are genuinely different phrasings. */
export const generatedTranslateToTargetSchema = z.object({
	type: z.literal('translate-to-target'),
	promptNative: nonEmpty,
	answers: z.array(targetTextSchema).min(1),
	...generatedBase
});

/** Type the native language. */
export const generatedTranslateToNativeSchema = z.object({
	type: z.literal('translate-to-native'),
	prompt: targetTextSchema,
	answersNative: z.array(nonEmpty).min(1),
	...generatedBase
});

export const generatedChallengeSchema = z.discriminatedUnion('type', [
	generatedRecognizeMcSchema,
	generatedProduceMcSchema,
	generatedClozeSchema,
	generatedTranslateToTargetSchema,
	generatedTranslateToNativeSchema
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

export type TargetText = z.infer<typeof targetTextSchema>;
export type GeneratedCloze = z.infer<typeof generatedClozeSchema>;
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
	instruction: z.string().optional(),
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
	/** Reading of `acceptedAnswers[0]`; see the domain type. */
	answerRomanization: z.string().optional(),
	wordBank: z.array(z.string()).optional(),
	/** Index-aligned with `wordBank`; all-or-nothing, see the resolver. */
	wordBankRomanization: z.array(z.string()).optional(),
	translationHint: z.string(),
	...storedBase
});

export const typedTranslationChallengeSchema = z.object({
	type: z.literal('typed-translation'),
	prompt: nonEmpty,
	promptRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	/** Reading of `acceptedAnswers[0]`; toTarget only. */
	answerRomanization: z.string().optional(),
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
 * generator allows it) because several cheap models choke on references — which
 * matters more now that `TargetText` appears in almost every wire type.
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
