import type { Component } from 'svelte';
import type { ChallengeProps } from '$lib/challenges/props';
import type { ChallengeType } from '$lib/types';

import MultipleChoice from './multiple-choice/MultipleChoice.svelte';
import Cloze from './cloze/Cloze.svelte';
import TypedTranslation from './typed-translation/TypedTranslation.svelte';
import MatchPairs from './match-pairs/MatchPairs.svelte';
import MultiCloze from './multi-cloze/MultiCloze.svelte';
import WordOrder from './word-order/WordOrder.svelte';
import SpotError from './spot-error/SpotError.svelte';
import CueCloze from './cue-cloze/CueCloze.svelte';

type ChallengeComponents = {
	[T in ChallengeType]: Component<ChallengeProps<T>>;
};

/** The frontend half of the compile-time plugin registry. */
export const CHALLENGE_COMPONENTS = {
	'multiple-choice': MultipleChoice,
	cloze: Cloze,
	'typed-translation': TypedTranslation,
	'match-pairs': MatchPairs,
	'multi-cloze': MultiCloze,
	'word-order': WordOrder,
	'spot-error': SpotError,
	'cue-cloze': CueCloze
} satisfies ChallengeComponents;

/** The registry lookup is correlated by tag; this is the dispatch boundary's one cast. */
export function componentFor(type: ChallengeType): Component<ChallengeProps<ChallengeType>> {
	return CHALLENGE_COMPONENTS[type] as Component<ChallengeProps<ChallengeType>>;
}
