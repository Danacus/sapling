/**
 * The total order `docs/sync.md` §4 mandates: `(at, device, id)`.
 *
 * LiveStore supplies an order of its own — the eventlog sequence, with local
 * events rebased onto remote ones — and that order is *not* this one. Where a
 * merge rule is genuinely order-sensitive (the two last-write-wins rules), the
 * materializer therefore decides the winner by comparing this key against the
 * winner it already recorded, exactly as `sync/apply.ts` does with its
 * `itemUpdates` / `profileUpdate` bookkeeping. That keeps the outcome a
 * function of the event *set* rather than of the order LiveStore happened to
 * materialize it in — which is what makes the result survive a rebase.
 *
 * The tie-breaks carry no meaning (§4). They exist so two devices holding the
 * same events agree on the winner.
 */

/** The `(at, device, id)` triple that identifies one event for ordering. */
export interface EventKey {
	at: number;
	device: string;
	id: string;
}

/** Negative when `a` sorts before `b`. Mirrors `compareKeys` in `sync/apply.ts`. */
export function compareEventKeys(a: EventKey, b: EventKey): number {
	return a.at - b.at || a.device.localeCompare(b.device) || a.id.localeCompare(b.id);
}

/**
 * True when `candidate` should displace `winner`.
 *
 * A `null` winner means nothing has claimed the field yet. Equality loses, so
 * re-delivering the winning event is a no-op rather than a rewrite.
 */
export function beats(candidate: EventKey, winner: EventKey | null): boolean {
	return winner === null || compareEventKeys(candidate, winner) > 0;
}

/**
 * Identity of one history entry: `(itemId, at, device)` (§4).
 *
 * This is the `reviews` primary key rather than the originating event id.
 * §4 dedupes history by this triple, not by event — two devices that recorded
 * the same review must collapse to one entry even though their events differ.
 */
export function reviewKey(itemId: string, at: number, device: string): string {
	return `${itemId}|${at}|${device}`;
}
