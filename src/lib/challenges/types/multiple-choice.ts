/**
 * `multiple-choice` — four options, exactly one right, either direction.
 *
 * The answer key is an *index*, so the right answer is the option it points
 * at. Which language the options are in is what `direction` decides, and
 * everything presentational here follows from it.
 */

import type { MultipleChoiceChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

/** The right option in its canonical form — `''` for a row missing it. */
function correctOption(challenge: MultipleChoiceChallenge): string {
	return challenge.options[challenge.correctIndex]?.trim() ?? '';
}

export const multipleChoiceStoredDef = {
	type: 'multiple-choice',
	reviewsSrs: true,
	pooled: true,

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
