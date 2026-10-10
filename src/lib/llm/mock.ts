/**
 * Whether model calls run in mock mode: no API key, or the learner switched it
 * on. The mock replies themselves live beside each call in Rust
 * (`crates/sapling-llm/fixtures/`).
 */

import { getApiKey } from '$lib/db/settings';

/** localStorage flag that forces the mock even when a key is present. */
export const MOCK_FLAG_KEY = 'll.mockMode';

/**
 * Whether the learner switched the mock on, as opposed to having no key. A
 * screen that would otherwise say "add a key" asks this, so development can
 * still walk the keyed path without spending tokens. Guarded: safe from node.
 */
export function isMockForced(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(MOCK_FLAG_KEY) === '1';
	} catch {
		/* storage disabled */
		return false;
	}
}

/** Guarded: safe to call from node. */
export function isMockMode(): boolean {
	return isMockForced() || !getApiKey();
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
