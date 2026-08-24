/**
 * The contract every challenge component implements.
 *
 * One declared shape rather than six hand-rolled inline prop types: the
 * dispatcher (`ChallengeHost.svelte`) passes the same props to all of
 * them, so a component that quietly disagreed about the name or the optionality
 * of one of them used to fail silently — the prop simply arrived `undefined`.
 * Typing `$props()` with `ChallengeProps<TheirChallenge>` makes that a compile
 * error instead.
 *
 * Both languages reach every component whether or not it uses them. That is
 * deliberate: which types happen to need a language name is a rendering detail
 * that changes as the components do, and threading a prop through the host on
 * demand is exactly the sort of churn this contract exists to prevent. A
 * component that does not need one simply does not destructure it.
 */

import type { AnswerEvent } from '$lib/session/engine';
import type { Challenge } from '$lib/types';

/** Props shared by every challenge component. */
export interface ChallengeProps<C extends Challenge> {
	challenge: C;
	/** Fired once, when the learner commits. Components then lock themselves. */
	onanswer: (event: AnswerEvent) => void;
	/**
	 * The learner's target language, as a name or code for `speak()`. Optional
	 * with an empty-string default, because a profile-less render is a boot state
	 * rather than an error, and an empty language just means "let the browser
	 * pick a voice".
	 */
	targetLanguage?: string;
	/** The learner's own language; used where a component names it in a prompt. */
	nativeLanguage?: string;
	/**
	 * The learner's romanization preference, already resolved for *this*
	 * challenge (see `$lib/session/romanization`): components render their
	 * readings only when it is true, and change nothing else. Optional and
	 * defaulting to true, so a bare render still shows readings — the behaviour
	 * every component had before the preference could hide them.
	 */
	showReadings?: boolean;
}
