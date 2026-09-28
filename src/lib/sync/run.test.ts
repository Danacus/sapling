/**
 * The seam, not the cycle: the cycle's promises are `crates/sapling-sync`'s
 * tests, and its merge rules `sapling-store`'s two-device test. What is pinned
 * here is what this host adds — its `fetch` and its `Backend` lent to the wasm
 * `sync` export and read back correctly, the configuration it reads, one
 * cycle at a time, and the record Settings shows.
 *
 * The store is the real one — the same wasm core, in memory. Only `fetch` is fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TestBackend } from '$lib/db/backend.testing';

const T0 = 1_700_000_000_000;
const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';
const SERVER = 'https://sync.example';

/** `url.ts` reads `import.meta.env` at module load, so this must precede it. */
vi.stubEnv('VITE_SYNC_URL', SERVER);

const { setBackendForTesting } = await import('$lib/db/backend');
const { makeTestBackend } = await import('$lib/db/backend.testing');
const { getProfile } = await import('$lib/db/repositories');
const { runSync, lastSyncOutcome, pairDevice, probeSync } = await import('./run');
const { getSyncPhrase, isSyncEnabled } = await import('./config');
const { formatPhrase, isValidPhrase, mintPhrase, normalizePhrase, PHRASE_LENGTH } =
	await import('./core');

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

let store: TestBackend;

function enable(): void {
	localStorage.setItem('ll.sync.phrase', PHRASE);
	localStorage.setItem('ll.sync.enabled', '1');
}

beforeEach(async () => {
	const storage = new MemoryStorage();
	storage.setItem('ll.syncDevice', 'devA');
	vi.stubGlobal('localStorage', storage);
	store = await makeTestBackend('devA');
	setBackendForTesting(store);
});

function word(n: number) {
	return {
		id: `i${n}`,
		kind: 'vocab' as const,
		term: `term${n}`,
		meaning: `meaning ${n}`,
		introducedAt: T0 + n
	};
}

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
}

/** A relay keeping one log; `reply` overrides it for a failure. */
function logServer(seed: Record<string, unknown>[] = [], reply?: () => Response | Error) {
	const log: { id: unknown; seq: number }[] = seed.map((event, i) => ({
		...event,
		id: event.id,
		seq: i + 1
	}));
	const calls: Call[] = [];
	const impl: typeof fetch = async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>
		});
		const override = reply?.();
		if (override instanceof Error) throw override;
		if (override) return override;
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as { events: { id: string }[] };
			const seqs: Record<string, number> = {};
			for (const event of body.events) {
				const held = log.find((row) => row.id === event.id);
				if (!held) log.push({ ...event, seq: log.length + 1 });
				seqs[event.id] = held?.seq ?? log.length;
			}
			return json({ seqs });
		}
		const after = Number(new URL(String(input)).searchParams.get('after'));
		return json({ events: log.filter((row) => row.seq > after), latest: log.length });
	};
	return { impl, calls, log };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const profileEvent = {
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

describe('runSync', () => {
	it('does nothing at all when sync is switched off', async () => {
		await store.commit('itemAdded', word(1));
		const { impl, calls } = logServer();

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: false, skipped: true, pushed: 0, pulled: 0 });
		expect(calls).toEqual([]);
		expect(lastSyncOutcome()).toBeUndefined();
	});

	it('pushes and pulls through the real store, and records the outcome', async () => {
		enable();
		await store.commit('itemAdded', word(1));
		const { impl, calls, log } = logServer([
			{ id: 'remote-2', type: 'itemAdded', at: T0, device: 'devB', payload: word(2) }
		]);

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: true, pushed: 1, pulled: 2 });
		expect(calls[0]).toMatchObject({ url: `${SERVER}/push`, method: 'POST' });
		expect(calls[0].headers.Authorization).toBe(`Bearer ${PHRASE}`);
		expect(log).toHaveLength(2);
		expect(await store.pendingEvents(10)).toEqual([]);
		expect(await store.getPullCursor()).toBe(2);
		const terms = (await store.getAllItems()).map((item) => item.term).sort();
		expect(terms).toEqual(['term1', 'term2']);
		expect(lastSyncOutcome()).toMatchObject({ ok: true, message: 'Sent 1, received 2.' });
	});

	it('records a failure as an outcome, never a rejection', async () => {
		enable();
		const { impl } = logServer([], () => new TypeError('network error'));

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.message).toBe('Could not reach the sync server.');
		expect(lastSyncOutcome()).toMatchObject({ ok: false, message: outcome.message });
	});

	it('joins the cycle already running instead of starting a second one', async () => {
		enable();
		await store.commit('itemAdded', word(1));
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { impl, calls } = logServer();
		const gated: typeof fetch = async (input, init) => {
			await gate;
			return impl(input, init);
		};

		const first = runSync(gated);
		const second = runSync(gated);
		expect(second).toBe(first);

		release?.();
		await Promise.all([first, second]);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});
});

describe('pairDevice', () => {
	it('adopts the phrase and reports paired when a profile is in the room', async () => {
		const outcome = await pairDevice('abcde-fghjk-mnpqr-stvwx', logServer([profileEvent]).impl);

		expect(outcome).toEqual({ ok: true, paired: true });
		expect(getSyncPhrase()).toBe(PHRASE);
		expect(isSyncEnabled()).toBe(true);
		expect((await getProfile())?.targetLanguage).toBe('Spanish');
	});

	it('succeeds unpaired on an empty room, keeping the phrase', async () => {
		expect(await pairDevice(PHRASE, logServer().impl)).toEqual({ ok: true, paired: false });
		expect(getSyncPhrase()).toBe(PHRASE);
	});

	it('rejects a phrase that is not one, storing nothing and asking no one', async () => {
		const fetchImpl = vi.fn<typeof fetch>();

		const outcome = await pairDevice('nope', fetchImpl);

		expect(outcome.message).toMatch(/does not look like a pairing phrase/);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(getSyncPhrase()).toBeUndefined();
	});
});

describe('probeSync', () => {
	it('asks for an empty page and reads a refusal as one', async () => {
		const { impl, calls } = logServer([], () => new Response('Unauthorized\n', { status: 401 }));

		const result = await probeSync(SERVER, PHRASE, impl);

		expect(calls[0].url).toBe(`${SERVER}/pull?after=0&limit=0`);
		expect(result).toMatchObject({ ok: false, reason: 'rejected' });
	});
});

describe('the phrase through the wasm build', () => {
	it('mints a phrase that survives its display form', () => {
		const phrase = mintPhrase();
		expect(phrase).toHaveLength(PHRASE_LENGTH);
		expect(isValidPhrase(phrase)).toBe(true);
		expect(normalizePhrase(formatPhrase(phrase).toLowerCase())).toBe(phrase);
	});

	it('draws from the host’s randomness', () => {
		expect(new Set(Array.from({ length: 200 }, mintPhrase)).size).toBe(200);
	});
});
