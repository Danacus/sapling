/**
 * The LiveStore leader worker — and the one place sync is turned on.
 *
 * The web adapter runs SQLite on a dedicated worker (plus a shared worker for
 * cross-tab election), and Vite needs that to be its own module imported with
 * `?worker`; see `adapter.ts`. The sync backend is configured *here* rather
 * than beside the store, because the leader is the only thread that talks to
 * the network — every tab's writes funnel through it, so a browser makes one
 * set of sync requests no matter how many tabs are open.
 *
 * The backend is chosen per store, from two inputs:
 *
 * - `SYNC_URL`, baked in at build time. Absent — the default — and no backend
 *   is ever constructed. This build is then the single-device app it has always
 *   been, with no network code reachable at all.
 * - `args.payload`, passed down from the window when the store is created.
 *   `undefined` means the learner has sync switched off, and `offline-backend.ts`
 *   explains at length why that is a real backend reporting offline rather than
 *   a no-op that pretends to succeed.
 *
 * Both error policies are deliberate, and both choose the learner's data over
 * the convenience of a clean slate:
 *
 * - `onSyncError: 'ignore'` is `docs/sync.md` §1 — sync failures degrade
 *   silently, the app stays fully usable, and a server that is down or gone is
 *   indistinguishable from being offline. It is the audio layer's rule applied
 *   to networking.
 * - `onBackendIdMismatch: 'ignore'` overrides a default of `'reset'`, which
 *   **clears the local eventlog and state databases**. That default is written
 *   for development, where the backend is wiped often and the client's data is
 *   disposable. Here it is the opposite way round: the local store is the
 *   learner's only copy of everything they have learned, and a Durable Object
 *   that was reset — or a phrase retyped as a different one — must never be
 *   able to delete it. Ignoring means such a client keeps its data and stops
 *   converging, which is visible, survivable, and recoverable by hand.
 */
import { makeWorker } from '@livestore/adapter-web/worker';
import { makeHttpSync } from '@livestore/sync-cf/client';

import { withCoalescedPull } from '$lib/sync/coalesce-pull';
import { withResilientConnect } from '$lib/sync/liveness';
import { offlineSyncBackend } from '$lib/sync/offline-backend';
import { SyncPayload } from '$lib/sync/payload';
import { SYNC_URL } from '$lib/sync/url';

import { schema } from './schema';

/**
 * Built once per worker, not per store: the URL cannot change at runtime.
 *
 * **`isConnected` is a gate, not a status readout**, and getting that wrong
 * broke sync completely for a day. The leader waits on it before processing a
 * pulled batch (`LeaderSyncProcessor.ts:831`) and before every push (`:869`,
 * `:873`); `makeHttpSync` starts it `false` and sets it `true` in exactly one
 * place, after a successful `Ping`. So whether a device syncs at all comes down
 * to whether one request worked — and on a freshly paired device that request
 * is the first cross-origin POST, preflight included, against a cold Durable
 * Object. It is the likeliest request in the whole session to be slow.
 *
 * This file previously passed `ping: { enabled: false }` to avoid a ping every
 * ten seconds (~8,600 requests a day per open tab). That removed the only way
 * the flag could ever recover. Worse, the failure is invisible from every side:
 * a ping that takes over ten seconds raises `TimeoutException`, which
 * `makeHttpSync` *catches*, sets `isConnected: false`, and then **succeeds** —
 * so nothing logs, nothing errors, and the device never syncs again.
 *
 * Both halves are needed, and neither substitutes for the other:
 *
 * - `withResilientConnect` retries the initial connect, because `Effect.repeat`
 *   stops on a hard failure and would not save a device whose first ping failed
 *   outright.
 * - a ping every minute recovers a device that *was* connected and later was
 *   not. A minute rather than ten seconds keeps it at ~1,400 requests a day,
 *   which is a liveness check rather than a poll for data — the pull cadence is
 *   still `livePull: false` below.
 */
const httpSync =
	SYNC_URL === undefined
		? undefined
		: // `withCoalescedPull` is why a device that has been away for a while
			// catches up in minutes rather than an hour. The backend pages at 100
			// events and LiveStore rebases the *entire* pending queue on every page,
			// so merging pages before it sees them divides that cost directly. See
			// `$lib/sync/coalesce-pull` for the arithmetic.
			withCoalescedPull(
				withResilientConnect(makeHttpSync({ url: SYNC_URL, ping: { requestInterval: 60_000 } }))
			);

makeWorker({
	schema,
	syncPayloadSchema: SyncPayload,
	sync: {
		backend: (args) =>
			httpSync !== undefined && args.payload !== undefined
				? httpSync(args)
				: offlineSyncBackend(args),
		onSyncError: 'ignore',
		onBackendIdMismatch: 'ignore',
		/**
		 * Sync at boot, and only at boot.
		 *
		 * `livePull: true` (the default) asks the backend for a reactive stream.
		 * Over HTTP `makeHttpSync` has no such thing and emulates it by polling
		 * every five seconds, which is the wrong shape for a language app used in
		 * sessions. `false` makes the leader pull the backlog once, when the store
		 * opens, and then stop. Pushing is unaffected and stays event-driven: the
		 * push loop blocks on an empty queue, so a device that writes nothing
		 * sends nothing.
		 *
		 * So a device catches up when the app starts. Its own writes leave
		 * immediately and are confirmed by the server, which was measured rather
		 * than assumed — a push advances `upstreamHead` and drains `pending` with
		 * no pull stream open at all.
		 */
		livePull: false
	}
});
