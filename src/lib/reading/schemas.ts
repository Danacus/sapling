/**
 * The two wire envelopes reading mode pins with `responseFormat`.
 *
 * A text is paid for once and then read many times, so unlike a conversation
 * turn these envelopes can afford to be generous — but they still carry only
 * content: the sentence, its reading, its translation, and what the words that
 * are new to this learner mean. Which readings actually render, which words get
 * a colour, what is tappable — all of that is decided at render time from the
 * learner's own vocabulary (`./annotate`), so nothing here describes
 * presentation.
 *
 * Model-emitted optional fields are `.nullish()` rather than `.optional()`, the
 * same bargain the generation and conversation schemas strike: models emit
 * `null` for "not applicable" far more often than they omit a key, and the
 * parsers in `./generate` and `./annotate-call` normalize `null` back to absent
 * so nothing downstream has to hold three states for one field.
 *
 * The two envelopes are deliberately *not* one schema with optional halves.
 * Generation writes the sentences; annotation is handed sentences the learner
 * pasted and must never send them back — the text on screen has to be exactly
 * what was pasted, and a model that can re-emit the text is a model that can
 * quietly rewrite it.
 */

import { z } from 'zod';
import { toJsonSchema } from '$lib/llm/json-schema';
import type { TokenUsage } from '$lib/llm';
import type { GlossEntry, ReadingSentence } from '$lib/types';

const nonEmpty = z.string().min(1);

/**
 * One glossed word: what it is, how it sounds, what it means.
 *
 * `reading` follows the same rule every target-language string in this app
 * does — the Latin reading, `null` for languages already written in the Latin
 * script.
 */
export const glossEntrySchema = z.object({
	term: nonEmpty,
	reading: z.string().nullish(),
	meaning: nonEmpty
});

/** One sentence the model wrote: the target-language line and its two annotations. */
export const generatedSentenceSchema = z.object({
	text: nonEmpty,
	reading: z.string().nullish(),
	translation: z.string().nullish()
});

/** A whole text written from the learner's vocabulary. */
export const generatedTextSchema = z.object({
	title: nonEmpty,
	sentences: z.array(generatedSentenceSchema),
	glossary: z.array(glossEntrySchema)
});

/**
 * One sentence's annotations, and nothing else.
 *
 * No `text`: the sentences were split locally from what the learner pasted
 * (`./sentences`) and travel to the model numbered. Sending them back would
 * cost tokens for a string the app already holds and would let a rewrite pass
 * for a transcription.
 */
export const annotatedSentenceSchema = z.object({
	reading: z.string().nullish(),
	translation: z.string().nullish()
});

/**
 * The annotation of a pasted text. `title` is nullish here and required above:
 * the learner may have typed their own, in which case the model has nothing to
 * add.
 */
export const annotatedTextSchema = z.object({
	title: z.string().nullish(),
	sentences: z.array(annotatedSentenceSchema),
	glossary: z.array(glossEntrySchema)
});

/** Names for the two structured-output schemas. */
export const GENERATED_TEXT_SCHEMA_NAME = 'reading_text';
export const ANNOTATED_TEXT_SCHEMA_NAME = 'reading_annotation';

/**
 * A text as the app holds it, before an id and a timestamp make it a
 * {@link ReadingText}.
 *
 * Both calls end here — a generated text and an annotated one differ in who
 * wrote the sentences, not in what the reader needs — so the page mints
 * `id`/`createdAt`, stamps the `source`, and stores it.
 */
export interface ReadingTextDraft {
	title: string;
	sentences: ReadingSentence[];
	glossary: GlossEntry[];
	/** Absent from the mock, which spends nothing. */
	usage?: TokenUsage;
}

/**
 * `strict: true` structured outputs want every property listed in `required`
 * with `additionalProperties: false`; an optional key stays expressible by
 * being nullable, which is exactly how the schemas above are written.
 *
 * Copied from `$lib/conversation/schemas` rather than shared. The comment there
 * explains why the batch format's fuller `tighten` pass is not the same job;
 * extracting one helper for three callers would mean editing two modules this
 * feature otherwise leaves alone, to save nine lines.
 */
function requireEveryKey(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) requireEveryKey(child);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const schema = node as Record<string, unknown>;

	if (Array.isArray(schema.anyOf)) requireEveryKey(schema.anyOf);
	if (schema.items) requireEveryKey(schema.items);

	const properties = schema.properties as Record<string, unknown> | undefined;
	if (properties && typeof properties === 'object') {
		for (const value of Object.values(properties)) requireEveryKey(value);
		schema.required = Object.keys(properties);
		schema.additionalProperties = false;
	}
}

function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const json = toJsonSchema(schema);
	requireEveryKey(json);
	return json;
}

/** The schema sent as `response_format.json_schema.schema` for the write call. */
export function generatedTextJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(generatedTextSchema);
}

/** The same, for the annotate call. */
export function annotatedTextJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(annotatedTextSchema);
}
