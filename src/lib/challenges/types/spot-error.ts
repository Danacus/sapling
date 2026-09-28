/**
 * `spot-error` — tap the one word in a target-language sentence that does not
 * belong.
 *
 * What the learner *taps* is the wrong word, which is what grading compares
 * against; what the banner *prints* is the word that belonged there — "Answer:
 * pedir" is the thing worth remembering, while "the wrong one was pagar" is
 * already on screen, highlighted.
 *
 * And the sentence is target-language whichever way the challenge is exercised,
 * so neither the romanization line nor the audio is gated on `direction`: what
 * the learner needs to hear is the *corrected* sentence, not the broken one they
 * were shown.
 */

import type { SpotErrorChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

export const spotErrorStoredDef = {
	type: 'spot-error',
	reviewsSrs: true,
	pooled: true,

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
	},

	// Silent until it is answered: the broken sentence is there to be *read*, and
	// hearing it would teach the learner the mistake. So the only clip is the
	// corrected sentence the banner plays afterwards.
	audioTexts(challenge) {
		const spoken = challenge.correctedSentence.trim();
		return spoken ? [spoken] : [];
	}
} satisfies StoredTypeDef<SpotErrorChallenge>;
