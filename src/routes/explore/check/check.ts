/**
 * The decisions behind "Check what you know", kept out of the page so they
 * can be tested in node: which proposed words are new, how hard the next grid
 * is, and how one grid is fetched.
 *
 * Deliberately dumb. There is no frequency rank and no estimate of how many
 * words the learner knows: a grid is whatever the model proposes, minus what
 * the learner already has or has already seen this run, and the only signal
 * that steers it is the share of the last grid that was tapped. Nothing here
 * is stored — a tapped word becomes an ordinary card through `addWords`, and a
 * run that stops halfway has already kept everything it added.
 *
 * The repeat filter is the client's and never the model's: `recent` tells the
 * model what it already listed, but a model that repeats itself anyway must
 * not show the learner the same word twice or offer one they already have.
 */

import { wordBatch } from '$lib/llm';
import type { CallOptions, CheckStep, SuggestedWord, WordBatchArgs } from '$lib/llm';
import { sameCard } from '$lib/text';

/** Tiles in one check grid. */
export const GRID_SIZE = 20;
/** Fewer survivors than this and the grid is fetched once more before showing. */
export const MIN_GRID = 8;
/** What a check batch asks for: room for the filter to drop a third. */
export const CHECK_COUNT = 30;
/** What a starter batch asks for: a topic's dozen first words. */
export const STARTER_COUNT = 12;
/** The latest shown terms a request carries (the call caps there too). */
export const RECENT_LIMIT = 60;

/** Share tapped at or above which the next grid steps harder. */
const HARDER_AT = 0.7;
/** Share tapped below which the next grid steps easier. */
const EASIER_BELOW = 0.3;

/** A card at a seam with no ids: what `add_words` dedupes by. */
export interface TakenWord {
	term: string;
	romanization?: string | null;
}

/**
 * The next check step from the last grid: most of it recognised, a bit
 * harder; little of it, a bit easier; otherwise the same. An empty grid says
 * nothing, so it stays put.
 */
export function nextStep(tapped: number, shown: number): CheckStep {
	if (shown <= 0) return 'same';
	const share = tapped / shown;
	if (share >= HARDER_AT) return 'harder';
	if (share < EASIER_BELOW) return 'easier';
	return 'same';
}

/**
 * The proposed words that are neither in `taken` nor repeated within the
 * batch, at most `limit`, in the model's order — by `sameCard`, the rule
 * `add_words` itself dedupes by, so a tile never offers a word adding would
 * then skip.
 */
export function freshWords(
	batch: readonly SuggestedWord[],
	taken: readonly TakenWord[],
	limit = GRID_SIZE
): SuggestedWord[] {
	const seen: TakenWord[] = [...taken];
	const fresh: SuggestedWord[] = [];
	for (const word of batch) {
		if (fresh.length >= limit) break;
		if (seen.some((other) => sameCard(other, word))) continue;
		seen.push(word);
		fresh.push(word);
	}
	return fresh;
}

/** The last {@link RECENT_LIMIT} terms of `shown`, oldest first. */
export function recentTerms(shown: readonly { term: string }[]): string[] {
	return shown.slice(-RECENT_LIMIT).map((word) => word.term);
}

/**
 * How a check run opens. An empty library starts at the very most common
 * words. A library that already holds words would get those same common words
 * back, nearly all of them filtered away, so the run instead opens at `same`
 * with the latest-added library terms as `recent`: "about as hard as what I
 * last added, none of these". Still no estimate — just the newest cards as the
 * reference point.
 */
export function firstCheck(library: readonly { term: string; introducedAt: number }[]): {
	step: CheckStep;
	seed: string[];
} {
	if (library.length === 0) return { step: 'start', seed: [] };
	const seed = [...library]
		.sort((a, b) => a.introducedAt - b.introducedAt)
		.slice(-RECENT_LIMIT)
		.map((item) => item.term);
	return { step: 'same', seed };
}

export interface GridRequest {
	args: Omit<WordBatchArgs, 'recent' | 'count'>;
	/** The library: never offered again. */
	library: readonly TakenWord[];
	/** Everything shown this run, oldest first: never offered again either. */
	shown: readonly SuggestedWord[];
	/**
	 * Library terms sent as `recent` ahead of `shown`, oldest first
	 * ({@link firstCheck}); a hint only, since the library is filtered anyway.
	 */
	seed?: readonly string[];
	/** Tiles wanted; a check grid is {@link GRID_SIZE}. */
	limit: number;
	/** Words to ask the model for. */
	count: number;
}

/**
 * One grid: a batch, filtered; and if too little of it survives, one more
 * batch — told about the first one's words too, so it moves on — filtered
 * against everything including the first's survivors. Never a third: a model
 * that keeps repeating itself gets a short grid rather than a loop.
 */
export async function fetchGrid(
	request: GridRequest,
	opts: CallOptions = {},
	fetchBatch: typeof wordBatch = wordBatch
): Promise<SuggestedWord[]> {
	const { args, library, shown, seed = [], limit, count } = request;
	const taken = [...library, ...shown];
	const steer = seed.map((term) => ({ term }));
	const first = await fetchBatch(
		{ ...args, count, recent: recentTerms([...steer, ...shown]) },
		opts
	);
	const grid = freshWords(first.words, taken, limit);
	if (grid.length >= Math.min(MIN_GRID, limit)) return grid;

	const second = await fetchBatch(
		{ ...args, count, recent: recentTerms([...steer, ...shown, ...first.words]) },
		opts
	);
	return [...grid, ...freshWords(second.words, [...taken, ...grid], limit - grid.length)];
}
