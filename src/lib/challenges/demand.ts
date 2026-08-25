/**
 * How much a challenge asks of the learner, dispatched by challenge type.
 *
 * Challenge types are not equally hard, and the gap is not small: "write this
 * sentence in Chinese" and "which of these four means *dog*" exercise the same
 * word and are barely the same activity. Something in the app has to know that,
 * and there were only two places it could live.
 *
 * It is deliberately **not** in grading. Nudging a verdict by type — half credit
 * for a hard format, a stricter bar for an easy one — would corrupt the one
 * signal FSRS has: a verdict is evidence about the *word*, and evidence has to
 * mean the same thing whatever question produced it. So grading stays type-blind
 * (see `./check`) and what gets shaped instead is the *question stream*: a word
 * earns its early reviews through recognition, and production arrives once the
 * word can bear it. Comprehension precedes production — the same principle as
 * the adaptive-romanization ramp in `$lib/session/romanization`, applied to the
 * exercise rather than to the crutch.
 *
 * This module is only the door: the tier each type reports lives with that type,
 * in `./types/<type>.ts`, next to its schema and its grading rule, and the
 * registry's mapped type means a seventh member of the union fails `pnpm check`
 * there rather than silently defaulting to "easy". The *floors* — how strong a
 * word has to be before it can bear tier 1 or tier 2 — are the session's
 * question, not the challenge's, and live in `$lib/session/progression`.
 */

import type { Challenge } from '$lib/types';
import { storedDefFor } from './types';
import type { Demand } from './types';

export type { Demand };

/**
 * How much productive recall this challenge asks of its words, 0..2:
 * 0 recognition (read/choose), 1 constrained production (assemble from given
 * material), 2 free production (produce from nothing).
 *
 * A property of the challenge alone — nothing here knows how well the learner
 * knows the words in it. Pairing the two is `$lib/session/progression`'s job.
 */
export function demandOf(challenge: Challenge): Demand {
	return storedDefFor(challenge).demand(challenge);
}
