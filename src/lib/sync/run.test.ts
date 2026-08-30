/**
 * What `runSync` promises is not "it moves events" — it is what survives an
 * interruption. Every test here pins one of those promises: a local event keeps
 * its NULL `seq` until the server has answered for it, the cursor moves only
 * behind an applied page, an own event coming back is a stamp rather than a
 * second row, and every failure is a returned value.
 *
 * The store is the real one — the same WASM SQLite, in memory — so the merge
 * rules under test are the ones the app ships. Only `fetch` is fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Store } from '$lib/db/store';

const T0 = 1_700_000_000_000;
const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';
const SERVER = 'https://sync.example';
const DEVICE = 'devA';
const OTHER = 'devB';

/** `url.ts` reads `import.meta.env` at module load, so this must precede it. */
vi.stubEnv('VITE_SYNC_URL', SERVER);

const { setStoreForTesting } = await import('$lib/db/store');
const { makeTestStore } = await import('$lib/db/store.testing');
const { runSync, lastSyncOutcome } = await import('./run');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

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
	storage.setItem('ll.sync.phrase', PHRASE);
	storage.setItem('ll.sync.enabled', '1');
	storage.setItem('ll.syncDevice', DEVICE);
	vi.stubGlobal('localStorage', storage);

	store = await makeTestStore();
	setStoreForTesting(store);
});

/** One `itemAdded` payload, enough to see the item land in the read model. */
function word(n: number) {
	return {
		id: `i${n}`,
		kind: 'vocab' as const,
		term: `term${n}`,
		meaning: `meaning ${n}`,
		introducedAt: T0 + n
	};
}

/** A pull row from another device. */
function remote(seq: number, device = OTHER) {
	return {
		seq,
		id: `remote-${seq}`,
		type: 'itemAdded',
		at: T0 + seq,
		device,
		payload: word(seq)
	};
}

/* -------------------------------------------------------------------------- */
/* Fake transport                                                              */
/* -------------------------------------------------------------------------- */

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: { events?: { id: string }[] };
}

/** What a handler answers with; an `Error` is thrown from `fetch` (offline). */
type Reply = { status?: number; body?: unknown } | Error;

function fakeFetch(respond: (call: Call) => Reply): { impl: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl: typeof fetch = async (input, init) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		};
		calls.push(call);
		const reply = respond(call);
		if (reply instanceof Error) throw reply;
		return new Response(JSON.stringify(reply.body ?? {}), {
			status: reply.status ?? 200,
			headers: { 'content-type': 'application/json' }
		});
	};
	return { impl, calls };
}

/**
 * A backend that actually keeps a log: pushes are sequenced and handed back on
 * pull, which is the only way the own-event round trip can be tested at all.
 */
function logServer(seed: ReturnType<typeof remote>[] = []) {
	const log: Record<string, unknown>[] = [];
	for (const event of seed) log.push({ ...event, seq: log.length + 1 });

	const { impl, calls } = fakeFetch((call) => {
		if (call.method === 'POST') {
			const seqs: Record<string, number> = {};
			for (const event of call.body?.events ?? []) {
				const existing = log.find((row) => row.id === event.id);
				if (existing) {
					seqs[event.id] = existing.seq as number;
					continue;
				}
				const seq = log.length + 1;
				log.push({ ...event, seq });
				seqs[event.id] = seq;
			}
			return { body: { seqs } };
		}
		const after = Number(new URL(call.url).searchParams.get('after'));
		const latest = log.length;
		return { body: { events: log.filter((row) => (row.seq as number) > after), latest } };
	});
	return { impl, calls, log };
}

const gets = (calls: Call[]) => calls.filter((call) => call.method === 'GET');
const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST');
const afterOf = (call: Call) => new URL(call.url).searchParams.get('after');

async function cursor(): Promise<number | undefined> {
	const rows = await store.query<{ value: string }>(
		"SELECT value FROM meta WHERE key = 'pullCursor'"
	);
	return rows[0] ? Number(rows[0].value) : undefined;
}

const seqs = () =>
	store.query<{ id: string; seq: number | null }>('SELECT id, seq FROM events ORDER BY rowid');

