/**
 * The remotes: every optional external service, behind one trigger.
 *
 * Pages and the layout call `syncRemotes()` at the moments worth spending a
 * round trip on — boot, the tab hidden or shown, a practice summary, leaving
 * a text — and never name a service. Which remotes are set up, what order they
 * run in and how overlapping triggers coalesce is this module's
 * (`runner.ts`, `flight.ts`). Each service keeps its own module (`$lib/sync`,
 * `$lib/taal`), which knows nothing of the other; the adapters here map each
 * one's outcome onto `RemoteOutcome`.
 *
 * Settings still calls a remote directly ("Sync now", connecting Taal), and
 * the layout calls `REMOTES.sync` alone where it needs the pull itself — the
 * profile of a device that just joined a library.
 */
import { remoteTrigger } from './runner';
import { syncRemote } from './sync';
import { taalRemote } from './taal';
import type { Remote, RemoteId } from './types';

/** Keyed by `RemoteId`, so a remote named there and missing here fails `pnpm check`. */
export const REMOTES: { readonly [Id in RemoteId]: Remote<Id> } = {
	sync: syncRemote,
	taal: taalRemote
};

/**
 * Runs every configured remote: pullers first, then the send-only ones.
 * Single flight, never throws, never worth awaiting on a render path.
 */
export const syncRemotes: () => Promise<void> = remoteTrigger(Object.values(REMOTES));

export type { Remote, RemoteId, RemoteOutcome } from './types';
