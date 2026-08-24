/**
 * `list_words` — read the learner's list, all of it or the part they asked
 * about.
 *
 * The only tool with no side effect, and the one the model needs before almost
 * any other: it cannot update or remove a word whose exact term it has not
 * seen. `limit` is clamped rather than rejected, because a model that asks for
 * a thousand words wants "all of them", not an error — and the list travels
 * back through the context window, so an unbounded answer is a real cost.
 */

import { z } from 'zod';
import type { KnowledgeItem } from '$lib/types';
import type { AssistantToolDef } from './def';
import { countWords, optionalText, wordView } from './primitives';

/** Used when the model names no limit. */
export const DEFAULT_LIMIT = 50;
/** Hard ceiling, whatever the model asks for. */
export const MAX_LIMIT = 200;

export const listWordsParams = z.object({
	query: optionalText,
	limit: z.number().nullish()
});

export type ListWordsParams = z.infer<typeof listWordsParams>;

/** Case-insensitive substring match over the three fields a learner would name. */
function matches(item: KnowledgeItem, query: string): boolean {
	const haystack = [item.term, item.meaning, item.romanization ?? ''].join('\n').toLowerCase();
	return haystack.includes(query);
}

export const listWordsTool = {
	name: 'list_words',
	description:
		'Read the learner\'s word list. Omit "query" for the whole list, or pass text to match against terms, meanings and romanizations. Use this before updating or removing a word, to get its exact term.',
	paramsSchema: listWordsParams,

	async run(params, ctx) {
		const items = await ctx.getAllItems();
		const query = params.query?.trim().toLowerCase() ?? '';
		const found = query ? items.filter((item) => matches(item, query)) : items;

		const requested = params.limit ?? DEFAULT_LIMIT;
		const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
		const entries = found.slice(0, limit).map((item) => ({
			...wordView(item),
			reviews: item.history.length
		}));

		return {
			result: { total: found.length, showing: entries.length, entries },
			summary: query
				? `Found ${countWords(found.length)} matching "${params.query?.trim()}"`
				: `Read the list: ${countWords(found.length)}`
		};
	}
} satisfies AssistantToolDef<typeof listWordsParams>;
