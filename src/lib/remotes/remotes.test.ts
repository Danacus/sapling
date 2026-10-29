/**
 * The runner and the single-flight helper, over fake remotes: the order a pass
 * runs them in, what an unconfigured or failing one costs the others, and how
 * a burst of triggers coalesces. What each real remote does is its own
 * module's test (`$lib/sync/run.test.ts`, `$lib/taal/run.test.ts`); the
 * adapters are pinned here only where they map an outcome.
 */
import { describe, expect, it, vi } from 'vitest';

import { singleFlight } from './flight';
import { REMOTES } from './index';
import { remoteTrigger, runRemotes } from './runner';
import { taalOutcome } from './taal';
import type { Remote, RemoteId, RemoteOutcome } from './types';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => (resolve = done));
	return { promise, resolve };
}

const OK: RemoteOutcome = { ok: true, pushed: 0, pulled: 0, summary: 'ok' };

/** A remote that logs `start:<id>` and `end:<id>` around an optional wait. */
function fake(
	id: RemoteId,
	log: string[],
	options: {
		pulls?: boolean;
		configured?: boolean;
		outcome?: RemoteOutcome;
		fail?: 'throw' | 'reject';
		wait?: Promise<void>;
	} = {}
): Remote & { run: ReturnType<typeof vi.fn> } {
	return {
		id,
		pulls: options.pulls ?? false,
		configured: () => options.configured ?? true,
		run: vi.fn(async () => {
			log.push(`start:${id}`);
			if (options.fail === 'throw') throw new Error('broken');
			await options.wait;
			log.push(`end:${id}`);
			return options.outcome ?? OK;
		})
	};
}

describe('runRemotes', () => {
	it('runs the pullers to the end before any send-only remote starts', async () => {
		const log: string[] = [];
		const sender = fake('taal', log);
		const puller = fake('sync', log, { pulls: true, outcome: { ...OK, pulled: 3 } });

		// Listed sender first, to show the order is the runner's, not the list's.
		await runRemotes([sender, puller]);

		expect(log).toEqual(['start:sync', 'end:sync', 'start:taal', 'end:taal']);
	});

	it('still runs the send-only remotes when nothing came down', async () => {
		const log: string[] = [];
		const puller = fake('sync', log, { pulls: true, outcome: { ...OK, pulled: 0 } });
		const sender = fake('taal', log);

		await runRemotes([puller, sender]);

		expect(sender.run).toHaveBeenCalledTimes(1);
	});

	it('skips a remote that is not set up, without running it', async () => {
		const log: string[] = [];
		const puller = fake('sync', log, { pulls: true, configured: false });
		const sender = fake('taal', log);

		await runRemotes([puller, sender]);

		expect(puller.run).not.toHaveBeenCalled();
		expect(log).toEqual(['start:taal', 'end:taal']);
	});

	it('lets neither a throwing nor a failing remote stop the others, and never rejects', async () => {
		const log: string[] = [];
		const broken = fake('sync', log, { pulls: true, fail: 'throw' });
		const failing = fake('taal', log, { outcome: { ...OK, ok: false, summary: 'refused' } });
		const after = fake('taal', log);

		await expect(runRemotes([broken, failing, after])).resolves.toBeUndefined();

		expect(failing.run).toHaveBeenCalledTimes(1);
		expect(after.run).toHaveBeenCalledTimes(1);
	});

	it('treats a remote whose configuration check throws as not set up', async () => {
		const log: string[] = [];
		const odd: Remote = {
			...fake('sync', log),
			configured: () => {
				throw new Error('storage');
			}
		};
		const sender = fake('taal', log);

		await runRemotes([odd, sender]);

		expect(log).toEqual(['start:taal', 'end:taal']);
	});
});

describe('remoteTrigger', () => {
	it('turns three overlapping triggers into two runs of every remote', async () => {
		const log: string[] = [];
		const gate = deferred();
		const puller = fake('sync', log, { pulls: true, wait: gate.promise });
		const sender = fake('taal', log);
		const trigger = remoteTrigger([puller, sender]);

		const first = trigger();
		const second = trigger();
		const third = trigger();
		expect(third).toBe(second);

		gate.resolve();
		await Promise.all([first, second, third]);

		expect(puller.run).toHaveBeenCalledTimes(2);
		expect(sender.run).toHaveBeenCalledTimes(2);
	});
});

describe('singleFlight', () => {
	it('runs now, queues one behind a running run, and joins later calls to it', async () => {
		const gate = deferred();
		let runs = 0;
		const job = singleFlight(async (label: string) => {
			runs += 1;
			if (runs === 1) await gate.promise;
			return `${label}#${runs}`;
		});

		const first = job('a');
		const second = job('b');
		const third = job('c');
		expect(third).toBe(second);
		expect(runs).toBe(1);

		gate.resolve();
		// The queued run takes the arguments of the call that queued it.
		expect(await first).toBe('a#1');
		expect(await second).toBe('b#2');
		expect(await job('d')).toBe('d#3');
	});

	it('starts the queued run even when the running one rejects', async () => {
		const gate = deferred();
		let runs = 0;
		const job = singleFlight(async () => {
			runs += 1;
			if (runs === 1) {
				await gate.promise;
				throw new Error('first failed');
			}
			return runs;
		});

		const first = job();
		const second = job();
		gate.resolve();

		await expect(first).rejects.toThrow('first failed');
		expect(await second).toBe(2);
	});
});

describe('the registry', () => {
	it('lists sync as the one puller and Taal as send-only', () => {
		expect(REMOTES.sync).toMatchObject({ id: 'sync', pulls: true });
		expect(REMOTES.taal).toMatchObject({ id: 'taal', pulls: false });
	});

	it('maps Taal’s outcomes onto a remote outcome', () => {
		expect(taalOutcome(undefined)).toMatchObject({ ok: true, skipped: true, pushed: 0 });
		expect(taalOutcome({ status: 'ok', sent: 4, message: 'Sent 4.' })).toEqual({
			ok: true,
			pushed: 4,
			pulled: 0,
			summary: 'Sent 4.'
		});
		for (const status of ['refused', 'failed', 'invalid'] as const) {
			expect(taalOutcome({ status, sent: 0, message: 'no' })).toEqual({
				ok: false,
				pushed: 0,
				pulled: 0,
				summary: 'no'
			});
		}
	});
});
