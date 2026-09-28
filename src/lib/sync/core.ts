/**
 * The sync client that lives in Rust (`crates/sapling-sync`), run on the
 * window thread: the wasm build's `sync` export, lent this thread's `fetch` as
 * the transport and the window's `Backend` as the store, plus the pairing
 * phrase's helpers. Rust owns the cycle, the probe, pairing and the phrase;
 * this module only carries JSON across.
 */

import { ready } from '$lib/db/backend';
import { PHRASE_LENGTH, type Sync } from '$lib/db/generated/sync';
import {
	formatPhrase as formatInCore,
	isValidPhrase as isValidInCore,
	mintPhrase as mintInCore,
	normalizePhrase as normalizeInCore,
	sync,
	type SyncHost
} from '$lib/db/wasm/sapling_core';
import { loadWindowCore } from '$lib/db/window-core';

export { BAD_PHRASE, PHRASE_LENGTH } from '$lib/db/generated/sync';

/** The canonical form of anything a learner might type or paste. */
export function normalizePhrase(raw: string): string {
	return normalizeInCore(raw);
}

/** Whether a *normalised* phrase is one this app could have minted. */
export function isValidPhrase(phrase: string): boolean {
	return isValidInCore(phrase);
}

/** A fresh pairing phrase, in canonical form. */
export function mintPhrase(): string {
	return mintInCore(crypto.getRandomValues(new Uint8Array(PHRASE_LENGTH)));
}

/** The canonical phrase as a human reads it: `ABCDE-FGHJK-MNPQR-STVWX`. */
export function formatPhrase(phrase: string): string {
	return formatInCore(phrase);
}

function requester(fetchImpl: typeof fetch) {
	return async (json: string): Promise<string> => {
		const { method, url, headers, body } = JSON.parse(json) as {
			method: string;
			url: string;
			headers: Record<string, string>;
			body?: string;
		};
		const response = await fetchImpl(url, { method, headers, body });
		return JSON.stringify({ status: response.status, body: await response.text() });
	};
}

async function syncHost(): Promise<SyncHost> {
	const backend = await ready();
	return {
		pendingEvents: async (limit) => JSON.stringify(await backend.pendingEvents(limit)),
		markPushed: (json) => backend.markPushed(JSON.parse(json) as Record<string, number>),
		applyRemote: (json) => backend.applyRemote(JSON.parse(json) as unknown[]),
		getPullCursor: () => backend.getPullCursor(),
		setPullCursor: (cursor) => backend.setPullCursor(cursor),
		hasProfile: async () => (await backend.getProfile()) !== undefined
	};
}

/**
 * One sync call by name. Never rejects for a failed cycle — that is an
 * outcome — only for a malformed call, which is a bug.
 */
export async function callSync<M extends keyof Sync>(
	method: M,
	args: Parameters<Sync[M]>[0],
	fetchImpl: typeof fetch = fetch
): Promise<Awaited<ReturnType<Sync[M]>>> {
	await loadWindowCore();
	const store = method === 'probeSync' ? undefined : await syncHost();
	const answer = await sync(method, JSON.stringify([args]), requester(fetchImpl), store);
	return JSON.parse(answer) as Awaited<ReturnType<Sync[M]>>;
}
