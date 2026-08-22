/**
 * Fuzzy answer validation.
 *
 * Learners should not be punished for a missing accent, a stray article or a
 * one-character typo, but they should be told about it — hence the three-way
 * `Verdict` ('almost' means accepted-with-a-nudge).
 */

import type { Challenge, Verdict } from '$lib/types';

/** Lowercase, trim, collapse whitespace, strip punctuation and diacritics. */
export function normalize(_input: string): string {
	throw new Error('TODO: normalize');
}

/** Levenshtein edit distance between two normalized strings. */
export function editDistance(_a: string, _b: string): number {
	throw new Error('TODO: editDistance');
}

/** Grades a free-text answer against the accepted answers. */
export function checkAnswer(_given: string, _accepted: string[]): Verdict {
	throw new Error('TODO: checkAnswer');
}

/** Grades any challenge; dispatches on `challenge.type`. */
export function checkChallenge(_challenge: Challenge, _answerGiven: string): Verdict {
	throw new Error('TODO: checkChallenge');
}
