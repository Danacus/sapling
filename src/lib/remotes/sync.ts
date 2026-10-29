/**
 * Sync as a remote: the one that pulls. `runSync` already answers the
 * runner's shape, less the `message` only Settings' pairing reads.
 */
import { isSyncConfigured, runSync } from '$lib/sync';
import type { Remote } from './types';

export const syncRemote: Remote<'sync'> = {
	id: 'sync',
	pulls: true,
	configured: isSyncConfigured,
	async run() {
		const { ok, skipped, pushed, pulled, summary } = await runSync();
		return { ok, ...(skipped ? { skipped } : {}), pushed, pulled, summary };
	}
};
