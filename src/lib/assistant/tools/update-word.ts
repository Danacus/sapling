/**
 * `update_word` — correct a word the learner already has.
 *
 * Addressed by `term`, not by id: the model never sees ids, and the learner
 * says "the note on gato is wrong". Matching is the shared
 * case/whitespace-insensitive rule, so the term the model read back from
 * `list_words` always resolves.
 *
 * The card and the review history are untouchable here. A correction is a
 * content edit — the learner has still reviewed this word n times, and rewriting
 * its schedule because a typo in the meaning was fixed would quietly undo their
 * progress.
 *
 * `romanization` and `notes` are the only clearable fields, and only by an
 * explicitly empty string: `null` (which models emit for "not applicable")
 * leaves a field alone, so a partially filled patch can never erase the rest.
 *
 * Two things follow from a spelling no longer being a word (see `./add-words`).
 * The top-level `romanization` is a *selector* — which 长 — and is unrelated to
 * `fields.romanization`, which is the new value; and the patch is refused when
 * it would land the word on top of a sibling, because `add_words` refusing to
 * create a collision would mean nothing if an edit could still produce one.
 */

import { z } from 'zod';
import type { KnowledgeItem } from '$lib/types';
import type { AssistantToolDef } from './def';
import {
	describeTermMiss,
	findByTerm,
	nonEmpty,
	optionalText,
	sameCard,
	toolFailure,
	trimmedOrUndefined,
	wordView
} from './primitives';

export const updateWordParams = z.object({
	term: nonEmpty,
	romanization: optionalText,
	fields: z.object({
		term: optionalText,
		meaning: optionalText,
		romanization: optionalText,
		notes: optionalText
	})
});

export type UpdateWordParams = z.infer<typeof updateWordParams>;

export const updateWordTool = {
	name: 'update_word',
	description:
		'Change the meaning, romanization, notes or spelling of a word already in the list. Identify it by its exact term, and — when two words share that spelling as different readings of a homograph — by the top-level "romanization" of the one you mean (which is not the same as "fields.romanization", the new value). Pass an empty string to clear "romanization" or "notes"; omitted fields are left alone. Review history is never affected.',
	paramsSchema: updateWordParams,

	async run(params, ctx) {
		const items = await ctx.getAllItems();
		const selector = trimmedOrUndefined(params.romanization);
		const item = findByTerm(items, params.term, selector);
		if (!item) return toolFailure(describeTermMiss(items, params.term, selector));

		const merged: KnowledgeItem = { ...item };
		const changed: string[] = [];

		for (const key of ['term', 'meaning'] as const) {
			const next = params.fields[key]?.trim();
			if (next && next !== item[key]) {
				merged[key] = next;
				changed.push(key);
			}
		}

		for (const key of ['romanization', 'notes'] as const) {
			const given = params.fields[key];
			// Only a string is an instruction; `null`/absent mean "leave it".
			if (typeof given !== 'string') continue;
			const next = given.trim();
			if (next === (item[key] ?? '')) continue;
			if (next) merged[key] = next;
			else delete merged[key];
			changed.push(key);
		}

		if (changed.length === 0) {
			return toolFailure(`nothing to change on "${item.term}": no new values given`);
		}

		// The same rule `add_words` adds under: an edit that walks one card onto
		// another is a fork of two review histories by a different route.
		const collision = items.find((other) => other.id !== item.id && sameCard(other, merged));
		if (collision) {
			return toolFailure(
				`"${merged.term}"${merged.romanization ? ` (${merged.romanization})` : ''} would collide with a word already in the list; give it a romanization that tells them apart, or leave it as it is`
			);
		}

		await ctx.upsertItems([merged]);
		return {
			result: { updated: wordView(merged), changed },
			summary: `Updated ${item.term} (${changed.join(', ')})`
		};
	}
} satisfies AssistantToolDef<typeof updateWordParams>;
