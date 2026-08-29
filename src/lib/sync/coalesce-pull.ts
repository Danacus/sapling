/**
 * Merging pulled pages before LiveStore sees them, because it rebases per page.
 *
 * This is the fix for a catch-up that took an hour. When a device has diverged
 * — local events the server has not got — every pulled page makes the leader
 * roll the *entire* pending queue back and replay it on top of the new events.
 * `syncstate.ts:232` is where that is decided: a rebase's `newEvents` is
 * `[...payload.newEvents, ...rebasedPending]`, and `onNewPullChunk` then
 * rolls back `N` changesets and re-materialises `N + page` events.
 *
 * So applying `M` remote events with `N` pending costs roughly
 * `(M / page) × (2N + page)` event-operations, and each of those is not one
 * statement: `materialize-event.ts` opens a SQLite session, runs the
 * materializer, serialises a changeset blob, writes it to a meta table and
 * appends to the eventlog — across two OPFS databases.
 *
 * The `M / page` factor is the waste. The server pages at
 * `MAX_PULL_EVENTS_PER_MESSAGE = 100`, so catching up 7,000 events means
 * rebasing the same pending queue seventy times and writing rollback data for
 * events that the next page will roll back again. Nobody ever observes the
 * sixty-nine intermediate states. Merging pages before handing them over
 * divides that factor by however many we merge, and changes nothing else:
 * the events keep their order, their sequence numbers and their metadata, and
 * the merge rules are untouched.
 *
 * It cannot remove the `2N` term. Rebasing a diverged device is required —
 * its events' parents genuinely do not match the server's head, which is what
 * divergence *is*. Rebasing seventy times is not.
 */
import type { SyncBackend } from '@livestore/common';
import { Effect, Option, Stream } from '@livestore/utils/effect';

/**
 * How many events to gather before handing a batch to the leader.
 *
 * The trade-off is one long transaction against many short ones. Larger is
 * cheaper overall — the `2N` rollback-and-replay term dominates and is paid
 * once per batch rather than once per event — but `materializeEventsBatch`
 * runs uninterruptibly, so an over-large value trades a slow catch-up for an
 * unresponsive one, and the buffer is held in memory (a `challengeAdded`
 * payload is ~12KB, so a thousand of them is ~12MB).
 *
 * 1000 is ten pages, so it cuts the rebase count by 10× while keeping a batch
 * well inside a size the leader already handles.
 *
 * **Measured** (node adapter against a local Worker, 3000 remote events with
 * 800 pending — the diverged case): 44.7s at one batch per page, 9.3s at 1000,
 * a **4.8× saving**. That tracks the model — 30 × (2·800 + 100) ≈ 51,000
 * event-operations against 3 × (2·800 + 1000) ≈ 7,800 — with the shortfall
 * from the predicted 6.5× being fixed overhead. Node's per-event cost is well
 * below OPFS's, so this understates the browser saving.
 *
 * There is more on the table: the floor is one batch, ≈4,600 operations. It is
 * not taken because `materializeEventsBatch` is uninterruptible, and a device
 * catching up should be slow rather than frozen.
 */
export const COALESCE_TARGET = 1000;

type Item<TMeta> = SyncBackend.PullResItem<TMeta>['batch'][number];

/**
 * Merges consecutive pull responses until `target` events have accumulated.
 *
 * Flushes early — and always — on a `NoMore` page, so this is safe under a
 * live pull too: a poll that returns three events is not held back waiting for
 * a thousand that will never come. The pending batch is also flushed when the
 * source stream ends.
 *
 * A failing source drops whatever is still buffered, which is correct rather
 * than lossy: those events were never handed to the leader, so its cursor has
 * not advanced past them and the retry re-pulls them. Only whole contiguous
 * prefixes are ever emitted.
 */
export const coalescePullStream =
	(target: number = COALESCE_TARGET) =>
	<TMeta, E, R>(
		stream: Stream.Stream<SyncBackend.PullResItem<TMeta>, E, R>
	): Stream.Stream<SyncBackend.PullResItem<TMeta>, E, R> =>
		stream.pipe(
			// `mapAccum` cannot emit anything when the stream ends, so the end is
			// modelled as a value: `None` is the signal to flush what is left.
			Stream.map(Option.some<SyncBackend.PullResItem<TMeta>>),
			Stream.concat(Stream.make(Option.none<SyncBackend.PullResItem<TMeta>>())),
			Stream.mapAccum(
				[] as Item<TMeta>[],
				(buffer, incoming): readonly [Item<TMeta>[], SyncBackend.PullResItem<TMeta>[]] => {
					if (Option.isNone(incoming)) {
						return buffer.length === 0
							? [[], []]
							: [[], [{ batch: buffer, pageInfo: { _tag: 'NoMore' } }]];
					}

					const { batch, pageInfo } = incoming.value;
					// Pages are at most 100 events, so spreading into `push` stays well
					// inside the argument limit and avoids re-copying the buffer.
					buffer.push(...batch);

					// An empty `NoMore` response is how the backend says "nothing at
					// all"; it has to reach the leader, which uses it to release the
					// pull mutex. Passing the buffer through unchanged handles both
					// that case and a final partial batch.
					if (pageInfo._tag === 'NoMore' || buffer.length >= target) {
						return [[], [{ batch: buffer, pageInfo }]];
					}

					return [buffer, []];
				}
			),
			Stream.flattenIterables
		);

/**
 * Wraps a sync backend so its `pull` merges pages. Everything else is passed
 * through untouched — this is a stream transform, not a new backend.
 */
export const withCoalescedPull =
	<TMeta, TPayload>(
		make: SyncBackend.SyncBackendConstructor<TMeta, TPayload>,
		target: number = COALESCE_TARGET
	): SyncBackend.SyncBackendConstructor<TMeta, TPayload> =>
	(args) =>
		Effect.map(make(args), (backend) => ({
			...backend,
			pull: (...pullArgs: Parameters<typeof backend.pull>) =>
				coalescePullStream(target)(backend.pull(...pullArgs))
		}));
