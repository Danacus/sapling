/**
 * The word list the assistant's tools (Rust, `crates/sapling-llm`) read and
 * write: the repositories, so every change is an event. The one module in
 * `$lib/assistant` and `$lib/conversation` that imports `$lib/db`.
 */

import { deleteItem, getAllItems, upsertItems } from '$lib/db';
import { newUuid } from '$lib/device';
import type { ToolContext } from '$lib/llm';

export function defaultToolContext(): ToolContext {
	return {
		getAllItems: () => getAllItems(),
		upsertItems: (items) => upsertItems(items),
		deleteItem: (id) => deleteItem(id),
		newId: newUuid,
		now: () => Date.now()
	};
}
