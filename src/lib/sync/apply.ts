/**
 * The apply engine: fold a set of remote events into local state.
 *
 * This is the whole of `docs/sync.md` §4, and it is **pure** — plain objects in,
 * plain objects out, no Dexie, no clock, no randomness. That is what makes the
 * merge rules testable, and `apply.test.ts` is where they are actually pinned
 * down. The only database-touching thing here is {@link applyRemoteBatch}, three
 * lines at the bottom that hand the fold to a repository.
 *
 * Two properties carry the design, and every rule below is written to preserve
 * them:
 *
 * - **Idempotent.** Applying an event twice is applying it once. There is no
 *   "already seen" ledger of *all* events — most types dedupe from the data
 *   they produce (an item id, a history entry's `(at, device)`, a boolean flag),
 *   and only the two that contribute to a count need their event ids
 *   remembered (`bookkeeping.countedEventIds`).
 * - **Commutative across batches.** Applying `[a]` then `[b]` equals applying
 *   `[a, b]` in one call, for any `a`, `b`. Sorting a batch by `(at, device, id)`
 *   is not enough on its own — a later batch may contain an *older* event — so
 *   the two order-sensitive rules (last-write-wins patches, and an amend racing
 *   its original) carry explicit bookkeeping instead of relying on arrival order.
 *
 * Together they mean a device can sync incrementally, in server-`seq` order,
 * and land exactly where a full replay would.
 *
 * **Cards are never transported.** `item-reviewed` carries a history entry;
 * the card is recomputed by replaying the merged history through `$lib/srs`
 * from a fresh card. FSRS is a deterministic fold over `(at, grade)`, so every
 * device that has seen the same reviews computes the same card, and no merge
 * rule for card fields is needed — there is nothing to merge.
 */

import { newCardState, reviewCard, type FsrsCardState, type Grade } from '$lib/srs';
import type { ChallengeResult, KnowledgeItem } from '$lib/types';
import { mergeSyncSnapshot } from '$lib/db';
import { EVENT_TYPES, typeSyncEvent, type SyncEvent, type TypedSyncEvent } from './events';
import { getDeviceId } from './config';
import type { EventKey, PoolRow, SyncBookkeeping, SyncSnapshot } from './snapshot';

/**
 * The total order §4 mandates: `at` first (the domain's own notion of when),
 * then `device`, then event id. The tie-breaks carry no meaning — they exist so
 * that two devices holding the same event set sort it the same way.
 */
export function compareEvents(a: SyncEvent, b: SyncEvent): number {
	return a.at - b.at || a.device.localeCompare(b.device) || a.id.localeCompare(b.id);
}

/** Same order, over the `(at, device, id)` triple a snapshot remembers for LWW. */
function compareKeys(a: EventKey, b: EventKey): number {
	return a.at - b.at || a.device.localeCompare(b.device) || a.id.localeCompare(b.id);
}

function keyOf(event: SyncEvent): EventKey {
	return { at: event.at, device: event.device, id: event.id };
}

/** Identity of one history entry: `(itemId, at, device)`. */
function reviewKey(itemId: string, at: number, device: string): string {
	return `${itemId}|${at}|${device}`;
}

/**
 * Mutable working copy of a snapshot. Maps and sets while folding, arrays on
 * the way out — the persisted form has to be plain JSON.
 */
interface Working {
	items: Map<string, KnowledgeItem>;
	pool: Map<string, PoolRow>;
	results: ChallengeResult[];
	profile: SyncSnapshot['profile'];
	counted: Set<string>;
	tombstones: Set<string>;
	superseded: Set<string>;
	itemUpdates: Map<string, EventKey>;
	profileUpdate: EventKey | null;
	/** Item ids whose history changed and whose card therefore needs re-folding. */
	dirty: Set<string>;
}

/**
 * Folds `events` into `state`.
 *
 * `localDevice` is skipped wholesale: those events were applied to the view at
 * write time (§4), and re-applying them would be harmless for most types but
 * would double-count the two that count. Pass `undefined` to apply everything,
 * which is what genesis round-trip tests want.
 *
 * Anything that fails envelope or payload validation is dropped silently and
 * the rest of the batch still applies — one malformed event from a newer client
 * must not be able to wedge a sync (§1's degrade-silently rule).
 */
export function applyEvents(
	state: SyncSnapshot,
	events: SyncEvent[],
	localDevice?: string
): SyncSnapshot {
	const work: Working = {
		items: new Map(state.items.map((item) => [item.id, item])),
		pool: new Map(state.pool.map((row) => [row.id, row])),
		results: state.results,
		profile: state.profile,
		counted: new Set(state.bookkeeping.countedEventIds),
		tombstones: new Set(state.bookkeeping.tombstones),
		superseded: new Set(state.bookkeeping.supersededReviews),
		itemUpdates: new Map(Object.entries(state.bookkeeping.itemUpdates)),
		profileUpdate: state.bookkeeping.profileUpdate,
		dirty: new Set()
	};

	const incoming = events
		.filter((event) => event.device !== localDevice)
		.map(typeSyncEvent)
		.filter((event): event is TypedSyncEvent => event !== undefined)
		.sort(compareEvents);

	for (const event of incoming) applyOne(work, event);
	for (const itemId of work.dirty) refold(work, itemId);

	return collect(state, work);
}

