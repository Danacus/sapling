/**
 * Top-up planning: deciding what the pool is missing, so generation can write
 * exactly that and nothing else.
 *
 * Play never consumes a challenge, so the pool — not a lesson — is the unit
 * that matters. What a word needs is a **fresh challenge of each kind it can
 * bear**, and only where it has none.
 *
 * The brief comes from here, and it is a list of *wants*: one word, one
 * kind, one rung each. A want exists where one of the words the learner is
 * about to meet ({@link selectSessionItems}: due first, then soonest due) has
 * no rested, playable challenge of a kind that word can bear
 * ({@link WANT_PER_WORD} of them — a recognition kind and a production kind
 * once the word can bear production, two recognition kinds before that). The
 * LLM layer (`$lib/llm`) plans nothing: it fills the list, one request per
 * kind.
 *
 * There is deliberately **no accuracy dial and no recent-mistake list**. FSRS
 * already answers a wrong answer by lowering the word's strength, which lowers
 * its ladder rung, which shortens every sentence written about it — one
 * mechanism, already tested, instead of a second one layered over it that had
 * to be kept agreeing with the first.
 *
 * Pure: no clock (`now` is passed in), no database, and deterministic given
 * the injectable `rng`, which only breaks ties between equally good kinds.
 */

import type { ChallengeRow } from '$lib/db';
import { PLANNABLE_KINDS, bareKind, kindKey, kindOf } from '$lib/llm';
import type { PlannableKind, Want, WantItem } from '$lib/llm';
import { selectSessionItems } from '$lib/srs';
import type { KnowledgeItem } from '$lib/types';
import { isPlayable, isRested, knownItemIds } from './pool';
import { demandForLevel, difficultyLevelOf } from './progression';

/**
 * Fresh challenges each upcoming word should have waiting: a recognition kind
 * and a production kind once the word can bear production, two recognition
 * kinds before that.
 *
 * Two, not more, because a session serves each word once or twice and the
 * pool is recycled after {@link RESERVE_GAP}: a third challenge per word would
 * mostly sit unplayed until the first two had rested, and every one of them is
 * paid for.
 */
export const WANT_PER_WORD = 2;

/**
 * Ceiling on wants in one top-up, so a long-neglected collection does not turn
 * one button press into a dozen requests. Twelve upcoming words at two each is
 * the everyday case, and the words beyond the cap are the least urgent ones —
 * they come first next time.
 */
export const MAX_TOPUP_WANTS = 24;

export interface PlanTopUpOptions {
	/** Cap on upcoming words considered. Defaults to the SRS default (12). */
	maxItems?: number;
	/** Injectable `[0,1)` source for tie-breaking between kinds; defaults to `Math.random`. */
	rng?: () => number;
}

/** What one word already has in the pool, by kind. */
interface Coverage {
	/** Kinds with at least one rested, playable challenge — nothing to write. */
	rested: Set<string>;
	/** Kinds the word has *ever* had a playable challenge of, rested or not. */
	ever: Set<string>;
}

/**
 * What every word has in the pool, by kind — read once, off the playable rows.
 *
 * A reported row counts for nothing (it was a bad challenge, not practice), and
 * a row citing a word that no longer exists counts for nothing either, for the
 * same reason `planSession` would never serve it: coverage is exactly what the
 * session would be willing to play.
 */
function coverageOf(pool: readonly ChallengeRow[], items: readonly KnowledgeItem[], now: number) {
	const known = knownItemIds(items);
	const coverage = new Map<string, Coverage>();
	for (const row of pool) {
		if (!isPlayable(row, known)) continue;
		const kind = kindOf(row);
		if (!kind) continue;
		const key = kindKey(kind);
		const rested = isRested(row, now);
		for (const id of row.itemIds) {
			let entry = coverage.get(id);
			if (!entry) {
				entry = { rested: new Set(), ever: new Set() };
				coverage.set(id, entry);
			}
			entry.ever.add(key);
			if (rested) entry.rested.add(key);
		}
	}
	return coverage;
}

const NONE: Coverage = { rested: new Set(), ever: new Set() };

