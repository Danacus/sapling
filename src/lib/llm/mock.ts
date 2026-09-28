/**
 * Whether model calls run in mock mode: no API key, or the learner switched it
 * on. The mock replies themselves live beside each call in Rust
 * (`crates/sapling-llm/fixtures/`).
 */

import { getApiKey } from '$lib/db/settings';

/** localStorage flag that forces the mock even when a key is present. */
export const MOCK_FLAG_KEY = 'll.mockMode';

/** Guarded: safe to call from node. */
export function isMockMode(): boolean {
	try {
		if (typeof localStorage !== 'undefined' && localStorage.getItem(MOCK_FLAG_KEY) === '1') {
			return true;
		}
	} catch {
		/* storage disabled; fall through to the key check */
	}
	return !getApiKey();
}

/** Turns the mock on or off for this device. */
export function setMockMode(on: boolean): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (on) localStorage.setItem(MOCK_FLAG_KEY, '1');
		else localStorage.removeItem(MOCK_FLAG_KEY);
	} catch {
		/* ignore */
	}
}
