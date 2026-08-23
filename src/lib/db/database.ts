/**
 * Dexie database definition.
 *
 * All learner state lives in IndexedDB under the `language-learning` database.
 * Only `src/lib/db/repositories.ts` should talk to these tables directly; the
 * rest of the app goes through the repository functions.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Stats } from '$lib/types';
import { poolRowFromLegacy, type LegacyChallengeRow } from './migrate';

/** The `profile` and `stats` tables hold exactly one row under this key. */
export const SINGLETON_KEY = 'singleton';

/** Stored profile: the domain `Profile` plus the singleton primary key. */
export interface ProfileRow extends Profile {
	id: string;
}

/** Stored stats: the domain `Stats` plus the singleton primary key. */
export interface StatsRow extends Stats {
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

/** Stored answer log entry. `seq` is assigned by Dexie's auto-increment key. */
export interface ResultRow extends ChallengeResult {
	seq?: number;
}

export class AppDatabase extends Dexie {
	declare profile: Table<ProfileRow, string>;
	declare items: Table<KnowledgeItem, string>;
	declare challenges: Table<ChallengeRow, string>;
	declare results: Table<ResultRow, number>;
	declare stats: Table<StatsRow, string>;

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
	}
}

/** Process-wide database handle. */
export const db = new AppDatabase();
