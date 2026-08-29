/**
 * Reading the pre-LiveStore Dexie database, for the one purpose of migrating
 * it (`$lib/livestore/migrate-dexie`).
 *
 * Thin by design, in the shape `sync/genesis.ts` established: this module does
 * the part that cannot be unit-tested — talking to IndexedDB — and nothing
 * else. Every decision worth testing lives in the pure synthesis next door.
 *
 * It deliberately does **not** go through `seedOutbox`, even though that
 * function reads exactly these tables. `seedOutbox` is gated on the
 * `genesisDone` flag, and that flag means "the outbox has been seeded", not
 * "this data has reached LiveStore". A device that had sync configured has
 * already set it, so reusing that path would skip the migration for precisely
 * the users with the most history to lose.
 */

import type { ChallengeResult, KnowledgeItem, Profile } from '$lib/types';
import { db, SINGLETON_KEY, type ChallengeRow } from './database';

/** One answered challenge, with the Dexie key that gives it a stable identity. */
export interface LegacyResult extends ChallengeResult {
	/** Dexie's `++seq` autoincrement key. Absent only on a hand-written row. */
	seq?: number;
}

/** Everything the old database held that the new one wants. */
export interface LegacySnapshot {
	profile: Profile | null;
	items: KnowledgeItem[];
	pool: ChallengeRow[];
	results: LegacyResult[];
}

/** True when a snapshot holds nothing worth migrating. */
export function isEmptySnapshot(snapshot: LegacySnapshot): boolean {
	return (
		snapshot.profile === null &&
		snapshot.items.length === 0 &&
		snapshot.pool.length === 0 &&
		snapshot.results.length === 0
	);
}

/**
 * Reads the whole legacy database.
 *
 * Read-only and non-destructive: the Dexie tables are the only copy of this
 * data until step 5 removes them, so nothing here writes, clears or upgrades
 * anything. `results` keeps its `seq` because the migration needs a stable
 * per-row identity and `ChallengeResult` has no id of its own.
 */
export async function readLegacySnapshot(): Promise<LegacySnapshot> {
	const [profileRow, items, pool, results] = await Promise.all([
		db.profile.get(SINGLETON_KEY),
		db.items.toArray(),
		db.challenges.toArray(),
		db.results.orderBy('seq').toArray()
	]);

	return {
		profile: profileRow ? (({ id: _id, ...rest }) => rest)(profileRow) : null,
		items,
		pool,
		results
	};
}
