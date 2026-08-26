/**
 * Dexie database definition.
 *
 * All learner state lives in IndexedDB under the `language-learning` database.
 * Only `src/lib/db/repositories.ts` should talk to these tables directly; the
 * rest of the app goes through the repository functions.
 */

import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile } from '$lib/types';
import type { SyncEvent } from '$lib/sync/events';
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
 * agree: three call sites were each destructuring them by hand — the session
 * engine, the sync capture path and genesis synthesis — so adding a sixth
 * bookkeeping field (`topic` was the fifth) meant remembering all three, and
 * missing one would quietly leak a local field into a `Challenge` or into a
 * synced payload.
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
 * One locally produced sync event, waiting to be pushed (docs/sync.md §9).
 *
 * `seq` is Dexie's auto-increment key and the *only* ordering: the outbox
 * drains oldest-first. It is a separate field rather than the table's `id`
 * because a {@link SyncEvent} already has an `id` of its own — the client-minted
 * UUID the server dedupes on — and shadowing it would be a trap.
 */
export interface OutboxRow {
	seq?: number;
	event: SyncEvent;
}

/**
 * Key-value scratch space for the sync client: the pull cursor, the
 * genesis-done flag, and the apply engine's dedupe bookkeeping.
 *
 * Untyped `value` on purpose — this is one table for several unrelated
 * singletons, each owned and typed by its reader in `$lib/sync`.
 */
export interface SyncStateRow {
	key: string;
	value: unknown;
}

export class AppDatabase extends Dexie {
	declare profile: Table<ProfileRow, string>;
	declare items: Table<KnowledgeItem, string>;
	declare challenges: Table<ChallengeRow, string>;
	declare results: Table<ResultRow, number>;
	declare outbox: Table<OutboxRow, number>;
	declare syncState: Table<SyncStateRow, string>;

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

		// v3: sync (docs/sync.md §9). Purely additive — two new tables, no
		// existing table touched, so Dexie needs no `upgrade` callback: a v2
		// database opens as v3 with both tables simply empty, which is exactly
		// the right starting state (capture is opt-in, and genesis backfills
		// everything that predates it).
		this.version(3).stores({ outbox: '++seq', syncState: 'key' });

		// v4: XP is gone. The streak is now derived from the results log, so the
		// whole `stats` table has nothing left to hold and Dexie drops it.
		this.version(4).stores({ stats: null });
	}
}

/** Process-wide database handle. */
export const db = new AppDatabase();
