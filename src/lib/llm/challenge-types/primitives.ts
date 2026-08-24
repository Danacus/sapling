/**
 * The zod building blocks every wire type is assembled from.
 *
 * This is the bottom of the generation layer: it imports zod and nothing else,
 * so the import chain runs primitives → the def modules → `./index` →
 * `../schemas` → `../generate` with no way back up. A def that reached for
 * `../schemas` would close that loop the moment `../schemas` started deriving
 * the union from the registry, which is why the shared pieces live here rather
 * than there.
 *
 * Optional string fields are declared `.nullish()` rather than `.optional()`:
 * models emit `null` for "not applicable" far more often than they omit a key,
 * and the resolvers normalize `null` back to absent.
 */

import { z } from 'zod';

/** A string the model must actually fill in. */
export const nonEmpty = z.string().min(1);

/**
 * A reference to a `KnowledgeItem`: either an existing id, or `new:<index>`
 * pointing at an entry of the batch's `newItems` array.
 */
export const itemRefSchema = nonEmpty;

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

export type TargetText = z.infer<typeof targetTextSchema>;

/**
 * The halves of a cloze sentence either side of the blank. Same shape as
 * {@link targetTextSchema} but the text may be empty: a sentence is allowed to
 * begin or end with the blank.
 */
export const clozePartSchema = z.object({
	text: z.string(),
	reading: z.string().nullish()
});

/**
 * The two fields every wire type carries, spread into each def's own object so
 * they stay ordinary properties rather than an intersection zod would have to
 * re-derive.
 */
export const generatedBase = {
	explanation: z.string().nullish(),
	itemIds: z.array(itemRefSchema).min(1)
};

/**
 * Exactly three distractors. Declared as a length-constrained array rather than
 * a tuple: tuples emit `prefixItems`, which several structured-output
 * implementations reject.
 */
export const threeOf = <T extends z.ZodType>(schema: T) => z.array(schema).length(3);
