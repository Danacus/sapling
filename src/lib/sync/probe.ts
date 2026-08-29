/**
 * Asking the sync backend whether this device could connect, and saying why not.
 *
 * This exists because of how sync fails. `onSyncError: 'ignore'` is the right
 * policy — the app must stay usable when the network is gone — but it means
 * every failure looks identical from the inside: nothing happens, forever. A
 * learner whose phrase is rejected sees exactly what a learner with no internet
 * sees, which is nothing at all.
 *
 * So the diagnosis is a deliberate, separate request rather than something
 * inferred from the sync engine's silence. It sends the same credential to the
 * same endpoint the real connection uses, and reads the status code:
 *
 * - **426** — the phrase was accepted. `handleSyncRequest` checks the pairing
 *   phrase first and the `Upgrade:` header second, so a 426 is proof that the
 *   URL is a real deployment *and* that authorisation passed, which is exactly
 *   what this can usefully establish.
 *
 *   The request asks for `transport=ws` even though the app now syncs over
 *   HTTP, and that is deliberate rather than left over: 426 is a distinctive
 *   sentinel produced before any transport is dispatched, whereas the HTTP
 *   endpoint answers a bare `GET` with **200** — indistinguishable from the
 *   root health check, which is the one status this must never read as
 *   success (`probe.test.ts` pins that). It has never proved a handshake
 *   completes, under either transport.
 * - **401** — the phrase was refused, either because it is malformed or because
 *   the deployment has a `SYNC_ALLOWED_PHRASES` allow-list it is not on. The
 *   Worker deliberately does not say which, so neither does this.
 * - **anything else, or a thrown fetch** — the backend was not reachable at all.
 *
 * It reports no more than attempting a real connection would, so it opens no
 * door: every answer here is one any client could get by trying to sync.
 */

/** Where the probe got to, in the learner's terms. */
export type SyncProbeResult =
	| { ok: true; message: string }
	| { ok: false; reason: 'rejected' | 'unreachable' | 'unexpected'; message: string };

/**
 * Turns a status code into a verdict.
 *
 * Split out from the request so the mapping can be tested without a network:
 * this is the part that carries the meaning, and the part most likely to drift
 * if the Worker's replies ever change.
 */
export function interpretProbe(status: number): SyncProbeResult {
	if (status === 426) {
		return { ok: true, message: 'Connected. This device can sync.' };
	}
	if (status === 401) {
		return {
			ok: false,
			reason: 'rejected',
			message:
				'The server refused this pairing phrase. Check it matches your other device exactly, ' +
				'and that it is on the server’s allowed list.'
		};
	}
	return {
		ok: false,
		reason: 'unexpected',
		message: `The sync server answered unexpectedly (${status}).`
	};
}

/**
 * Probes `url` with `phrase`, reporting whether a real connection would work.
 *
 * Never throws: a probe that failed is itself the answer, and the caller is a
 * settings page that must keep rendering.
 */
export async function probeSync(url: string, phrase: string): Promise<SyncProbeResult> {
	// `storeId` is the constant every client sends (the Worker derives the real
	// room from the phrase) and the payload is the credential. `transport=ws` is
	// the sentinel described above, not the transport sync uses.
	const payload = encodeURIComponent(JSON.stringify({ phrase }));
	const target = `${url.replace(/\/+$/, '')}/?storeId=sapling&transport=ws&payload=${payload}`;

	try {
		const response = await fetch(target, { method: 'GET', cache: 'no-store' });
		return interpretProbe(response.status);
	} catch {
		return {
			ok: false,
			reason: 'unreachable',
			message: 'Could not reach the sync server. Check your connection, or that it is deployed.'
		};
	}
}
