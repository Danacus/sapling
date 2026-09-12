/**
 * Adaptive word-bank size and distractor-tile count: how much of a served
 * cloze/multi-cloze bank or a word-order tray is shown, decided from the
 * challenge's weakest word's rung.
 *
 * Same shape as `./hints`' native-line ramp, and for the same reason: a row is
 * generated once and played for weeks while the word's rung moves, so "how
 * much support to show" cannot be baked into the row at write time. Generation
 * now always writes the fullest bank/tray a wire type's schema allows
 * (`$lib/llm/challenge-types`' cloze, multi-cloze and word-order defs), and
 * this module decides how much of that stored set a served challenge actually
 * shows — the same relationship romanization and the native hint already have
 * to their own stored fields.
 *
 * `bankSizeFor`/`distractorTilesFor` read `levelForStrength(weakestWordStrength(…))`,
 * exactly as `showNativeHint` does, so all three ramps move together as a
 * word's rung does. An unresolvable `itemId` (and a challenge citing no items
 * at all) reads as rung 1 there, which is why every ladder's floor is its
 * *most* supportive entry: showing extra support to a learner who does not
 * need it costs nothing, hiding support from one who does is a wall.
 *
 * The two `visible*` functions decide **which** stored entries show at that
 * size — deterministically, from the challenge's own stored order (already
 * shuffled once, at resolve time), never re-shuffled here: the answer(s)
 * first, keeping their original position, then the first
 * `size - answers` distractors in stored order. Positions, not values, are
 * returned, so a caller can slice any index-aligned romanization array
 * (`wordBankRomanization`, `tilesRomanization`) by the same indices.
 */

import type {
	ClozeChallenge,
	KnowledgeItem,
	MultiClozeChallenge,
	WordOrderChallenge
} from '$lib/types';
import { levelForStrength, weakestWordStrength } from './progression';

/** Cloze word-bank size by rung, answer included. Mirrors the old generation ladder. */
export const CLOZE_BANK_LADDER = [3, 3, 4, 5, 6] as const;

/** Multi-cloze shared word-bank size by rung, answers included. */
export const MULTI_CLOZE_BANK_LADDER = [5, 6, 7, 8, 9] as const;

/** Word-order distractor tile count by rung — the sentence's own tiles are always shown. */
export const WORD_ORDER_DISTRACTOR_LADDER = [0, 0, 1, 2, 3] as const;

/**
 * How large a served cloze's or multi-cloze's word bank should read, answer(s)
 * included — never more than the stored bank actually has.
 */
export function bankSizeFor(
	challenge: ClozeChallenge | MultiClozeChallenge,
	items: KnowledgeItem[]
): number {
	const level = levelForStrength(weakestWordStrength(challenge, items));
	const stored = challenge.wordBank?.length ?? 0;
	const ladder = challenge.type === 'cloze' ? CLOZE_BANK_LADDER : MULTI_CLOZE_BANK_LADDER;
	return Math.min(stored, ladder[level - 1]);
}

/**
 * How many extra distractor tiles a served word-order challenge should show —
 * never more than the stored tray actually has beyond the sentence itself.
 */
export function distractorTilesFor(challenge: WordOrderChallenge, items: KnowledgeItem[]): number {
	const level = levelForStrength(weakestWordStrength(challenge, items));
	const storedDistractors = Math.max(0, challenge.tiles.length - challenge.answerTokens.length);
	return Math.min(storedDistractors, WORD_ORDER_DISTRACTOR_LADDER[level - 1]);
}

/**
 * Picks `size` positions out of a bank: every answer's own position, then the
 * first surviving distractor positions in stored order, until `size` is
 * reached. `size` is clamped up to the number of answers (a bank smaller than
 * its own answers is not a thing `bankSizeFor` produces, but a caller must
 * never be handed a bank missing its answer) and down to the bank's length.
 */
function selectPositions(
	bankLength: number,
	answerPositions: readonly number[],
	size: number
): number[] {
	const capped = Math.min(Math.max(size, answerPositions.length), bankLength);
	const selected = new Set(answerPositions);
	for (let i = 0; selected.size < capped && i < bankLength; i++) {
		selected.add(i);
	}
	return [...selected].sort((a, b) => a - b);
}

/** The stored bank position of each of `challenge`'s own answers, in answer order. */
function answerPositionsOf(challenge: ClozeChallenge | MultiClozeChallenge): number[] {
	const bank = challenge.wordBank ?? [];
	const answers =
		challenge.type === 'cloze'
			? [challenge.acceptedAnswers[0]]
			: challenge.gaps.map((gap) => gap.acceptedAnswers[0]);
	const taken = new Set<number>();
	const positions: number[] = [];
	for (const answer of answers) {
		const at = bank.findIndex((word, index) => word === answer && !taken.has(index));
		if (at >= 0) {
			taken.add(at);
			positions.push(at);
		}
	}
	return positions;
}

/**
 * The stored bank positions a served cloze/multi-cloze should show at `size`
 * — the answer(s)' own positions plus the first surviving distractors, in
 * stored order. Index-aligned with `wordBank` and `wordBankRomanization`.
 */
export function visibleBank(
	challenge: ClozeChallenge | MultiClozeChallenge,
	size: number
): number[] {
	const bank = challenge.wordBank ?? [];
	if (bank.length === 0) return [];
	return selectPositions(bank.length, answerPositionsOf(challenge), size);
}

/**
 * The stored tile positions that make up the sentence itself — everything in
 * `answerTokens`, matched to `tiles` by text with multiplicity (a sentence may
 * legitimately repeat a word, and so may a distractor list).
 */
function answerTilePositions(challenge: WordOrderChallenge): number[] {
	const remaining = new Map<string, number>();
	for (const token of challenge.answerTokens) {
		remaining.set(token, (remaining.get(token) ?? 0) + 1);
	}
	const positions: number[] = [];
	challenge.tiles.forEach((tile, index) => {
		const left = remaining.get(tile) ?? 0;
		if (left > 0) {
			remaining.set(tile, left - 1);
			positions.push(index);
		}
	});
	return positions;
}

/**
 * The stored tile positions a served word-order challenge should show: every
 * sentence tile, plus the first `count` surviving distractor tiles in stored
 * order. Index-aligned with `tiles` and `tilesRomanization`.
 */
export function visibleTiles(challenge: WordOrderChallenge, count: number): number[] {
	const answerPositions = answerTilePositions(challenge);
	return selectPositions(challenge.tiles.length, answerPositions, answerPositions.length + count);
}

/** Re-exported so a caller sizing a served challenge needs one import for both ramps. */
export { showNativeHint } from './hints';