/* -------------------------------------------------------------------------- */
/* Per-type rules (§4)                                                         */
/* -------------------------------------------------------------------------- */

function applyOne(work: Working, event: TypedSyncEvent): void {
	switch (event.type) {
		case EVENT_TYPES.itemAdded: {
			const item = event.payload;
			// Dedupe key: the item id. A tombstone outranks a concurrent add —
			// deleting is rare and deliberate, so it wins (§4).
			if (work.tombstones.has(item.id) || work.items.has(item.id)) return;
			work.items.set(item.id, {
				...item,
				fsrsCard: newCardState(item.introducedAt),
				history: []
			});
			return;
		}

		case EVENT_TYPES.itemReviewed: {
			const { itemId, at, grade } = event.payload;
			// Dedupe key: `(itemId, at, device)`. Also dropped if a
			// `review-amended` already superseded this entry — that is the
			// out-of-order half of the amend rule.
			if (work.superseded.has(reviewKey(itemId, at, event.device))) return;
			insertReview(work, itemId, { at, grade, device: event.device });
			return;
		}

		case EVENT_TYPES.reviewAmended: {
			const { itemId, at, grade, replaces } = event.payload;
			const item = work.items.get(itemId);
			if (!item) return;
			if (replaces !== undefined) {
				// Remember the supersession *before* touching history, so the
				// original `item-reviewed` is dropped whichever order it arrives in.
				work.superseded.add(reviewKey(itemId, replaces, event.device));
				const without = item.history.filter(
					(entry) => !(entry.at === replaces && (entry.device ?? event.device) === event.device)
				);
				if (without.length !== item.history.length) {
					work.items.set(itemId, { ...item, history: without });
					work.dirty.add(itemId);
				}
			}
			// The re-grade itself replaces any entry with the same identity, so
			// re-delivery lands on the same value rather than stacking.
			insertReview(work, itemId, { at, grade, device: event.device }, true);
			return;
		}

		case EVENT_TYPES.itemUpdated: {
			const { itemId, fields } = event.payload;
			const item = work.items.get(itemId);
			if (!item) return;
			// Last-write-wins, decided against the *winning event's* key rather
			// than against arrival order — which is what makes an older patch
			// arriving in a later batch a no-op instead of a regression.
			const winner = work.itemUpdates.get(itemId);
			const key = keyOf(event);
			if (winner && compareKeys(key, winner) <= 0) return;
			work.itemUpdates.set(itemId, key);
			work.items.set(itemId, { ...item, ...definedOnly(fields) });
			return;
		}

		case EVENT_TYPES.itemDeleted: {
			// The tombstone is the dedupe key: it is permanent, so re-delivery
			// and any later add or review of the id are all no-ops.
			work.tombstones.add(event.payload.itemId);
			work.items.delete(event.payload.itemId);
			work.dirty.delete(event.payload.itemId);
			return;
		}

		case EVENT_TYPES.challengeAdded: {
			// Content is immutable, so the challenge id alone dedupes.
			const { challenge, generatedAt, topic } = event.payload;
			if (work.pool.has(challenge.id)) return;
			work.pool.set(challenge.id, {
				...(challenge as unknown as PoolRow),
				generatedAt,
				timesServed: 0,
				lastServedAt: null,
				reported: false,
				...(topic ? { topic } : {})
			});
			return;
		}

		case EVENT_TYPES.challengeServed: {
			// A serve leaves nothing behind but a number, so the event id is the
			// only honest dedupe key: `timesServed` is the count of *distinct*
			// applied serve events (§4 — exact, unlike a max-merge of counters).
			//
			// An orphan serve (challenge not here) is dropped *without* being
			// counted, so it would still apply if it were ever re-delivered
			// after its `challenge-added`. In practice it cannot happen: a
			// device can only serve a challenge it has, and per-device log order
			// survives the server's `seq`.
			if (work.counted.has(event.id)) return;
			const row = work.pool.get(event.payload.challengeId);
			if (!row) return;
			work.counted.add(event.id);
			work.pool.set(row.id, {
				...row,
				timesServed: row.timesServed + 1,
				lastServedAt: Math.max(row.lastServedAt ?? 0, event.at)
			});
			return;
		}

		case EVENT_TYPES.challengeReported: {
			// Sticky boolean: idempotent on its own, no key needed.
			const row = work.pool.get(event.payload.challengeId);
			if (!row || row.reported) return;
			work.pool.set(row.id, { ...row, reported: true });
			return;
		}

		case EVENT_TYPES.resultLogged: {
			// Two answers can be genuinely identical (same challenge, same typo,
			// same millisecond), so the log is a set-union by *event* id.
			if (work.counted.has(event.id)) return;
			work.counted.add(event.id);
			work.results = [...work.results, event.payload];
			return;
		}

		case EVENT_TYPES.profileUpdated: {
			// Whole-object LWW, same key comparison as `item-updated`.
			const key = keyOf(event);
			if (work.profileUpdate && compareKeys(key, work.profileUpdate) <= 0) return;
			work.profileUpdate = key;
			work.profile = event.payload;
			return;
		}
	}
}

