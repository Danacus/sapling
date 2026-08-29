/**
 * The credential the store boots with.
 *
 * `syncPayload()` is the single value that decides whether a device syncs at
 * all: the leader worker reads its presence as "sync is on" and its absence as
 * "sync is off", and picks a real backend or the offline one accordingly. When
 * `store.ts` was not passing it, every browser connected with no credential,
 * the Worker refused, and — because sync degrades silently by design — the
 * symptom was nothing happening at all, on both devices, forever.
 *
 * So these tests pin the two answers that matter, and in particular that an
 * enabled device produces a payload rather than `undefined`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';

/** A `localStorage` good enough for the module under test. */
function installStorage(): Storage {
	const map = new Map<string, string>();
	const storage = {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		}
	} as Storage;
	vi.stubGlobal('localStorage', storage);
	return storage;
}

/**
 * `url.ts` reads `import.meta.env` once at module load, so the environment has
 * to be stubbed before the import rather than after.
 */
async function loadConfig(syncUrl: string | undefined) {
	vi.resetModules();
	if (syncUrl === undefined) vi.stubEnv('VITE_SYNC_URL', '');
	else vi.stubEnv('VITE_SYNC_URL', syncUrl);
	return import('./config');
}

describe('syncPayload', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		installStorage();
	});

	it('is undefined when the learner has not turned sync on', async () => {
		const config = await loadConfig('https://sync.example.test');
		expect(config.syncPayload()).toBeUndefined();
	});

	it('carries the phrase once sync is enabled', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);

		// The regression: this was never reaching `createStorePromise`, so the
		// leader worker saw `undefined` and chose the offline backend.
		expect(config.syncPayload()).toEqual({ phrase: PHRASE });
	});

	it('is undefined when the build has no backend, however enabled the device is', async () => {
		const config = await loadConfig(undefined);
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);
		expect(config.syncPayload()).toBeUndefined();
	});

	it('goes quiet again when sync is switched off, but keeps the phrase', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);
		config.setSyncEnabled(false);

		expect(config.syncPayload()).toBeUndefined();
		// Kept on purpose: switching back on must rejoin the same library rather
		// than stranding the device in a fresh empty one.
		expect(config.getSyncPhrase()).toBe(PHRASE);
	});

	it('accepts a phrase in the form a learner would actually type it', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase('  abcde-fghjk-mnpqr-stvwx  ');
		config.setSyncEnabled(true);
		expect(config.syncPayload()).toEqual({ phrase: PHRASE });
	});
});
