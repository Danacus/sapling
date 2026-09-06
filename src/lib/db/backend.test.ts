import { describe, expect, it } from 'vitest';
import { isSahPoolBusy } from './backend';

describe('isSahPoolBusy', () => {
	it('recognizes the spec-named DOMException createSyncAccessHandle rejects with when its lock is held', () => {
		// String(DOMException) is "<name>: <message>" in every browser; the name
		// is the one thing that does not vary by browser wording.
		const reason =
			"NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created for a file which is inside a locked or read-only ancestor directory or has an open Access Handle.";
		expect(isSahPoolBusy(reason)).toBe(true);
	});

	it('does not classify a wasm fetch/instantiate failure as the busy case', () => {
		// e.g. a 404 on the hashed core wasm file after a deploy lands while a
		// stale tab is still open.
		const reason = 'TypeError: Failed to fetch dynamically imported module: /sapling_core_bg.wasm';
		expect(isSahPoolBusy(reason)).toBe(false);
	});

	it('does not classify a missing OPFS API as the busy case', () => {
		expect(isSahPoolBusy('Error: Missing required OPFS APIs.')).toBe(false);
	});
});
