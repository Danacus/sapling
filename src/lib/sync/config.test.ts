/**
 * Whether this device should sync, and with which phrase.
 *
 * `isSyncEnabled()` is a three-part answer — the build has a backend, the
 * learner turned it on, and a phrase survived being stored — so callers can
 * never get a `true` they cannot act on. Sync fails silently by design, which
 * is exactly why the conditions are pinned here rather than observed later.
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

describe('sync configuration', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		installStorage();
	});

	it('is off until the learner turns sync on', async () => {
		const config = await loadConfig('https://sync.example.test');
		expect(config.isSyncEnabled()).toBe(false);
	});

	it('is on, with the phrase, once sync is enabled', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);

		expect(config.isSyncEnabled()).toBe(true);
		expect(config.getSyncPhrase()).toBe(PHRASE);
	});

	it('stays off when the build has no backend, however enabled the device is', async () => {
		const config = await loadConfig(undefined);
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);
		expect(config.isSyncEnabled()).toBe(false);
	});

	it('goes quiet again when sync is switched off, but keeps the phrase', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);
		config.setSyncEnabled(false);

		expect(config.isSyncEnabled()).toBe(false);
		// Kept on purpose: switching back on must rejoin the same library rather
		// than stranding the device in a fresh empty one.
		expect(config.getSyncPhrase()).toBe(PHRASE);
	});

	it('accepts a phrase in the form a learner would actually type it', async () => {
		const config = await loadConfig('https://sync.example.test');
		config.setSyncPhrase('  abcde-fghjk-mnpqr-stvwx  ');
		config.setSyncEnabled(true);
		expect(config.getSyncPhrase()).toBe(PHRASE);
	});
});
