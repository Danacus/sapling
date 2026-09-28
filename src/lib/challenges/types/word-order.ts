/**
 * `word-order` — rebuild a target sentence out of shuffled tiles.
 *
 * `answer` is the sentence the resolver joined with the script's own spacing
 * rule, which is what the component reports once the tiles are placed and what
 * grading compares — exactly, never fuzzily — so the printed answer and the
 * graded one are byte-identical by construction.
 */

import type { WordOrderChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

export const wordOrderStoredDef = {
	type: 'word-order',
	reviewsSrs: true,
	pooled: true,

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
	},

	// Silent while it is being played: the prompt is native, the tiles carry no
	// speaker (four or five of them would be noise, and hearing the words would
	// hand over half the puzzle), so the banner's reading of the finished
	// sentence is the only clip — and the `toNative` row has even that in the
	// learner's own language, which is nothing worth hearing.
	audioTexts(challenge) {
		if (challenge.direction !== 'toTarget') return [];
		const spoken = challenge.answer.trim();
		return spoken ? [spoken] : [];
	}
} satisfies StoredTypeDef<WordOrderChallenge>;
