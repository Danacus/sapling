/**
 * The whole server, driven through `app.request()` against a `:memory:`
 * database. No socket is opened and no file is written, so the suite is as
 * cheap as the app's pure-logic tests — the same reason the store takes its
 * path as an argument.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { hashKey } from './auth.ts';
import { openStore, type SyncStore } from './db.ts';
import {
	EVENT_TYPES,
	SYNC_LIMITS,
	type StoredSyncEvent,
	type SyncEvent
} from '../../src/lib/sync/events.ts';

const ALICE_KEY = 'alice-key';
const BOB_KEY = 'bob-key';
const ORIGIN = 'https://sapling.example';

let store: SyncStore;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
	store = openStore(':memory:');
	store.insertKey(hashKey(ALICE_KEY), 'alice', 1_000);
	store.insertKey(hashKey(BOB_KEY), 'bob', 1_000);
	app = createApp({ store, origins: [ORIGIN], now: () => 1_700_000_000_000 });
});

/** A valid envelope; `payload` stays opaque to the server, so it can be anything. */
function event(n: number, overrides: Partial<SyncEvent> = {}): SyncEvent {
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		device: 'device-a',
		at: 1_700_000_000_000 + n,
		type: EVENT_TYPES.itemReviewed,
		payload: { itemId: `item-${n}`, grade: 3 },
		...overrides
	};
}

async function push(key: string, events: unknown[], device = 'device-a'): Promise<Response> {
	return app.request('/v1/events', {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ device, events })
	});
}

async function pull(key: string, query = ''): Promise<Response> {
	return app.request(`/v1/events${query}`, { headers: { Authorization: `Bearer ${key}` } });
}

async function pushJson(
	key: string,
	events: unknown[],
	device?: string
): Promise<{ accepted: number; latest: number }> {
	const res = await push(key, events, device);
	expect(res.status).toBe(200);
	return (await res.json()) as { accepted: number; latest: number };
}

async function pullJson(
	key: string,
	query = ''
): Promise<{ events: StoredSyncEvent[]; latest: number }> {
	const res = await pull(key, query);
	expect(res.status).toBe(200);
	return (await res.json()) as { events: StoredSyncEvent[]; latest: number };
}

const seqs = (events: StoredSyncEvent[]) => events.map((e) => e.seq);

describe('auth', () => {
	it('serves health without a key — the one open route', async () => {
		const res = await app.request('/v1/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('401s the event endpoints without a key', async () => {
		expect((await app.request('/v1/events')).status).toBe(401);

		const posted = await app.request('/v1/events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device: 'd', events: [] })
		});
		expect(posted.status).toBe(401);
	});

	it('401s an unknown key, and says how to authenticate', async () => {
		const res = await pull('not-a-real-key');
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
	});

	it('401s a non-Bearer scheme', async () => {
		const res = await app.request('/v1/events', { headers: { Authorization: ALICE_KEY } });
		expect(res.status).toBe(401);
	});
});

