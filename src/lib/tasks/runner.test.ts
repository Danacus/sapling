import { describe, expect, it } from 'vitest';
import { LlmError } from '$lib/llm';
import { MAX_KEPT_TASKS, createRunner, rootOf } from './runner';
import type { TaskContext, TaskKindDef } from './types';

/** A job the test finishes by hand. */
interface Gate<R = string> {
	resolve: (value: R) => void;
	reject: (cause: unknown) => void;
	ctx: TaskContext;
	input: unknown;
}

/** A kind whose every run parks until the test releases it. */
function gated<R = string>(serial: boolean, extra: Partial<TaskKindDef<unknown, R>> = {}) {
	const gates: Gate<R>[] = [];
	const def: TaskKindDef<unknown, R> = {
		serial,
		title: (input) => `job ${String(input)}`,
		summary: (result) => `got ${String(result)}`,
		run: (input, ctx) =>
			new Promise<R>((resolve, reject) => {
				gates.push({ resolve, reject, ctx, input });
			}),
		...extra
	};
	return { def, gates };
}

function clock() {
	let t = 1000;
	return { now: () => t, tick: (ms: number) => (t += ms) };
}

function ids() {
	let n = 0;
	return () => `t${++n}`;
}

/** Lets the runner's promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createRunner: lifecycle', () => {
	it('runs a task through queued → running → done and summarises it', async () => {
		const c = clock();
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { now: c.now, newId: ids() });

		const started = runner.start('slow', 'a');
		const [running] = runner.list();
		expect(running).toMatchObject({
			id: 't1',
			kind: 'slow',
			title: 'job a',
			status: 'running',
			queuedAt: 1000,
			startedAt: 1000,
			retryable: true,
			cancellable: true
		});

		c.tick(500);
		slow.gates[0].resolve('ok');
		await expect(started.done).resolves.toEqual({ status: 'done', result: 'ok' });
		expect(runner.list()[0]).toMatchObject({ status: 'done', finishedAt: 1500, summary: 'got ok' });
	});

	it('closes steps in order and the last one on settle', async () => {
		const c = clock();
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { now: c.now, newId: ids() });
		runner.start('slow', 'a');
		const { ctx, resolve } = slow.gates[0];

		ctx.step('one', 'First');
		c.tick(100);
		ctx.step('two', 'Second');
		expect(runner.list()[0].steps).toEqual([
			{ id: 'one', label: 'First', startedAt: 1000, endedAt: 1100 },
			{ id: 'two', label: 'Second', startedAt: 1100 }
		]);

		c.tick(50);
		resolve('ok');
		await flush();
		expect(runner.list()[0].steps[1]).toEqual({
			id: 'two',
			label: 'Second',
			startedAt: 1100,
			endedAt: 1150
		});
	});

	it('records progress and replaces it on every report', () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		const { ctx } = slow.gates[0];

		ctx.progress(1, 4, 'calls');
		expect(runner.list()[0].progress).toEqual({ done: 1, total: 4, unit: 'calls' });
		ctx.progress(3, 4);
		expect(runner.list()[0].progress).toEqual({ done: 3, total: 4 });
	});

	it('fails with the error message, and an LlmError message verbatim', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });

		const a = runner.start('slow', 'a');
		slow.gates[0].reject(new LlmError('rate-limit', 'Too many requests. Try again in a minute.'));
		await expect(a.done).resolves.toEqual({
			status: 'failed',
			error: 'Too many requests. Try again in a minute.'
		});

		const b = runner.start('slow', 'b');
		slow.gates[1].reject(new Error('boom'));
		await expect(b.done).resolves.toEqual({ status: 'failed', error: 'boom' });

		const c = runner.start('slow', 'c');
		slow.gates[2].reject('not an error');
		await expect(c.done).resolves.toEqual({ status: 'failed', error: 'Something went wrong.' });
		expect(runner.list().map((task) => task.status)).toEqual(['failed', 'failed', 'failed']);
	});

	it('treats a run that throws synchronously as a failure', async () => {
		const runner = createRunner(
			{
				bad: {
					serial: false,
					title: () => 'bad',
					summary: () => '',
					run: () => {
						throw new Error('sync');
					}
				} satisfies TaskKindDef<undefined, void>
			},
			{ newId: ids() }
		);
		await expect(runner.start('bad', undefined).done).resolves.toEqual({
			status: 'failed',
			error: 'sync'
		});
	});

	it('maps an AbortError thrown by the job to cancelled', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		const a = runner.start('slow', 'a');
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		slow.gates[0].reject(abort);
		await expect(a.done).resolves.toEqual({ status: 'cancelled' });
	});
});

describe('createRunner: cancel', () => {
	it('settles a running task as cancelled at once, fires its signal, and drops a late result', async () => {
		const c = clock();
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { now: c.now, newId: ids() });
		const a = runner.start('slow', 'a');
		slow.gates[0].ctx.step('one', 'First');

		c.tick(30);
		runner.cancel('t1');
		expect(slow.gates[0].ctx.signal.aborted).toBe(true);
		expect(runner.list()[0]).toMatchObject({ status: 'cancelled', finishedAt: 1030 });
		expect(runner.list()[0].steps[0].endedAt).toBe(1030);
		await expect(a.done).resolves.toEqual({ status: 'cancelled' });

		// The job resolves anyway, later: nothing changes.
		slow.gates[0].resolve('late');
		await flush();
		expect(runner.list()[0].status).toBe('cancelled');
		expect(runner.list()[0].summary).toBeUndefined();
	});

	it('cancels a queued task without ever running it', async () => {
		const slow = gated(true);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		const b = runner.start('slow', 'b');
		expect(runner.list()[1].status).toBe('queued');

		runner.cancel('t2');
		await expect(b.done).resolves.toEqual({ status: 'cancelled' });
		expect(slow.gates).toHaveLength(1);

		// And the running one is untouched.
		slow.gates[0].resolve('ok');
		await flush();
		expect(runner.list().map((task) => task.status)).toEqual(['done', 'cancelled']);
	});

	it('is a no-op on a settled task', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].resolve('ok');
		await flush();
		runner.cancel('t1');
		expect(runner.list()[0].status).toBe('done');
	});
});

describe('createRunner: serial kinds', () => {
	it('queues a second task of a serial kind and starts it when the first settles', async () => {
		const slow = gated(true);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		runner.start('slow', 'b');
		expect(runner.list().map((task) => task.status)).toEqual(['running', 'queued']);
		expect(slow.gates).toHaveLength(1);

		slow.gates[0].resolve('ok');
		await flush();
		expect(runner.list().map((task) => task.status)).toEqual(['done', 'running']);
		expect(slow.gates).toHaveLength(2);
		expect(slow.gates[1].input).toBe('b');
	});

	it('starts the next queued task when the running one is cancelled', () => {
		const slow = gated(true);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		runner.start('slow', 'b');
		runner.cancel('t1');
		expect(runner.list().map((task) => task.status)).toEqual(['cancelled', 'running']);
	});

	it('runs different kinds concurrently, and a non-serial kind concurrently with itself', () => {
		const slow = gated(true);
		const quick = gated(false);
		const runner = createRunner({ slow: slow.def, quick: quick.def }, { newId: ids() });
		runner.start('slow', 'a');
		runner.start('quick', 'b');
		runner.start('quick', 'c');
		expect(runner.list().map((task) => task.status)).toEqual(['running', 'running', 'running']);
	});
});

describe('createRunner: retry, dismiss, cap, subscribe', () => {
	it('retries a failed task as a new task with the same input', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].reject(new Error('boom'));
		await flush();

		const again = runner.retry('t1');
		expect(again?.id).toBe('t2');
		expect(slow.gates[1].input).toBe('a');
		expect(runner.list().map((task) => task.status)).toEqual(['failed', 'running']);
	});

	it('stamps a retry with the task it came from', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].reject(new Error('boom'));
		await flush();

		runner.retry('t1');
		expect(runner.list()[0].retryOf).toBeUndefined();
		expect(runner.list()[1].retryOf).toBe('t1');
	});

	it('chains a retry of a retry onto its immediate predecessor', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].reject(new Error('boom'));
		await flush();
		runner.retry('t1');
		slow.gates[1].reject(new Error('boom again'));
		await flush();
		runner.retry('t2');

		expect(runner.list().map((task) => task.retryOf)).toEqual([undefined, 't1', 't2']);
	});

	it('hands the outcome of a retry to whoever holds its id', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].reject(new Error('boom'));
		await flush();

		// The tray discards what `retry` returns, so this is the only way back to
		// the value — and the page that started 't1' has only ever held that id.
		const again = runner.retry('t1');
		slow.gates[1].resolve('ok');
		await flush();
		await expect(runner.outcomeOf('slow', again?.id as string)).resolves.toEqual({
			status: 'done',
			result: 'ok'
		});

		expect(runner.outcomeOf('slow', 'nope')).toBeUndefined();
		runner.dismiss('t2');
		expect(runner.outcomeOf('slow', 't2')).toBeUndefined();
	});

	it('refuses to retry a running, done, unknown or non-retryable task', async () => {
		const slow = gated(false);
		const fixed = gated(false, { retryable: false });
		const runner = createRunner({ slow: slow.def, fixed: fixed.def }, { newId: ids() });

		runner.start('slow', 'a');
		expect(runner.retry('t1')).toBeUndefined();
		slow.gates[0].resolve('ok');
		await flush();
		expect(runner.retry('t1')).toBeUndefined();
		expect(runner.retry('nope')).toBeUndefined();

		runner.start('fixed', 'b');
		fixed.gates[0].reject(new Error('boom'));
		await flush();
		expect(runner.list()[1].retryable).toBe(false);
		expect(runner.retry('t2')).toBeUndefined();
	});

	it('dismisses only settled tasks', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		runner.dismiss('t1');
		expect(runner.list()).toHaveLength(1);
		slow.gates[0].resolve('ok');
		await flush();
		runner.dismiss('t1');
		expect(runner.list()).toHaveLength(0);
	});

	it('keeps at most MAX_KEPT_TASKS settled tasks, dropping the oldest', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids(), maxKept: 3 });
		for (let i = 0; i < 5; i++) runner.start('slow', String(i));
		// A running one is never dropped, however many settled ones there are.
		for (let i = 0; i < 4; i++) slow.gates[i].resolve('ok');
		await flush();
		expect(runner.list().map((task) => task.id)).toEqual(['t2', 't3', 't4', 't5']);
		expect(runner.list()[3].status).toBe('running');
		expect(MAX_KEPT_TASKS).toBe(20);
	});

	it('notifies subscribers with a fresh list on every change, until unsubscribed', async () => {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		const seen: string[][] = [];
		const stop = runner.subscribe((tasks) => seen.push(tasks.map((task) => task.status)));

		runner.start('slow', 'a');
		slow.gates[0].ctx.step('one', 'First');
		slow.gates[0].ctx.progress(1, 2);
		slow.gates[0].resolve('ok');
		await flush();
		expect(seen).toEqual([['running'], ['running'], ['running'], ['done']]);
		expect(seen[0]).not.toBe(seen[1]);

		stop();
		runner.start('slow', 'b');
		expect(seen).toHaveLength(4);
	});

	it('cancellable: false is carried onto the record', () => {
		const stuck = gated(true, { cancellable: false });
		const runner = createRunner({ stuck: stuck.def }, { newId: ids() });
		runner.start('stuck', 'a');
		expect(runner.list()[0].cancellable).toBe(false);
	});
});

describe('rootOf', () => {
	/** A runner whose 't1' has been retried twice, and one unrelated task beside it. */
	async function chained() {
		const slow = gated(false);
		const runner = createRunner({ slow: slow.def }, { newId: ids() });
		runner.start('slow', 'a');
		slow.gates[0].reject(new Error('boom'));
		await flush();
		runner.retry('t1');
		slow.gates[1].reject(new Error('boom'));
		await flush();
		runner.retry('t2');
		runner.start('slow', 'someone else');
		return runner;
	}

	it('follows a two-step chain back to the id the page started', async () => {
		const runner = await chained();
		expect(rootOf(runner.list(), 't3')).toBe('t1');
		expect(rootOf(runner.list(), 't2')).toBe('t1');
	});

	it('is its own id for a task nobody retried, and for one nobody has heard of', async () => {
		const runner = await chained();
		expect(rootOf(runner.list(), 't1')).toBe('t1');
		expect(rootOf(runner.list(), 't4')).toBe('t4');
		expect(rootOf(runner.list(), 'nope')).toBe('nope');
	});

	it('still answers the page after the failed original was dismissed', async () => {
		const runner = await chained();
		// The first thing a learner does with a failure they have retried.
		runner.dismiss('t1');
		expect(runner.list().map((task) => task.id)).toEqual(['t2', 't3', 't4']);

		// 't2' still names 't1', so the id the page has been holding all along is
		// still the answer — a dismissed record loses its row, not its name.
		expect(rootOf(runner.list(), 't3')).toBe('t1');
		expect(rootOf(runner.list(), 't2')).toBe('t1');
	});

	it('stops at the last id it can still read, which is where the walk ends', async () => {
		const runner = await chained();
		// Dismissing the *middle* of a chain is the one thing that shortens it:
		// the link from 't2' to 't1' went with the record. A page therefore
		// adopts each descendant's id as it appears rather than re-deriving the
		// root from scratch — see `/read`'s effect.
		runner.dismiss('t1');
		runner.dismiss('t2');
		expect(rootOf(runner.list(), 't3')).toBe('t2');
	});
});
