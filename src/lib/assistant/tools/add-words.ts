/**
 * `add_words` — put new vocabulary into the learner's list.
 *
 * The only tool that mints `KnowledgeItem`s, so it is the only one that has to
 * know two things the rest of the app takes for granted: a new word needs a
 * real, due-now FSRS card before it is persisted (`$lib/llm` leaves `fsrsCard`
 * null for exactly the same reason, and `generateChallenges` fills it in the
 * same way), and a term the learner already has must never be added twice — a
 * duplicate forks one word's review history into two entries that each get
 * scheduled half as often.
 *
 * Dedupe therefore runs against the stored list *and* within the batch itself:
 * a model asked to add ten words from a chat message will happily repeat one.
 */

import { z } from 'zod';
import { newCardState } from '$lib/srs';
import type { KnowledgeItem } from '$lib/types';
import type { AssistantToolDef } from './def';
import {
	countWords,
	kindSchema,
	nonEmpty,
	optionalField,
	optionalText,
	termKey,
	trimmedOrUndefined
} from './primitives';

/** Cap per call. High enough for a pasted list, low enough to stay one write. */
export const MAX_WORDS_PER_CALL = 50;

/** The reason string a skipped word carries; the model reads it and moves on. */
export const ALREADY_PRESENT = 'already in the word list';

export const addWordsParams = z.object({
	words: z
		.array(
			z.object({
				term: nonEmpty,
				meaning: nonEmpty,
				romanization: optionalText,
				notes: optionalText,
				kind: kindSchema.nullish()
			})
		)
		.min(1)
		.max(MAX_WORDS_PER_CALL)
});

export type AddWordsParams = z.infer<typeof addWordsParams>;

export const addWordsTool = {
	name: 'add_words',
	description:
		'Add one or more words to the learner\'s word list. Include "romanization" whenever the target language is not written in the Latin script. Words already in the list are skipped, so it is safe to send a whole list.',
	paramsSchema: addWordsParams,

	async run(params, ctx) {
		const existing = await ctx.getAllItems();
		const taken = new Set(existing.map((item) => termKey(item.term)));

		const added: KnowledgeItem[] = [];
		const skipped: { term: string; reason: string }[] = [];

		for (const word of params.words) {
			const term = word.term.trim();
			const key = termKey(term);
			if (taken.has(key)) {
				skipped.push({ term, reason: ALREADY_PRESENT });
				continue;
			}
			// Claimed immediately, so a batch that repeats a word skips the repeat
			// rather than writing it twice.
			taken.add(key);

			const at = ctx.now();
			added.push({
				id: ctx.newId(),
				kind: word.kind ?? 'vocab',
				term,
				meaning: word.meaning.trim(),
				...optionalField('romanization', trimmedOrUndefined(word.romanization)),
				...optionalField('notes', trimmedOrUndefined(word.notes)),
				fsrsCard: newCardState(at),
				introducedAt: at,
				history: []
			});
		}

		if (added.length > 0) await ctx.upsertItems(added);

		const terms = added.map((item) => item.term);
		return {
			result: { added: terms, skipped },
			summary:
				added.length === 0
					? `Nothing added: ${countWords(skipped.length)} already in the list`
					: [
							`Added ${countWords(added.length)}: ${terms.join(', ')}`,
							...(skipped.length > 0 ? [`skipped ${skipped.length} already in the list`] : [])
						].join('; ')
		};
	}
} satisfies AssistantToolDef<typeof addWordsParams>;
