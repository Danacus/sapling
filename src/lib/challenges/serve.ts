/**
 * What a served challenge shows, decided in Rust (`crates/sapling-challenges`'
 * `serve.rs`) from its weakest word's rung: the native hint, how much of a
 * stored bank or tray shows, which readings show, whether it is played before
 * it is read — and a word's maturity, which the screens that colour a word read.
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
import type { RomanizationMode } from '$lib/ui/prefs';
import { asWords, callChallenges } from './core';

export type { Maturity };

/** Which readings a served challenge shows — one answer for the whole, one per word. */
export interface ReadingPlan {
	/**
	 * The whole-challenge decision, from its weakest word: what a flat stored
	 * reading and any token no tracked word covers follow.
	 */
	sentence: boolean;
	/**
	 * Per-word decisions keyed by the item's `term` — every known word, not
	 * only the ones the challenge cites. Empty under `'on'`/`'off'`.
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
}

/** Readings on everywhere: the default a component gets with no plan. */
export const ALL_READINGS: ReadingPlan = { sentence: true, byTerm: new Map() };

/**
 * The one served-presentation object, rolled once per served challenge. `seed`
 * replays the reading rolls.
 */
export function presentationFor(
	challenge: Challenge,
	items: readonly KnowledgeItem[],
	opts: { romanizationMode: RomanizationMode; seed?: number }
): Presentation {
	const served = callChallenges('presentationFor', {
		challenge,
		words: asWords(items),
		romanizationMode: opts.romanizationMode,
		...(opts.seed === undefined ? {} : { seed: opts.seed })
	});
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
 * stored bank and tray, every reading — for whatever the caller left out.
 */
export function resolvedPresentation(
	challenge: Challenge,
	presentation?: Partial<Presentation>
): Presentation {
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
		readings: presentation?.readings ?? ALL_READINGS
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

/**
 * Whether a challenge is played before it is read: `enabled` is the learner's
 * preference; whether speech is available is the caller's question.
 */
export function isListeningChallenge(challenge: Challenge, enabled: boolean): boolean {
	return enabled && callChallenges('isListening', { challenge, enabled });
}

/** How far along a word is, in three coarse steps. */
export function maturityOf(item: KnowledgeItem): Maturity {
	return callChallenges('maturityOf', { strength: strengthOf(item) });
}

/** The chance a word of this strength has its reading hidden under `'adaptive'`. */
export function hideReadingProbability(strength: number): number {
	return callChallenges('hideReadingProbability', { strength });
}
