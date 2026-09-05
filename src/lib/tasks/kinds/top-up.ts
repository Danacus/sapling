/**
 * `top-up` — a lesson written into the pool, in the background.
 *
 * Wraps `generateChallenges` unchanged: its progress steps become the task's
 * ledger, its abort signal is the task's, and its result is summarised for
 * the tray. Serial, because two top-ups at once would ask for the same wants
 * twice.
 */

import { generateChallenges } from '$lib/session/engine';
import type { GenerateInfo } from '$lib/session/engine';
import type { Profile } from '$lib/types';
import type { TaskKindDef } from '../types';

export interface TopUpInput {
	profile: Profile;
	/** The scenario the lesson leans into, when the learner gave one. */
	topic?: string;
	/**
	 * Write for every upcoming word whether or not it is covered — the start
	 * screen's button once the pool has nothing missing. See `GenerateOptions`.
	 */
	extra?: boolean;
}

export const topUpTask = {
	serial: true,

	title(input) {
		const what = input.extra ? 'Extra challenges' : 'New lesson';
		return input.topic ? `${what} · ${input.topic}` : what;
	},

	run(input, ctx) {
		return generateChallenges(input.profile, {
			signal: ctx.signal,
			onProgress: (step) => ctx.step(step.id, step.label),
			...(input.topic ? { topic: input.topic } : {}),
			...(input.extra ? { extra: true } : {})
		});
	},

	summary(result) {
		const n = result.addedChallenges;
		const added = `${n} challenge${n === 1 ? '' : 's'} added`;
		if (result.failedRequests === 0) return added;
		const f = result.failedRequests;
		return `${added} — ${f} request${f === 1 ? '' : 's'} failed`;
	}
} satisfies TaskKindDef<TopUpInput, GenerateInfo>;
