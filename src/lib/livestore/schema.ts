/**
 * `docs/sync.md` §3 and §4 as a LiveStore schema.
 *
 * The write model is `events.ts`, the read model is `tables.ts`, and the merge
 * rules that turn one into the other are `materializers.ts`. Everything the
 * old design derived rather than stored — the FSRS card, `timesServed`,
 * `lastServedAt`, the day streak — is still derived, in `derive.ts`.
 *
 * This module is only the assembly, plus the one schema-level decision:
 *
 * **Unknown events are ignored.** §3 retired `xp-banked` and specified that
 * old logs still carrying it must keep working — "they are now simply an
 * unknown type, and `parseSyncPayload`/apply drop unknown types silently
 * (§1's degrade-silently rule) — that is the designed degradation, not a
 * migration step." LiveStore 0.4 makes that a schema setting rather than
 * something the apply engine has to remember to do. The same setting covers
 * the forward case: an older build meeting an event a newer build introduced
 * skips it and keeps its eventlog intact, instead of failing the sync.
 */
import { makeSchema, State } from '@livestore/livestore';

import { events } from './events';
import { materializers } from './materializers';
import { tables } from './tables';

const state = State.SQLite.makeState({ tables, materializers });

export const schema = makeSchema({
	events,
	state,
	unknownEventHandling: { strategy: 'ignore' }
});

export { events } from './events';
export { PROFILE_ID, tables } from './tables';
