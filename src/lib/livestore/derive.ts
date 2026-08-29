/**
 * The state `docs/sync.md` §4 computes rather than stores.
 *
 * Keeping these derived is the point of the whole exercise. A stored FSRS card
 * has to be kept in agreement with a stored history by whichever code path
 * happens to write them, and `sync/apply.ts` needed a `dirty` set and a refold
 * pass to do it. Here the card is a pure function of the rows, so there is no
 * agreement to maintain and nothing to invalidate.
 *
 * These are plain functions over query results, not queries: the callers that
 * will need them (the session planner, the words page) run their own reactive
 * queries and fold the rows themselves.
 */
import { newCardState, reviewCard, type FsrsCardState, type Grade } from '$lib/srs';

/** One row of the `reviews` table, as much of it as the folds read. */
export interface ReviewRow {
	at: number;
	grade: number;
	device: string;
}

/** One row of the `serves` table. */
export interface ServeRow {
	at: number;
}

/**
 * §4's deterministic history order: `(at, device)`.
 *
 * This is what makes the card independent of the order reviews arrived in —
 * two devices holding the same rows fold them the same way.
 */
export function sortHistory<T extends ReviewRow>(rows: readonly T[]): T[] {
	return [...rows].sort((a, b) => a.at - b.at || a.device.localeCompare(b.device));
}

/**
 * Replays an item's whole merged history through `$lib/srs` from a fresh card.
 *
 * A few dozen `reviewCard` calls per item, which is nothing next to being
 * exact — and exactness is what lets two devices that have seen the same
 * reviews agree without transporting a card at all.
 */
export function deriveCard(introducedAt: number, history: readonly ReviewRow[]): FsrsCardState {
	let card = newCardState(introducedAt);
	for (const entry of sortHistory(history)) card = reviewCard(card, entry.grade as Grade, entry.at);
	return card;
}

/**
 * The pool bookkeeping `ChallengeRow` used to store: `timesServed` is the
 * count of distinct applied serve events (§4 — exact, unlike a max-merge of
 * counters), `lastServedAt` the greatest of their timestamps.
 */
export function serveStats(serves: readonly ServeRow[]): {
	timesServed: number;
	lastServedAt: number | null;
} {
	return {
		timesServed: serves.length,
		lastServedAt: serves.length === 0 ? null : Math.max(...serves.map((s) => s.at))
	};
}
