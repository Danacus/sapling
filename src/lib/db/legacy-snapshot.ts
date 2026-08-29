/**
 * Reading the pre-LiveStore Dexie database, for the one purpose of migrating
 * it (`$lib/livestore/migrate-dexie`).
 *
 * Thin by design: this module does the part that cannot be unit-tested —
 * talking to IndexedDB — and nothing else. Every decision worth testing lives
 * in the pure synthesis next door.
 *
 * The retired sync client had a `seedOutbox` that read exactly these tables,
 * and reusing it would have been the obvious move. It was deliberately not
 * reused, and the reason is worth keeping now that the code is gone: it was
 * gated on a `genesisDone` flag meaning "the outbox has been seeded", *not*
 * "this data has reached LiveStore". Any device that had sync configured had
 * already set it, so that path would have skipped the migration for precisely
 * the learners with the most history to lose.
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
 * Read-only and non-destructive: until a learner has successfully migrated,
 * these tables are the only copy of their library, so nothing here writes,
 * clears or upgrades anything — and the database is not deleted afterwards
 * either. `results` keeps its `seq` only so a caller *could* order by it; the
 * migration deliberately does not use it for identity, because it is a
 * device-local autoincrement (see `resultKey`).
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
