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

/** The right option in its canonical form — `''` for a row missing it. */
function correctOption(challenge: MultipleChoiceChallenge): string {
	return challenge.options[challenge.correctIndex]?.trim() ?? '';
}

export const multipleChoiceStoredDef = {
	type: 'multiple-choice',
	schema: multipleChoiceChallengeSchema,

	check(challenge, answerGiven) {
		const correctOption = challenge.options[challenge.correctIndex];
		return checkAnswer(answerGiven, [correctOption]);
	},

	// Recognition in **both** directions: the answer is already on screen and the
	// learner picks it out. `toTarget` looks productive — the answer is a target
	// word — but nothing is produced; a distractor list is a closed set, and
	// recognizing the right member of one is what a beginner can do first.
	demand() {
		return 0;
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
		return correctOption(challenge);
	},

	// Exactly one phrase either way, and which one follows `direction` — the same
	// split every other fact here follows. `toNative` puts the target language in
	// the *prompt*: the header's speaker reads it, and in listening mode it is
	// played the instant the challenge appears with nothing on screen to read
	// meanwhile, which makes it the single clip warming matters most for.
	// `toTarget` says nothing until the grade lands, and then says the answer.
	audioTexts(challenge) {
		const spoken =
			challenge.direction === 'toNative' ? challenge.prompt.trim() : correctOption(challenge);
		return spoken ? [spoken] : [];
	}
} satisfies StoredTypeDef<MultipleChoiceChallenge>;
