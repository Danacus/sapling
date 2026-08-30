/**
 * Asking the sync backend whether this device could connect.
 *
 * A stub while the sync client is being rewritten: there is no backend to ask
 * yet, so every answer is "unreachable".
 */

/** Where the probe got to, in the learner's terms. */
export type SyncProbeResult =
	| { ok: true; message: string }
	| { ok: false; reason: 'rejected' | 'unreachable' | 'unexpected'; message: string };

export async function probeSync(_url: string, _phrase: string): Promise<SyncProbeResult> {
	return {
		ok: false,
		reason: 'unreachable',
		message: 'Sync is not connected in this build.'
	};
}
