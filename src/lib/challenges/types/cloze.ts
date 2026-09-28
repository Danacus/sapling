/**
 * `cloze` — fill the `___` blank in a target-language sentence.
 *
 * The answer is always a target-language word, whichever way the challenge is
 * exercised, so the romanization line is never suppressed here. What the learner
 * hears afterwards is the *whole sentence with the blank filled*, not the word on
 * its own: how a word sounds in place is the thing they were missing.
 */

import type { ClozeChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

/** The blank, as the resolver joined the sentence around it. */
const GAP = '___';

/**
 * The sentence with the blank filled by the canonical accepted answer — `''`
 * when the row carries no answer to fill it with, because a bare gap read aloud
 * teaches nothing.
 */
function completedSentence(challenge: ClozeChallenge): string {
	const canonical = challenge.acceptedAnswers[0]?.trim() ?? '';
	if (!canonical) return '';
	return challenge.sentence.split(GAP).join(canonical);
}

export const clozeStoredDef = {
	type: 'cloze',
	reviewsSrs: true,
	pooled: true,

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
		// The sentence, spoken whole — the blank filled with the canonical script
		// form the resolver pinned, never a romanized variant.
		return completedSentence(challenge);
	},

	// Two clips, in the order the round asks for them. The speaker button sits in
	// the sentence line from the first frame and reads the blank as an ellipsis
	// (every engine renders that as the "…and then?" pause the learner needs);
	// once the answer is in, both that button and the banner read the sentence
	// complete. Neither is gated on `direction` the way `spokenAnswerFor` is —
	// the sentence is target-language whichever way the row is exercised, and
	// warming a clip nobody plays costs only a cache entry.
	audioTexts(challenge) {
		const asked = challenge.sentence.split(GAP).join('…');
		const answered = completedSentence(challenge);
		// A sentence with no blank left to fill makes the two identical.
		return [...new Set([asked, answered])].filter((text) => text !== '');
	}
} satisfies StoredTypeDef<ClozeChallenge>;
