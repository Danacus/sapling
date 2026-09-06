import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openTauriBackend } from './tauri';

/**
 * The one thing this transport has that the Worker's does not: an order.
 *
 * The Worker's message queue delivers first-in-first-out, so two backend calls
 * issued without awaiting run in the order they were made. Tauri's `async`
 * commands run on a thread pool and give no such promise, so `tauri.ts` chains
 * every `invoke` behind the previous one. These cases pin that chain — and that
 * a failure does not break it — with a fake `invoke` that answers out of order
 * on purpose.
 */

/** Set per test; the mocked `invoke` calls it. */
let answer: (method: string, args: unknown[]) => Promise<string | null>;

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (_command: string, payload: { method: string; args: string }) =>
		answer(payload.method, JSON.parse(payload.args) as unknown[])
}));

/** A promise plus the handles to settle it later. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Lets every already-queued microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	answer = () => Promise.resolve('0');
});

describe('openTauriBackend', () => {
	it('probes with poolSize and parses the answer', async () => {
		const seen: string[] = [];
		answer = (method) => {
			seen.push(method);
			return Promise.resolve(method === 'poolSize' ? '7' : 'null');
		};

		const backend = await openTauriBackend();
		expect(seen).toEqual(['poolSize']);
		await expect(backend.poolSize()).resolves.toBe(7);
	});

	it('reads nothing back as undefined, not null', async () => {
		answer = () => Promise.resolve(null);
		const backend = await openTauriBackend();
		await expect(backend.getItem('missing')).resolves.toBeUndefined();
	});

	it('rejects with an Error carrying the command’s reason', async () => {
		const backend = await openTauriBackend();
		answer = () => Promise.reject('The database could not be opened: no such file');
		await expect(backend.poolSize()).rejects.toThrow(
			'The database could not be opened: no such file'
		);
	});

	it('reaches the core in the order the calls were made, however they resolve', async () => {
		const backend = await openTauriBackend();

		const entered: string[] = [];
		const gates = new Map<string, ReturnType<typeof deferred<string>>>();
		answer = (method) => {
			entered.push(method);
			const gate = deferred<string>();
			gates.set(method, gate);
			return gate.promise;
		};

		// Three calls, none awaited — what a component that fires a write and
		// then reads does.
		const results = [backend.poolSize(), backend.getPullCursor(), backend.getProfile()];
		await settle();

		// Only the first is in flight: the second cannot start before it settles.
		expect(entered).toEqual(['poolSize']);

		// Answer them in the reverse of the order they will be issued in, so an
		// unchained transport would visibly interleave.
		gates.get('poolSize')!.resolve('1');
		await settle();
		expect(entered).toEqual(['poolSize', 'getPullCursor']);

		gates.get('getPullCursor')!.resolve('"cursor"');
		await settle();
		expect(entered).toEqual(['poolSize', 'getPullCursor', 'getProfile']);

		gates.get('getProfile')!.resolve('null');
		await expect(Promise.all(results)).resolves.toEqual([1, 'cursor', null]);
	});

	it('does not wedge the queue when a call fails', async () => {
		const backend = await openTauriBackend();

		const entered: string[] = [];
		answer = (method) => {
			entered.push(method);
			return method === 'getPullCursor'
				? Promise.reject('the database is closed')
				: Promise.resolve('2');
		};

		const failing = backend.getPullCursor();
		const following = backend.poolSize();

		await expect(failing).rejects.toThrow('the database is closed');
		await expect(following).resolves.toBe(2);
		expect(entered).toEqual(['getPullCursor', 'poolSize']);
	});
});
