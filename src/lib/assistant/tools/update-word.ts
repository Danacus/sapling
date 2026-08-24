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
 */

import { z } from 'zod';
import type { KnowledgeItem } from '$lib/types';
import type { AssistantToolDef } from './def';
import { findByTerm, nonEmpty, optionalText, toolFailure, wordView } from './primitives';

export const updateWordParams = z.object({
	term: nonEmpty,
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
		'Change the meaning, romanization, notes or spelling of a word already in the list. Identify it by its exact term. Pass an empty string to clear "romanization" or "notes"; omitted fields are left alone. Review history is never affected.',
	paramsSchema: updateWordParams,

	async run(params, ctx) {
		const items = await ctx.getAllItems();
		const item = findByTerm(items, params.term);
		if (!item) return toolFailure(`no word "${params.term}" in the list`);

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

		await ctx.upsertItems([merged]);
		return {
			result: { updated: wordView(merged), changed },
			summary: `Updated ${item.term} (${changed.join(', ')})`
		};
	}
} satisfies AssistantToolDef<typeof updateWordParams>;
