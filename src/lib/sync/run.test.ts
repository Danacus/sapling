/**
 * The orchestrator's contract is not "it moves events" — it is *what survives
 * an interruption*. Every test here pins one of the four promises `runSync`
 * makes: the outbox loses only what the server acknowledged, the cursor moves
 * only behind an applied batch, a failure is a returned value rather than a
 * throw, and two overlapping calls are one cycle.
 *
 * `$lib/db` and the apply engine are replaced with in-memory stand-ins (no
 * IndexedDB in node; the real fold is pinned by `apply.test.ts`), and `fetch` is
 * a scripted fake — the whole point of it being injectable. `localStorage` is
 * stubbed rather than mocked away, so the real `./config` gate is what decides
 * whether a device is configured.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxRow } from '$lib/db/database';
import { EVENT_TYPES, SYNC_LIMITS, type StoredSyncEvent, type SyncEvent } from './events';

const T0 = 1_700_000_000_000;
const DEVICE = 'devA';
const OTHER = 'devB';
const SERVER = 'https://sync.example';
const KEY = 'secret-key';

/** The fake outbox table, oldest first. */
const outbox: OutboxRow[] = [];
/** The fake `syncState` table. */
const syncState = new Map<string, unknown>();
/** Batches handed to the apply engine, in order. */
const applied: StoredSyncEvent[][] = [];
/** Applies and cursor writes interleaved, so their *order* can be asserted. */
const journal: string[] = [];
/** How many times genesis was asked to run. */
let genesisRuns = 0;

vi.mock('$lib/db', () => ({
	peekOutbox: async (limit: number) => outbox.slice(0, limit).map((row) => ({ ...row })),
	drainOutbox: async (seqs: number[]) => {
		for (const seq of seqs) {
			const index = outbox.findIndex((row) => row.seq === seq);
			if (index >= 0) outbox.splice(index, 1);
		}
	},
	getSyncState: async (key: string) => syncState.get(key),
	setSyncState: async (key: string, value: unknown) => {
		syncState.set(key, value);
		journal.push(`${key}=${String(value)}`);
	},
	// Reached through `runGenesis`; genesis itself is pinned by genesis.test.ts.
	seedOutbox: async () => {
		genesisRuns += 1;
		return 0;
	}
}));

vi.mock('./apply', () => ({
	applyRemoteBatch: async (events: StoredSyncEvent[]) => {
		applied.push(events);
		journal.push(`apply=${events.map((event) => event.seq).join(',')}`);
	}
}));

const { runSync } = await import('./run');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A valid v4-shaped UUID per seq, so `storedSyncEventSchema` accepts it. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function remoteEvent(seq: number, device = OTHER): StoredSyncEvent {
	return {
		seq,
		id: uuid(seq),
		device,
		at: T0 + seq,
		type: EVENT_TYPES.challengeServed,
		payload: { challengeId: `c${seq}` }
	};
}

function localEvent(seq: number): SyncEvent {
	return {
		id: uuid(1000 + seq),
		device: DEVICE,
		at: T0 + seq,
		type: EVENT_TYPES.itemReviewed,
		payload: { itemId: `i${seq}`, at: T0 + seq, grade: 3 }
	};
}

/** Fills the fake outbox with `count` rows, seqs starting at 1. */
function fillOutbox(count: number): void {
	for (let seq = 1; seq <= count; seq++) outbox.push({ seq, event: localEvent(seq) });
}

/* -------------------------------------------------------------------------- */
/* Fake transport                                                              */
/* -------------------------------------------------------------------------- */

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: { device?: string; events?: SyncEvent[] };
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

/** A server with an empty log: accepts every push, has nothing to hand back. */
const quietServer = () => fakeFetch((call) => (call.method === 'POST' ? {} : pageOf([], 0)));

/** One pull response. */
function pageOf(events: unknown[], latest: number): { body: unknown } {
	return { body: { events, latest } };
}

/** The `after=` query the client sent on a GET. */
const afterOf = (call: Call) => new URL(call.url).searchParams.get('after');

const gets = (calls: Call[]) => calls.filter((call) => call.method === 'GET');
const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST');

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