/**
 * The wants the pool is missing for the words the learner is about to meet.
 *
 * For each upcoming word, in due order: its rung is `difficultyLevelOf`, the
 * kinds it may be asked are the ones whose stored demand tier that rung can
 * bear (`demandForLevel` — the same floors `planSession` gates serving on, so
 * nothing is written that would then sit unserved for weeks), and a want is
 * added for each kind-group the word is short in, up to {@link WANT_PER_WORD}
 * across both. A kind the word already has a rested challenge of is never
 * asked for again; among the rest, a kind the word has *never* had in the pool
 * wins over one it has had, and `rng` breaks the tie. One word never gets the
 * same kind twice in one top-up.
 *
 * The list is capped at {@link MAX_TOPUP_WANTS}, cutting the least urgent words
 * first — they are at the end, because the words come out of
 * `selectSessionItems` most overdue first.
 */
export function planTopUp(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions = {}
): Want[] {
	return collectWants(pool, items, now, opts).wants.slice(0, MAX_TOPUP_WANTS);
}

/** How well the pool covers the words coming up — the start screen's figure. */
export interface TopUpCoverage {
	/** Words the next top-up would consider: the same list a session draws on. */
	upcoming: number;
	/** Of those, the words with nothing left to write — every kind they need is rested and waiting. */
	covered: number;
	/** What a top-up would write right now, after the cap. Zero means the button has nothing to do. */
	wants: number;
}

/**
 * Counts, not wants: how many upcoming words are fully covered, and how many
 * challenges a top-up would write. Deterministic whatever `rng` says — the
 * roll only picks *which* kind fills a gap, never whether there is one — so
 * the start screen can show the same number the Generate button acts on.
 *
 * `covered` is counted before the cap: a word past {@link MAX_TOPUP_WANTS}
 * still has gaps, it just does not get them filled this time.
 */
export function topUpCoverage(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions = {}
): TopUpCoverage {
	const { upcoming, wants } = collectWants(pool, items, now, opts);
	const short = new Set(wants.map((want) => want.item.id));
	return {
		upcoming: upcoming.length,
		covered: upcoming.length - short.size,
		wants: Math.min(wants.length, MAX_TOPUP_WANTS)
	};
}

/**
 * The uncapped plan: every upcoming word that can be written about, and every
 * want it has. {@link planTopUp} cuts the list; {@link topUpCoverage} counts
 * it — the one walk, so the two can never disagree about a word.
 */
function collectWants(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions
): { upcoming: KnowledgeItem[]; wants: Want[] } {
	const rng = opts.rng ?? Math.random;
	const { reviewItems } = selectSessionItems(items, {
		now,
		...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems })
	});
	// A word with no term or no meaning has nothing to write a challenge
	// about — and nothing a challenge could be graded against — so it is
	// neither upcoming nor covered: it is not in the picture at all.
	const upcoming = reviewItems.filter((word) => word.term?.trim() && word.meaning?.trim());
	const coverage = coverageOf(pool, items, now);
	const wants: Want[] = [];

	for (const word of upcoming) {
		const term = word.term.trim();
		const meaning = word.meaning.trim();

		const level = difficultyLevelOf(word, now);
		const bearable = demandForLevel(level);
		const allowed = PLANNABLE_KINDS.filter((kind) => kind.demand <= bearable);
		const recognition = allowed.filter((kind) => kind.demand === 0);
		const production = allowed.filter((kind) => kind.demand > 0);
		const have = coverage.get(word.id) ?? NONE;
		const item: WantItem = { id: word.id, term, meaning };
		const chosen = new Set<string>();

		// One of each group once production is bearable; otherwise both from
		// recognition. `need` is distinct *kinds* the word should have rested
		// challenges of in that group, so a word with two rested recognize-mc rows
		// still gets a second recognition kind — that is the variety the pool is
		// for.
		const groups: [readonly PlannableKind[], number][] =
			production.length > 0
				? [
						[recognition, WANT_PER_WORD - 1],
						[production, 1]
					]
				: [[recognition, WANT_PER_WORD]];

		for (const [group, need] of groups) {
			const covered = group.filter((kind) => have.rested.has(kindKey(kind))).length;
			for (let missing = need - covered; missing > 0; missing--) {
				const candidates = group.filter(
					(kind) => !have.rested.has(kindKey(kind)) && !chosen.has(kindKey(kind))
				);
				if (candidates.length === 0) break;
				const fresh = candidates.filter((kind) => !have.ever.has(kindKey(kind)));
				const from = fresh.length > 0 ? fresh : candidates;
				const kind = from[Math.min(from.length - 1, Math.floor(rng() * from.length))];
				chosen.add(kindKey(kind));
				wants.push({ item, kind: bareKind(kind), difficulty: level });
			}
		}
	}

	return { upcoming, wants };
}
