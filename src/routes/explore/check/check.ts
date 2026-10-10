/**
 * The decisions behind "Check what you know", kept out of the page so they
 * can be tested in node: which proposed words are new, how hard the next grid
 * is, what the model is told to leave out, and how one grid is fetched.
 *
 * Deliberately dumb. There is no frequency rank and no estimate of how many
 * words the learner knows: a grid is whatever the model proposes, minus what
 * the learner already has or has already seen this run, and the only signal
 * that steers it is the share of the last grid that was tapped. Nothing here
 * is stored — a tapped word becomes an ordinary card through `addWords`, and a
 * run that stops halfway has already kept everything it added.
 *
 * The model is told everything to leave out — the whole library and the run,
 * newest last (`excludeTerms`) — because one that saw only the last few grids
 * listed the earlier ones again and a grid of twenty filtered down to five.
 * The tail of that list is also what the step is relative to, so the library
 * goes in by when each word was added. Still, the repeat filter is the
 * client's and never the model's: a model that repeats itself anyway must not
 * show the learner the same word twice or offer one they already have.
 */

import { wordBatch } from '$lib/llm';
import type { CallOptions, CheckStep, SuggestedWord, WordBatchArgs } from '$lib/llm';
import { sameCard, termKey } from '$lib/text';

/** Tiles in one check grid. */
export const GRID_SIZE = 20;
/** What a check batch asks for: twice the grid, room for the filter to drop half. */
export const CHECK_COUNT = 40;
/** What a starter batch asks for: a topic's dozen first words. */
export const STARTER_COUNT = 12;
/** The most terms `exclude` carries, the newest kept (the call caps there too). */
export const EXCLUDE_LIMIT = 2000;
/** Calls one grid may take before it is shown short. */
export const MAX_FETCHES = 3;

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

/**
 * `terms` as the model's `exclude`: trimmed, blanks dropped, each once at its
 * *last* place (by `termKey`), and only the newest {@link EXCLUDE_LIMIT}. The
 * last place, because a word added this run sits in both the library and the
 * run, and it is the run's order the step reads off the tail.
 */
export function excludeTerms(terms: readonly string[]): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (let i = terms.length - 1; i >= 0 && kept.length < EXCLUDE_LIMIT; i--) {
		const term = terms[i]?.trim() ?? '';
		if (!term) continue;
		const key = termKey(term);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(term);
	}
	return kept.reverse();
}

/** The library oldest first, so its newest words end up last in `exclude`. */
export function byIntroduction(
	library: readonly (TakenWord & { introducedAt: number })[]
): TakenWord[] {
	return [...library]
		.sort((a, b) => a.introducedAt - b.introducedAt)
		.map(({ term, romanization }) => ({ term, romanization }));
}

/**
 * How a check run opens. An empty library starts at the very most common
 * words. A library that already holds words would get those same common words
 * back, nearly all of them filtered away, so the run instead opens at `same`:
 * "about as hard as the last words in `exclude`", which are the latest-added
 * library terms ({@link byIntroduction}). Still no estimate — just the newest
 * cards as the reference point.
 */
export function firstCheck(library: readonly unknown[]): CheckStep {
	return library.length === 0 ? 'start' : 'same';
}

export interface GridRequest {
	args: Omit<WordBatchArgs, 'exclude' | 'count'>;
	/** The library, oldest first ({@link byIntroduction}): never offered again. */
	library: readonly TakenWord[];
	/** Everything shown this run, oldest first: never offered again either. */
	shown: readonly SuggestedWord[];
	/** Tiles wanted; a check grid is {@link GRID_SIZE}. */
	limit: number;
	/** Words to ask the model for, per call. */
	count: number;
}

/**
 * One grid: batches, each filtered against the library, the run and the grid
 * so far, until `limit` survive or {@link MAX_FETCHES} calls are spent. Each
 * later call's `exclude` also names every word the earlier replies listed,
 * kept or not, so it moves on. A model that keeps repeating itself gets a
 * short grid rather than a loop; an empty one is the page's error.
 *
 * A later call that fails leaves the grid with what it has — the learner sees
 * a short grid rather than an error over words already in hand — unless that
 * is nothing, or the caller aborted.
 */
export async function fetchGrid(
	request: GridRequest,
	opts: CallOptions = {},
	fetchBatch: typeof wordBatch = wordBatch
): Promise<SuggestedWord[]> {
	const { args, library, shown, limit, count } = request;
	const taken: TakenWord[] = [...library, ...shown];
	const listed: SuggestedWord[] = [];
	const grid: SuggestedWord[] = [];
	for (let call = 0; call < MAX_FETCHES && grid.length < limit; call++) {
		const exclude = excludeTerms([...taken, ...listed].map((word) => word.term));
		let words: SuggestedWord[];
		try {
			words = (await fetchBatch({ ...args, count, exclude }, opts)).words;
		} catch (cause) {
			if (grid.length === 0 || opts.signal?.aborted) throw cause;
			break;
		}
		grid.push(...freshWords(words, [...taken, ...grid], limit - grid.length));
		listed.push(...words);
	}
	return grid;
}
