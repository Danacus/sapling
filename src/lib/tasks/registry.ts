/**
 * The task-kind registry: the one place that knows how many kinds there are.
 *
 * `TaskKind` is **derived from this object**, so a def that is written but
 * not listed here is not a kind at all — `startTask('its-name', …)` fails
 * `pnpm check` at the call site, the tray never sees it, and `registry.test.ts`
 * checks every listed def has a title, a run and a summary. Adding a kind is
 * one module in `./kinds/` and one line below.
 *
 * Import direction: the defs reach *down* into `$lib/session`, `$lib/reading`,
 * `$lib/llm`, `$lib/tts` and `$lib/db`; nothing in those layers may import
 * `$lib/tasks`, or a page's fire-and-forget would become a cycle.
 */

import { readAnnotateTask } from './kinds/read-annotate';
import { readGenerateTask } from './kinds/read-generate';
import { readingsTask } from './kinds/readings';
import { topUpTask } from './kinds/top-up';
import { ttsModelTask } from './kinds/tts-model';
import type { InputOf, ResultOf } from './runner';
import type { TaskRecord } from './types';

export const TASK_KINDS = {
	'top-up': topUpTask,
	readings: readingsTask,
	'read-generate': readGenerateTask,
	'read-annotate': readAnnotateTask,
	'tts-model': ttsModelTask
} as const;

export type TaskKinds = typeof TASK_KINDS;

/** Every registered kind's name. */
export type TaskKind = keyof TaskKinds;

/** What starts a task of kind `K`. */
export type TaskInput<K extends TaskKind> = InputOf<TaskKinds[K]>;

/** What a task of kind `K` resolves with. */
export type TaskResult<K extends TaskKind> = ResultOf<TaskKinds[K]>;

/** A task record narrowed to the app's own kinds. */
export type Task = TaskRecord<TaskKind>;
