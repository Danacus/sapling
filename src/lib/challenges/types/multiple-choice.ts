/**
 * `multiple-choice` — four options, exactly one right, either direction.
 *
 * The one stored type with no free text anywhere: the answer key is an *index*,
 * so grading is a comparison against the option it points at rather than against
 * a list of accepted spellings. Which language the options are in is what
 * `direction` decides, and everything presentational here follows from it.
 */

import { z } from 'zod';
import type { MultipleChoiceChallenge } from '$lib/types';
import { checkAnswer } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { nonEmpty, storedBase } from './primitives';

export const multipleChoiceChallengeSchema = z.object({
	type: z.literal('multiple-choice'),
	prompt: nonEmpty,
	promptRomanization: z.string().optional(),
	instruction: z.string().optional(),
	options: z.tuple([z.string(), z.string(), z.string(), z.string()]),
	/** Index-aligned with `options` when present; the resolver guarantees the length. */
	optionsRomanization: z.array(z.string()).length(4).optional(),
	correctIndex: z.int().min(0).max(3),
	...storedBase
});

export const multipleChoiceStoredDef = {
	type: 'multiple-choice',
	schema: multipleChoiceChallengeSchema,

	check(challenge, answerGiven) {
		const correctOption = challenge.options[challenge.correctIndex];
		return checkAnswer(answerGiven, [correctOption]);
	},

	correctAnswerText(challenge) {
		return challenge.options[challenge.correctIndex];
	},

	answerIsTargetLanguage(challenge) {
		return challenge.direction === 'toTarget';
	},

	answerReading(challenge) {
		return challenge.optionsRomanization?.[challenge.correctIndex];
	},

	spokenAnswerFor(challenge) {
		if (challenge.direction !== 'toTarget') return '';
		return challenge.options[challenge.correctIndex]?.trim() ?? '';
	}
} satisfies StoredTypeDef<MultipleChoiceChallenge>;
