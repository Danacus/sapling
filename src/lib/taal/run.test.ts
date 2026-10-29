/**
 * The seam, not the client: the request's shape, batching and what a status
 * means are `crates/sapling-taal`'s tests. What is pinned here is what this
 * host adds — the code and the per-code, per-profile watermark it keeps, its
 * `fetch` and `studySessions` lent to the wasm `taal` export, one push at a
 * time with one queued behind it, and the record Settings shows.
 *
 * The store is the real one — the same wasm core, in memory. Only `fetch` is fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TestBackend } from '$lib/db/backend.testing';

const { setBackendForTesting } = await import('$lib/db/backend');
const { makeTestBackend } = await import('$lib/db/backend.testing');
const { createProfile, recordStudy, saveProfile, setActiveProfile } =
	await import('$lib/db/repositories');
const { pushTaal } = await import('./run');
const { clearTaalCode, getPushedThrough, getTaalCode, lastTaalOutcome, setTaalCode } =
	await import('./config');
const { BAD_CODE, isTaalCode, REFUSED } = await import('./core');

const CODE = `${'a'.repeat(20)}.${'B'.repeat(32)}`;
const OTHER = `${'c'.repeat(20)}.${'D'.repeat(32)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

const PROFILE = {
	nativeLanguage: 'English',
	targetLanguage: 'Dutch',
	level: 'beginner' as const,
	interests: [],
	model: 'model',
	createdAt: 1
};

let store: TestBackend;

beforeEach(async () => {
	vi.stubGlobal('localStorage', new MemoryStorage());
	store = await makeTestBackend('devA');
	setBackendForTesting(store);
	await saveProfile(PROFILE);
});

interface Sent {
	url: string;
	body: {
		writes: [
			{ update: { name: string } },
			{ updateMask: { fieldPaths: string[] }; update: { fields: unknown } }
		];
	};
}

/** Answers every POST with `status`, or each with the next of `statuses`. */
function fakeTaal(...statuses: number[]) {
	const sent: Sent[] = [];
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Sent['body'] });
		const status = statuses[Math.min(sent.length - 1, statuses.length - 1)] ?? 200;
		return new Response('{}', { status });
	});
	return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
}

async function activeId(): Promise<string> {
	const profiles = await store.listProfiles();
	return profiles.find((profile) => profile.active)!.id;
}

describe('the code', () => {
	it('is validated before it is stored', () => {
		expect(isTaalCode(` ${CODE}\n`)).toBe(true);
		expect(setTaalCode('not a code')).toBeUndefined();
		expect(getTaalCode()).toBeUndefined();
		expect(setTaalCode(` ${CODE} `)).toBe(CODE);
		expect(getTaalCode()).toBe(CODE);
		expect(BAD_CODE).toBe('This is not a Taal code.');
	});
});

describe('pushTaal', () => {
	it('is a no-op without a code', async () => {
		const { sent, fetchImpl } = fakeTaal();
		await recordStudy('t1', Date.now() - HOUR, 10 * 60_000);
		expect(await pushTaal(fetchImpl)).toBeUndefined();
		expect(sent).toHaveLength(0);
		expect(lastTaalOutcome()).toBeUndefined();
	});

	it('sends the active profile’s sessions under its id and keeps the watermark', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - 2 * HOUR, 10 * 60_000);
		const { sent, fetchImpl } = fakeTaal(200);
		const before = Date.now();

		const outcome = await pushTaal(fetchImpl);

		expect(outcome).toMatchObject({ status: 'ok', sent: 1 });
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toContain('/documents:commit?key=');
		expect(sent[0].body.writes[0].update.name).toMatch(/\/appInbox\/a{20}$/);
		const profile = await activeId();
		const [path] = sent[0].body.writes[1].updateMask.fieldPaths;
		expect(path).toMatch(new RegExp(`^sessions\\.\`${profile}-input-\\d+\`$`));
		expect(getPushedThrough(CODE, profile)).toBeGreaterThanOrEqual(before);
		expect(lastTaalOutcome()).toMatchObject({ status: 'ok', okAt: expect.any(Number) });
	});

	it('reads from the re-send margin after a whole push', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - 5 * DAY, 10 * 60_000);
		await recordStudy('t1', Date.now() - 3 * HOUR, 10 * 60_000);
		const { sent, fetchImpl } = fakeTaal(200);

		await pushTaal(fetchImpl);
		await pushTaal(fetchImpl);

		const sizes = sent.map((request) => request.body.writes[1].updateMask.fieldPaths.length);
		// The first backfills both; the second re-sends only the last 48 hours.
		expect(sizes).toEqual([2, 1]);
	});

	it('keeps a watermark per profile', async () => {
		setTaalCode(CODE);
		const first = await activeId();
		const { fetchImpl } = fakeTaal(200);
		await pushTaal(fetchImpl);
		expect(getPushedThrough(CODE, first)).toBeDefined();

		const second = await createProfile({ ...PROFILE, targetLanguage: 'French' });
		await setActiveProfile(second);
		expect(getPushedThrough(CODE, second)).toBeUndefined();
		await pushTaal(fetchImpl);
		expect(getPushedThrough(CODE, second)).toBeDefined();
		expect(getPushedThrough(CODE, first)).toBeDefined();
	});

	it('records a refusal without moving the watermark, and tries again next time', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - HOUR, 10 * 60_000);
		const { sent, fetchImpl } = fakeTaal(403, 200);

		expect(await pushTaal(fetchImpl)).toMatchObject({ status: 'refused', message: REFUSED });
		expect(getPushedThrough(CODE, await activeId())).toBeUndefined();
		expect(lastTaalOutcome()).toMatchObject({ status: 'refused', message: REFUSED });

		expect(await pushTaal(fetchImpl)).toMatchObject({ status: 'ok' });
		expect(sent).toHaveLength(2);
	});

	it('records a failure and keeps when it last landed', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - HOUR, 10 * 60_000);
		await pushTaal(fakeTaal(200).fetchImpl);
		const okAt = lastTaalOutcome()?.okAt;

		const offline = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}) as unknown as typeof fetch;
		expect(await pushTaal(offline)).toMatchObject({ status: 'failed' });
		expect(lastTaalOutcome()).toMatchObject({ status: 'failed', okAt });
	});

	it('runs one push at a time and queues exactly one behind it', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - HOUR, 10 * 60_000);
		const { sent, fetchImpl } = fakeTaal(200);

		const first = pushTaal(fetchImpl);
		const second = pushTaal(fetchImpl);
		const third = pushTaal(fetchImpl);
		expect(third).toBe(second);
		await Promise.all([first, second, third]);

		expect(sent).toHaveLength(2);
	});

	it('starts over when the code changes, and forgets everything on disconnect', async () => {
		setTaalCode(CODE);
		await recordStudy('t1', Date.now() - HOUR, 10 * 60_000);
		await pushTaal(fakeTaal(200).fetchImpl);
		const profile = await activeId();
		expect(getPushedThrough(CODE, profile)).toBeDefined();

		setTaalCode(OTHER);
		expect(getPushedThrough(OTHER, profile)).toBeUndefined();
		expect(getPushedThrough(CODE, profile)).toBeUndefined();
		expect(lastTaalOutcome()).toBeUndefined();

		await pushTaal(fakeTaal(200).fetchImpl);
		clearTaalCode();
		expect(getTaalCode()).toBeUndefined();
		expect(getPushedThrough(OTHER, profile)).toBeUndefined();
		expect(lastTaalOutcome()).toBeUndefined();
	});
});
