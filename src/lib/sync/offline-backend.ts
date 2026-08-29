/**
 * The sync backend used when the learner has sync turned off.
 *
 * LiveStore decides whether to sync when the leader worker builds the store,
 * and the leader worker is a separate bundle with no `localStorage` to consult.
 * What it *does* get is the sync payload, passed down from the window at store
 * creation — so "sync is off" reaches it as `payload === undefined`, and this
 * module is what it returns in that case. A `SyncBackendConstructor` has to
 * return a backend; there is no "return nothing" to fall back on.
 *
 * **`push` refuses, and that is the point.** The tempting alternative — a
 * backend whose `push` quietly succeeds — is a trap: LiveStore would mark those
 * events as confirmed by a backend that has never seen them, and the first day
 * the learner turned sync *on* the client would arrive with a cursor describing
 * a log the server does not have. Refusing leaves the events exactly where they
 * belong, pending, and if sync is turned on later they push in order like any
 * other backlog. `IsOfflineError` is LiveStore's own vocabulary for it, the
 * state the whole local-first design is built to absorb; paired with
 * `onSyncError: 'ignore'` in `livestore.worker.ts` it degrades exactly the way
 * a flaky network does, silently. That is the audio layer's rule (`content.md`)
 * applied to networking, and the one `docs/sync.md` §1 set out.
 *
 * **`pull` must not fail, though — it must never emit.** This was measured, not
 * assumed: a `pull` that fails with `IsOfflineError` hangs store creation
 * outright, so the app never boots. A failing `connect` is harmless, and `push`
 * and `ping` may fail freely; `pull` is the one operation the leader will wait
 * on forever. `Stream.never` says the honest thing anyway — no event will ever
 * arrive from a backend that isn't there — and it costs no retry loop.
 * If you change any of these four, re-check that a store still boots.
 */
import { IsOfflineError, SyncBackend } from '@livestore/common';
import { Effect, Stream, SubscriptionRef } from '@livestore/utils/effect';

const offline = () => new IsOfflineError({ cause: 'Sync is turned off on this device' });

/**
 * A backend that is permanently, deliberately unreachable.
 *
 * `metadata` is surfaced in LiveStore's devtools, so it says why rather than
 * looking like a backend that is merely down.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see below
type AnyMetadata = any;

/**
 * The metadata parameter is `any` to match LiveStore's own
 * `SyncBackendConstructor<any, …>`. A backend that never emits an event has no
 * metadata to describe, but `never` does not unify with the WebSocket backend's
 * metadata where `livestore.worker.ts` picks between the two — `pull` takes its
 * cursor as a parameter, so the type is invariant there.
 */
export const offlineSyncBackend: SyncBackend.SyncBackendConstructor<AnyMetadata, unknown> = () =>
	Effect.gen(function* () {
		const isConnected = yield* SubscriptionRef.make(false);

		return SyncBackend.of<AnyMetadata>({
			// Nothing to prepare, so `connect` succeeds rather than performing a
			// failure the caller would only have to absorb.
			connect: Effect.void,
			pull: () => Stream.never,
			push: () => Effect.fail(offline()),
			ping: Effect.fail(offline()),
			isConnected,
			metadata: {
				name: 'offline',
				description: 'Sync is turned off on this device.'
			},
			supports: { pullPageInfoKnown: true, pullLive: false }
		});
	});
