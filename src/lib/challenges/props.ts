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
import type { AnswerEvent } from '$lib/session/engine';
import { applyPlan, type ReadingPlan } from '$lib/session/romanization';
import type { Challenge } from '$lib/types';

/**
 * Readings on everywhere, nothing hidden: the default every component gives
 * {@link ChallengeProps.readings}.
 *
 * Exported (and shared, which is safe — nothing writes to a `ReadingPlan`) so
 * six components declare the same default by naming it rather than by each
 * writing out a fresh object literal that could quietly disagree.
 */
export const ALL_READINGS: ReadingPlan = { sentence: true, byTerm: new Map() };

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
	 * challenge and rolled once when it was served (see
	 * `$lib/session/romanization`). `sentence` is the whole-challenge answer a
	 * component applies to a stored romanization string; `byTerm` fades
	 * individual words out of tokenized text and is applied by `applyPlan`.
	 *
	 * Optional, defaulting to {@link ALL_READINGS}, so a bare render still shows
	 * every reading — the behaviour every component had before the preference
	 * could hide them.
	 */
	readings?: ReadingPlan;
	/**
	 * Romanize one string of *target-language* text locally, or `null` when this
	 * language has no local romanizer (`$lib/romanize`) — in which case the
	 * component falls back to the stored, LLM-written romanization fields on the
	 * challenge, gated by `readings.sentence`.
	 *
	 * Already bound to the learner's vocabulary terms by the session screen, so a
	 * word they are studying comes back as one token keyed by its term and
	 * `applyPlan` can decide it on its own. The whole contract is:
	 *
	 * ```svelte
	 * <RubyText tokens={applyPlan(tokenize(someTargetText), readings)} />
	 * ```
	 *
	 * Call it only where the slot really is target-language text — the same
	 * places a component reaches for a stored `…Romanization` field. Running a
	 * native-language string through it would annotate the answer.
	 */
	tokenize?: ((text: string) => RomanizedToken[]) | null;
}

/**
 * The two romanization props, combined into the one call every component makes:
 * *"give me ruby tokens for this target-language slot, or `null` if there are
 * none"*.
 *
 * `null` is the fallback signal end to end — no local romanizer for this
 * language, so the caller renders the stored `…Romanization` string gated by
 * `readings.sentence`, exactly as it did before any of this existed. A non-null
 * result already has the learner's per-word decisions applied, so the blocks
 * that draw it stay dumb.
 *
 * Lives here rather than six times over in the components because it is the
 * *meaning* of the two props, not a rendering choice: a component that forgot
 * the `applyPlan` half would silently show readings the learner has outgrown,
 * which is precisely the kind of quiet disagreement this contract exists to
 * make impossible.
 */
export function rubyFor(
	tokenize: ((text: string) => RomanizedToken[]) | null,
	readings: ReadingPlan
): (text: string) => RomanizedToken[] | null {
	if (!tokenize) return () => null;
	return (text) => applyPlan(tokenize(text), readings);
}
