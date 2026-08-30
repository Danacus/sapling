/**
 * The stored shape of a pooled challenge.
 *
 * All that is left of the old Dexie schema: the domain `Challenge` union plus
 * the four pool-bookkeeping fields the session planner reads. Everything else
 * moved to the facts log (`schema.ts`).
 */

import type { Challenge } from '$lib/types';

/**
 * Stored challenge: the domain `Challenge` union plus pool bookkeeping.
 *
 * The union is intersected rather than extended so the `type` discriminant
 * still narrows after a read.
 *
 * Every challenge ever generated stays in the pool — answering one does not
 * consume it, it only stamps it. The session planner (`planSession` in
 * `$lib/session/engine`) reads the whole pool and decides what is worth playing
 * again from these four fields.
 */
export type ChallengeRow = Challenge & {
	/** Epoch milliseconds the batch this came from was persisted. */
	generatedAt: number;
	/** How many times the learner has actually answered it. */
	timesServed: number;
	/** Epoch milliseconds of the last answer, or `null` while never served. */
	lastServedAt: number | null;
	/** The learner flagged it as broken; excluded from the pool forever. */
	reported: boolean;
	/** Generation topic, when the batch was generated with one. */
	topic?: string;
};

/**
 * Sheds the bookkeeping above, leaving the immutable domain `Challenge`.
 *
 * Lives here, beside the fields it strips, because those two lists have to
 * agree: call sites were each destructuring them by hand, so adding a sixth
 * bookkeeping field (`topic` was the fifth) meant remembering every one of them,
 * and missing one would quietly leak a local field into a `Challenge`.
 *
 * The cast is unavoidable: a rest-destructure over a discriminated union
 * produces an `Omit` that no longer narrows on `type`, even though every field
 * of it survived.
 */
export function challengeOf(row: ChallengeRow): Challenge {
	const {
		generatedAt: _generatedAt,
		timesServed: _timesServed,
		lastServedAt: _lastServedAt,
		reported: _reported,
		topic: _topic,
		...challenge
	} = row;
	return challenge as Challenge;
}
