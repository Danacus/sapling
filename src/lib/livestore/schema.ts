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

/**
 * The ten domain events, plus the setter `tables.migrationState` derives.
 *
 * `makeSchema` registers a client document's `set` event itself when it is
 * missing, and `makeState` registers the matching materializer — but only at
 * runtime. The *type* of `schema` is derived from what is passed in, so
 * `store.commit(tables.migrationState.set(...))` does not typecheck unless the
 * setter is named here too. Listing it is a no-op for the runtime (the
 * registration is guarded on the name already) and the difference between
 * compiling and not for us.
 */
const allEvents = { ...events, migrationStateSet: tables.migrationState.set };

export const schema = makeSchema({
	events: allEvents,
	state,
	unknownEventHandling: { strategy: 'ignore' }
});

export { events } from './events';
export { MIGRATION_STATE_ID, PROFILE_ID, tables } from './tables';
