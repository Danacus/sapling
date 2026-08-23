/**
 * The shape the sync layer folds events into — types only, no runtime code.
 *
 * It exists as its own module for a dependency reason: the pure apply engine
 * (`./apply`) must never import Dexie, and `$lib/db/repositories` must be able
 * to read and write a snapshot without importing the engine. Both sides import
 * these types instead, so there is no cycle and no runtime edge between them.
 *
 * A snapshot is the *whole* synced state, plus the bookkeeping that makes
 * applying an event set idempotent. It is plain JSON: the bookkeeping is
 * persisted in the `syncState` table, and IndexedDB cannot store a `Set`
 * cheaply enough to be worth the ceremony — the engine builds sets from these
 * arrays when it starts and writes arrays back when it finishes.
 */

import type { ChallengeRow } from '$lib/db/database';
import type { ChallengeResult, KnowledgeItem, Profile } from '$lib/types';

/** A pool row, exactly as the challenges table stores it. */
export type PoolRow = ChallengeRow;

/** One day's XP total. `Stats.streakDays`/`lastActiveDay` are derived from these. */
export interface DayXp {
	day: string;
	xp: number;
}

/**
 * Identity of the event that last won a last-write-wins slot: `(at, device, id)`,
 * the same triple the global sort order uses. Storing the whole triple rather
 * than just `at` is what makes LWW independent of how events are batched — two
 * events in the same millisecond resolve the same way whichever arrives first.
 */
export interface EventKey {
	at: number;
	device: string;
	id: string;
}

/**
 * What the engine has to remember between batches for application to be
 * idempotent and commutative. Every field is a *minimal* dedupe key; see
 * `./apply` for the per-type rationale.
 */
export interface SyncBookkeeping {
	/**
	 * Event ids of everything that contributes to a **count or a sum** —
	 * `challenge-served`, `result-logged`, `xp-banked`. Those three cannot be
	 * deduped from the data they produce (a serve leaves no trace but a number,
	 * two results can be genuinely identical), so the event id is the only
	 * honest key. Grows with the log; a serve id is 36 bytes and an active
	 * learner produces a few thousand a year.
	 */
	countedEventIds: string[];
	/** Item ids killed by `item-deleted`. Tombstones win over concurrent adds and reviews. */
	tombstones: string[];
	/**
	 * `itemId|at|device` of history entries that a `review-amended` superseded.
	 * Needed only for the out-of-order case: the amend may arrive before the
	 * `item-reviewed` it replaces, and without this the original would then be
	 * re-inserted alongside the re-grade.
	 */
	supersededReviews: string[];
	/** Winning `item-updated` per item id — the LWW comparison key. */
	itemUpdates: Record<string, EventKey>;
	/** Winning `profile-updated`, or `null` if none has been applied. */
	profileUpdate: EventKey | null;
}

/** Everything sync owns, at one point in time. */
export interface SyncSnapshot {
	items: KnowledgeItem[];
	pool: PoolRow[];
	results: ChallengeResult[];
	/** Per-day XP totals; whole `Stats` is rebuilt from them by `statsFromDays`. */
	days: DayXp[];
	profile: Profile | null;
	bookkeeping: SyncBookkeeping;
}

/** The local state genesis synthesizes events from: a snapshot minus bookkeeping. */
export type GenesisState = Omit<SyncSnapshot, 'bookkeeping'>;

/** Bookkeeping for a device that has applied nothing yet. */
export function emptyBookkeeping(): SyncBookkeeping {
	return {
		countedEventIds: [],
		tombstones: [],
		supersededReviews: [],
		itemUpdates: {},
		profileUpdate: null
	};
}
