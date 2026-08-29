/**
 * `isConnected` gates every pull and every push, so a `connect` that gives up
 * is a device that silently never syncs again.
 *
 * The schedules here recur without delay, so the retry behaviour is asserted
 * without a clock and without wall time. The production schedule's backoff is a
 * separate concern from whether it retries at all.
 */
import { SyncBackend, UnknownError } from '@livestore/common';
import { Effect, Schedule, Stream, SubscriptionRef } from '@livestore/utils/effect';
import { describe, expect, it } from 'vitest';

import { withResilientConnect } from './liveness';

type Fake = SyncBackend.SyncBackendConstructor<never, unknown>;

/** A backend whose `connect` fails `failures` times before succeeding. */
const flakyBackend = (failures: number) => {
	let attempts = 0;

	const make = (() =>
		Effect.gen(function* () {
			const isConnected = yield* SubscriptionRef.make(false);
			return {
				connect: Effect.suspend(() => {
					attempts += 1;
					return attempts <= failures
						? Effect.fail(new UnknownError({ cause: 'nope' }))
						: SubscriptionRef.set(isConnected, true);
				}),
				pull: () => Stream.never,
				push: () => Effect.void,
				ping: Effect.void,
				isConnected,
				metadata: { name: 'flaky', description: 'test' },
				supports: { pullPageInfoKnown: true, pullLive: false }
			};
		})) as unknown as Fake;

	return { make, attempts: () => attempts };
};

// The fake needs none of the constructor's real requirements, so the run site
// is where the pretence is dropped rather than smearing casts through the tests.
const run = <A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> =>
	Effect.runPromise(Effect.scoped(effect) as Effect.Effect<A>);

describe('withResilientConnect', () => {
	it('keeps trying until the backend answers', async () => {
		const flaky = flakyBackend(3);
		const wrapped = withResilientConnect(flaky.make, Schedule.recurs(10));

		const connected = await run(
			Effect.gen(function* () {
				const backend = yield* wrapped({ storeId: 'sapling', clientId: 'a', payload: undefined });
				yield* backend.connect.pipe(Effect.orDie);
				return yield* backend.isConnected;
			})
		);

		expect(connected).toBe(true);
		expect(flaky.attempts()).toBe(4); // three failures, then success
	});

	it('gives up only when the schedule is exhausted, leaving isConnected false', async () => {
		// The failure this guards: an exhausted schedule is what the unwrapped
		// backend does on attempt one, and it is why a device can never sync
		// again without a relaunch.
		const flaky = flakyBackend(99);
		const wrapped = withResilientConnect(flaky.make, Schedule.recurs(2));

		const connected = await run(
			Effect.gen(function* () {
				const backend = yield* wrapped({ storeId: 'sapling', clientId: 'a', payload: undefined });
				yield* backend.connect.pipe(Effect.ignore);
				return yield* backend.isConnected;
			})
		);

		expect(connected).toBe(false);
		expect(flaky.attempts()).toBe(3); // initial attempt plus two retries
	});

	it('does not retry a connect that works first time', async () => {
		const flaky = flakyBackend(0);
		const wrapped = withResilientConnect(flaky.make, Schedule.recurs(10));

		await run(
			Effect.gen(function* () {
				const backend = yield* wrapped({ storeId: 'sapling', clientId: 'a', payload: undefined });
				yield* backend.connect.pipe(Effect.orDie);
			})
		);

		expect(flaky.attempts()).toBe(1);
	});

	it('leaves the rest of the backend alone', async () => {
		const flaky = flakyBackend(0);
		const wrapped = withResilientConnect(flaky.make);

		const same = await run(
			Effect.gen(function* () {
				const backend = yield* wrapped({ storeId: 'sapling', clientId: 'a', payload: undefined });
				return backend.metadata.name === 'flaky' && backend.supports.pullLive === false;
			})
		);

		expect(same).toBe(true);
	});
});
