/**
 * Dexie database definition.
 *
 * TODO: declare the Dexie subclass, its tables and the version/schema stores.
 * Suggested tables: `profile` (single row, id `'me'`), `items` (KnowledgeItem
 * keyed by id, indexed on `fsrsCard.due` proxy or a denormalized `dueAt`),
 * `results` (ChallengeResult log) and `stats` (single row).
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { ChallengeResult, KnowledgeItem, Profile, Stats } from '$lib/types';

/** The `profile` and `stats` tables hold exactly one row under this key. */
export const SINGLETON_KEY = 'me';

export interface ProfileRow extends Profile {
	id: string;
}

export interface StatsRow extends Stats {
	id: string;
}

export class AppDatabase extends Dexie {
	// TODO: initialize in the constructor via `this.version(1).stores({ ... })`.
	declare profile: Table<ProfileRow, string>;
	declare items: Table<KnowledgeItem, string>;
	declare results: Table<ChallengeResult, string>;
	declare stats: Table<StatsRow, string>;

	constructor() {
		super('language-learning');
		// TODO: this.version(1).stores({ profile: 'id', items: 'id, kind, dueAt', ... });
	}
}

/** Process-wide database handle. TODO: instantiate lazily / guard for SSR. */
export const db = new AppDatabase();
