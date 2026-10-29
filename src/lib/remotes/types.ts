/**
 * A remote is an optional external service this device talks to — the sync
 * relay, the Taal leaderboard. Each keeps its own setup, credentials and
 * Settings card; what they share is *when* they run, so that part has one
 * shape and one trigger (`syncRemotes`), and no page names a service.
 */

/** Every remote, by name. The registry is keyed by this, so an unlisted one fails `pnpm check`. */
export type RemoteId = 'sync' | 'taal';

/** What one run did, in the one shape the runner reads. Never a rejection. */
export interface RemoteOutcome {
	ok: boolean;
	/** Nothing ran: the remote is not set up here. Not a failure. */
	skipped?: boolean;
	/** What went out. */
	pushed: number;
	/** What came down and is now in this device's reads. Always 0 for a send-only remote. */
	pulled: number;
	/** One learner-facing line. */
	summary: string;
}

export interface Remote<Id extends RemoteId = RemoteId> {
	id: Id;
	/**
	 * Whether it brings events down. Pullers run first, so a send-only remote
	 * sees what another device did in the same pass.
	 */
	pulls: boolean;
	/** Set up on this device — cheap, synchronous, no network. */
	configured(): boolean;
	/** One run, single flight, never throwing (the runner guards it anyway). */
	run(): Promise<RemoteOutcome>;
}
