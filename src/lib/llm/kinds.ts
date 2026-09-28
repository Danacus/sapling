/**
 * The kinds of challenge the session can plan, read off `CHALLENGE_KINDS`,
 * which is generated from `crates/sapling-llm/lessons/`. The session plans
 * wants in TypeScript; Rust writes them.
 */

import type { Demand } from '$lib/challenges/types';
import type { ChallengeKind, WireType } from '$lib/db/generated/index';
import { CHALLENGE_KINDS } from '$lib/db/generated/llm';
import type { Challenge } from '$lib/types';

export type { ChallengeKind, Want, WantItem, WireType } from '$lib/db/generated/index';

/** A rung of the five-step ladder a want is written at. */
export type DifficultyRung = 1 | 2 | 3 | 4 | 5;

/** A kind the session may ask for, with the demand tier its stored challenge reports. */
export interface PlannableKind extends ChallengeKind {
	readonly demand: Demand;
	/** Rungs at which new challenges of this kind may be generated. */
	readonly levels: readonly DifficultyRung[];
}

/** Every kind still generated, in registry order (a seeded pick depends on it). */
export const PLANNABLE_KINDS: readonly PlannableKind[] = CHALLENGE_KINDS.flatMap((kind) =>
	kind.plannable
		? [
				{
					type: kind.type,
					demand: kind.plannable.demand as Demand,
					levels: kind.plannable.levels as DifficultyRung[]
				}
			]
		: []
);

export function kindKey(kind: ChallengeKind): string {
	return kind.type;
}

/** The identity alone, without a plannable kind's demand. */
export function bareKind(kind: ChallengeKind): ChallengeKind {
	return { type: kind.type };
}

export function plannableKind(kind: ChallengeKind): PlannableKind | undefined {
	return PLANNABLE_KINDS.find((candidate) => candidate.type === kind.type);
}

/** Whether a kind still counts for coverage and ordinary serving. */
export function isActiveKind(kind: ChallengeKind): boolean {
	return plannableKind(kind) !== undefined;
}

export function isKindAvailableAt(kind: ChallengeKind, level: DifficultyRung): boolean {
	return plannableKind(kind)?.levels.includes(level) ?? false;
}

/** The kind a stored challenge was written as; `undefined` for a match-pairs round. */
export function kindOf(challenge: Challenge): ChallengeKind | undefined {
	const promptIsTarget = 'promptIsTarget' in challenge && challenge.promptIsTarget === true;
	const found = CHALLENGE_KINDS.find(
		({ stored }) =>
			stored.type === challenge.type &&
			stored.direction === challenge.direction &&
			(stored.promptIsTarget ?? false) === promptIsTarget
	);
	return found ? { type: found.type as WireType } : undefined;
}
