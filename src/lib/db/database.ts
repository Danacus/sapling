/**
 * Dexie database definition — now read-only, and kept only to be migrated.
 *
 * Learner state lives in LiveStore (`$lib/livestore`). This database is what
 * was there before: `legacy-snapshot.ts` reads it once, on the first boot after
 * the upgrade, and `$lib/livestore/migrate-dexie` turns it into an eventlog.
 * Nothing writes here any more.
 *
 * **The version declarations below are not a schema you own.** They are a
 * description of what is already on learners' disks, and Dexie compares them
 * against it: changing one — including "tidying away" the unused `outbox` and
 * `syncState` tables, or adding a v5 that drops them — makes Dexie run an
 * *upgrade* the moment the migration opens the database, mutating the very data
 * being migrated before it has been carried across. Leave them exactly as they
 * are. Stale rows in unread tables cost nothing.
 *
 * The database itself is deliberately not deleted either: until a learner has
 * successfully migrated, it is the only copy of their library.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile } from '$lib/types';
import { poolRowFromLegacy, type LegacyChallengeRow } from './migrate';

/** The `profile` table holds exactly one row under this key. */
export const SINGLETON_KEY = 'singleton';

/** Stored profile: the domain `Profile` plus the singleton primary key. */
export interface ProfileRow extends Profile {
	id: string;
}

/**
 * Stored challenge: the domain `Challenge` union plus pool bookkeeping.
 *
 * The union is intersected rather than extended so the `type` discriminant
 * still narrows after a read.
 *
 * Every challenge ever generated stays here — answering one does not consume
 * it, it only stamps it. The session planner (`planSession` in
 * `$lib/session/engine`) reads the whole table and decides what is worth
 * playing again from these four fields.
 */
export type ChallengeRow = Challenge & {
	/** Epoch milliseconds the batch this came from was persisted. */
	generatedAt: number;
	/** How many times the learner has actually answered it. */
	timesServed: number;
	/** Epoch milliseconds of the last answer, or `null` while never served. */
	lastServedAt: number | null;
	/** The learner flagged it as broken; excluded from the pool forever. */
	reported: boolean;
	/** Generation topic, when the batch was generated with one. */
	topic?: string;
};

/**
 * Sheds the bookkeeping above, leaving the immutable domain `Challenge`.
 *
 * Lives here, beside the fields it strips, because those two lists have to
 * agree: call sites were each destructuring them by hand, so adding a sixth
 * bookkeeping field (`topic` was the fifth) meant remembering every one of
 * them, and missing one would quietly leak a local field into a `Challenge`.
 * The remaining caller is the Dexie migration.
 *
 * The cast is unavoidable: a rest-destructure over a discriminated union
 * produces an `Omit` that no longer narrows on `type`, even though every field
 * of it survived.
 */
export function challengeOf(row: ChallengeRow): Challenge {
	const {
		generatedAt: _generatedAt,
		timesServed: _timesServed,
		lastServedAt: _lastServedAt,
		reported: _reported,
		topic: _topic,
		...challenge
	} = row;
	return challenge as Challenge;
}

/** Stored answer log entry. `seq` is assigned by Dexie's auto-increment key. */
export interface ResultRow extends ChallengeResult {
	seq?: number;
}

/**
 * The four tables the migration reads.
 *
 * `outbox` and `syncState` are absent on purpose. They still exist on disk —
 * v3 below created them and that declaration must stay — but they belonged to
 * the retired sync client, nothing reads them, and typing them here would only
 * invite something to start.
 */
export class AppDatabase extends Dexie {
	declare profile: Table<ProfileRow, string>;
	declare items: Table<KnowledgeItem, string>;
	declare challenges: Table<ChallengeRow, string>;
	declare results: Table<ResultRow, number>;

	constructor() {
		super('language-learning');

		this.version(1).stores({
			profile: 'id',
			items: 'id, kind',
			// The compound index let the v1 queue read the oldest queued row
			// without scanning or sorting in memory.
			challenges: 'id, status, [status+enqueuedAt]',
			results: '++seq, at',
			stats: 'id'
		});

		// v2: the queue became a pool. Only `challenges` changes, and Dexie
		// carries every unlisted table forward untouched.
		//
		// The new schema indexes almost nothing on purpose: a single learner's
		// pool is a few hundred rows, `getPool()` reads all of them, and the
		// planner filters in memory — index machinery here would buy nothing and
		// have to be kept in step with every scoring tweak.
		this.version(2)
			.stores({ challenges: 'id, generatedAt' })
			.upgrade((tx) =>
				tx
					.table('challenges')
					.toCollection()
					.modify((row, ref) => {
						ref.value = poolRowFromLegacy(row as LegacyChallengeRow);
					})
			);

		// v3: the retired sync client's outbox and scratch space. Both tables are
		// now unread — nothing declares them on the class above — but the
		// declaration stays, because removing it is what would make Dexie decide
		// this database needs upgrading.
		this.version(3).stores({ outbox: '++seq', syncState: 'key' });

		// v4: XP is gone. The streak is now derived from the results log, so the
		// whole `stats` table has nothing left to hold and Dexie drops it.
		this.version(4).stores({ stats: null });
	}
}

/** Process-wide database handle. */
export const db = new AppDatabase();
