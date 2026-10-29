/**
 * The Taal client that lives in Rust (`crates/sapling-taal`), run on the
 * window thread: the wasm build's `taal` export, lent this thread's `fetch` as
 * the transport and the window's `studySessions` read as the store. Rust owns
 * the code's rules, the request Taal's security rules accept, the batching
 * and what a response means; this module only carries JSON across.
 */

import { ready } from '$lib/db/backend';
import type { Taal } from '$lib/db/generated/taal';
import { isTaalCode as isCodeInCore, taal, type TaalHost } from '$lib/db/wasm/sapling_core';
import { loadWindowCore } from '$lib/db/window-core';
import { requester } from '$lib/sync/core';

export { BAD_CODE, CARDS_PER_ANSWER, REFUSED } from '$lib/db/generated/taal';

/** Whether a typed or pasted text is a Taal connect code. */
export function isTaalCode(raw: string): boolean {
	return isCodeInCore(raw);
}

async function taalHost(): Promise<TaalHost> {
	const backend = await ready();
	return {
		studySessions: async (since) => JSON.stringify(await backend.studySessions(since))
	};
}

/**
 * One Taal call by name. Never rejects for a refused or unreachable Taal —
 * that is an outcome — only for a malformed call, which is a bug.
 */
export async function callTaal<M extends keyof Taal>(
	method: M,
	args: Parameters<Taal[M]>[0],
	fetchImpl: typeof fetch = fetch
): Promise<Awaited<ReturnType<Taal[M]>>> {
	await loadWindowCore();
	const answer = await taal(method, JSON.stringify([args]), requester(fetchImpl), await taalHost());
	return JSON.parse(answer) as Awaited<ReturnType<Taal[M]>>;
}