/* -------------------------------------------------------------------------- */
/* History and cards                                                           */
/* -------------------------------------------------------------------------- */

type HistoryEntry = KnowledgeItem['history'][number];

/**
 * Inserts one review into an item's history, keyed by `(at, device)`.
 *
 * A matching entry means the review is already there: normally that is a
 * duplicate delivery and we leave it alone, but an amend (`replace`) is exactly
 * the case where the grade must be overwritten. Items under a tombstone, and
 * items this device has never heard of, are skipped — §4's "a review of a word
 * deleted elsewhere applies to nothing".
 */
function insertReview(work: Working, itemId: string, entry: HistoryEntry, replace = false): void {
	if (work.tombstones.has(itemId)) return;
	const item = work.items.get(itemId);
	if (!item) return;

	const index = item.history.findIndex(
		(existing) => existing.at === entry.at && (existing.device ?? entry.device) === entry.device
	);
	if (index >= 0) {
		if (!replace || item.history[index].grade === entry.grade) return;
		const history = [...item.history];
		history[index] = entry;
		work.items.set(itemId, { ...item, history });
	} else {
		work.items.set(itemId, { ...item, history: [...item.history, entry] });
	}
	work.dirty.add(itemId);
}

/**
 * Recomputes an item's card by replaying its whole merged history.
 *
 * Sorting by `(at, device)` before folding is what makes the result independent
 * of the order the reviews arrived in — the whole point of §2. Replaying from
 * `introducedAt` costs a few dozen `reviewCard` calls per touched item, which is
 * nothing next to being exact.
 */
function refold(work: Working, itemId: string): void {
	const item = work.items.get(itemId);
	if (!item) return;

	const history = [...item.history].sort(
		(a, b) => a.at - b.at || (a.device ?? '').localeCompare(b.device ?? '')
	);
	let card: FsrsCardState = newCardState(item.introducedAt);
	for (const entry of history) card = reviewCard(card, entry.grade as Grade, entry.at);

	work.items.set(itemId, { ...item, history, fsrsCard: card });
}

/** Drops `undefined`-valued keys so an absent patch field never blanks a set one. */
function definedOnly<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

/* -------------------------------------------------------------------------- */
/* Collect                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns the working copy back into a snapshot, **reusing `state`'s own arrays
 * wherever nothing changed**. The Dexie wrapper diffs by reference identity to
 * decide what to write, so that reuse is not a micro-optimization: it is how a
 * sync that lands three reviews writes three rows instead of the whole table.
 */
function collect(state: SyncSnapshot, work: Working): SyncSnapshot {
	const items = [...work.items.values()];
	const pool = [...work.pool.values()];

	// Sorted, not insertion-ordered: two devices that have applied the same
	// event set must hold byte-identical bookkeeping too, or "same state" would
	// depend on the order the pulls happened to arrive in.
	const bookkeeping: SyncBookkeeping = {
		countedEventIds: [...work.counted].sort(),
		tombstones: [...work.tombstones].sort(),
		supersededReviews: [...work.superseded].sort(),
		itemUpdates: Object.fromEntries([...work.itemUpdates].sort(([a], [b]) => a.localeCompare(b))),
		profileUpdate: work.profileUpdate
	};

	return {
		items: sameRows(state.items, items) ? state.items : items,
		pool: sameRows(state.pool, pool) ? state.pool : pool,
		results: work.results,
		profile: work.profile,
		bookkeeping
	};
}

/** True when two row arrays hold the same objects, by reference, in the same order. */
function sameRows<T>(before: T[], after: T[]): boolean {
	return before.length === after.length && before.every((row, index) => row === after[index]);
}

/* -------------------------------------------------------------------------- */
/* Dexie wrapper (thin, untested — the logic above is where the tests are)     */
/* -------------------------------------------------------------------------- */

/**
 * Applies a pulled batch to local state.
 *
 * Goes through `mergeSyncSnapshot`, which loads, folds and writes back inside
 * one transaction and touches the outbox not at all — so nothing pulled can
 * ever be pushed back out (see the note at the top of `$lib/db/repositories`).
 */
export async function applyRemoteBatch(events: SyncEvent[]): Promise<void> {
	if (events.length === 0) return;
	const device = getDeviceId();
	await mergeSyncSnapshot((before) => applyEvents(before, events, device));
}
