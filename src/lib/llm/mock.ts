/**
 * Whether model calls run in mock mode: no API key, or the learner switched it
 * on. The mock replies themselves live beside each call in Rust
 * (`crates/sapling-llm/fixtures/`).
 */

import { getApiKey } from '$lib/db/settings';

/**
 * localStorage flag that forces the mock even when a key is present. Set by
 * hand (devtools) during development; nothing in the app writes it.
 */
const MOCK_FLAG_KEY = 'll.mockMode';

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
