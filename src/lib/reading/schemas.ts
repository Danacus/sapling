/**
 * The wire envelopes reading mode pins with `responseFormat`.
 *
 * Three of them, and all carry only content. **Generate** is a text the model
 * wrote: a title and its paragraphs — no readings, no translations, no
 * glossary, because a stored text is only the text and everything the reader
 * shows about a word is derived at render time from the learner's own
 * vocabulary (`./annotate`) and `$lib/romanize`. **Look up** is one word the
 * learner asked about, which is a {@link glossEntrySchema} row and nothing more.
 * **Translate** is one segment in the native language, a single string.
 *
 * Model-emitted optional fields are `.nullish()` rather than `.optional()`, the
 * same bargain the generation and conversation schemas strike: models emit
 * `null` for "not applicable" far more often than they omit a key, and the
 * parsers normalize `null` back to absent so nothing downstream has to hold
 * three states for one field.
 */

import { z } from 'zod';
import { toJsonSchema } from '$lib/llm/json-schema';
import type { TokenUsage } from '$lib/llm';
import type { Segment } from '$lib/types';

const nonEmpty = z.string().min(1);

/**
 * One explained word: what it is, how it sounds, what it means — twice over.
 *
 * `meaning` is the gloss a card would carry, a few words; `explanation` is the
 * longer answer to "what does this mean here", a few sentences. They are two
 * fields because they have two readers: the learner files the first and only
 * reads the second, and one field asked to be both came back as a paragraph
 * nobody wanted on a flashcard. `explanation` is nullable because a word that
 * needs no more than its gloss should not be padded to fill a slot.
 *
 * `reading` follows the same rule every target-language string in this app
 * does — the Latin reading, `null` for languages already written in the Latin
 * script.
 */
export const glossEntrySchema = z.object({
	term: nonEmpty,
	reading: z.string().nullish(),
	meaning: nonEmpty,
	explanation: z.string().nullish()
});

/**
 * A word explained, as the reader holds it: the lookup's answer with `null`
 * normalized away. Never stored — a text carries no glossary — and never a
 * knowledge item by itself; the learner adds the word if it matters.
 */
export interface GlossEntry {
	/** Exactly as the text spells it: matching is `wordKey` and nothing else. */
	term: string;
	/** Latin reading of `term`; absent for Latin-script targets. */
	reading?: string;
	/** The short gloss, in the learner's native language: what a card would file. */
	meaning: string;
	/**
	 * The longer explanation of the word in its sentence — sense, nuance, the
	 * grammar of this form. Display-only: shown on the card, never filed with the
	 * word and never stored.
	 */
	explanation?: string;
}

/**
 * A whole text written from the learner's vocabulary: a title and its
 * paragraphs. Paragraphs because that is the unit a writer produces and the
 * unit an imported text is stored in, so a generated text is one untimed
 * segment per paragraph exactly as a pasted one is.
 */
export const generatedTextSchema = z.object({
	title: nonEmpty,
	paragraphs: z.array(z.string())
});

/**
 * One line of the text in the learner's native language, and nothing about it:
 * no notes, no alternatives, no word-by-word breakdown. The reader shows it
 * under the line and forgets it when the text is closed.
 */
export const lineTranslationSchema = z.object({
	translation: nonEmpty
});

/** Names for the three structured-output schemas. */
export const GENERATED_TEXT_SCHEMA_NAME = 'reading_text';
export const LOOKED_UP_WORD_SCHEMA_NAME = 'reading_lookup';
export const LINE_TRANSLATION_SCHEMA_NAME = 'reading_translation';

/**
 * A generated text as the app holds it, before an id and a timestamp make it a
 * `ReadingText`: the task mints `id`/`createdAt`, stamps the `source`, and
 * stores it.
 */
export interface ReadingTextDraft {
	title: string;
	segments: Segment[];
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

/** And for the lookup call, whose whole envelope is one explained word. */
export function lookedUpWordJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(glossEntrySchema);
}

/** And for the translate call, whose whole envelope is one translated line. */
export function lineTranslationJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(lineTranslationSchema);
}
