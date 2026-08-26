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

/** The canonical accepted answer — `''` for a row that carries none. */
function canonicalAnswer(challenge: TypedTranslationChallenge): string {
	return challenge.acceptedAnswers[0]?.trim() ?? '';
}

export const typedTranslationStoredDef = {
	type: 'typed-translation',
	schema: typedTranslationChallengeSchema,

	check(challenge, answerGiven) {
		return checkAnswer(answerGiven, challenge.acceptedAnswers);
	},

	// The hardest thing the app asks — but only one way round. `toTarget` is free
	// production: a whole target sentence written from memory, with no options, no
	// tiles and no bank. `toNative` is comprehension wearing a keyboard; the
	// typing happens in the learner's own language, so it demands nothing of their
	// target-language recall and belongs with the recognition tier.
	demand(challenge) {
		return challenge.direction === 'toTarget' ? 2 : 0;
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
		return canonicalAnswer(challenge);
	},

	// One phrase, on whichever side of the round the target language sits.
	// `toNative` hands the learner target-language text to translate and hangs a
	// speaker button off it; `toTarget` shows a native prompt worth nothing to
	// hear and speaks the answer once it has been graded.
	audioTexts(challenge) {
		const spoken =
			challenge.direction === 'toNative' ? challenge.prompt.trim() : canonicalAnswer(challenge);
		return spoken ? [spoken] : [];
	}
} satisfies StoredTypeDef<TypedTranslationChallenge>;
