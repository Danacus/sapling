import { loadWindowCore } from '$lib/db/window-core';

// This app is a fully client-side, local-first SPA: all state lives in a
// browser-local SQLite database, so there is nothing meaningful to render on
// the server.
export const ssr = false;
export const prerender = false;

// The challenge decisions are synchronous calls into the wasm core, so it is
// instantiated before the first page renders.
export async function load(): Promise<Record<string, never>> {
	await loadWindowCore();
	return {};
}
