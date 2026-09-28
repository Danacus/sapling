/**
 * The stored shape of a pooled challenge.
 *
 * All that is left of the old Dexie schema: the domain `Challenge` union plus
 * the four pool-bookkeeping fields the session planner reads. Everything else
 * moved to the facts log (`crates/sapling-db/src/schema.rs`).
 */

import type { PoolRow } from './generated/index';
import type { Challenge } from '$lib/types';

/**
 * Stored challenge: the domain `Challenge` union plus pool bookkeeping —
 * `generatedAt`, `timesServed`, `lastServedAt` (`null` while never served),
 * `reported` and `topic?`. Generated from `sapling-challenges`' `PoolRow`, an
 * intersection, so the `type` discriminant still narrows after a read.
 *
 * Every challenge ever generated stays in the pool — answering one does not
 * consume it, it only stamps it — and the session planner decides what is
 * worth playing again from these fields.
 */
export type ChallengeRow = PoolRow;

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
