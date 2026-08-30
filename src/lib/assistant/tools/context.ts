/**
 * The production {@link ToolContext}: the repositories, the uuid source and the
 * clock.
 *
 * The one module in `$lib/assistant` that imports `$lib/db`, so everything else
 * — tools, chat loop, mock — stays testable without the database, and so the
 * assistant's whole write surface is three functions listed in one place.
 */

import { deleteItem, getAllItems, upsertItems } from '$lib/db';
import { newUuid } from '$lib/device';
import type { ToolContext } from './def';

/**
 * Wires the real store, with `deps` overriding any part of it — the seam tests
 * and the offline mock use. Production passes nothing.
 */
export function defaultToolContext(deps: Partial<ToolContext> = {}): ToolContext {
	return {
		getAllItems,
		// Both repositories take an optional `now`; the context's own clock is
		// the tool's business, so the default is left to the write itself.
		upsertItems: (items) => upsertItems(items),
		deleteItem: (id) => deleteItem(id),
		newId: newUuid,
		now: () => Date.now(),
		...deps
	};
}
