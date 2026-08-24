/**
 * `cloze` — fill the `___` blank in a target-language sentence.
 *
 * The answer is always a target-language word, whichever way the challenge is
 * exercised, so the romanization line is never suppressed here. What the learner
 * hears afterwards is the *whole sentence with the blank filled*, not the word on
 * its own: how a word sounds in place is the thing they were missing.
 */

import { z } from 'zod';
import type { ClozeChallenge } from '$lib/types';
import { checkAnswer } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const clozeChallengeSchema = z.object({
	type: z.literal('cloze'),
	sentence: nonEmpty,
	sentenceRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	/** Reading of `acceptedAnswers[0]`; see the domain type. */
	answerRomanization: z.string().optional(),
	wordBank: z.array(z.string()).optional(),
	/** Index-aligned with `wordBank`; all-or-nothing, see the resolver. */
	wordBankRomanization: z.array(z.string()).optional(),
	translationHint: z.string(),
	...storedBase
});

export const clozeStoredDef = {
	type: 'cloze',
	schema: clozeChallengeSchema,

	check(challenge, answerGiven) {
		return checkAnswer(answerGiven, challenge.acceptedAnswers);
	},

	correctAnswerText(challenge) {
		return challenge.acceptedAnswers[0] ?? '';
	},

	answerIsTargetLanguage() {
		return true;
	},

	answerReading(challenge) {
		return challenge.answerRomanization;
	},

	spokenAnswerFor(challenge) {
		if (challenge.direction !== 'toTarget') return '';
		const canonical = challenge.acceptedAnswers[0]?.trim() ?? '';
		if (!canonical) return '';
		// The sentence, spoken whole — the blank filled with the canonical script
		// form the resolver pinned, never a romanized variant.
		return challenge.sentence.split('___').join(canonical);
	}
} satisfies StoredTypeDef<ClozeChallenge>;
