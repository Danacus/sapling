/**
 * Adaptive serve-time presentation: everything about a served challenge that
 * is decided from the challenge's weakest word's rung rather than written by
 * the model — the native-language hint line, a cloze/multi-cloze word bank's
 * size, and a word-order tray's distractor-tile count.
 *
 * All three exist for the same reason: a row is generated once and played for
 * weeks while the word's rung moves, so "how much support to show" cannot be
 * baked into the row at write time. The model always writes the fullest
 * version it can — every native line, the fullest bank/tray a wire type's
 * schema allows (`$lib/llm/challenge-types`' cloze, multi-cloze and
 * word-order defs) — and this module decides how much of that stored content
 * a *served* challenge actually shows.
 *
 * `showNativeHint`, `bankSizeFor` and `distractorTilesFor` all read
 * `levelForStrength(weakestWordStrength(…))`, so the three ramps move together
 * as a word's rung does. An unresolvable `itemId` (and a challenge citing no
 * items at all) reads as rung 1 there, which is why every ladder's floor is
 * its *most* supportive entry: showing extra support to a learner who does not
 * need it costs nothing, hiding support from one who does is a wall.
 * `presentationFor` folds all three, plus the readings roll, into the one prop
 * the learn screen hands down through `ChallengeHost`.
 *
 * The two `visible*` functions decide **which** stored entries show at a given
 * size — deterministically, from the challenge's own stored order (already
 * shuffled once, at resolve time), never re-shuffled here: the answer(s)
 * first, keeping their original position, then the first
 * `size - answers` distractors in stored order. Positions, not values, are
 * returned, so a caller can slice any index-aligned romanization array
 * (`wordBankRomanization`, `tilesRomanization`) by the same indices.
 */

import type {
	Challenge,
	ClozeChallenge,
	KnowledgeItem,
	MultiClozeChallenge,
	WordOrderChallenge
} from '$lib/types';
import type { RomanizationMode } from '$lib/ui/prefs';
import {
	CLOZE_BANK_LADDER,
	HINT_CEILING_LEVEL,
	MULTI_CLOZE_BANK_LADDER,
	WORD_ORDER_DISTRACTOR_LADDER
} from './ladders';
import { itemsById, levelForStrength, weakestWordStrength } from './progression';
import { ALL_READINGS, planReadings, type ReadingPlan } from './reading';

export {
	CLOZE_BANK_LADDER,
	HINT_CEILING_LEVEL,
	MULTI_CLOZE_BANK_LADDER,
	WORD_ORDER_DISTRACTOR_LADDER
} from './ladders';

/**
 * Everything about a served challenge that is decided at serve time rather
 * than written by the model — one object instead of four separate optional
 * props, since they were always rolled together by {@link presentationFor} and
 * never independently.
 *
 * Declared here, in the module that builds it, rather than in
 * `$lib/challenges/props`: a component only ever reads this, and the serve
 * layer must not import the component contract back. `props.ts` re-exports
 * this type so every existing importer keeps finding it.
 */
export interface Presentation {
	/**
	 * Whether the challenge's native-language line — a cloze's translation, a
	 * word-order's prompt, a spot-error's intended meaning — is shown; the line
	 * itself is always on the row.
	 */
	showHint: boolean;
	/**
	 * How many entries a cloze's or multi-cloze's word bank shows, answer(s)
	 * included. Meaningless (read as `0`) for a type with no bank; the full
	 * stored bank is always kept, this only says how much of it to render, via
	 * `visibleBank`.
	 */
	bankSize: number;
	/**
	 * How many extra distractor tiles a word-order challenge's tray shows
	 * beyond the sentence's own tiles, via `visibleTiles`. Meaningless (read as
	 * `0`) for a type with no tray.
	 */
	distractorTiles: number;
	/**
	 * Which readings the served challenge shows — rolled once, here, by
	 * {@link planReadings} from the learner's mode and the challenge's own
	 * words. One answer for the whole challenge, one per word it exercises.
	 */
	readings: ReadingPlan;
}

/**
 * Whether this served challenge shows its native-language line — a cloze's
 * `translationHint`, a word-order's `prompt`, a spot-error's `meaning`.
 *
 * True while the challenge's weakest word sits at or below
 * {@link HINT_CEILING_LEVEL}. An `itemId` that no longer resolves counts as
 * strength 0 (the weakest word there is), and so does a challenge citing no
 * items at all — a hint is the safe default, since hiding one from a learner
 * who needed it is a wall, and showing one to a learner who did not is only a
 * line they can ignore. Unlike the readings ramp it is a step, not a coin
 * flip: the hint shows on the two early rungs and is gone from rung 3 — the
 * rung at which the target-language sentence is meant to carry the meaning on
 * its own — so there is nothing to roll and nothing to memoise. Pure and
 * deterministic: no rng, no clock, no DB.
 */
