/**
 * Which screens first run shows, and where it ends — kept out of the page so
 * the branching can be tested in node.
 *
 * The aim is that a new learner leaves onboarding with words and a way into
 * practice, not an empty garden. So the last step asks how much of the
 * language they know and hands them to "Check what you know" in the matching
 * mode. That step needs a model to write the words, though, and offering it
 * without one would end on an error: so it exists only when a key is there (or
 * the mock is forced on for development), and keyless onboarding ends on the
 * dashboard, whose empty state says honestly what a key would unlock.
 *
 * Adding a second language never had a key step — the key is device-wide and
 * already saved, or deliberately not — so it is languages, then the level
 * question when the stored key allows it.
 */

export type OnboardingStep = 'languages' | 'model' | 'level';

/** The two answers to "How much do you know?". */
export type StartingPoint = 'scratch' | 'some';

export interface StepsInput {
	/** `?add`: a further language on an existing library. */
	adding: boolean;
	/** A key to generate with: the one typed on the model step, or (adding) the stored one. */
	keyed: boolean;
	/** The `ll.mockMode` flag, set explicitly — not the keyless fallback. */
	mockForced: boolean;
}

/** The steps this run shows, in order; the progress dots are its length. */
export function onboardingSteps({ adding, keyed, mockForced }: StepsInput): OnboardingStep[] {
	const steps: OnboardingStep[] = adding ? ['languages'] : ['languages', 'model'];
	if (keyed || mockForced) steps.push('level');
	return steps;
}

/** Where a run that ends without the level step goes. */
export const FINISH_HREF = '/';

/** Where each answer to the level step goes: a starter topic, or the check grid. */
export function startHref(start: StartingPoint): string {
	return start === 'scratch' ? '/explore/check?mode=starter' : '/explore/check';
}
