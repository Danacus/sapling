/**
 * `typed-translation` — type the full translation of a prompt.
 *
 * The only type where the learner spells something from nothing, so it leans
 * hardest on the fuzzy matcher: `acceptedAnswers` is exhaustive by the time it is
 * stored (the resolver folds diacritics into it), and a one-character miss earns
 * `'almost'` rather than a red screen.
 */

import type { TypedTranslationChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

/** The canonical accepted answer — `''` for a row that carries none. */
function canonicalAnswer(challenge: TypedTranslationChallenge): string {
	return challenge.acceptedAnswers[0]?.trim() ?? '';
}

export const typedTranslationStoredDef = {
	type: 'typed-translation',
	reviewsSrs: true,
	pooled: true,

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
