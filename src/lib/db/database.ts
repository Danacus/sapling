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

/** Lifecycle of a generated challenge sitting in the local queue. */
export type ChallengeStatus = 'queued' | 'done';

/**
 * Stored challenge: the domain `Challenge` union plus queue bookkeeping.
 *
 * The union is intersected rather than extended so the `type` discriminant
 * still narrows after a read.
 */
export type ChallengeRow = Challenge & {
	status: ChallengeStatus;
	/** Epoch milliseconds; queue order is oldest-first on this field. */
	enqueuedAt: number;
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
			// The compound index lets `takeNextChallenge()` read the oldest queued
			// row without scanning or sorting in memory.
			challenges: 'id, status, [status+enqueuedAt]',
			results: '++seq, at',
			stats: 'id'
		});
	}
}

/** Process-wide database handle. */
export const db = new AppDatabase();
