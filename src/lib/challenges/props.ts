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
	/** The target language's BCP-47 tag, for speech; absent when unresolved. */
	targetLanguageTag?: string;
	tokenize?: ((text: string) => RomanizedToken[]) | null;
}