export function showNativeHint(
	challenge: Challenge,
	items: KnowledgeItem[],
	byId: ReadonlyMap<string, KnowledgeItem> = itemsById(items)
): boolean {
	return levelForStrength(weakestWordStrength(challenge, items, byId)) <= HINT_CEILING_LEVEL;
}

/**
 * How large a served cloze's or multi-cloze's word bank should read, answer(s)
 * included — never more than the stored bank actually has.
 *
 * `byId` is the optional pre-built {@link itemsById} index, so a caller asking
 * about several facts of one challenge builds it once; omitted, it is rebuilt
 * from `items` exactly as before.
 */
export function bankSizeFor(
	challenge: ClozeChallenge | MultiClozeChallenge,
	items: KnowledgeItem[],
	byId: ReadonlyMap<string, KnowledgeItem> = itemsById(items)
): number {
	const level = levelForStrength(weakestWordStrength(challenge, items, byId));
	const stored = challenge.wordBank?.length ?? 0;
	const ladder = challenge.type === 'cloze' ? CLOZE_BANK_LADDER : MULTI_CLOZE_BANK_LADDER;
	return Math.min(stored, ladder[level - 1]);
}

/**
 * How many extra distractor tiles a served word-order challenge should show —
 * never more than the stored tray actually has beyond the sentence itself.
 * Takes the same optional `byId` index as {@link bankSizeFor}.
 */
export function distractorTilesFor(
	challenge: WordOrderChallenge,
	items: KnowledgeItem[],
	byId: ReadonlyMap<string, KnowledgeItem> = itemsById(items)
): number {
	const level = levelForStrength(weakestWordStrength(challenge, items, byId));
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

/**
 * The one served-presentation object a challenge component reads — the single
 * serve entry point. Folds {@link showNativeHint}, {@link bankSizeFor},
 * {@link distractorTilesFor} and the challenge's {@link planReadings} roll into
 * the shape {@link Presentation} declares, so the learn screen makes one call
 * per served challenge instead of three.
 *
 * The readings roll is threaded through here rather than left to the caller
 * precisely because it is the same decision, made from the same challenge over
 * the same vocabulary: the hint, the bank and the crutch all fade as the
 * challenge's weakest word grows. `rng` is forwarded to `planReadings` so a
 * deterministic draw can be injected in tests.
 *
 * The `itemsById` index is built once here and threaded to every helper that
 * needs the challenge's weakest word — each of them used to rebuild it through
 * `weakestWordStrength`'s default, so one served challenge paid for the same
 * map up to three times. The helpers still accept a bare `items` array; this is
 * the optimisation, not the contract.
 *
 * `bankSizeFor`/`distractorTilesFor` only mean something for the challenge
 * types that carry a bank or a tray; the other two fields read `0` for every
 * other type, which is harmless — a component that does not have a bank or a
 * tray never reads them.
 */
export function presentationFor(
	challenge: Challenge,
	items: KnowledgeItem[],
	opts: { romanizationMode: RomanizationMode; rng?: () => number }
): Presentation {
	const byId = itemsById(items);
	return {
		showHint: showNativeHint(challenge, items, byId),
		bankSize:
			challenge.type === 'cloze' || challenge.type === 'multi-cloze'
				? bankSizeFor(challenge, items, byId)
				: 0,
		distractorTiles:
			challenge.type === 'word-order' ? distractorTilesFor(challenge, items, byId) : 0,
		readings: planReadings(opts.romanizationMode, challenge, items, opts.rng, byId)
	};
}

/** The full stored bank a bare render shows when no presentation was supplied. */
function storedBankSize(challenge: Challenge): number {
	return challenge.type === 'cloze' || challenge.type === 'multi-cloze'
		? (challenge.wordBank?.length ?? 0)
		: 0;
}

/** The full stored distractor tray a bare render shows when no presentation was supplied. */
function storedDistractorTiles(challenge: Challenge): number {
	return challenge.type === 'word-order'
		? Math.max(0, challenge.tiles.length - challenge.answerTokens.length)
		: 0;
}

/**
 * A served presentation, or the "bare render shows everything stored" defaults
 * when none was handed down.
 *
 * The point is that a component stops spelling the defaults itself: absent
 * `presentation` means the hint is on, a bank shows in full, a tray's stored
 * distractors all show, and every reading shows — the behaviour every component
 * had before any of this was rolled at serve time, and what a bare render
 * (tests, a component used on its own) must keep doing. A partial is accepted
 * because a component may legitimately be handed only the fields it cares
 * about; each field the caller supplies passes through untouched and only the
 * missing ones fall back. A served challenge always hands the full object, made
 * by {@link presentationFor}.
 */
export function resolvedPresentation(
	challenge: Challenge,
	presentation?: Partial<Presentation>
): Presentation {
	return {
		showHint: presentation?.showHint ?? true,
		bankSize: presentation?.bankSize ?? storedBankSize(challenge),
		distractorTiles: presentation?.distractorTiles ?? storedDistractorTiles(challenge),
		readings: presentation?.readings ?? ALL_READINGS
	};
}
