/**
 * Top-up planning: deciding what the pool is missing, so generation can write
 * exactly that and nothing else.
 *
 * Play never consumes a challenge, so the pool — not a lesson — is the unit
 * that matters. What a word needs is a **fresh challenge of each kind it can
 * bear**, and only where it has none.
 *
 * The brief comes from here, and it is a list of *wants*: one word, one kind,
 * one rung each. The walk is the learner's **whole vocabulary**, in urgency
 * order — the words the schedule owes, most overdue first, then the not-yet-due
 * ones, soonest first — and each word in turn contributes a want for every
 * kind-group it is short in ({@link WANT_PER_WORD} of them: a recognition kind
 * and a production kind once the word can bear production, two recognition
 * kinds before that). A word that is already covered contributes nothing and is
 * simply stepped over. The LLM layer (`$lib/llm`) plans nothing: it fills the
 * list, one request per kind.
 *
 * **Nothing windows the walk.** It used to stop at the twelve most urgent
 * words, which meant a collection with thirty due words got its third and
 * fourth challenge about the same twelve while eighteen due words had none —
 * and a second "write more anyway" mode existed only to keep the button doing
 * *something* once that small window was full. Walking everything is the one
 * mechanism both of those were papering over: one press writes for the words
 * that can use it most, the next press reaches the words below them, and the
 * button runs dry exactly when the whole collection is covered.
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
import { dueAt, isDue } from '$lib/srs';
import type { KnowledgeItem } from '$lib/types';
import { SESSION_LENGTH, isPlayable, isRested, knownItemIds } from './pool';
import { demandForLevel, difficultyLevelOf } from './progression';

/**
 * Fresh challenges each word should have waiting: a recognition kind and a
 * production kind once the word can bear production, two recognition kinds
 * before that.
 *
 * Two, not more, because a session serves each word once or twice and the
 * pool is recycled after {@link RESERVE_GAP}: a third challenge per word would
 * mostly sit unplayed until the first two had rested, and every one of them is
 * paid for.
 */
export const WANT_PER_WORD = 2;

/**
 * Ceiling on wants in one top-up, so a long-neglected collection does not turn
 * one button press into a dozen requests. Twelve words at two each is a
 * generous lesson, and the words beyond the cap are the least urgent ones —
 * they are still uncovered afterwards, so the next press starts with them.
 */
export const MAX_TOPUP_WANTS = 24;

export interface PlanTopUpOptions {
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
 * The wants the pool is missing, most urgent word first.
 *
 * For each word, in urgency order: its rung is `difficultyLevelOf`, the kinds
 * it may be asked are the ones whose stored demand tier that rung can bear
 * (`demandForLevel` — the same floors `planSession` gates serving on, so
 * nothing is written that would then sit unserved for weeks), and a want is
 * added for each kind-group the word is short in, up to {@link WANT_PER_WORD}
 * across both. A kind the word already has a rested challenge of is never
 * asked for again; among the rest, a kind the word has *never* had in the pool
 * wins over one it has had, and `rng` breaks the tie. One word never gets the
 * same kind twice in one top-up.
 *
 * The list is capped at {@link MAX_TOPUP_WANTS}, cutting the least urgent words
 * first — they are at the end of the walk, and being still uncovered they lead
 * the next one.
 */
export function planTopUp(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions = {}
): Want[] {
	return collectWants(pool, items, now, opts).wants.slice(0, MAX_TOPUP_WANTS);
}

/** How well the pool covers the words a session is about to serve. */
export interface TopUpCoverage {
	/**
	 * The words the figure is about: every word the schedule owes, or — when it
	 * owes none — the next {@link SESSION_LENGTH} soonest-due ones, which is
	 * what a session would then play instead.
	 */
	upcoming: number;
	/** Of those, the words with nothing left to write — every kind they need is rested and waiting. */
	covered: number;
	/**
	 * What a top-up would write right now, after the cap. Counted over the
	 * *whole* walk, so it can be positive while every due word is covered: the
	 * button is then writing ahead, into the words below them. Zero means the
	 * whole collection is covered and the button has nothing to do.
	 */
	wants: number;
	/** Whether {@link upcoming} is the due words (true) or the next ones (false). */
	due: boolean;
}

/**
 * Counts, not wants: how many of the words a session is about to serve are
 * fully covered, and how many challenges a top-up would write. Deterministic
 * whatever `rng` says — the roll only picks *which* kind fills a gap, never
 * whether there is one — so the start screen can show the same number the
 * Generate button acts on.
 *
 * The two numbers deliberately answer different questions. The **figure** is
 * about the session in front of the learner, so it is scoped to the words that
 * session will serve. The **count** is about the button, so it spans the whole
 * walk: pressing Generate with every due word covered is a perfectly good
 * thing to do, it just buys the words further down.
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
	const { owed, ahead, wants } = collectWants(pool, items, now, opts);
	const short = new Set(wants.map((want) => want.item.id));
	const due = owed.length > 0;
	const upcoming = due ? owed : ahead.slice(0, SESSION_LENGTH);

	return {
		upcoming: upcoming.length,
		covered: upcoming.filter((word) => !short.has(word.id)).length,
		wants: Math.min(wants.length, MAX_TOPUP_WANTS),
		due
	};
}

/**
 * The uncapped plan: every word that can be written about, split at the due
 * line and in urgency order, and every want any of them has.
 * {@link planTopUp} cuts the list; {@link topUpCoverage} counts it — the one
 * walk, so the two can never disagree about a word.
 */
function collectWants(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions
): { owed: KnowledgeItem[]; ahead: KnowledgeItem[]; wants: Want[] } {
	const rng = opts.rng ?? Math.random;

	// A word with no term or no meaning has nothing to write a challenge
	// about — and nothing a challenge could be graded against — so it is
	// neither upcoming nor covered: it is not in the picture at all.
	const writable = items.filter((word) => word.term?.trim() && word.meaning?.trim());
	// Soonest due first, id breaking the tie so the walk does not depend on the
	// order the store handed the items back. Everything the schedule owes sorts
	// ahead of everything it does not, most overdue at the front — the same
	// order `planSession` walks on the play side.
	const sorted = [...writable].sort(
		(a, b) => dueAt(a, now) - dueAt(b, now) || (a.id < b.id ? -1 : 1)
	);
	const owed = sorted.filter((word) => isDue(word, now));
	const ahead = sorted.filter((word) => !isDue(word, now));

	const coverage = coverageOf(pool, items, now);
	const wants: Want[] = [];

	for (const word of [...owed, ...ahead]) {
		const term = word.term.trim();
		const meaning = word.meaning.trim();

		const level = difficultyLevelOf(word);
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

	return { owed, ahead, wants };
}
