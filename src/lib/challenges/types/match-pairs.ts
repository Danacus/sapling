/**
 * `match-pairs` — pair each term with its counterpart.
 *
 * The odd one out, and deliberately so: it is assembled locally at zero cost (no
 * wire type generates it), it is graded a tap at a time in the component rather
 * than from one answer string, and it has no single "the answer" to print, read
 * or speak. Every *answer* fact here is therefore the empty one — which is
 * exactly what the banner wants: an empty `correctAnswerText` means "print no
 * answer line at all".
 *
 * `audioTexts` is the exception, and for the same reason: with no one answer,
 * what the round speaks is decided a tap at a time, so it warms the whole
 * left-hand column rather than any single phrase.
 */

import type { MatchPairsChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

export const matchPairsStoredDef = {
	type: 'match-pairs',
	// The one exception on both counts: built locally, never pooled, never
	// reviewed. Every other def says `true, true`.
	reviewsSrs: false,
	pooled: false,

	correctAnswerText() {
		return '';
	},

	answerIsTargetLanguage() {
		return false;
	},

	answerReading() {
		return undefined;
	},

	spokenAnswerFor() {
		return '';
	},

	// The one place this type is not silent, and it is the noisiest type there
	// is: the left column is the target language, so every left-hand tap reads
	// its tile aloud (see `MatchPairs.svelte`). Which tile the learner reaches
	// for is unknowable, so the whole column is warmed, in tile order.
	// Deduplicated because a term can legitimately appear in two pairs.
	audioTexts(challenge) {
		const left = challenge.pairs.map((pair) => pair.a.trim()).filter((text) => text !== '');
		return [...new Set(left)];
	}
} satisfies StoredTypeDef<MatchPairsChallenge>;
