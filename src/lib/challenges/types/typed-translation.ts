/**
 * `typed-translation` — type the full translation of a prompt.
 *
 * The only type where the learner spells something from nothing, so it leans
 * hardest on the fuzzy matcher: `acceptedAnswers` is exhaustive by the time it is
 * stored (the resolver folds diacritics into it), and a one-character miss earns
 * `'almost'` rather than a red screen.
 */

import { z } from 'zod';
import type { TypedTranslationChallenge } from '$lib/types';
import { checkAnswer } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const typedTranslationChallengeSchema = z.object({
	type: z.literal('typed-translation'),
	prompt: nonEmpty,
	promptRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	/** Reading of `acceptedAnswers[0]`; toTarget only. */
	answerRomanization: z.string().optional(),
	...storedBase
});

export const typedTranslationStoredDef = {
	type: 'typed-translation',
	schema: typedTranslationChallengeSchema,

	check(challenge, answerGiven) {
		return checkAnswer(answerGiven, challenge.acceptedAnswers);
	},

	correctAnswerText(challenge) {
		return challenge.acceptedAnswers[0] ?? '';
	},

	answerIsTargetLanguage(challenge) {
		return challenge.direction === 'toTarget';
	},

	answerReading(challenge) {
		return challenge.answerRomanization;
	},

	spokenAnswerFor(challenge) {
		if (challenge.direction !== 'toTarget') return '';
		return challenge.acceptedAnswers[0]?.trim() ?? '';
	}
} satisfies StoredTypeDef<TypedTranslationChallenge>;
