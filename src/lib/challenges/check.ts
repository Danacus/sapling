/**
 * Grading, dispatched by challenge type.
 *
 * A one-line façade over the registry, kept as its own module for the same
 * reason `./display` is: the *rule* for each type — exact or fuzzy, against
 * which field — is per-type knowledge and lives in `./types/<type>.ts`, next to
 * that type's schema and its presentation. This is only the door.
 *
 * It used to live in `$lib/validate`, which was the wrong way round: the string
 * matchers underneath (`checkAnswer`, `validateAnswer`, `normalize`) know
 * nothing about challenges and are used directly by components that grade as the
 * learner types. Keeping them a leaf means the challenge layer can import them
 * without the arrow ever pointing back.
 */

import type { Challenge, Verdict } from '$lib/types';
import { storedDefFor } from './types';

/** Grades any challenge; dispatches on `challenge.type`. */
export function checkChallenge(challenge: Challenge, answerGiven: string): Verdict {
	return storedDefFor(challenge).check(challenge, answerGiven);
}
