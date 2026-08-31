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
 *
 * ## Two 长s are two words; two bare 长s are one
 *
 * A spelling is not a word. 长 is `cháng` ("long") and `zhǎng` ("to grow"), with
 * different meanings and different schedules, and a learner studying both wants
 * two cards — which the storage layer has always allowed, since `items.id` is a
 * surrogate and every review is id-keyed. So the guard is `sameCard`
 * (`$lib/text`): same spelling *and* a reading that fails to tell them apart.
 *
 * The asymmetry about a missing reading is the whole of the back-compat story. A
 * word offered with no `romanization` collides with every spelling of itself,
 * and so does an existing card that was stored without one — because there is
 * nothing in a bare 长 to say which 长 it is, and a careless model call, or a
 * collection written before any of this, must not be able to fork an SRS history
 * on a guess. The only way to a second card is to name both readings.
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
	sameCard,
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
		'Add one or more words to the learner\'s word list. Include "romanization" whenever the target language is not written in the Latin script. Words already in the list are skipped, so it is safe to send a whole list. Two words spelled the same are kept separately only when they are different readings of a homograph AND each one carries its own "romanization" (Mandarin 长 cháng "long" and 长 zhǎng "to grow" are two words); a word sent without a romanization is skipped whenever that spelling is already there at all.',
	paramsSchema: addWordsParams,

	async run(params, ctx) {
		const existing = await ctx.getAllItems();
		const taken: { term: string; romanization?: string }[] = existing.map((item) => ({
			term: item.term,
			romanization: item.romanization
		}));

		const added: KnowledgeItem[] = [];
		const skipped: { term: string; reason: string }[] = [];

		for (const word of params.words) {
			const term = word.term.trim();
			const romanization = trimmedOrUndefined(word.romanization);
			const card = { term, romanization };
			if (taken.some((held) => sameCard(held, card))) {
				skipped.push({ term, reason: ALREADY_PRESENT });
				continue;
			}
			// Claimed immediately, so a batch that repeats a word skips the repeat
			// rather than writing it twice.
			taken.push(card);

			const at = ctx.now();
			added.push({
				id: ctx.newId(),
				kind: word.kind ?? 'vocab',
				term,
				meaning: word.meaning.trim(),
				...optionalField('romanization', romanization),
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
