import type {
	AnswerOf,
	Challenge,
	ChallengeAnswer,
	ChallengeOf,
	ChallengeTypeInfo,
	ChallengeType,
	Graded,
	ScreenOf,
	Served
} from '$lib/types';
import { callChallenges } from './core';

export interface ServedOf<T extends ChallengeType> extends Omit<Served, 'screen'> {
	screen: { type: T; screen: ScreenOf<T> };
}

/** The one serve-time call: the plugin owns the screen, audio and stable shown id. */
export function serveChallenge<T extends ChallengeType>(
	challenge: ChallengeOf<T>,
	shown: string
): ServedOf<T> {
	return callChallenges('serveChallenge', { challenge, shown }) as ServedOf<T>;
}

/** The one grading call: the plugin owns verdict, feedback and event text. */
export function gradeChallenge<T extends ChallengeType>(
	challenge: ChallengeOf<T>,
	shown: string,
	answer: AnswerOf<T>
): Graded {
	const tagged = { type: challenge.type, answer } as ChallengeAnswer;
	return callChallenges('gradeChallenge', { challenge, shown, answer: tagged });
}

export function serveAny(challenge: Challenge, shown: string): Served {
	return callChallenges('serveChallenge', { challenge, shown });
}

export function gradeAny(challenge: Challenge, shown: string, answer: ChallengeAnswer): Graded {
	return callChallenges('gradeChallenge', { challenge, shown, answer });
}

/** Canonical answer feedback for a skip, without teaching the frontend any type rules. */
export function correctFeedback(challenge: Challenge, shown: string): Graded['feedback'] {
	return callChallenges('correctFeedback', { challenge, shown });
}

let typeInfo: ChallengeTypeInfo[] | undefined;

/** Registry flags are generated from the Rust plugin constants. */
export function challengeInfo(type: ChallengeType): ChallengeTypeInfo {
	typeInfo ??= callChallenges('challengeTypes', {});
	const info = typeInfo.find((candidate) => candidate.type === type);
	if (!info) throw new Error(`Unregistered challenge type ${type}`);
	return info;
}