describe('push', () => {
	it('accepts a batch and reports the new head', async () => {
		expect(await pushJson(ALICE_KEY, [event(1), event(2)])).toEqual({ accepted: 2, latest: 2 });
	});

	it('is idempotent: a retried batch is accepted again but stored once', async () => {
		const first = await pushJson(ALICE_KEY, [event(1), event(2)]);
		const second = await pushJson(ALICE_KEY, [event(1), event(2)]);

		// Same answer both times — a client retrying after a timeout must not be
		// able to tell whether the first attempt landed.
		expect(second).toEqual(first);
		expect((await pullJson(ALICE_KEY)).events).toHaveLength(2);
	});

	it('stores payloads verbatim, whatever shape they are', async () => {
		const odd = event(1, { type: 'some-future-event-type', payload: [1, 'two', { three: null }] });
		await pushJson(ALICE_KEY, [odd]);

		const { events } = await pullJson(ALICE_KEY);
		expect(events[0]?.type).toBe('some-future-event-type');
		expect(events[0]?.payload).toEqual([1, 'two', { three: null }]);
	});

	it('rejects the whole request when any envelope is invalid', async () => {
		const res = await push(ALICE_KEY, [event(1), { ...event(2), id: 'not-a-uuid' }]);
		expect(res.status).toBe(400);

		// Nothing from a rejected request is stored — the transaction never ran.
		const { events, latest } = await pullJson(ALICE_KEY);
		expect(events).toHaveLength(0);
		expect(latest).toBe(0);
	});

	it.each([
		['blank device', { ...event(1), device: '' }],
		['non-positive at', { ...event(1), at: 0 }],
		['empty type', { ...event(1), type: '' }],
		['missing payload', { id: event(1).id, device: 'd', at: 1, type: 't' }]
	])('rejects %s with 400', async (_label, bad) => {
		expect((await push(ALICE_KEY, [bad])).status).toBe(400);
	});

	it('400s a malformed request body', async () => {
		const res = await app.request('/v1/events', {
			method: 'POST',
			headers: { Authorization: `Bearer ${ALICE_KEY}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ events: [] })
		});
		expect(res.status).toBe(400);
	});

	it('413s more than the per-request event cap', async () => {
		const tooMany = Array.from({ length: SYNC_LIMITS.maxEventsPerRequest + 1 }, (_, i) =>
			event(i + 1)
		);
		expect((await push(ALICE_KEY, tooMany)).status).toBe(413);
	});

	it('413s an oversized payload', async () => {
		const fat = event(1, { payload: { blob: 'x'.repeat(SYNC_LIMITS.maxPayloadBytes) } });
		expect((await push(ALICE_KEY, [fat])).status).toBe(413);
	});

	it('accepts exactly the caps', async () => {
		const atCap = Array.from({ length: SYNC_LIMITS.maxEventsPerRequest }, (_, i) => event(i + 1));
		expect(await pushJson(ALICE_KEY, atCap)).toEqual({
			accepted: SYNC_LIMITS.maxEventsPerRequest,
			latest: SYNC_LIMITS.maxEventsPerRequest
		});
	});
});

describe('pull', () => {
	beforeEach(async () => {
		await pushJson(ALICE_KEY, [event(1), event(2), event(3)]);
	});

	it('returns everything from seq 0, ascending, with the log head', async () => {
		const { events, latest } = await pullJson(ALICE_KEY);
		expect(seqs(events)).toEqual([1, 2, 3]);
		expect(latest).toBe(3);
		expect(events[0]).toMatchObject({
			id: event(1).id,
			device: 'device-a',
			type: EVENT_TYPES.itemReviewed
		});
	});

	it('returns only events after the cursor', async () => {
		const { events, latest } = await pullJson(ALICE_KEY, '?after=2');
		expect(seqs(events)).toEqual([3]);
		// `latest` is the head of the log, not of the page — that is how a
		// client knows whether another page is waiting.
		expect(latest).toBe(3);
	});

	it('respects limit, and latest still points past the page', async () => {
		const { events, latest } = await pullJson(ALICE_KEY, '?after=0&limit=2');
		expect(seqs(events)).toEqual([1, 2]);
		expect(latest).toBe(3);
	});

	it('clamps an over-large limit instead of failing the sync', async () => {
		const { events } = await pullJson(ALICE_KEY, '?limit=100000');
		expect(events).toHaveLength(3);
	});

	it('400s a nonsense cursor', async () => {
		expect((await pull(ALICE_KEY, '?after=banana')).status).toBe(400);
		expect((await pull(ALICE_KEY, '?limit=0')).status).toBe(400);
	});

	it('returns an empty page at the head of the log', async () => {
		const { events, latest } = await pullJson(ALICE_KEY, '?after=3');
		expect(events).toEqual([]);
		expect(latest).toBe(3);
	});
});

describe('isolation', () => {
	it('keeps two users’ logs entirely separate', async () => {
		await pushJson(ALICE_KEY, [event(1), event(2)]);
		// Same event ids, different user: the unique key is (user, event_id), so
		// Bob's push must not be deduped against Alice's.
		expect(await pushJson(BOB_KEY, [event(1)], 'device-b')).toEqual({ accepted: 1, latest: 3 });

		const alice = await pullJson(ALICE_KEY);
		expect(seqs(alice.events)).toEqual([1, 2]);
		expect(alice.latest).toBe(2);

		const bob = await pullJson(BOB_KEY);
		// seq is a global counter, so Bob's first event is 3 — still strictly
		// ascending within his own log, which is all a cursor needs.
		expect(seqs(bob.events)).toEqual([3]);
	});
});

describe('cors', () => {
	it('reflects an allowed origin', async () => {
		const res = await app.request('/v1/events', {
			headers: { Authorization: `Bearer ${ALICE_KEY}`, Origin: ORIGIN }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
	});

	it('does not reflect an unknown origin', async () => {
		const res = await app.request('/v1/events', {
			headers: { Authorization: `Bearer ${ALICE_KEY}`, Origin: 'https://evil.example' }
		});
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});

	it('answers a preflight without a key — the browser cannot send one', async () => {
		const res = await app.request('/v1/events', {
			method: 'OPTIONS',
			headers: {
				Origin: ORIGIN,
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'authorization,content-type'
			}
		});
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
		expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
			'authorization'
		);
	});
});

describe('rate limiting', () => {
	it('429s once the bucket is empty, per user', async () => {
		const limited = createApp({ store, rateLimitPerMinute: 3, now: () => 0 });
		const req = (key: string) =>
			limited.request('/v1/events', { headers: { Authorization: `Bearer ${key}` } });

		expect((await req(ALICE_KEY)).status).toBe(200);
		expect((await req(ALICE_KEY)).status).toBe(200);
		expect((await req(ALICE_KEY)).status).toBe(200);
		expect((await req(ALICE_KEY)).status).toBe(429);
		// Bob has his own bucket.
		expect((await req(BOB_KEY)).status).toBe(200);
	});
});
