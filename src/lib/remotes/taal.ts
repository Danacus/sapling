/**
 * Taal as a remote: send-only. Its outcome maps onto the runner's shape here,
 * so `$lib/taal` keeps speaking its own: `sent` is what went out, nothing ever
 * comes down, and a refusal or failure is `ok: false` with Taal's own line.
 */
import { getTaalCode, pushTaal, type TaalRun } from '$lib/taal';
import type { Remote, RemoteOutcome } from './types';

export function taalOutcome(run: TaalRun): RemoteOutcome {
	if (!run) {
		// No code, or no profile yet: nothing to push as.
		return { ok: true, skipped: true, pushed: 0, pulled: 0, summary: 'Taal is not connected.' };
	}
	return { ok: run.status === 'ok', pushed: run.sent, pulled: 0, summary: run.message };
}

export const taalRemote: Remote<'taal'> = {
	id: 'taal',
	pulls: false,
	configured: () => getTaalCode() !== undefined,
	run: async () => taalOutcome(await pushTaal())
};
