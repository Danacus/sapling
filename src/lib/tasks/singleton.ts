/**
 * The one runner the app uses, bound to the registry.
 *
 * Module state, on purpose: a task has to outlive the component that started
 * it, and a module is the only thing in a client-side app that does. The
 * reactive view components read is `./store.svelte`, fed from `subscribe`
 * here; the functions below are what pages call.
 */

import { TASK_KINDS } from './registry';
import type { Task, TaskInput, TaskKind, TaskResult } from './registry';
import { createRunner } from './runner';
import type { StartedTask } from './runner';
import type { TaskOutcome } from './types';

const runner = createRunner(TASK_KINDS);

/** Starts a task and returns its id and outcome. See {@link TaskOutcome}. */
export function startTask<K extends TaskKind>(
	kind: K,
	input: TaskInput<K>
): StartedTask<TaskResult<K>> {
	return runner.start(kind, input);
}

/**
 * How a listed task ended, for anyone holding its id — including a task the
 * runner started itself for a Retry, whose promise the tray threw away. This
 * is how a page reads the *value* of an outcome it learnt about from a record.
 */
export function taskOutcome<K extends TaskKind>(
	kind: K,
	id: string
): Promise<TaskOutcome<TaskResult<K>>> | undefined {
	return runner.outcomeOf(kind, id);
}

export const cancelTask: (id: string) => void = runner.cancel;
export const retryTask: (id: string) => StartedTask<unknown> | undefined = runner.retry;
export const dismissTask: (id: string) => void = runner.dismiss;
export const listTasks: () => Task[] = runner.list;
export const subscribeTasks: (listener: (tasks: Task[]) => void) => () => void = runner.subscribe;
