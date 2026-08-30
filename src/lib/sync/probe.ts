/**
 * Asking the sync backend whether this device could connect.
 *
 * Sync's failure mode is silence — the app is built to keep working when the
 * backend is gone — so a refused phrase and a healthy connection look identical
 * from Settings unless something goes and looks. An empty pull is the cheapest
 * request that exercises the whole path: routing, the bearer phrase, the room.
 */

/** Where the probe got to, in the learner's terms. */
export type SyncProbeResult =
	| { ok: true; message: string }
	| { ok: false; reason: 'rejected' | 'unreachable' | 'unexpected'; message: string };

export async function probeSync(
	url: string,
	phrase: string,
	fetchImpl: typeof fetch = fetch
): Promise<SyncProbeResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${url}/pull?after=0&limit=0`, {
			headers: { Authorization: `Bearer ${phrase}` }
		});
	} catch {
		return { ok: false, reason: 'unreachable', message: 'Could not reach the sync server.' };
	}

	if (response.ok) return { ok: true, message: 'Connected to the sync server.' };
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			reason: 'rejected',
			message: 'The sync server did not accept this pairing phrase.'
		};
	}
	return {
		ok: false,
		reason: 'unexpected',
		message: `The sync server answered with ${response.status}.`
	};
}
