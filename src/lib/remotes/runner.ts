/**
 * One pass over the remotes, in the order that makes a single trigger enough.
 *
 * Pullers first: what another device did lands here before anything is sent
 * onward, so a send-only remote (Taal) carries those hours in the same pass —
 * the reason `onSyncPulled` used to exist. The send-only ones run after the
 * pullers whether or not anything came down, because the trigger itself
 * usually means local data changed (a session ended, a text was closed).
 *
 * A remote that is not set up costs nothing; one that fails or throws costs
 * itself, never the others, and the pass never rejects — remotes are optional,
 * and a trigger is always fire-and-forget.
 */
import { singleFlight } from './flight';
import type { Remote, RemoteOutcome } from './types';

async function runOne(remote: Remote): Promise<RemoteOutcome | undefined> {
	try {
		return await remote.run();
	} catch {
		return undefined;
	}
}

/** One pass: configured pullers, then configured senders. Never throws. */
export async function runRemotes(remotes: readonly Remote[]): Promise<void> {
	const configured = remotes.filter((remote) => {
		try {
			return remote.configured();
		} catch {
			return false;
		}
	});
	await Promise.all(configured.filter((remote) => remote.pulls).map(runOne));
	await Promise.all(configured.filter((remote) => !remote.pulls).map(runOne));
}

/**
 * The trigger over `remotes`: one pass, single flight, so a burst of triggers
 * is at most the pass running and one more behind it.
 */
export function remoteTrigger(remotes: readonly Remote[]): () => Promise<void> {
	return singleFlight(() => runRemotes(remotes));
}
