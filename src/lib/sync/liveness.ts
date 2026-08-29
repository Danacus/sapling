/**
 * Keeping `isConnected` recoverable, because everything is gated on it.
 *
 * `SyncBackend.isConnected` looks like a status readout and is actually a
 * **gate**. The leader waits on it before processing a pulled batch
 * (`LeaderSyncProcessor.ts:831`) and before every push (`:869`, `:873`), and
 * with `onSyncError: 'ignore'` a device stuck behind it does nothing, reports
 * nothing, and looks exactly like a device with nothing to sync.
 *
 * `makeHttpSync` starts it `false` and sets it `true` in one place only: after
 * a successful `Ping`. So the question that decides a whole session is "did the
 * first ping work", and on a freshly paired device that ping is the very first
 * cross-origin POST — preflight included — against a cold Durable Object. It is
 * the single most likely request to be slow.
 *
 * Two ways it goes wrong, and the second is the nasty one:
 *
 * - the ping **fails** — mapped to `UnknownError`, so `connect` fails and the
 *   forked fiber dies with a log nobody reads;
 * - the ping **takes more than ten seconds** — `TimeoutException` is *caught*,
 *   `isConnected` is set `false`, and `ping` then **succeeds**. Nothing
 *   anywhere reports a problem, and the device never syncs again.
 *
 * This wrapper retries `connect` until it works, which turns both into a delay
 * instead of a silent, permanent stall. It is deliberately not "set
 * `isConnected` to true and hope": the flag should mean the backend answered.
 *
 * The repeating ping in `livestore.worker.ts` is the other half — it recovers a
 * device that was connected and later was not. Neither replaces the other:
 * `Effect.repeat` stops on a hard failure, so the repeat alone would not save a
 * device whose first ping failed outright.
 */
import type { SyncBackend } from '@livestore/common';
import { Duration, Effect, Schedule } from '@livestore/utils/effect';

/**
 * How hard to keep trying the initial connection.
 *
 * Exponential from a second, capped at thirty, forever. Forever is the point:
 * the alternative is a device that gave up before the network came back and
 * will not try again until the app is relaunched. One request per interval at
 * worst, and it stops as soon as the backend answers.
 */
const CONNECT_SCHEDULE = Schedule.exponential(Duration.seconds(1)).pipe(
	Schedule.modifyDelay((_, delay) => Duration.min(delay, Duration.seconds(30)))
);

/**
 * Wraps a sync backend so its `connect` retries instead of giving up.
 *
 * Everything else is passed through untouched.
 */
export const withResilientConnect =
	<TMeta, TPayload>(
		make: SyncBackend.SyncBackendConstructor<TMeta, TPayload>,
		schedule: Schedule.Schedule<unknown> = CONNECT_SCHEDULE
	): SyncBackend.SyncBackendConstructor<TMeta, TPayload> =>
	(args) =>
		Effect.map(make(args), (backend) => ({
			...backend,
			connect: Effect.retry(backend.connect, schedule)
		}));
