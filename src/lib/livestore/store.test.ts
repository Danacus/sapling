/**
 * The options the app boots its store with.
 *
 * There is one assertion here that earns the file: **the sync credential is
 * actually passed.** It was not, once, and nothing caught it — not the types,
 * not `pnpm check`, not the end-to-end check against a live backend, because
 * that test built its own stores and supplied its own payload. The app's real
 * boot path was the one piece never exercised, and the failure it produced was
 * invisible by design: the leader worker reads a missing payload as "sync is
 * off", picks the offline backend, and two paired devices quietly sync nothing.
 *
 * The adapter is deliberately not covered. `./adapter` imports Vite worker
 * constructors that cannot be evaluated in node, which is the whole reason
 * `storeOptions` was split out of `storeReady` in the first place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';

function installStorage(): void {
	const map = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		}
	} as Storage);
}

/** `url.ts` reads `import.meta.env` at module load, so stub before importing. */
async function load(syncUrl: string) {
	vi.resetModules();
	vi.stubEnv('VITE_SYNC_URL', syncUrl);
	const config = await import('$lib/sync/config');
	const store = await import('./store');
	return { config, store };
}

describe('storeOptions', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		installStorage();
	});

	it('names the store with the constant, never with the phrase', async () => {
		const { config, store } = await load('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);

		const options = await store.storeOptionsForTesting();
		// Deriving this from the phrase would rename the OPFS database on
		// pairing, opening an empty one and stranding everything already written.
		expect(options.storeId).toBe('sapling');
		expect(options.storeId).not.toContain(PHRASE);
	});

	it('passes the pairing phrase when sync is on', async () => {
		const { config, store } = await load('https://sync.example.test');
		config.setSyncPhrase(PHRASE);
		config.setSyncEnabled(true);

		const options = await store.storeOptionsForTesting();
		expect(options.syncPayload).toEqual({ phrase: PHRASE });
		// Without the schema the payload cannot be encoded for the leader worker.
		expect(options.syncPayloadSchema).toBeDefined();
	});

	it('passes no payload when sync is off, which is how the leader is told', async () => {
		const { store } = await load('https://sync.example.test');
		const options = await store.storeOptionsForTesting();
		expect(options.syncPayload).toBeUndefined();
	});
});
