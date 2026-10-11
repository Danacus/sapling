import type { RomanizedToken } from '$lib/romanize';
import type { AnswerOf, ChallengeOf, ChallengeType, Graded, ScreenOf } from '$lib/types';

/** Props implemented by every registered challenge component. */
export interface ChallengeProps<T extends ChallengeType> {
	challenge: ChallengeOf<T>;
	screen: ScreenOf<T>;
	graded?: Graded;
	onanswer: (answer: AnswerOf<T>, responseMs: number) => void;
	targetLanguage?: string;
	nativeLanguage?: string;
	tokenize?: ((text: string) => RomanizedToken[]) | null;
}