beforeEach(() => {
	outbox.length = 0;
	applied.length = 0;
	journal.length = 0;
	syncState.clear();
	genesisRuns = 0;

	const storage = new MemoryStorage();
	storage.setItem('ll.syncServer', SERVER);
	storage.setItem('ll.syncKey', KEY);
	storage.setItem('ll.syncDevice', DEVICE);
	vi.stubGlobal('localStorage', storage);
});

afterEach(() => vi.unstubAllGlobals());

describe('runSync — configuration', () => {
	it('does nothing at all when sync is not configured', async () => {
		localStorage.removeItem('ll.syncKey');
		fillOutbox(2);
		const { impl, calls } = quietServer();

		const outcome = await runSync(impl);

		expect(outcome).toEqual({ ok: false, skipped: true, pushed: 0, pulled: 0 });
		expect(calls).toEqual([]);
		expect(outbox).toHaveLength(2);
		expect(genesisRuns).toBe(0);
	});

	it('runs genesis before touching the network', async () => {
		const { impl } = quietServer();

		await runSync(impl);

		expect(genesisRuns).toBe(1);
	});
});

describe('runSync — push', () => {
	it('sends the outbox with the bearer key and drains what was acknowledged', async () => {
		fillOutbox(3);
		const { impl, calls } = fakeFetch((call) =>
			call.method === 'POST' ? { body: { accepted: 3, latest: 3 } } : pageOf([], 0)
		);

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: true, pushed: 3 });
		expect(outbox).toEqual([]);
		const push = posts(calls)[0];
		expect(push.url).toBe(`${SERVER}/v1/events`);
		expect(push.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(push.body?.device).toBe(DEVICE);
		expect(push.body?.events).toHaveLength(3);
	});

	it('leaves the outbox intact — and never pulls — when the push fails', async () => {
		fillOutbox(3);
		const { impl, calls } = fakeFetch(() => ({ status: 500 }));

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.pushed).toBe(0);
		expect(outcome.error).toMatch(/problem on its side/);
		expect(outbox).toHaveLength(3);
		// A failed push must not be followed by a pull: the cycle stops there.
		expect(gets(calls)).toEqual([]);
		expect(syncState.get('lastSync')).toBeUndefined();
	});

	it('keeps every push inside the protocol batch limit', async () => {
		const total = SYNC_LIMITS.maxEventsPerRequest + 2;
		fillOutbox(total);
		const { impl, calls } = fakeFetch((call) => (call.method === 'POST' ? {} : pageOf([], 0)));

		const outcome = await runSync(impl);

		expect(outcome.pushed).toBe(total);
		expect(outbox).toEqual([]);
		const sizes = posts(calls).map((call) => call.body?.events?.length ?? 0);
		expect(sizes).toEqual([SYNC_LIMITS.maxEventsPerRequest, 2]);
	});
});

