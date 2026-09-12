/**
 * The free round, built locally — no model call, no tokens.
 *
 * `match-pairs` is the one challenge the pipeline does not generate: the session
 * splices a round of it between paid challenges as a breather, drawing on words
 * the learner already has. It used to live in `$lib/llm/generate` beside the
 * paid generation path, but it is not an LLM concern — it spends no tokens and
 * imports no client — so it lives with the challenge it builds now. The arrow
 * still points one way: this module imports `$lib/types` and generic leaves,
 * never `$lib/llm`.
 */

import { newUuid } from '$lib/device';
import { shuffled } from '$lib/random';
import { labelKey } from '$lib/text';
import type { Challenge, KnowledgeItem } from '$lib/types';

/**
 * Smallest and largest pair count for an *unsized* round — one built without a
 * ladder rung, which is what a caller with no vocabulary strength to read gets.
 */
const MATCH_MIN = 4;
const MATCH_MAX = 5;

/**
 * Pairs per round at each rung of the ladder — the free round's counterpart to
 * the `params` ladders the paid types have. A new word's round is three pairs
 * because the point of it is a breather; a word the learner owns gets six,
 * which is about as tall a column as a phone screen holds — the learn route's
 * stage grows rather than clips, so a taller round only costs a scroll, but six
 * is where the round stops being one glance.
 *
 * Bounded by the stored side's own scale on purpose: `$lib/challenges/types/match-pairs`
 * measures a round's difficulty over `FEWEST_PAIRS` (2) to `MOST_PAIRS` (6), so
 * a ladder reaching past six would peg every top rung at the same stored
 * difficulty and the planner's fit preference would stop being able to tell them
 * apart.
 */
const MATCH_PAIRS_LADDER = [3, 4, 5, 6, 6] as const;

/** The fewest pairs any rung asks for — the floor a sized round declines below. */
const LADDER_MIN = Math.min(...MATCH_PAIRS_LADDER);

/** The five-rung ladder a round may be sized at — the same `1..5` the session plans on. */
type RoundRung = 1 | 2 | 3 | 4 | 5;

export interface MatchPairsOptions {
	/**
	 * The ladder rung to size the round for. Omitted means "unsized": four or
	 * five pairs, drawn from `rng`, exactly as this function has always behaved.
	 */
	difficulty?: RoundRung;
}

/**
 * Builds a `match-pairs` challenge locally, for free — no model call, no
 * tokens. Pairs a random handful of already-known items term-to-meaning.
 *
 * **Every tile label is unique.** Two items that render the same text on either
 * side (two synonyms sharing a meaning, two spellings sharing a term) make the
 * round unplayable: the learner sees two identical tiles and has to guess which
 * twin belongs to which pair, and a correct guess is graded wrong half the time.
 * The first item of a colliding group is kept and the rest are skipped, matched
 * case-insensitively on trimmed text.
 *
 * **Size comes from the same ladder everything else is written to.** Given a
 * rung, the round asks for {@link MATCH_PAIRS_LADDER} pairs — the zero-cost
 * type's version of a def's `params`. Given none, it is four or five pairs
 * drawn from `rng`.
 *
 * Returns `undefined` when fewer collision-free items remain than the smallest
 * round that mode can ask for: four unsized, {@link LADDER_MIN} with a rung.
 * Between that floor and the rung's own count it builds the *smaller* round
 * rather than declining — a slightly short round is still a breather, and the
 * alternative is no round at all for a learner with a dozen words.
 *
 * @param rng Injectable `[0,1)` source so tests (and replays) are deterministic.
 */
export function makeMatchPairsChallenge(
	items: KnowledgeItem[],
	rng: () => number = Math.random,
	options: MatchPairsOptions = {}
): Challenge | undefined {
	const rung = options.difficulty;
	const smallest = rung === undefined ? MATCH_MIN : LADDER_MIN;

	const usable = items.filter((i) => i.term?.trim() && i.meaning?.trim());
	if (usable.length < smallest) return undefined;

	const pool = shuffled(usable, rng);

	// Drop collisions *after* the shuffle, so which twin survives is still
	// random rather than always the first one in storage order.
	const seenTerms = new Set<string>();
	const seenMeanings = new Set<string>();
	const distinct: KnowledgeItem[] = [];
	for (const item of pool) {
		const term = labelKey(item.term);
		const meaning = labelKey(item.meaning);
		if (seenTerms.has(term) || seenMeanings.has(meaning)) continue;
		seenTerms.add(term);
		seenMeanings.add(meaning);
		distinct.push(item);
	}
	if (distinct.length < smallest) return undefined;

	// Sized: the rung names the count outright and no draw is spent on it, so a
	// round is a pure function of the rung once the shuffle has happened.
	// Unsized: the old four-or-five draw, untouched.
	let wanted: number;
	if (rung === undefined) {
		const max = Math.min(MATCH_MAX, distinct.length);
		wanted = max > MATCH_MIN ? MATCH_MIN + Math.floor(rng() * (max - MATCH_MIN + 1)) : MATCH_MIN;
	} else {
		wanted = MATCH_PAIRS_LADDER[rung - 1];
	}
	const chosen = distinct.slice(0, Math.min(wanted, distinct.length));

	return {
		id: newUuid(),
		type: 'match-pairs',
		direction: 'toNative',
		itemIds: chosen.map((i) => i.id),
		// `aRom` carries the term's romanization when the item has one; `b` is
		// already in the learner's native language, so it never needs one.
		pairs: chosen.map((i) => {
			const aRom = i.romanization?.trim();
			return {
				a: i.term.trim(),
				b: i.meaning.trim(),
				...(aRom ? { aRom } : {})
			};
		})
	};
}
