/**
 * `remove_word` — forget a word entirely.
 *
 * The only destructive tool, and the only one whose mistake the learner cannot
 * undo: deleting an item drops its whole review history with it. The guard is
 * in the system prompt (`buildSystemPrompt` in `../chat` forbids calling this
 * without an explicit confirmation in the conversation) rather than here,
 * because "did the learner agree" is a fact about the conversation, not about
 * the arguments — but the tool stays single-word on purpose: a model that has
 * to name each deletion separately cannot clear a list in one call.
 *
 * Pooled challenges keep pointing at the deleted id, which is safe by design —
 * see `deleteItem` in `$lib/db`.
 */

import { z } from 'zod';
import type { AssistantToolDef } from './def';
import { findByTerm, nonEmpty, toolFailure } from './primitives';

export const removeWordParams = z.object({
	term: nonEmpty
});

export type RemoveWordParams = z.infer<typeof removeWordParams>;

export const removeWordTool = {
	name: 'remove_word',
	description:
		'Delete one word from the list, by its exact term. This also deletes its review history and cannot be undone, so only call it after the learner has explicitly confirmed that this word should go.',
	paramsSchema: removeWordParams,

	async run(params, ctx) {
		const items = await ctx.getAllItems();
		const item = findByTerm(items, params.term);
		if (!item) return toolFailure(`no word "${params.term}" in the list`);

		await ctx.deleteItem(item.id);
		return {
			result: { removed: item.term },
			summary: `Removed ${item.term}`
		};
	}
} satisfies AssistantToolDef<typeof removeWordParams>;