const count = async (table: string) =>
	(await store.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

/* -------------------------------------------------------------------------- */

describe('runSync — configuration', () => {
	it('does nothing at all when sync is switched off', async () => {
		localStorage.removeItem('ll.sync.enabled');
		await store.commit('itemAdded', word(1));
		const { impl, calls } = logServer();

		const outcome = await runSync(impl);

		expect(outcome).toEqual({ ok: false, skipped: true, pushed: 0, pulled: 0 });
		expect(calls).toEqual([]);
		// A skipped cycle is not a result worth reporting to the learner.
		expect(lastSyncOutcome()).toBeUndefined();
	});
});

describe('runSync — push', () => {
	it('sends pending events with the bearer phrase and stamps the seqs it gets back', async () => {
		await store.commit('itemAdded', word(1));
		await store.commit('itemAdded', word(2));
		const { impl, calls } = logServer();

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: true, pushed: 2 });
		expect((await seqs()).map((row) => row.seq)).toEqual([1, 2]);
		const push = posts(calls)[0];
		expect(push.url).toBe(`${SERVER}/push`);
		expect(push.headers.Authorization).toBe(`Bearer ${PHRASE}`);
		expect(push.body?.events).toHaveLength(2);
	});

	it('leaves the seq NULL — and never pulls — when the push fails', async () => {
		await store.commit('itemAdded', word(1));
		const { impl, calls } = fakeFetch(() => ({ status: 500 }));

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: false, pushed: 0 });
		expect(outcome.message).toMatch(/problem on its side/);
		expect((await seqs())[0].seq).toBeNull();
		expect(gets(calls)).toEqual([]);
		expect(await cursor()).toBeUndefined();
	});

	it('records the outcome so Settings can show it', async () => {
		await store.commit('itemAdded', word(1));
		const { impl } = logServer();

		await runSync(impl);

		const last = lastSyncOutcome();
		expect(last?.ok).toBe(true);
		expect(last?.message).toBe('Sent 1, received 1.');
		expect(last?.at).toBeGreaterThan(0);
	});
});

describe('runSync — pull', () => {
	it('pages until it catches up, applying each page before moving the cursor', async () => {
		const { impl, calls } = fakeFetch((call) => {
			if (call.method === 'POST') return { body: { seqs: {} } };
			return afterOf(call) === '0'
				? { body: { events: [remote(1), remote(2)], latest: 4 } }
				: { body: { events: [remote(3), remote(4)], latest: 4 } };
		});

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: true, pulled: 4 });
		expect(gets(calls).map(afterOf)).toEqual(['0', '2']);
		expect(await cursor()).toBe(4);
		expect(await count('events')).toBe(4);
	});

	it("materialises a second device's word into the read model", async () => {
		const { impl } = logServer([remote(1)]);

		await runSync(impl);

		const items = await store.query<{ id: string; term: string }>('SELECT id, term FROM items');
		expect(items).toEqual([{ id: 'i1', term: 'term1' }]);
	});

	it('only stamps a seq on its own event coming back, never a second row', async () => {
		await store.commit('itemAdded', word(1));
		const { impl } = logServer();

		await runSync(impl);

		// One push and one pull of the same event: one row, one item, one seq.
		expect(await count('events')).toBe(1);
		expect(await count('items')).toBe(1);
		expect((await seqs())[0].seq).toBe(1);
		expect(await cursor()).toBe(1);
	});

	it('resumes from the stored cursor rather than re-reading the log', async () => {
		const { impl, calls } = logServer([remote(1), remote(2)]);

		await runSync(impl);
		await runSync(impl);

		expect(gets(calls).map(afterOf)).toEqual(['0', '2']);
		expect(await cursor()).toBe(2);
	});

	it('gives up instead of looping when a page cannot advance the cursor', async () => {
		const { impl, calls } = fakeFetch((call) =>
			call.method === 'POST'
				? { body: { seqs: {} } }
				: { body: { events: [{ garbage: true }], latest: 9 } }
		);

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.message).toMatch(/does not advance the cursor/);
		expect(gets(calls)).toHaveLength(1);
		expect(await cursor()).toBeUndefined();
	});
});

describe('runSync — failures', () => {
	it('names a refused phrase and leaves the cursor where it was', async () => {
		const { impl } = fakeFetch(() => ({ status: 401 }));

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: false, pushed: 0, pulled: 0 });
		expect(outcome.message).toMatch(/rejected the pairing phrase/);
		expect(await cursor()).toBeUndefined();
		expect(lastSyncOutcome()?.ok).toBe(false);
	});

	it('reports an unreachable server and leaves the cursor where it was', async () => {
		const { impl } = fakeFetch(() => new TypeError('network error'));

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.message).toMatch(/Could not reach/);
		expect(await cursor()).toBeUndefined();
	});

	it('keeps a cursor already earned when a later page dies', async () => {
		const offline = new TypeError('network error');
		const { impl } = fakeFetch((call) => {
			if (call.method === 'POST') return { body: { seqs: {} } };
			return afterOf(call) === '0' ? { body: { events: [remote(1)], latest: 4 } } : offline;
		});

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(await cursor()).toBe(1);
	});
});

describe('runSync — single flight', () => {
	it('joins the cycle already running instead of starting a second one', async () => {
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

		expect(posts(calls)).toHaveLength(1);
	});
});