describe('runSync — pull', () => {
	it('pages until it catches up, applying each batch before moving the cursor', async () => {
		const { impl, calls } = fakeFetch((call) => {
			if (call.method === 'POST') return {};
			return afterOf(call) === '0'
				? pageOf([remoteEvent(1), remoteEvent(2)], 4)
				: pageOf([remoteEvent(3), remoteEvent(4)], 4);
		});

		const outcome = await runSync(impl);

		expect(outcome).toMatchObject({ ok: true, pulled: 4 });
		expect(applied.map((batch) => batch.map((event) => event.seq))).toEqual([
			[1, 2],
			[3, 4]
		]);
		// Apply strictly before the cursor that covers it — the whole
		// interruption-safety argument in one assertion.
		expect(journal.slice(0, 4)).toEqual(['apply=1,2', 'cursor=2', 'apply=3,4', 'cursor=4']);
		expect(gets(calls).map(afterOf)).toEqual(['0', '2']);
		expect(syncState.get('cursor')).toBe(4);
	});

	it('resumes from the stored cursor', async () => {
		syncState.set('cursor', 7);
		const { impl, calls } = fakeFetch((call) =>
			call.method === 'POST' ? {} : pageOf([remoteEvent(8)], 8)
		);

		await runSync(impl);

		expect(gets(calls).map(afterOf)).toEqual(['7']);
		expect(syncState.get('cursor')).toBe(8);
	});

	it("skips this device's own events but still steps past them", async () => {
		const { impl } = fakeFetch((call) =>
			call.method === 'POST'
				? {}
				: pageOf([remoteEvent(1), remoteEvent(2, DEVICE), remoteEvent(3)], 3)
		);

		const outcome = await runSync(impl);

		expect(applied).toEqual([[remoteEvent(1), remoteEvent(3)]]);
		expect(outcome.pulled).toBe(2);
		expect(syncState.get('cursor')).toBe(3);
	});

	it('applies nothing at all when a page is entirely its own echo', async () => {
		const { impl } = fakeFetch((call) =>
			call.method === 'POST' ? {} : pageOf([remoteEvent(1, DEVICE)], 1)
		);

		const outcome = await runSync(impl);

		expect(applied).toEqual([]);
		expect(outcome).toMatchObject({ ok: true, pulled: 0 });
		expect(syncState.get('cursor')).toBe(1);
	});

	it('drops an invalid remote event, applies the rest, and steps over it', async () => {
		const broken = { seq: 2, id: 'not-a-uuid', device: OTHER, at: T0, type: '', payload: null };
		const { impl } = fakeFetch((call) =>
			call.method === 'POST' ? {} : pageOf([remoteEvent(1), broken, remoteEvent(3)], 3)
		);

		const outcome = await runSync(impl);

		expect(applied).toEqual([[remoteEvent(1), remoteEvent(3)]]);
		expect(outcome).toMatchObject({ ok: true, pulled: 2 });
		expect(syncState.get('cursor')).toBe(3);
	});

	it('gives up instead of looping when a page cannot advance the cursor', async () => {
		// No usable seq anywhere: re-asking would fetch the same page forever.
		const { impl, calls } = fakeFetch((call) =>
			call.method === 'POST' ? {} : pageOf([{ garbage: true }], 9)
		);

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/does not advance the cursor/);
		expect(gets(calls)).toHaveLength(1);
		expect(syncState.get('cursor')).toBeUndefined();
	});

	it('rejects a response that is not a pull page', async () => {
		const { impl } = fakeFetch((call) => (call.method === 'POST' ? {} : { body: { nope: 1 } }));

		const outcome = await runSync(impl);

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toMatch(/unexpected response/);
	});
});

describe('runSync — interruption', () => {
	it('leaves a resumable cursor when a pull dies mid-way, and picks it up next time', async () => {
		const offline = new TypeError('network error');
		const first = fakeFetch((call) => {
			if (call.method === 'POST') return {};
			return afterOf(call) === '0' ? pageOf([remoteEvent(1), remoteEvent(2)], 4) : offline;
		});

		const interrupted = await runSync(first.impl);

		expect(interrupted.ok).toBe(false);
		expect(interrupted.error).toMatch(/Could not reach/);
		// The first batch is applied and its cursor is stored; nothing else is.
		expect(syncState.get('cursor')).toBe(2);
		expect(syncState.get('lastSync')).toBeUndefined();

		const second = fakeFetch((call) =>
			call.method === 'POST' ? {} : pageOf([remoteEvent(3), remoteEvent(4)], 4)
		);
		const resumed = await runSync(second.impl);

		// Resumed exactly where it stopped — the interrupted page is not re-read.
		expect(gets(second.calls).map(afterOf)).toEqual(['2']);
		expect(resumed).toMatchObject({ ok: true, pulled: 2 });
		expect(syncState.get('cursor')).toBe(4);
	});

	it('stamps lastSync only when the whole cycle got through', async () => {
		const { impl } = quietServer();

		await runSync(impl);

		expect(typeof syncState.get('lastSync')).toBe('number');
		expect(syncState.get('lastSync')).toBeGreaterThan(0);
	});
});

describe('runSync — single flight', () => {
	it('joins an in-flight cycle instead of starting a second one', async () => {
		fillOutbox(1);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { impl, calls } = fakeFetch((call) => (call.method === 'POST' ? {} : pageOf([], 0)));
		const gated: typeof fetch = async (input, init) => {
			await gate;
			return impl(input, init);
		};

		const first = runSync(gated);
		const second = runSync(gated);
		expect(second).toBe(first);

		release?.();
		const [a, b] = await Promise.all([first, second]);

		expect(a).toBe(b);
		expect(a).toMatchObject({ ok: true, pushed: 1 });
		expect(posts(calls)).toHaveLength(1);
	});

	it('starts a fresh cycle once the previous one has settled', async () => {
		const { impl, calls } = quietServer();

		await runSync(impl);
		await runSync(impl);

		expect(gets(calls)).toHaveLength(2);
	});
});
