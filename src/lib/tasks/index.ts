/**
 * Public surface of the task system.
 *
 * Pages start tasks here and read them through `./store.svelte`; nothing
 * below this layer imports it. See `.claude/rules/tasks.md`.
 */

export { TASK_KINDS } from './registry';
export type { Task, TaskInput, TaskKind, TaskKinds, TaskResult } from './registry';
export { MAX_KEPT_TASKS, createRunner } from './runner';
export type { InputOf, ResultOf, RunnerOptions, StartedTask, TaskDefs, TaskRunner } from './runner';
export {
	cancelTask,
	dismissTask,
	listTasks,
	retryTask,
	startTask,
	subscribeTasks
} from './singleton';
export { SETTLED } from './types';
export type {
	TaskContext,
	TaskKindDef,
	TaskOutcome,
	TaskProgress,
	TaskRecord,
	TaskStatus,
	TaskStep
} from './types';
