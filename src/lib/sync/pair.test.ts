/**
 * Pairing has one job that matters: decide whether this device already has a
 * library, without ever writing a profile. So each test here pins one answer —
 * a profile arrived, the room was empty, the server said no, the phrase was
 * junk — and every one of them also checks that nothing was written.
 *
 * Same rig as `run.test.ts`: the real WASM store in memory, a fake `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Store } from '$lib/db/store';

const T0 = 1_700_000_000_000;
const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';
const SERVER = 'https://sync.example';

/** `url.ts` reads `import.meta.env` at module load, so this must precede it. */
vi.stubEnv('VITE_SYNC_URL', SERVER);

const { setStoreForTesting } = await import('$lib/db/store');
const { makeTestStore } = await import('$lib/db/store.testing');
const { getProfile } = await import('$lib/db/repositories');
const { pairDevice } = await import('./pair');
const { getSyncPhrase, isSyncEnabled } = await import('./config');

class MemoryStorage {
	private readonly entries = new Map<string, string>();
	getItem(key: string): string | null {
		return this.entries.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.entries.set(key, String(value));
	}
	removeItem(key: string): void {
		this.entries.delete(key);
	}
	clear(): void {
		this.entries.clear();
	}
}

let store: Store;

beforeEach(async () => {
	const storage = new MemoryStorage();
	storage.setItem('ll.syncDevice', 'devA');
	vi.stubGlobal('localStorage', storage);

	store = await makeTestStore();
	setStoreForTesting(store);
});

/** The profile row the first device wrote, as it comes back off the log. */
const profileEvent = {
	seq: 1,
	id: 'remote-profile',
	type: 'profileUpdated',
	at: T0,
	device: 'devB',
	payload: {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['cooking'],
		model: 'google/gemini-2.5-flash-lite',
		createdAt: T0
	}
};

/** A server holding `seed`, answering pushes with the next seq. */
function logServer(seed: unknown[] = []): typeof fetch {
	const log = [...seed] as Record<string, unknown>[];
	return async (input, init) => {
		const url = String(input);
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as { events: { id: string }[] };
			const seqs: Record<string, number> = {};
			for (const event of body.events) {
				log.push({ ...event, seq: log.length + 1 });
				seqs[event.id] = log.length;
			}
			return json({ seqs });
		}
		const after = Number(new URL(url).searchParams.get('after'));
		return json({ events: log.filter((row) => (row.seq as number) > after), latest: log.length });
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('pairDevice', () => {
	it('adopts the phrase and reports paired when a profile is in the room', async () => {
		const outcome = await pairDevice('abcde-fghjk-mnpqr-stvwx', logServer([profileEvent]));

		expect(outcome).toEqual({ ok: true, paired: true });
		expect(getSyncPhrase()).toBe(PHRASE);
		expect(isSyncEnabled()).toBe(true);
		expect((await getProfile())?.targetLanguage).toBe('Spanish');
	});

	it('succeeds but reports unpaired when the room is empty', async () => {
		const outcome = await pairDevice(PHRASE, logServer());

		expect(outcome).toEqual({ ok: true, paired: false });
		// The phrase is kept: the other device just has not synced yet.
		expect(getSyncPhrase()).toBe(PHRASE);
		expect(await getProfile()).toBeUndefined();
	});

	it('passes the server’s refusal through and writes no profile', async () => {
		const outcome = await pairDevice(PHRASE, async () => json({}, 401));

		expect(outcome.ok).toBe(false);
		expect(outcome.paired).toBe(false);
		expect(outcome.message).toMatch(/rejected the pairing phrase/);
		expect(await getProfile()).toBeUndefined();
	});

	it('rejects a phrase that is not one, storing nothing and asking no one', async () => {
		const fetchImpl = vi.fn<typeof fetch>();

		const outcome = await pairDevice('nope', fetchImpl);

		expect(outcome).toEqual({ ok: false, paired: false, message: expect.any(String) });
		expect(outcome.message).toMatch(/does not look like a pairing phrase/);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(getSyncPhrase()).toBeUndefined();
		expect(isSyncEnabled()).toBe(false);
	});
});
