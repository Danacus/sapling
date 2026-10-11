/**
 * Grading, which is Rust's (`crates/sapling-challenges`' `grade.rs` over its
 * string matchers). Type-blind: a verdict is FSRS's evidence about the word,
 * so demand and difficulty shape which question is asked, never what an
 * answer to it is worth.
 */

import type { AnswerMatch, MultiClozeGrade } from '$lib/db/generated/index';
import type { Challenge, MultiClozeChallenge, Verdict } from '$lib/types';
import { callChallenges } from './core';

export type { AnswerMatch, MultiClozeGrade };

/**
 * Grades any challenge from the one string its component reports, as given at
 * help level `shown` — which decides whether a cloze was typed (near misses
 * count) or tapped from its bank (exact). Absent is the bare render.
 */
export function checkChallenge(challenge: Challenge, answer: string, shown?: string): Verdict {
	return callChallenges('checkChallenge', { challenge, answer, shown });
}

/**
 * A free-text answer against every accepted one: `correct` for an exact
 * normalized match, `almost` for a missing accent or a typo within the
 * length's threshold (unless `fuzzy` is off), and the nearest accepted answer
 * whatever decided it. The typing components grade with this as they commit.
 */
export function validateAnswer(
	given: string,
	accepted: string[],
	opts: { fuzzy?: boolean } = {}
): AnswerMatch {
	return callChallenges('validateAnswer', { given, accepted, ...opts });
}

/** A passage gap by gap: the worst verdict overall, and each gap's own for its word's review. */
export function gradeMultiClozeAnswers(
	challenge: MultiClozeChallenge,
	answers: string[]
): MultiClozeGrade {
	return callChallenges('gradeMultiCloze', { challenge, answers });
}
