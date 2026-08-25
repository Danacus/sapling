/**
 * `word-order` — rebuild a target sentence out of shuffled tiles.
 *
 * Graded exactly, never fuzzily: the learner picked from a closed set rather
 * than spelling anything, so one tile out of place is a wrong arrangement and
 * not a near miss. The comparison is on the *assembled sentence* — which is what
 * the component reports — and `answer` is the sentence the resolver joined with
 * the script's own spacing rule, so the two are byte-identical by construction.
 */

import { z } from 'zod';
import type { WordOrderChallenge } from '$lib/types';
import { normalize } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const wordOrderChallengeSchema = z.object({
	type: z.literal('word-order'),
	prompt: nonEmpty,
	instruction: z.string().optional(),
	/** Shuffled by the resolver; duplicates are legal (grading is by text sequence). */
	tiles: z.array(nonEmpty).min(2),
	/** Index-aligned with `tiles`; all-or-nothing, see the resolver. */
	tilesRomanization: z.array(z.string()).optional(),
	answerTokens: z.array(nonEmpty).min(2),
	/** `answerTokens` joined with the script's own spacing rule. */
	answer: nonEmpty,
	answerRomanization: z.string().optional(),
	...storedBase
});

export const wordOrderStoredDef = {
	type: 'word-order',
	schema: wordOrderChallengeSchema,

	check(challenge, answerGiven) {
		return normalize(answerGiven) === normalize(challenge.answer) ? 'correct' : 'wrong';
	},

	// Constrained production: the learner really does build a target sentence,
	// but out of tiles that are handed to them. Every word is on screen and
	// spelled correctly — what is being recalled is the *order*, not the
	// vocabulary — so this sits a tier below writing the same sentence blind.
	demand() {
		return 1;
	},

	correctAnswerText(challenge) {
		return challenge.answer;
	},

	answerIsTargetLanguage() {
		return true;
	},

	answerReading(challenge) {
		return challenge.answerRomanization;
	},

	spokenAnswerFor(challenge) {
		if (challenge.direction !== 'toTarget') return '';
		// The assembled sentence, spacing and all — never the tiles read one by one.
		return challenge.answer.trim();
	}
} satisfies StoredTypeDef<WordOrderChallenge>;
