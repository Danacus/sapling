/**
 * `spot-error` — tap the one word in a target-language sentence that does not
 * belong.
 *
 * Two asymmetries live here, and both are deliberate. What the learner *taps* is
 * the wrong word, so that is what `check` compares against; what the banner
 * *prints* is the word that belonged there — "Answer: pedir" is the thing worth
 * remembering, while "the wrong one was pagar" is already on screen, highlighted.
 *
 * And the sentence is target-language whichever way the challenge is exercised,
 * so neither the romanization line nor the audio is gated on `direction`: what
 * the learner needs to hear is the *corrected* sentence, not the broken one they
 * were shown.
 */

import { z } from 'zod';
import type { SpotErrorChallenge } from '$lib/types';
import { normalize } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const spotErrorChallengeSchema = z.object({
	type: z.literal('spot-error'),
	tokens: z.array(nonEmpty).min(3),
	/** Index-aligned with `tokens`; all-or-nothing, see the resolver. */
	tokensRomanization: z.array(z.string()).optional(),
	/** The position of the *wrong* word: tapping it is the correct answer. */
	correctIndex: z.int().min(0),
	intendedWord: nonEmpty,
	intendedWordRomanization: z.string().optional(),
	correctedSentence: nonEmpty,
	meaning: nonEmpty,
	...storedBase
});

export const spotErrorStoredDef = {
	type: 'spot-error',
	schema: spotErrorChallengeSchema,

	check(challenge, answerGiven) {
		// The answer is the *wrong* word — the one the learner is asked to tap.
		return normalize(answerGiven) === normalize(challenge.tokens[challenge.correctIndex])
			? 'correct'
			: 'wrong';
	},

	// Recognition: the learner reads a sentence and judges it. Nothing is
	// produced — not even the word that belonged there, which the banner supplies
	// afterwards — so this is comprehension work, and it is available to a word
	// the very first time it comes back round.
	demand() {
		return 0;
	},

	// Not the word they had to tap — the word that belonged there.
	correctAnswerText(challenge) {
		return challenge.intendedWord;
	},

	answerIsTargetLanguage() {
		return true;
	},

	// Reads the word that *belonged* there — which is what the banner prints.
	answerReading(challenge) {
		return challenge.intendedWordRomanization;
	},

	spokenAnswerFor(challenge) {
		// No direction gate: see the module note.
		return challenge.correctedSentence.trim();
	}
} satisfies StoredTypeDef<SpotErrorChallenge>;
