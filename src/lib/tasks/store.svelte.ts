/**
 * The reactive view of the runner, for components.
 *
 * Runes in a module: `tasks` is `$state.raw` (the runner hands over a fresh
 * array on every change, so there is nothing to proxy) kept current by one
 * subscription for the life of the app. Components read `taskStore.tasks`,
 * `taskStore.running` and `taskStore.latestOf(kind)` and never keep task
 * state of their own — a page that held its own `generating` flag would be
 * wrong the moment the learner navigated back to it.
 *
 * `hidden` is the one piece of presentation state kept here rather than in
 * the tray: a focused screen (the session mid-play) may ask the tray to stay
 * out of the way, and it has to ask something that outlives the tray.
 */

import type { Task, TaskKind } from './registry';
import { listTasks, subscribeTasks } from './singleton';

let tasks = $state.raw<Task[]>(listTasks());
let hidden = $state(false);

subscribeTasks((next) => {
	tasks = next;
});

export const taskStore = {
	/** Every task the runner still lists, oldest first. */
	get tasks(): Task[] {
		return tasks;
	},
	/** The ones still going: queued or running. */
	get running(): Task[] {
		return tasks.filter((task) => task.status === 'queued' || task.status === 'running');
	},
	/** The newest task of a kind, whatever its status; `undefined` when none. */
	latestOf<K extends TaskKind>(kind: K): Task | undefined {
		for (let i = tasks.length - 1; i >= 0; i--) {
			if (tasks[i].kind === kind) return tasks[i];
		}
		return undefined;
	},
	get hidden(): boolean {
		return hidden;
	},
	/** Asks the tray to stay off screen (or lets it back). */
	setHidden(value: boolean): void {
		hidden = value;
	}
};
