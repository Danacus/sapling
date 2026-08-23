/**
 * Schema migrations that are worth testing.
 *
 * Dexie's `upgrade` callbacks run inside a real IndexedDB transaction, which
 * node does not have (see CLAUDE.md: no fake-indexeddb). So the *decision* a
 * migration makes lives here as a pure function, unit-tested on plain objects,
 * and `database.ts` reduces its upgrade hook to "call this on every row".
 *
 * Deliberately Dexie-free: the only import is a type, which is erased, so this
 * module is safe to load from the node test environment.
 */

import type { Challenge } from '$lib/types';
import type { ChallengeRow } from './database';

/** Lifecycle of a generated challenge in the v1 queue model. */
export type LegacyChallengeStatus = 'queued' | 'done';

/**
 * A challenge row as `version(1)` stored it: a consume-once queue entry, where
 * `done` meant "answered, dead" and the row was never looked at again.
 */
export type LegacyChallengeRow = Challenge & {
	status: LegacyChallengeStatus;
	/** Epoch milliseconds; queue order was oldest-first on this field. */
	enqueuedAt: number;
};

/**
 * Reinterprets a v1 queue row as a v2 pool row.
 *
 * The mapping is the whole point of the rework stated in data terms: a queue
 * entry's `status` was a one-bit serve counter, so `done` becomes "served
 * once", `queued` becomes "never served", and `enqueuedAt` — which only ever
 * meant "when this was generated" — becomes `generatedAt` under its real name.
 *
 * `lastServedAt` for a migrated `done` row is its generation time rather than
 * the (unrecorded) moment it was answered. That is a deliberate under-estimate:
 * it is the earliest time the row could have been served, so the engine's
 * `RESERVE_GAP` recycling guard treats old answered rows as *more* eligible
 * than they might be — which is right, because everything in a v1 database was
 * answered at least a session ago.
 *
 * Idempotent by construction: a row that already carries `timesServed` is
 * handed back untouched, so re-running the upgrade cannot reset serve counts.
 */
export function poolRowFromLegacy(row: LegacyChallengeRow | ChallengeRow): ChallengeRow {
	if (isPoolRow(row)) return row;

	const { status, enqueuedAt, ...challenge } = row;
	const served = status === 'done';
	return {
		...(challenge as Challenge),
		generatedAt: enqueuedAt,
		timesServed: served ? 1 : 0,
		lastServedAt: served ? enqueuedAt : null,
		reported: false
	};
}

/** True once a row has been through {@link poolRowFromLegacy}. */
function isPoolRow(row: LegacyChallengeRow | ChallengeRow): row is ChallengeRow {
	return typeof (row as ChallengeRow).timesServed === 'number';
}
