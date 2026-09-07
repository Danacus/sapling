/**
 * The task runner: one lifecycle for every long job in the app.
 *
 * A page starts a task and is then free to go — the runner owns the
 * `AbortController`, the status, the step ledger and the progress fraction,
 * and it keeps them in module state that outlives any component, which is
 * what lets the learner practise while a lesson is being written and still
 * find the ledger where they left it. Pages *read* task state (through
 * `./store.svelte`) and never hold their own.
 *
 * Built as a factory so the tests can run it over fake kinds with a fake
 * clock; `./singleton` makes the one instance the app uses.
 *
 * **Serial per kind, concurrent across kinds.** A kind that says `serial`
 * runs one task at a time and later ones wait as `queued`: two top-ups would
 * ask for the same wants twice, and two annotations would trip the same rate
 * limit. Different kinds have nothing to do with one another and run
 * together.
 *
 * **Cancel is immediate and means "stop waiting".** The task's signal fires
 * and its record settles as `cancelled` right away; whatever the job does
 * with the signal is its own business (`$lib/llm` unwinds at its fetch, the
 * voice download does not listen at all), and if it later resolves anyway the
 * result is dropped. A kind whose job ignores the signal says so with
 * `cancellable: false`, so the tray can word the button honestly.
 *
 * **In memory only.** A reload loses every record. That is deliberate: a
 * request that dies with the tab cannot be resumed, only re-run, and the
 * pool, the texts and the readings all land through their own repositories
 * the moment a job finishes, so nothing is lost but the ledger.
 *
 * **Retry is a new record, and it says where it came from.** Re-running a
 * failed input mints a fresh task with a fresh outcome promise — the tray,
 * which is where Retry is pressed, throws that promise away — so the record
 * carries `retryOf` and `rootOf` walks the chain back. A page that must act on
 * an outcome watches records descending from the id it started rather than
 * awaiting the one promise it was handed, and reads the value out of
 * `outcomeOf`, which is addressable by id for exactly that reason.
 */

import type {
	TaskContext,
	TaskKindDef,
	TaskOutcome,
	TaskRecord,
	TaskStatus,
	TaskStep
} from './types';
import { SETTLED } from './types';

/** How many settled tasks stay listed before the oldest are dropped. */
export const MAX_KEPT_TASKS = 20;

/** Any registry shape: kind name → def. */
export type TaskDefs = Record<string, TaskKindDef<never, unknown>>;

// The registry's defs are typed with their own concrete inputs, which makes
// each *contravariant* in `I` and so not assignable to `TaskKindDef<never, …>`
// without these projections. `InputOf`/`ResultOf` recover the concrete types
// for callers; the runner itself only ever holds an input as `unknown`.
export type InputOf<D> = D extends { run(input: infer I, ctx: TaskContext): Promise<unknown> }
	? I
	: never;
export type ResultOf<D> = D extends { run(input: never, ctx: TaskContext): Promise<infer R> }
	? R
	: never;

/** What `start` hands back: the record's id, and how it ends. */
export interface StartedTask<R> {
	id: string;
	/** Never rejects — see {@link TaskOutcome}. */
	done: Promise<TaskOutcome<R>>;
}

export interface RunnerOptions {
	/** Epoch ms; injectable for the tests. */
	now?: () => number;
	/** Task ids; injectable for the tests. */
	newId?: () => string;
	/** Overrides {@link MAX_KEPT_TASKS}. */
	maxKept?: number;
}

export interface TaskRunner<Defs extends TaskDefs> {
	start<K extends keyof Defs & string>(
		kind: K,
		input: InputOf<Defs[K]>
	): StartedTask<ResultOf<Defs[K]>>;
	/** Settles the task as `cancelled` now and fires its signal. No-op once settled. */
	cancel(id: string): void;
	/**
	 * Runs a failed or cancelled task's input again as a **new** task whose
	 * record names this one in `retryOf`, and returns it; `undefined` when the
	 * task is unknown, unsettled, still `done`, or not retryable.
	 */
	retry(id: string): StartedTask<unknown> | undefined;
	/**
	 * How a listed task ended — the same promise `start` handed out, addressable
	 * by id so a *retry*, whose `StartedTask` the tray discarded, can still be
	 * read by the page that cares about it. `undefined` for an unknown id, a
	 * record of another kind, or one already dismissed or trimmed away; the
	 * `kind` is checked rather than trusted, which is what makes the result type
	 * sound.
	 */
	outcomeOf<K extends keyof Defs & string>(
		kind: K,
		id: string
	): Promise<TaskOutcome<ResultOf<Defs[K]>>> | undefined;
	/** Drops a settled task from the list. No-op while it is queued or running. */
	dismiss(id: string): void;
	/** Every task the runner still lists, oldest first. */
	list(): TaskRecord<keyof Defs & string>[];
	/** Called with the fresh list after every change. Returns the unsubscribe. */
	subscribe(listener: (tasks: TaskRecord<keyof Defs & string>[]) => void): () => void;
}

