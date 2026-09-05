/**
 * The shapes every background task shares, whatever it does.
 *
 * A task is one long job the learner started and does not have to watch: a
 * lesson top-up, a text being written or annotated, a readings backfill, the
 * voice model download. The runner (`./runner`) gives each the same lifecycle
 * — `queued` → `running` → `done` | `failed` | `cancelled` — and the same two
 * ways of saying how far it has got: **steps**, a ledger of named phases with
 * their timings, for a job that moves through stages; and **progress**, a
 * fraction, for a job that counts (calls landed, bytes fetched). A kind uses
 * whichever fits, or both; the tray renders whichever is there.
 *
 * Nothing here knows a kind by name. `TaskKindDef` is the contract one kind
 * satisfies, `TaskRecord` is the runner's view of any task, and the concrete
 * `TaskKind` union is derived from the registry (`./registry`), which is the
 * one place that knows how many kinds there are.
 */

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** A settled task is one of the three terminal statuses. */
export const SETTLED: ReadonlySet<TaskStatus> = new Set(['done', 'failed', 'cancelled']);

/**
 * One named phase of a task. `endedAt` is written when the next step starts,
 * or when the task settles — so the ledger is honest about where the seconds
 * went, which is the whole reason a step has a clock.
 */
export interface TaskStep {
	id: string;
	label: string;
	startedAt: number;
	endedAt?: number;
}

/** How far a counting task has got: `done` of `total`, in `unit`s if it says. */
export interface TaskProgress {
	done: number;
	total: number;
	/** A short noun for the count — `'calls'`, `'MB'`. Absent for a bare fraction. */
	unit?: string;
}

/**
 * What the runner knows about one task. Generic over the kind so the registry
 * can narrow it to its own union; the runner itself only needs a string.
 */
export interface TaskRecord<K extends string = string> {
	id: string;
	kind: K;
	/** Written for the tray: what this job is, in the learner's terms. */
	title: string;
	status: TaskStatus;
	steps: TaskStep[];
	progress?: TaskProgress;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Set when `status` is `failed`; already written for a human. */
	error?: string;
	/** Set when `status` is `done`; one line on what came of it. */
	summary?: string;
	/** Whether the tray may offer "Retry" once this has failed or been cancelled. */
	retryable: boolean;
	/**
	 * Whether cancelling stops the work. Every task can be *cancelled* — the
	 * tray drops it and its signal fires — but a kind whose underlying job
	 * ignores the signal says so here, and the tray words the button
	 * accordingly.
	 */
	cancellable: boolean;
}

/** What a kind's `run` is handed: its stop signal and its two ways to report. */
export interface TaskContext {
	/** Fires on cancel. Pass it down to every fetch and every `$lib/llm` call. */
	signal: AbortSignal;
	/** Opens a new step, closing the one before it. */
	step(id: string, label: string): void;
	/** Reports a fraction; replaces the previous one. */
	progress(done: number, total: number, unit?: string): void;
}

/**
 * One kind of background job, from what it is called to what it says when
 * it is finished. A kind is a module in `./kinds/` and one entry in the
 * registry; the runner never learns anything about it beyond this.
 *
 * @typeParam I What starts it. Kept by the runner for "Retry", so it must be
 * complete — a def cannot reach back into the page that started it.
 * @typeParam R What it produced. The page that started the task may read it
 * from the outcome; the tray only ever sees `summary(result)`.
 */
export interface TaskKindDef<I, R> {
	/** The tray's title for a task of this kind, from its input. */
	title(input: I): string;
	/** The job. Throws to fail; an `AbortError` (or an aborted signal) is a cancellation. */
	run(input: I, ctx: TaskContext): Promise<R>;
	/** One line for the tray once the job is done. */
	summary(result: R): string;
	/**
	 * Tasks of this kind run one at a time, later ones waiting as `queued`.
	 * Kinds that write the same tables, or spend the same rate limit, say `true`.
	 * Different kinds always run concurrently.
	 */
	serial: boolean;
	/** Defaults to `true`. */
	retryable?: boolean;
	/** Defaults to `true`; see {@link TaskRecord.cancellable}. */
	cancellable?: boolean;
}

/**
 * How a started task ends, as a value rather than a rejection.
 *
 * `startTask`'s promise never rejects: a page that started a job and moved
 * on must not be the thing an unhandled rejection is reported against, and a
 * page that stayed reads the result out of `done`.
 */
export type TaskOutcome<R> =
	{ status: 'done'; result: R } | { status: 'failed'; error: string } | { status: 'cancelled' };
