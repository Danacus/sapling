/**
 * `top-up` — a lesson written into the pool, in the background.
 *
 * Wraps `generateChallenges` unchanged: its progress steps become the task's
 * ledger, its abort signal is the task's, and its result is summarised for
 * the tray. Serial, because two top-ups at once would ask for the same wants
 * twice.
 */

import { getReasoningEffort, getRequestItems } from '$lib/db';
import { generateChallenges } from '$lib/session/engine';
import type { GenerateInfo } from '$lib/session/engine';
import type { Profile } from '$lib/types';
import type { TaskKindDef } from '../types';

export interface TopUpInput {
	profile: Profile;
	/** The scenario the lesson leans into, when the learner gave one. */
	topic?: string;
}

export const topUpTask = {
	serial: true,

	title(input) {
		return input.topic ? `New lesson · ${input.topic}` : 'New lesson';
	},

	run(input, ctx) {
		// The generation knobs are device settings, read here rather than
		// threaded through the page: every top-up, however it was started, gets
		// whatever is configured now.
		const itemsPerRequest = getRequestItems();
		const reasoningEffort = getReasoningEffort();
		return generateChallenges(input.profile, {
			signal: ctx.signal,
			onProgress: (step) => ctx.step(step.id, step.label),
			...(input.topic ? { topic: input.topic } : {}),
			...(itemsPerRequest === undefined ? {} : { itemsPerRequest }),
			...(reasoningEffort === 'default' ? {} : { reasoningEffort })
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
