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

import type { RomanizedToken } from '$lib/romanize';
import type { Presentation } from '$lib/challenges/serve/presentation';
import type { Challenge, Verdict } from '$lib/types';

/**
 * What every challenge component hands back when the learner commits an answer.
 *
 * Grading happens inside the component (it owns the input widget and therefore
 * the raw string); the session screen only decides what that verdict is *worth*
 * and what to say about it.
 *
 * Declared here rather than in the session engine, where it used to live:
 * `onanswer` in {@link ChallengeProps} is this type, so it belongs beside the
 * contract. The engine re-exports it so its existing importers keep working.
 */
export interface AnswerEvent {
	/**
	 * Exactly what the learner produced, for the result log and escalation, or
	 * the session's skip sentinel when they gave up on the challenge.
	 */
	answerGiven: string;
	verdict: Verdict;
	/**
	 * Milliseconds from "challenge shown" to "answer submitted". Kept for review
	 * screens and analytics only — it no longer sharpens the FSRS grade, which
	 * the learner is asked about directly instead (see the session engine's
	 * `amendResult`).
	 */
	responseMs: number;
	/** Nearest accepted answer, when the component graded with `validateAnswer`. */
	closestAccepted?: string;
	/**
	 * Optional per-item evidence from a challenge with several independently
	 * gradable answers. The overall `verdict` still drives the banner and session
	 * summary; these entries let SRS grade each item by the gap it actually owned.
	 */
	itemVerdicts?: readonly { itemId: string; verdict: Verdict }[];
}

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
	 * Everything decided at serve time — the hint, the bank size, the
	 * distractor-tile count and the readings — built once per served challenge by
	 * `$lib/challenges/serve/presentation`'s `presentationFor`. A component
	 * resolves it with that module's `resolvedPresentation`, which fills the
	 * bare-render defaults, and reads `readings` off the resolved object rather
	 * than taking a separate prop.
	 *
	 * Optional, and absent means "show everything stored, hint on, every reading
	 * on" — the default every component gave each of these before they were
	 * rolled into one prop, and what a bare render (tests, a component used on
	 * its own) still gets by passing nothing.
	 */
	presentation?: Presentation;
	/**
	 * Romanize one string of *target-language* text locally, or `null` when this
	 * language has no local romanizer (`$lib/romanize`) — in which case the
	 * component falls back to the stored, LLM-written romanization fields on the
	 * challenge, gated by the resolved presentation's readings.
	 *
	 * Already bound to the learner's vocabulary terms by the session screen, so a
	 * word they are studying comes back as one token keyed by its term and the
	 * plan can decide it on its own. Call it only where the slot really is
	 * target-language text — the same places a component reaches for a stored
	 * `…Romanization` field. Running a native-language string through it would
	 * annotate the answer.
	 */
	tokenize?: ((text: string) => RomanizedToken[]) | null;
}
