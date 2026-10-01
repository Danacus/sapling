/**
 * What a served challenge shows, decided in Rust (`crates/sapling-challenges`'
 * `serve.rs`) from the help level serving picked for it (`fits.rs`): the
 * native hint, how much of a stored bank or tray shows, whether its reading
 * shows, whether it is played before it is read — and, for the screens that
 * colour a word, its maturity and the reader's reading ramp, which are display
 * and decide nothing about a challenge.
 *
 * The learn screen computes a {@link Presentation} once per served challenge
 * and hands it down through `ChallengeHost`; a component resolves it with
 * {@link resolvedPresentation}, whose "show everything stored" defaults are
 * what a bare render gets.
 */

import type {
	Challenge,
	ClozeChallenge,
	KnowledgeItem,
	MultiClozeChallenge,
	WordOrderChallenge
} from '$lib/types';
import type { Maturity } from '$lib/db/generated/index';
import { strengthOf } from '$lib/srs';
import { callChallenges } from './core';

export type { Maturity };

/** Which readings a served challenge shows — one answer for the whole, and per-word overrides. */
export interface ReadingPlan {
	/** The whole-challenge decision: the help level's reading shown or hidden. */
	sentence: boolean;
	/**
	 * Per-word overrides keyed by the item's `term`. Serving leaves it empty —
	 * a help level decides the whole challenge — and the shape stays so a
	 * component reads one plan whoever made it.
	 */
	byTerm: ReadonlyMap<string, boolean>;
}

/** Everything about a served challenge decided at serve time. */
export interface Presentation {
	/** Whether the native-language line shows; the line itself is always stored. */
	showHint: boolean;
	/** Bank entries a cloze or multi-cloze shows, answers included, via {@link visibleBank}. */
	bankSize: number;
	/** Distractor tiles a word-order shows beyond its own, via {@link visibleTiles}. */
	distractorTiles: number;
	readings: ReadingPlan;
	/** Played before it is read: the prompt's text waits until the learner asks. */
	listening: boolean;
	/**
	 * The help level this screen is — `crates/sapling-challenges`' `help.rs` names
	 * them (`pick-6`, `typed-hidden`, `listening`). What the answer records.
	 */
	shown: string;
}

/** Readings on everywhere: the default a component gets with no plan. */
export const ALL_READINGS: ReadingPlan = { sentence: true, byTerm: new Map() };

/**
 * The one served-presentation object: the challenge at the help level serving
 * picked (`shown`, from the plan). A level this build does not know shows the
 * row at its easiest.
 */
export function presentationFor(challenge: Challenge, shown: string): Presentation {
	const served = callChallenges('presentationFor', { challenge, shown });
	return {
		...served,
		readings: {
			sentence: served.readings.sentence,
			byTerm: new Map(Object.entries(served.readings.byTerm))
		}
	};
}

/**
 * A served presentation, or the bare-render defaults — hint on, the whole
 * stored bank and tray, every reading, nothing played first — for whatever
 * the caller left out. `shown` is not defaulted: it is what an answer records,
 * and a bare render records nothing.
 */
export function resolvedPresentation(
	challenge: Challenge,
	presentation?: Partial<Presentation>
): Omit<Presentation, 'shown'> {
	const bank =
		challenge.type === 'cloze' || challenge.type === 'multi-cloze'
			? (challenge.wordBank?.length ?? 0)
			: 0;
	const tray =
		challenge.type === 'word-order'
			? Math.max(0, challenge.tiles.length - challenge.answerTokens.length)
			: 0;
	return {
		showHint: presentation?.showHint ?? true,
		bankSize: presentation?.bankSize ?? bank,
		distractorTiles: presentation?.distractorTiles ?? tray,
		readings: presentation?.readings ?? ALL_READINGS,
		listening: presentation?.listening ?? false
	};
}

/**
 * The stored bank positions a cloze or multi-cloze shows at `size`: its
 * answers where they sit, then the first distractors in stored order.
 * Index-aligned with `wordBank` and `wordBankRomanization`.
 */
export function visibleBank(
	challenge: ClozeChallenge | MultiClozeChallenge,
	size: number
): number[] {
	return callChallenges('visibleBank', { challenge, size });
}

/**
 * The stored tile positions a word-order shows: every sentence tile, then the
 * first `count` distractors. Index-aligned with `tiles` and `tilesRomanization`.
 */
export function visibleTiles(challenge: WordOrderChallenge, count: number): number[] {
	return callChallenges('visibleTiles', { challenge, count });
}

/** How far along a word is, in three coarse steps. */
export function maturityOf(item: KnowledgeItem): Maturity {
	return callChallenges('maturityOf', { strength: strengthOf(item) });
}

/** The chance the reader hides a word's reading at this strength, under `'adaptive'`. */
export function hideReadingProbability(strength: number): number {
	return callChallenges('hideReadingProbability', { strength });
}
