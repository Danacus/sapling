/**
 * `match-pairs` — pair each term with its counterpart.
 *
 * The odd one out, and deliberately so: it is assembled locally at zero cost (no
 * wire type generates it), it is graded a tap at a time in the component rather
 * than from one answer string, and it has no single "the answer" to print, read
 * or speak. Every presentation fact here is therefore the empty one — which is
 * exactly what the banner wants: an empty `correctAnswerText` means "print no
 * answer line at all".
 */

import { z } from 'zod';
import type { MatchPairsChallenge } from '$lib/types';
import { normalize } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const matchPairsChallengeSchema = z.object({
	type: z.literal('match-pairs'),
	pairs: z
		.array(
			z.object({
				a: nonEmpty,
				b: nonEmpty,
				aRom: z.string().optional(),
				bRom: z.string().optional()
			})
		)
		.min(2),
	...storedBase
});

export const matchPairsStoredDef = {
	type: 'match-pairs',
	schema: matchPairsChallengeSchema,

	check(challenge, answerGiven) {
		// Match-pairs is normally graded interactively in the UI (each tap
		// resolves one pair), not via a single free-text answer. This stays
		// gradeable by accepting an "a::b" / "a|b" encoding of one resolved pair,
		// matched against the challenge's pairs.
		const parts = answerGiven.split(/::|\|/).map((p) => p.trim());
		if (parts.length !== 2) return 'wrong';
		const [a, b] = parts;
		const hit = challenge.pairs.some(
			(pair) => normalize(a) === normalize(pair.a) && normalize(b) === normalize(pair.b)
		);
		return hit ? 'correct' : 'wrong';
	},

	correctAnswerText() {
		return '';
	},

	answerIsTargetLanguage() {
		return false;
	},

	answerReading() {
		return undefined;
	},

	spokenAnswerFor() {
		return '';
	}
} satisfies StoredTypeDef<MatchPairsChallenge>;