function defaultId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `t_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** An abort is a cancellation, whichever layer raised it. */
function isAbort(cause: unknown, signal: AbortSignal): boolean {
	if (signal.aborted) return true;
	return cause instanceof Error && cause.name === 'AbortError';
}

function messageOf(cause: unknown): string {
	if (cause instanceof Error && cause.message.trim()) return cause.message;
	return 'Something went wrong.';
}

/** Closes whichever step is still open, at `at`. */
function closeSteps(steps: readonly TaskStep[], at: number): TaskStep[] {
	return steps.map((step) => (step.endedAt === undefined ? { ...step, endedAt: at } : step));
}

/**
 * The id a chain of retries started from, so a page can ask "is this record
 * mine?" without walking `retryOf` itself.
 *
 * The walk stops at whatever `retryOf` last named, **listed or not**: the
 * failed original is usually the first thing dismissed from the tray, and its
 * id is still the one the page is holding. So the root of a task that was never
 * retried is its own id, and the root of an id the runner has never heard of is
 * that id — a page comparing against its own set gets `false` either way.
 */
export function rootOf(tasks: readonly TaskRecord[], id: string): string {
	let root = id;
	// Bounded by the list, because a `retryOf` only ever names a task minted
	// before it: the walk can go backwards through the list and nowhere else.
	for (let step = 0; step < tasks.length; step++) {
		const parent = tasks.find((task) => task.id === root)?.retryOf;
		if (parent === undefined) break;
		root = parent;
	}
	return root;
}

export function createRunner<Defs extends TaskDefs>(
	defs: Defs,
	options: RunnerOptions = {}
): TaskRunner<Defs> {
	type Kind = keyof Defs & string;
	type Record_ = TaskRecord<Kind>;

	const now = options.now ?? Date.now;
	const newId = options.newId ?? defaultId;
	const maxKept = options.maxKept ?? MAX_KEPT_TASKS;

	let tasks: Record_[] = [];
	const listeners = new Set<(tasks: Record_[]) => void>();

	// Per task: what started it (kept for retry), its stop switch, and the
	// outcome promise with its resolver — the promise as well as the resolver,
	// because `outcomeOf` hands it to whoever holds the id and a retry's was
	// never handed to anyone. Per serial kind: whether one is running, and who
	// is waiting behind it.
	const inputs = new Map<string, unknown>();
	const controllers = new Map<string, AbortController>();
	const outcomes = new Map<string, Promise<TaskOutcome<unknown>>>();
	const resolvers = new Map<string, (outcome: TaskOutcome<unknown>) => void>();
	const busy = new Set<Kind>();
	const waiting = new Map<Kind, string[]>();

	function notify(): void {
		const snapshot = tasks.slice();
		for (const listener of listeners) listener(snapshot);
	}

	function get(id: string): Record_ | undefined {
		return tasks.find((task) => task.id === id);
	}

	function update(id: string, patch: Partial<Record_>): Record_ | undefined {
		const index = tasks.findIndex((task) => task.id === id);
		if (index < 0) return undefined;
		const next = { ...tasks[index], ...patch };
		tasks = [...tasks.slice(0, index), next, ...tasks.slice(index + 1)];
		return next;
	}

	/** Drops the oldest settled tasks past the cap. Records only; never a running one. */
	function trim(): void {
		let settled = tasks.filter((task) => SETTLED.has(task.status)).length;
		if (settled <= maxKept) return;
		tasks = tasks.filter((task) => {
			if (!SETTLED.has(task.status) || settled <= maxKept) return true;
			settled--;
			forget(task.id);
			return false;
		});
	}

	function forget(id: string): void {
		inputs.delete(id);
		controllers.delete(id);
		outcomes.delete(id);
		resolvers.delete(id);
	}

	/**
	 * The one place a task reaches a terminal status. Idempotent. The result
	 * goes to the outcome promise only — the record carries its `summary`, never
	 * the value itself, which may be a whole text.
	 */
	function settle(id: string, status: TaskStatus, extra: Partial<Record_>, result?: unknown): void {
		const task = get(id);
		if (!task || SETTLED.has(task.status)) return;
		const at = now();
		update(id, { ...extra, status, finishedAt: at, steps: closeSteps(task.steps, at) });

		const resolve = resolvers.get(id);
		resolvers.delete(id);
		if (resolve) {
			if (status === 'done') resolve({ status, result });
			else if (status === 'failed') resolve({ status, error: extra.error ?? messageOf(undefined) });
			else resolve({ status: 'cancelled' });
		}

		// A serial kind moves on to whoever was waiting — on a cancel too, since
		// a cancelled task is one nobody is waiting for any more.
		const kind = task.kind;
		if (defs[kind].serial && busy.has(kind)) {
			busy.delete(kind);
			const next = waiting.get(kind)?.shift();
			if (next !== undefined) execute(next);
		}

		trim();
		notify();
	}

	function execute(id: string): void {
		const task = get(id);
		// Cancelled while it was still queued: nothing to run.
		if (!task || task.status !== 'queued') return;
		const def = defs[task.kind];
		const controller = controllers.get(id) as AbortController;
		if (def.serial) busy.add(task.kind);

		update(id, { status: 'running', startedAt: now() });
		notify();

		const ctx: TaskContext = {
			signal: controller.signal,
			step(stepId, label) {
				const current = get(id);
				if (!current || current.status !== 'running') return;
				const at = now();
				update(id, {
					steps: [...closeSteps(current.steps, at), { id: stepId, label, startedAt: at }]
				});
				notify();
			},
			progress(done, total, unit) {
				const current = get(id);
				if (!current || current.status !== 'running') return;
				update(id, { progress: { done, total, ...(unit === undefined ? {} : { unit }) } });
				notify();
			}
		};

		let run: Promise<unknown>;
		try {
			run = (def as TaskKindDef<unknown, unknown>).run(inputs.get(id), ctx);
		} catch (cause) {
			run = Promise.reject(cause);
		}

		run.then(
			(result) => {
				// Already cancelled (and detached): the late result is dropped.
				if (get(id)?.status !== 'running') return;
				settle(
					id,
					'done',
					{ summary: (def as TaskKindDef<unknown, unknown>).summary(result) },
					result
				);
			},
			(cause: unknown) => {
				if (get(id)?.status !== 'running') return;
				if (isAbort(cause, controller.signal)) settle(id, 'cancelled', {});
				else settle(id, 'failed', { error: messageOf(cause) });
			}
		);
	}

	/**
	 * `retryOf` is the runner's own business — only {@link retry} passes it, and
	 * the public `start` on {@link TaskRunner} does not offer it: a caller cannot
	 * claim a lineage it did not come from.
	 */
	function start<K extends Kind>(
		kind: K,
		input: InputOf<Defs[K]>,
		retryOf?: string
	): StartedTask<ResultOf<Defs[K]>> {
		const def = defs[kind];
		const id = newId();
		const record: Record_ = {
			id,
			kind,
			title: (def as TaskKindDef<unknown, unknown>).title(input),
			status: 'queued',
			steps: [],
			queuedAt: now(),
			retryable: def.retryable ?? true,
			cancellable: def.cancellable ?? true,
			...(retryOf === undefined ? {} : { retryOf })
		};
		tasks = [...tasks, record];
		inputs.set(id, input);
		controllers.set(id, new AbortController());
		const done = new Promise<TaskOutcome<unknown>>((resolve) => resolvers.set(id, resolve));
		outcomes.set(id, done);

		if (def.serial && busy.has(kind)) {
			const queue = waiting.get(kind) ?? [];
			queue.push(id);
			waiting.set(kind, queue);
			notify();
		} else {
			execute(id);
		}

		return { id, done: done as Promise<TaskOutcome<ResultOf<Defs[K]>>> };
	}

	function cancel(id: string): void {
		const task = get(id);
		if (!task || SETTLED.has(task.status)) return;
		const queue = waiting.get(task.kind);
		if (queue) {
			const at = queue.indexOf(id);
			if (at >= 0) queue.splice(at, 1);
		}
		controllers.get(id)?.abort(new DOMException('The task was cancelled.', 'AbortError'));
		settle(id, 'cancelled', {});
	}

	function retry(id: string): StartedTask<unknown> | undefined {
		const task = get(id);
		if (!task || !task.retryable || task.status === 'done' || !SETTLED.has(task.status)) {
			return undefined;
		}
		if (!inputs.has(id)) return undefined;
		// The *immediate* predecessor, not the root: a chain of retries is a chain
		// of records, and `rootOf` is what flattens it for whoever asks.
		return start(task.kind, inputs.get(id) as InputOf<Defs[Kind]>, id);
	}

	function outcomeOf<K extends Kind>(
		kind: K,
		id: string
	): Promise<TaskOutcome<ResultOf<Defs[K]>>> | undefined {
		if (get(id)?.kind !== kind) return undefined;
		return outcomes.get(id) as Promise<TaskOutcome<ResultOf<Defs[K]>>> | undefined;
	}

	function dismiss(id: string): void {
		const task = get(id);
		if (!task || !SETTLED.has(task.status)) return;
		tasks = tasks.filter((entry) => entry.id !== id);
		forget(id);
		notify();
	}

	return {
		start,
		cancel,
		retry,
		outcomeOf,
		dismiss,
		list: () => tasks.slice(),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
