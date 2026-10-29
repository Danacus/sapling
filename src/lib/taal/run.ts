/**
 * The host's half of Taal: when, with which code, for which profile, and what
 * Settings remembers. The push itself is Rust's (`core.ts`): the window of
 * sessions to read, the request, batching and what a response means.
 *
 * **One push at a time, and none lost.** `pushTaal` is single flight
 * (`$lib/remotes/flight`): a trigger while a push runs queues exactly one more
 * behind it, and every later trigger joins that one — the second push sees
 * whatever the first could not. A push is a no-op without a code or a
 * profile, and it never throws: Taal is a leaderboard, so a failure is a line
 * in Settings and nothing anywhere else.
 *
 * *When* to push is not this module's: the triggers call `$lib/remotes`'
 * `syncRemotes`, which runs Taal after sync — so another device's study time,
 * once pulled, goes out on the same trigger.
 */
import { ready } from '$lib/db/backend';
import type { TaalOutcome } from '$lib/db/generated/index';
import { singleFlight } from '$lib/remotes/flight';
import {
	getPushedThrough,
	getTaalCode,
	recordTaalOutcome,
	setPushedThrough,
	type TaalRecord
} from './config';
import { callTaal } from './core';

/** What one push did; `undefined` when there was nothing to push as (no code, no profile). */
export type TaalRun = TaalOutcome | undefined;

const push = singleFlight(pushNow);

/** Pushes now, or after the push already running. `fetchImpl` is for tests. */
export function pushTaal(fetchImpl: typeof fetch = fetch): Promise<TaalRun> {
	return push(fetchImpl);
}

async function activeProfile(): Promise<string | undefined> {
	const backend = await ready();
	return (await backend.listProfiles()).find((profile) => profile.active)?.id;
}

async function pushNow(fetchImpl: typeof fetch): Promise<TaalRun> {
	const code = getTaalCode();
	if (!code) return undefined;
	let outcome: TaalOutcome;
	try {
		const profile = await activeProfile();
		if (!profile) return undefined;
		const pushedThrough = getPushedThrough(code, profile);
		outcome = await callTaal(
			'pushTaal',
			{ code, profile, now: Date.now(), ...(pushedThrough === undefined ? {} : { pushedThrough }) },
			fetchImpl
		);
		// A code changed or cleared mid-push: this outcome is about a code
		// nobody holds any more, and its watermark must not land on the new one.
		if (getTaalCode() !== code) return outcome;
		if (outcome.status === 'ok' && outcome.pushedThrough !== undefined) {
			setPushedThrough(code, profile, outcome.pushedThrough);
		}
	} catch (error) {
		// The store failed to open: the push never started.
		const message = error instanceof Error && error.message ? error.message : 'Taal push failed.';
		outcome = { status: 'failed', sent: 0, message };
	}
	record(outcome);
	return outcome;
}

function record(outcome: TaalOutcome): void {
	const entry: Omit<TaalRecord, 'okAt'> = {
		at: Date.now(),
		status: outcome.status,
		message: outcome.message
	};
	recordTaalOutcome(entry);
}
