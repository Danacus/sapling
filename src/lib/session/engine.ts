/**
 * Session engine: everything the learn screen needs that is not rendering.
 *
 * The split is deliberate. `+page.svelte` owns the *feel* (transitions,
 * keyboard, banners); this module owns the *rules* (what to play, what an
 * answer is worth, what gets written to the database). Anything worth a unit
 * test lives here, and the pure half — {@link planRefill}, {@link planSession},
 * {@link sessionSummary} — is testable without the database.
 *
 * **Generation and play are decoupled.** Every challenge ever generated lives
 * in a persistent pool (the `challenges` table); answering one stamps it
 * rather than consuming it. {@link generateChallenges} is an explicit,
 * backgroundable user action that tops the pool up with what it is missing
 * (`./topup`), and {@link planSession} assembles a session out of whatever is
 * already there — so starting is instant, always, and never waits on the
 * network.
 *
 * Token economy, restated because it is what allows that: one `getBatch` call
 * fills the whole top-up — internally a handful of short concurrent requests,
 * one per challenge kind, each against its own cached system prompt, see
 * `$lib/llm/generate` — grading is local and free, and only an explicit
 * "explain this" spends more. So we generate only what the pool lacks, and get
 * many sessions out of each challenge by recycling. `getBatch` is still one
 * `await` from here: cutting the brief into requests, per-request retries and
 * dropping a request that fails are all below the seam.
 */

import {
	addResult,
	addToPool,
	getAllItems,
	getPool,
	recordServe,
	reportChallenge as flagChallengeReported,
	updateItemAfterReview
} from '$lib/db';
import type { ChallengeRow } from '$lib/db';
import { challengeOf } from '$lib/db';
import { getBatch, isMockMode, makeMatchPairsChallenge } from '$lib/llm';
import type { BatchArgs, OnProgress, TokenUsage } from '$lib/llm';
import {
	Grade,
	gradeFromResult,
	isDue,
	newCardState,
	reviewCard,
	type FsrsCardState
} from '$lib/srs';
import { RESERVE_GAP, isPlayable, isRested, knownItemIds } from './pool';
import { planTopUp } from './topup';
import type { PlanTopUpOptions } from './topup';
import { difficultyOf } from '$lib/challenges/difficulty';
import type { Challenge, KnowledgeItem, Profile, Verdict } from '$lib/types';
import {
	bearable,
	difficultyLevelOf,
	itemsById,
	levelBandCentre,
	levelForStrength,
	weakestWordStrength,
	type DifficultyLevel
} from './progression';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Challenges we ask the model for in one batch. */
export const BATCH_TARGET = 14;

/**
 * How long a challenge rests after being served before it may be planned again.
 * Lives in `./pool` with the eligibility predicates, since the top-up planner
 * reads it too; re-exported here where every caller has always found it.
 */
export { RESERVE_GAP };

/**
 * Fewer rested challenges than this is reported as `poolLow`, so the start
 * screen can nudge towards generating. Deliberately below {@link BATCH_TARGET}:
 * a session built partly from re-reads is still a session, and nagging on every
 * visit is how a nudge becomes wallpaper.
 *
 * Measured against *rested* material rather than plan length, because the plan
 * is never short any more — it fills the tail with early reviews. "How much can
 * you play without re-reading a sentence you saw this week" is the figure that
 * actually tells you when to generate.
 */
export const POOL_LOW_THRESHOLD = 8;

/**
 * Hard ceiling on LLM challenges in one session. {@link BATCH_TARGET} is what
 * actually sizes a session; this only exists so a pool that has grown large
 * cannot turn one sitting into a marathon.
 */
export const SESSION_LENGTH = 20;

/** A free, locally built match-pairs round is slotted in after every N challenges. */
export const MATCH_PAIRS_EVERY = 4;

/**
 * `answerGiven` written when the learner presses "Too hard — skip".
 *
 * It is a `wrong` answer in every respect, FSRS `Again` included —
 * "I could not produce it" is exactly what `Again` encodes. That grade is the
 * whole of its effect on what gets written next: the word's strength falls, its
 * ladder rung falls with it, and the next top-up sizes every challenge about it
 * to the lower rung. Nothing else carries the skip forward.
 */
export const SKIP_ANSWER = '(skipped)';

/* -------------------------------------------------------------------------- */
/* The component contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What every challenge component hands back when the learner commits an answer.
 *
 * Grading happens inside the component (it owns the input widget and therefore
 * the raw string); the session screen only decides what that verdict is *worth*
 * and what to say about it.
 */
export interface AnswerEvent {
	/**
	 * Exactly what the learner produced, for the result log and escalation, or
	 * {@link SKIP_ANSWER} when they gave up on the challenge.
	 */
	answerGiven: string;
	verdict: Verdict;
	/**
	 * Milliseconds from "challenge shown" to "answer submitted". Kept for review
	 * screens and analytics only — it no longer sharpens the FSRS grade, which
	 * the learner is asked about directly instead (see {@link amendResult}).
	 */
	responseMs: number;
	/** Nearest accepted answer, when the component graded with `validateAnswer`. */
	closestAccepted?: string;
}

/**
 * Props shared by every challenge component.
 *
 * Declared in `$lib/challenges/props` — it is a rendering contract, and it
 * belongs next to the components that implement it. Re-exported here because
 * this is where {@link AnswerEvent}, its other half, lives.
 */
export type { ChallengeProps } from '$lib/challenges/props';

/* -------------------------------------------------------------------------- */
/* Session accounting (pure)                                                   */
/* -------------------------------------------------------------------------- */

/** One answered challenge, as kept by the session for its end screen. */
export interface SessionAnswer {
	challengeId: string;
	type: Challenge['type'];
	verdict: Verdict;
	/** Item ids exercised; empty for match-pairs (it touches no SRS state). */
	itemIds: string[];
}

/** End-of-session figures. */
export interface SessionSummary {
	answered: number;
	correct: number;
	almost: number;
	wrong: number;
	/**
	 * Share of answers that were accepted (`correct` or `almost`), 0..1.
	 * `almost` counts as a hit because the UI told the learner it counted.
	 */
	accuracy: number;
	/** Distinct items exercised (match-pairs contributes none). */
	itemsPracticed: number;
}

/** Folds the session log into the numbers the end screen shows. Pure. */
export function sessionSummary(answers: SessionAnswer[]): SessionSummary {
	let correct = 0;
	let almost = 0;
	let wrong = 0;
	const items = new Set<string>();

	for (const answer of answers) {
		if (answer.verdict === 'correct') correct++;
		else if (answer.verdict === 'almost') almost++;
		else wrong++;
		for (const id of answer.itemIds) items.add(id);
	}

	const answered = answers.length;
	return {
		answered,
		correct,
		almost,
		wrong,
		accuracy: answered === 0 ? 0 : (correct + almost) / answered,
		itemsPracticed: items.size
	};
}

/**
 * Splices the free match-pairs rounds into a planned session, returning the one
 * queue the learn screen walks.
 *
 * These rounds used to be improvised mid-session, between queue positions, which
 * left the session with *two* sources of challenges — and anything that wanted
 * to see a whole session in advance saw only one of them. The TTS warm loop is
 * the case that made it hurt: a round that does not exist yet cannot have its
 * tile audio pre-rendered, so every match round arrived silent-then-late. The
 * rounds were never improvised for a reason — they are drawn from `items`, which
 * is frozen for the session, and their positions are pure arithmetic — so
 * building them at plan time costs nothing and buys one source of truth: the
 * warm loop, the progress math and the walk all see the same session, and an
 * early quit wastes only free, locally built material.
 *
 * One round goes in after every {@link MATCH_PAIRS_EVERY}th challenge, **never
 * after the last one** — a session must not end on free filler. Each splice
 * point builds its own round, so every one is an independent shuffle and pick.
 * A point where {@link makeMatchPairsChallenge} declines (too few collision-free
 * items to fill even the smallest round) simply gets no round; with static items
 * that means none anywhere.
 *
 * **The rounds are sized off the ladder, like every paid challenge.**
 * `makeMatchPairsChallenge` takes a rung and turns it into a pair count, and the
 * rung comes from {@link medianRoundRung} over the very words the round is drawn
 * from — so a beginner gets three pairs to breathe and someone who owns their
 * vocabulary gets six. The **median**, because a round is one screen shared by
 * several words: one mature word among a dozen new ones must not size the round
 * for all of them, and an average would let it drag the count up by a fraction
 * of a rung anyway.
 *
 * Still pure given `rng` and `now`: the rung is computed once, from the frozen
 * session vocabulary, and every splice point is handed the same one.
 *
 * @param now Epoch ms, for reading each word's place on the ladder.
 * @param rng Injectable `[0,1)` source, forwarded to every round it builds.
 */
export function interleaveMatchRounds(
	challenges: Challenge[],
	items: KnowledgeItem[],
	now: number,
	rng: () => number = Math.random
): Challenge[] {
	const queue: Challenge[] = [];
	const difficulty = medianRoundRung(items, now);

	for (const [index, challenge] of challenges.entries()) {
		queue.push(challenge);

		const position = index + 1;
		if (position === challenges.length || position % MATCH_PAIRS_EVERY !== 0) continue;

		const round = makeMatchPairsChallenge(items, rng, { difficulty });
		if (round) queue.push(round);
	}

	return queue;
}

/**
 * The ladder rung a match round over this vocabulary should be written at: the
 * median rung of the words that could actually end up in one.
 *
 * "Could end up in one" is the same filter `makeMatchPairsChallenge` applies
 * first — a word needs both a term and a meaning to make a pair — and no more
 * than that: which words survive the label-collision pass depends on the shuffle,
 * so consulting it here would make the size depend on a draw the caller has not
 * made yet.
 *
 * The median rather than the mean, and the **lower** median on an even count.
 * A round is a recognition breather shared by several words at once, so the size
 * should follow the body of the vocabulary and not its strongest member; where
 * the two middles disagree, the easier of them is the one that keeps a round
 * from outrunning half the words in it. Falls back to rung 1 for an empty
 * vocabulary, where the round is declined anyway.
 */
function medianRoundRung(items: KnowledgeItem[], now: number): DifficultyLevel {
	const rungs = items
		.filter((item) => item.term?.trim() && item.meaning?.trim())
		.map((item) => difficultyLevelOf(item, now))
		.sort((a, b) => a - b);

	return rungs.length === 0 ? 1 : rungs[Math.floor((rungs.length - 1) / 2)];
}

/**
 * The canonical target-language audio for a challenge's answer.
 *
 * Moved to `$lib/challenges/display`, where it sits alongside the three other
 * per-type presentation rules it kept drifting from (what the correct answer
 * reads as, whether it is target-language, what its Latin reading is). Still
 * exported here: the session screen pre-synthesizes it when a challenge is
 * shown, which is session pacing rather than rendering, and this is where that
 * caller has always looked for it.
 */
export { spokenAnswerFor } from '$lib/challenges/display';

/* -------------------------------------------------------------------------- */
/* Listening mode (pure)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Share of eligible challenges presented audio-first. Half: a session that was
 * *all* listening stops being reading practice, and one that never listens
 * never trains the ear.
 */
export const LISTENING_SHARE = 0.5;

/** FNV-1a over the id, mapped to `[0,1)`. Stable across devices and reloads. */
function idFraction(id: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0x100000000;
}

/**
 * Whether a challenge should be played before it is read.
 *
 * Listening mode is **presentation only** — the stored challenge is untouched,
 * nothing about it is generated differently, and grading is identical. That is
 * the point: every recognize-MC row already in the pool, however long ago it was
 * generated, can be served as a listening exercise.
 *
 * Eligible: `multiple-choice` in the `toNative` direction, i.e. target text
 * shown and a native meaning picked — the only stored shape whose prompt is a
 * target-language string the learner is expected to understand rather than
 * produce.
 *
 * Which of them get it is decided by a hash of the challenge id rather than a
 * coin flip, so a challenge that comes back round in a later session is
 * presented the same way it was the first time. `enabled` is the learner's
 * preference (`ll.listeningMode`); the caller also has to check that speech is
 * actually available, which is a browser question this module knows nothing
 * about.
 */
export function isListeningChallenge(challenge: Challenge, enabled: boolean): boolean {
	if (!enabled) return false;
	if (challenge.type !== 'multiple-choice' || challenge.direction !== 'toNative') return false;
	if (!challenge.prompt.trim()) return false;
	return idFraction(challenge.id) < LISTENING_SHARE;
}

/* -------------------------------------------------------------------------- */
/* Session planning (pure)                                                     */
/* -------------------------------------------------------------------------- */

export interface PlanSessionOptions {
	/** Slots to aim for. Defaults to {@link BATCH_TARGET}. */
	target?: number;
	/** Hard ceiling, whatever `target` says. Defaults to {@link SESSION_LENGTH}. */
	limit?: number;
}

/** `fsrsCard` is `unknown` on the domain type; a missing card means "brand new". */
function asCard(fsrsCard: unknown): FsrsCardState | null {
	return (fsrsCard as FsrsCardState | null | undefined) ?? null;
}

function cardOf(item: KnowledgeItem): FsrsCardState | null {
	return asCard(item.fsrsCard);
}

/*
 * `isPlayable`, `isRested` and `knownItemIds` — the two halves of eligibility
 * and the lookup they share — live in `./pool`, because the top-up planner
 * (`./topup`) asks exactly the same questions to decide what is *missing*.
 */

/**
 * Ranks two served challenges by how long they have been left alone: least
 * recently served first, so recycling rotates through the pool instead of
 * favouring one corner of it. Ids break the tie, which is what keeps a plan
 * reproducible.
 */
function byRecency(a: ChallengeRow, b: ChallengeRow): number {
	return (a.lastServedAt ?? 0) - (b.lastServedAt ?? 0) || (a.id < b.id ? -1 : 1);
}

/**
 * Ranks two rested challenges by how much we want to serve them *next*.
 *
 * Never-served first (a fresh batch has to be able to surface at all), newest
 * generation first within those so the batch the learner just paid for leads;
 * then served ones by {@link byRecency}.
 */
function byFreshness(a: ChallengeRow, b: ChallengeRow): number {
	const aNew = a.lastServedAt === null;
	const bNew = b.lastServedAt === null;
	if (aNew !== bNew) return aNew ? -1 : 1;
	if (aNew && bNew) return b.generatedAt - a.generatedAt || (a.id < b.id ? -1 : 1);
	return byRecency(a, b);
}

/**
 * The pool as a planner wants to see it: playable challenges split by whether
 * they have rested, each half in its own serve order and also indexed by the
 * words it exercises.
 *
 * Built once per plan, so both planners below share one pass over the pool and
 * one notion of order — and so "the resting ones, in case we need them" costs
 * nothing when we do not.
 */
interface PlanBoard {
	/** Playable and rested, in {@link byFreshness} order. */
	rested: ChallengeRow[];
	/** Playable but still inside the gap, in {@link byRecency} order. */
	resting: ChallengeRow[];
	/** Item id → the rested challenges covering it, in serve order. */
	restedByItem: Map<string, ChallengeRow[]>;
	/** Item id → the resting challenges covering it, in serve order. */
	restingByItem: Map<string, ChallengeRow[]>;
	/**
	 * Whether a row's demand fits its weakest word — see `./progression`. Memoized
	 * per plan: the walks below ask about the same rows repeatedly, and each
	 * answer costs a pass over the vocabulary.
	 */
	bearable: (row: ChallengeRow) => boolean;
	/**
	 * How far a row's own difficulty sits from the **centre of its weakest
	 * word's level band** — the planner's third preference (see
	 * {@link firstFree}). Lower is a closer fit. Memoized for the same reason
	 * {@link bearable} is.
	 *
	 * The band centre rather than the word's raw strength, because that is the
	 * number the challenge was written to: `planTopUp` writes each want at
	 * `difficultyLevelOf`'s rung, so the planner asking for the same rung's
	 * midpoint is asking for what it ordered. Raw strength would
	 * degenerate at every band ceiling — a word in the upper half of any band is
	 * nearer that band's hardest row than its own centre, so the longest, oldest
	 * sentence in the bucket would win over the short fresh one written for it.
	 */
	fitRank: (row: ChallengeRow) => number;
}

function bucketByItem(rows: ChallengeRow[]): Map<string, ChallengeRow[]> {
	const byItem = new Map<string, ChallengeRow[]>();
	for (const row of rows) {
		for (const id of row.itemIds) {
			const bucket = byItem.get(id);
			if (bucket) bucket.push(row);
			else byItem.set(id, [row]);
		}
	}
	return byItem;
}

function planBoard(
	pool: ChallengeRow[],
	items: KnowledgeItem[],
	known: Set<string>,
	now: number
): PlanBoard {
	const playable = pool.filter((row) => isPlayable(row, known));
	const rested = playable.filter((row) => isRested(row, now)).sort(byFreshness);
	const resting = playable.filter((row) => !isRested(row, now)).sort(byRecency);

	// One index over the vocabulary for the whole plan: both predicates below ask
	// about the weakest word of every row, repeatedly, and each question used to
	// rebuild this map from scratch.
	const byId = itemsById(items);

	const memo = new Map<string, boolean>();
	const bearableRow = (row: ChallengeRow): boolean => {
		const cached = memo.get(row.id);
		if (cached !== undefined) return cached;
		const answer = bearable(row, items, now, byId);
		memo.set(row.id, answer);
		return answer;
	};

	const fitMemo = new Map<string, number>();
	const fitRank = (row: ChallengeRow): number => {
		const cached = fitMemo.get(row.id);
		if (cached !== undefined) return cached;
		const target = levelBandCentre(levelForStrength(weakestWordStrength(row, items, now, byId)));
		const rank = Math.abs(difficultyOf(row) - target);
		fitMemo.set(row.id, rank);
		return rank;
	};

	return {
		rested,
		resting,
		restedByItem: bucketByItem(rested),
		restingByItem: bucketByItem(resting),
		bearable: bearableRow,
		fitRank
	};
}

/**
 * The candidate whose {@link PlanBoard.fitRank} is smallest — the one whose own
 * difficulty sits closest to its own weakest word's current strength. Ties
 * (including the common case of one candidate) keep the first one in
 * `candidates`, which is what lets {@link firstFree} and {@link bearableFirst}
 * hand this a bucket already in freshness/recency order and get that order back
 * whenever difficulty has nothing to say.
 */
function nearestFit(
	candidates: readonly ChallengeRow[],
	fitRank: (row: ChallengeRow) => number
): ChallengeRow {
	let best = candidates[0];
	let bestRank = fitRank(best);
	for (const candidate of candidates.slice(1)) {
		const rank = fitRank(candidate);
		if (rank < bestRank) {
			best = candidate;
			bestRank = rank;
		}
	}
	return best;
}

/**
 * The challenge a plan takes next out of one already-ordered bucket: among the
 * unclaimed **bearable** ones, whichever is the {@link nearestFit}; failing
 * that, the first unclaimed one at all.
 *
 * Bearability is still the firm half of the preference (see `./progression`):
 * a word gets nothing from the bucket unless something in it fits at all, and
 * when nothing does the word is still served — a hard exercise beats a skipped
 * review, exactly as a too-familiar sentence does. *Which* bearable challenge
 * wins is the finer question this answers: not "the freshest one that fits",
 * but "the one whose own difficulty is closest to the middle of this word's
 * level band" — a strong word gets the harder of two fitting challenges, a
 * shaky one the easier — with freshness/recency (the bucket's own order)
 * breaking a true tie.
 *
 * This is the **only** place fit is consulted, and that is deliberate: a
 * `fitRank` is a distance to one particular word's target, so it means something
 * inside one word's own bucket and nothing at all between two words' buckets.
 *
 * And because the rule only ever reorders *inside* a bucket, it cannot bend the
 * rest gap: the caller consults the rested bucket first, so an unbearable rested
 * challenge still outranks a bearable resting one. The one place the gap yields
 * is the first due pass, and it yields for its own reason.
 */
function firstFree(
	bucket: ChallengeRow[] | undefined,
	taken: Set<string>,
	bearableRow: (row: ChallengeRow) => boolean,
	fitRank: (row: ChallengeRow) => number
): ChallengeRow | undefined {
	if (!bucket) return undefined;
	const free = (row: ChallengeRow) => !taken.has(row.id);
	const fitting = bucket.filter((row) => free(row) && bearableRow(row));
	if (fitting.length > 0) return nearestFit(fitting, fitRank);
	return bucket.find(free);
}

/**
 * `rows` partitioned so the bearable ones come first, **both halves in exactly
 * the order they arrived**.
 *
 * Used by the fillers, where there is no single item to walk and the bucket
 * order *is* the plan: `board.rested` is in {@link byFreshness} order and
 * `board.resting` in {@link byRecency} order, and those orders carry the two
 * invariants the whole tail rests on — a never-served row leads, and among
 * served ones the longest-untouched leads.
 *
 * Fit deliberately has no say here. A {@link PlanBoard.fitRank} is a distance
 * to *one word's* target, so ranking a heterogeneous bucket by it compares
 * numbers about different words: a stale word-order row that happens to sit near
 * its own word's band centre would beat a never-served row from the batch the
 * learner just paid for, and "the newest material leads" would quietly stop
 * being true. Fit stays where it means something — inside one word's own bucket,
 * in {@link firstFree}.
 */
function bearableFirst(
	rows: ChallengeRow[],
	bearableRow: (row: ChallengeRow) => boolean
): ChallengeRow[] {
	const fits: ChallengeRow[] = [];
	const rest: ChallengeRow[] = [];
	for (const row of rows) (bearableRow(row) ? fits : rest).push(row);
	return [...fits, ...rest];
}

/**
 * Slots a plan may fill: the caller's target, floored at zero and clamped to
 * the hard ceiling.
 */
function targetSlots(opts: PlanSessionOptions): number {
	const limit = Math.max(0, opts.limit ?? SESSION_LENGTH);
	return Math.min(Math.max(0, opts.target ?? BATCH_TARGET), limit);
}

/**
 * True while the schedule actually owes this word a review.
 *
 * A card-less item counts: it was introduced but never scheduled, so it belongs
 * in this session — just not ahead of words the learner is genuinely late on,
 * which {@link byDueDate} takes care of. The one thing this gates is whether a
 * word may spend the rest gap; everything else in a plan walks every word.
 */
function owesReview(item: KnowledgeItem, now: number): boolean {
	const card = cardOf(item);
	return card === null || isDue(card, now);
}

/** Soonest-due first, id as tiebreak; a card-less item counts as due now. */
function byDueDate(now: number): (a: KnowledgeItem, b: KnowledgeItem) => number {
	return (a, b) => (cardOf(a)?.due ?? now) - (cardOf(b)?.due ?? now) || (a.id < b.id ? -1 : 1);
}

/**
 * Builds the session: which pooled challenges to play, in order.
 *
 * **Due beats fresh, and that is the whole design.** The obvious cheap version
 * — score every challenge by freshness and take the top N — quietly kills
 * spaced repetition, because each new batch is newer than everything already
 * pooled and so crowds out every review that came due in the meantime. So the
 * walk is item-first: every word that owes a review, most overdue first, claims
 * the best challenge that exercises it; freshness only decides *which* of that
 * word's challenges wins, and only then fills whatever slots are left over. A
 * second pass gives each of those words a second challenge before anything else
 * is served: two angles on a word that is genuinely due is worth more than one
 * more sentence about a word that is not.
 *
 * **Then it keeps going.** Once the schedule has been paid off, the same two
 * passes run over the words that are *not* due yet, soonest first, and the
 * leftovers reach into material still inside its rest gap. That tail is why
 * there is no separate "practice" mode to press: when the schedule has work,
 * the session is the due session; when it has run dry, the session degrades
 * into review-ahead instead of into nothing, and a start button that is always
 * live needs no second button beside it. Early review is safe under FSRS — a
 * review is graded whenever it happens, it simply banks a smaller stability
 * gain when taken ahead of time — so nothing downstream changes; only the
 * choice of what to play does. Nothing is generated and no new word is
 * introduced either way: this is the existing pool, replayed. What tells the
 * learner it is time to generate is `poolLow`, not an empty session.
 *
 * Two gates decide what any of that may draw on, and only one of them is firm.
 * *Playable* ({@link isPlayable}) is absolute. *Rested* ({@link isRested}) is a
 * preference, and it is spent in two places, in this order. A word that owes a
 * review ({@link owesReview}) spends it on its very first challenge: when it has
 * nothing rested left it takes its longest-resting one instead, because a
 * learner who played hard for two days — serve-stamping the whole pool while
 * their young cards come due within hours — would otherwise be shown words due
 * and nothing to do about them, which is the priority above inverted. And the
 * final filler spends it once every rested row is used up, since by then the
 * alternative is a shorter session. In between — second angles, words not yet
 * due, the freshness filler — rested is strictly preferred, because variety is
 * precisely what those are for. A slightly too familiar sentence still reviews
 * the word; silence does not.
 *
 * A third preference rides *inside* that structure rather than beside it, in
 * two layers. **Bearability** ({@link bearable}, `./progression`) is the coarse
 * one: where a word has several challenges to choose from, only the ones whose
 * demand its weakest word can currently carry are even in the running —
 * recognition while the word is new, production once it has been recalled a few
 * times. **Fit** ({@link PlanBoard.fitRank}, `$lib/challenges/difficulty`) is
 * the fine one, breaking the tie among those: the challenge whose own
 * difficulty sits closest to the middle of that word's level band wins, so a
 * strong word gets the harder of two challenges it can bear and a shaky one the
 * easier — never the other way round, and never merely the freshest. Bearability
 * reorders a bucket wherever the planner takes from one, including the fillers;
 * fit applies only *within one word's own* bucket ({@link firstFree}), because
 * that is the only place its numbers are about the same word. Neither can cost a
 * review or bend the rest gap.
 *
 * Pure and deterministic — no clock, no database, no rng — so a plan can be
 * pinned exactly in tests.
 */
export function planSession(
	pool: ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanSessionOptions = {}
): Challenge[] {
	const target = targetSlots(opts);
	if (target === 0) return [];

	const known = knownItemIds(items);
	const board = planBoard(pool, items, known, now);
	const walk = [...items].sort(byDueDate(now));
	const owed = walk.filter((item) => owesReview(item, now));
	const ahead = walk.filter((item) => !owesReview(item, now));

	const chosen: ChallengeRow[] = [];
	const taken = new Set<string>();

	/**
	 * Two passes over one queue of words, each word claiming its best unclaimed
	 * challenge: one angle apiece, then a second apiece. `spendGap` is whether a
	 * word with nothing rested left may take its longest-resting challenge on the
	 * first pass — true for the words that owe a review, false for the rest.
	 */
	const claimEach = (queue: KnowledgeItem[], spendGap: boolean): void => {
		for (let pass = 0; pass < 2 && chosen.length < target; pass++) {
			for (const item of queue) {
				if (chosen.length >= target) break;
				const next =
					firstFree(board.restedByItem.get(item.id), taken, board.bearable, board.fitRank) ??
					(spendGap && pass === 0
						? firstFree(board.restingByItem.get(item.id), taken, board.bearable, board.fitRank)
						: undefined);
				if (!next) continue;
				taken.add(next.id);
				chosen.push(next);
			}
		}
	};

	claimEach(owed, true);
	claimEach(ahead, false);

	// Whatever is left: the fresh batch that no word claimed, then the
	// least-recently-served leftovers, and only then material still inside its
	// gap. Each list is already in serve order, with the challenges their words
	// can bear brought to the front of it — bearable-first *within* each half, so
	// preferring a fitting challenge never promotes resting material over rested,
	// and freshness/recency still orders each half.
	for (const row of [
		...bearableFirst(board.rested, board.bearable),
		...bearableFirst(board.resting, board.bearable)
	]) {
		if (chosen.length >= target) break;
		if (taken.has(row.id)) continue;
		taken.add(row.id);
		chosen.push(row);
	}

	return chosen.map(challengeOf);
}

/* -------------------------------------------------------------------------- */
/* Top-up planning (pure)                                                      */
/* -------------------------------------------------------------------------- */

export interface PlanRefillOptions extends PlanTopUpOptions {
	/**
	 * Free-form scenario for this top-up, e.g. `'ordering in a restaurant'`.
	 * Blank/whitespace-only is treated the same as absent — the key is only
	 * added to {@link BatchArgs} when it carries real content.
	 */
	topic?: string;
}

/**
 * Turns the pool and the learner's collection into one batch request.
 *
 * The brief is {@link planTopUp}'s: a want for every kind an upcoming word is
 * short of, and nothing for a word already covered. A batch is written *about*
 * vocabulary the learner already has and introduces none of its own — new words
 * arrive through the assistant and conversation mode — so a learner with no
 * words has no wants, and one whose upcoming words are all covered has none
 * either. Both come back as an empty `wants`, and {@link generateChallenges}
 * says which before spending anything.
 *
 * Pure: no clock, no database, no network. `now` is passed in so the SRS
 * decisions are reproducible in tests.
 */
export function planRefill(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	profile: Profile,
	now: number,
	opts: PlanRefillOptions = {}
): BatchArgs {
	const wants = planTopUp(pool, items, now, {
		...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems }),
		...(opts.rng === undefined ? {} : { rng: opts.rng })
	});
	const topic = opts.topic?.trim();

	return {
		profile: {
			nativeLanguage: profile.nativeLanguage,
			targetLanguage: profile.targetLanguage,
			level: profile.level,
			interests: profile.interests,
			// The learner's self-description, when they wrote one. Omitted rather
			// than sent blank, so a profile that never filled it in costs nothing;
			// the prompt builder does the length capping.
			...(profile.about?.trim() ? { about: profile.about.trim() } : {})
		},
		wants,
		// The whole vocabulary, not just the words the wants are about: it is
		// what the model may build sentences out of, so a challenge about a due
		// word can be a real sentence made of words the learner can already read
		// rather than one padded with strangers. The ids ride along for the
		// resolver's term index; only the terms reach the prompt.
		// The romanization rides along for one reason: `knownTermLabels` needs it
		// to tell two same-spelled cards apart in the prompt. It is dropped again
		// for every word whose spelling is unambiguous, which is nearly all of them.
		...(items.length
			? {
					knownItems: items.map((item) => ({
						id: item.id,
						term: item.term,
						...(item.romanization ? { romanization: item.romanization } : {})
					}))
				}
			: {}),
		...(topic ? { topic } : {})
	};
}

/* -------------------------------------------------------------------------- */
/* Generation (database + LLM)                                                 */
/* -------------------------------------------------------------------------- */

/** What one generation run produced, for the UI's status area and dev console. */
export interface GenerateInfo {
	addedChallenges: number;
	usage: TokenUsage;
	/**
	 * Requests that came back with nothing usable even after their retry. Not an
	 * error: their wants are still wanting, and the next top-up asks for them
	 * again. Surfaced so the learner can be told the pool grew by less than it
	 * might have.
	 */
	failedRequests: number;
	/** True when the offline mock produced this batch (no key configured). */
	mock: boolean;
	/** The whole collection at the time — unchanged by the run. */
	items: KnowledgeItem[];
	/** Exactly what was sent: the wants, and the vocabulary they were written against. */
	args: BatchArgs;
}

export interface GenerateOptions {
	now?: number;
	signal?: AbortSignal;
	/** Forwarded to {@link planRefill}; see {@link PlanRefillOptions.topic}. */
	topic?: string;
	/**
	 * Called as each phase of generation starts, so the learn screen can show
	 * what is being waited on. Steps are reported, not measured: the caller times
	 * each one from its event to the next.
	 */
	onProgress?: OnProgress;
}

/**
 * Tops the pool up. The learner asked for this.
 *
 * There is no threshold and no "if needed" about *when*: generating is a
 * deliberate button press, it is the only thing in the app that spends tokens
 * on content, and the pool it adds to is never drained by playing. What gets
 * written, though, is exactly what the pool is missing ({@link planTopUp}) —
 * so a second press straight after the first has nothing to ask for, and says
 * so instead of paying for challenges the pool already holds. The caller runs
 * this in the background — a session can be played from existing material while
 * it is in flight, and the new challenges simply show up in the pool for next
 * time.
 *
 * **It writes challenges and nothing else.** A top-up is drilling practice for
 * vocabulary the learner already has, so nothing here touches the item table:
 * new words are added deliberately, by the learner and the assistant, through
 * `add_words` (`$lib/assistant`, `$lib/conversation`). That is why the batch
 * needs no dedupe pass and no id remapping — there is no proposed vocabulary to
 * fork the collection with — and why a challenge citing an id the resolver
 * could not place is simply dropped over in `resolveBatch` rather than dragging
 * an item into the database behind it.
 *
 * `LlmError` is deliberately **not** caught: its `message` is already written
 * for a human, and the learn screen renders it inline with a retry button. The
 * two "nothing to write" cases throw a plain `Error` with the same contract.
 */
export async function generateChallenges(
	profile: Profile,
	opts: GenerateOptions = {}
): Promise<GenerateInfo> {
	const now = opts.now ?? Date.now();
	const progress = opts.onProgress;
	const mock = isMockMode();

	progress?.({ id: 'select-items', label: 'Checking what the pool is missing' });

	const [pool, items] = await Promise.all([getPool(), getAllItems()]);

	const args = planRefill(pool, items, profile, now, {
		...(opts.topic === undefined ? {} : { topic: opts.topic })
	});

	// Said here, before any request step is announced, so an empty brief is
	// never reported as a model that returned nothing.
	if (args.wants.length === 0) {
		throw new Error(
			items.length === 0
				? 'There are no words to write challenges about yet.'
				: 'Every word coming up already has fresh challenges waiting. Play a session, then generate again.'
		);
	}

	const batch = await getBatch(args, {
		...(opts.signal ? { signal: opts.signal } : {}),
		...(progress ? { onProgress: progress } : {})
	});

	progress?.({ id: 'save', label: 'Saving new challenges' });
	await addToPool(batch.challenges, now, opts.topic);

	return {
		addedChallenges: batch.challenges.length,
		usage: batch.usage,
		failedRequests: batch.failedRequests,
		mock,
		items,
		args
	};
}

/* -------------------------------------------------------------------------- */
/* Starting a session (database)                                               */
/* -------------------------------------------------------------------------- */

/** Everything the learn screen needs to render its start screen and then play. */
export interface SessionPlan {
	/** The challenges to play, in order. Empty means there is nothing to do. */
	challenges: Challenge[];
	/** Every item known right now — the match-pairs pool and the item lookup. */
	items: KnowledgeItem[];
	/**
	 * Pooled challenges playable without bending the rest gap (before session
	 * sizing). A plan may exceed this — a due word will spend the gap to get its
	 * one review — but as a "how much material is there" figure it is the honest
	 * one: this is what a session can be built from without repeating anything.
	 */
	readyCount: number;
	/** Words whose card is due at `now`. */
	dueCount: number;
	/**
	 * Fresh material is thinning out: fewer than {@link POOL_LOW_THRESHOLD}
	 * rested challenges left, so a session is starting to be built out of
	 * sentences the learner saw this week. The UI nudges towards generating; it
	 * never blocks starting, because a re-read still reviews the word.
	 */
	poolLow: boolean;
}

export interface StartSessionOptions extends PlanSessionOptions {
	/** Epoch ms; defaults to `Date.now()`. */
	now?: number;
}

/**
 * Reads the pool and plans a session from it. No network, no generation, no
 * waiting: this is what makes "Start session" instant, whatever state the
 * learner's key or connection is in.
 *
 * Cheap enough to re-run whenever the pool may have moved (a background
 * generation finishing, say) so the start screen's counts stay honest. The
 * counts describe the *schedule*, not the plan: `dueCount` is what is actually
 * due, and the plan routinely reaches past it into early review.
 */
export async function startSession(opts: StartSessionOptions = {}): Promise<SessionPlan> {
	const now = opts.now ?? Date.now();
	const { now: _now, ...planOpts } = opts;

	const [pool, items] = await Promise.all([getPool(), getAllItems()]);
	const challenges = planSession(pool, items, now, planOpts);

	const known = knownItemIds(items);
	const readyCount = pool.filter((row) => isPlayable(row, known) && isRested(row, now)).length;
	const dueCount = items.filter((item) => owesReview(item, now)).length;

	return {
		challenges,
		items,
		readyCount,
		dueCount,
		poolLow: readyCount < POOL_LOW_THRESHOLD
	};
}

/**
 * The learner flagged a challenge as broken from the feedback banner: wrong
 * answer key, nonsense sentence, an "answer" that was never typeable.
 *
 * One flag is enough — the row is excluded from every future pool read rather
 * than merely deprioritized, because a challenge the learner had to argue with
 * is worse than no challenge at all. The row itself stays, since results point
 * at it. Match-pairs rounds are built locally and never pooled, so flagging one
 * is a no-op (there is nothing to fix but the generator's item list).
 */
export async function reportChallenge(challenge: Challenge): Promise<void> {
	if (challenge.type === 'match-pairs') return;
	await flagChallengeReported(challenge.id);
}

/* -------------------------------------------------------------------------- */
/* Applying an answer (database)                                               */
/* -------------------------------------------------------------------------- */

/** Everything `applyResult` needs about one answered challenge. */
export interface AnswerOutcome {
	verdict: Verdict;
	/** Raw input, stored for review screens. */
	answerGiven: string;
	/**
	 * Time from "challenge shown" to "answer submitted". Recorded, not graded on:
	 * see {@link AnswerEvent.responseMs}.
	 */
	responseMs?: number;
	/** Epoch ms; defaults to `Date.now()`. */
	now?: number;
}

/**
 * Persists one answer: SRS card updates, the result log entry, and the pool's
 * serve stamp. All database writes for an answered challenge happen here, so
 * components never import a repository.
 *
 * The stamp lands at *answer* time, not when the session was planned, and that
 * asymmetry is what makes an early quit self-cleaning: challenges the learner
 * never reached were never stamped, so they come back in the next plan for
 * free, with no leftover-queue bookkeeping to reconcile.
 *
 * **Match-pairs deliberately touches no SRS state.** A matching round is a
 * recognition drill built locally from words the learner already has; letting it
 * feed FSRS would inflate stability for items that were never actually recalled
 * (and would let a learner farm easy "Easy" grades for free). It is logged, and
 * that is all. Its `itemIds` are still carried on the challenge for
 * traceability — we simply do not grade against them.
 *
 * Missing items are skipped rather than treated as an error: a challenge can
 * outlive its item if the learner reset their data mid-session.
 *
 * Returns, per item it actually reviewed, that item's card state **as it was
 * before** this review (`null` when the item had no card yet). FSRS has no
 * inverse, so that snapshot is the only way {@link amendResult} can re-grade
 * this same answer without stacking a second review on top of it. Match-pairs
 * returns an empty map; callers with nothing to amend can ignore the value.
 */
export async function applyResult(
	challenge: Challenge,
	outcome: AnswerOutcome
): Promise<Map<string, FsrsCardState | null>> {
	const now = outcome.now ?? Date.now();
	const priorCards = new Map<string, FsrsCardState | null>();

	if (challenge.type !== 'match-pairs') {
		const grade = gradeFromResult(outcome.verdict);
		for (const itemId of challenge.itemIds) {
			const { existed, prior } = await updateItemAfterReview(
				itemId,
				(stored) => reviewCard(asCard(stored) ?? newCardState(now), grade, now),
				{ at: now, grade }
			);
			if (existed) priorCards.set(itemId, asCard(prior));
		}
	}

	await addResult({
		challengeId: challenge.id,
		verdict: outcome.verdict,
		answerGiven: outcome.answerGiven,
		at: now
	});

	// Ephemeral match-pairs rounds were never pooled; `recordServe` no-ops on a
	// missing id, so this stays a single unconditional call.
	await recordServe(challenge.id, now);

	return priorCards;
}

/**
 * Re-grades the review {@link applyResult} just wrote, because the learner said
 * so: after a correct answer the banner offers Hard / Good / Easy, and touching
 * it means "that was not a plain Good".
 *
 * The rewind is exact rather than compensating. FSRS has no inverse, so the
 * card is not nudged from where the Good left it — it is recomputed from
 * `priorCards`, the pre-review snapshot {@link applyResult} handed back, and the
 * history entry *replaces* the one that review appended instead of adding to
 * it. A second appended review would inflate `reps` and double-count the answer
 * in the item's recent grades. Recomputing from the same priors every time
 * is also what makes repeated calls safe: assessing Easy and then Hard lands
 * exactly where assessing Hard once would, because neither reads the card it is
 * about to overwrite.
 *
 * Match-pairs is a no-op, for the reason given in {@link applyResult}, and so
 * is any item the challenge names but that review skipped (deleted mid-session)
 * — absence from `priorCards` is the signal.
 *
 * No interaction with {@link applyOverturn}: an overturn only ever fires on a
 * `wrong` verdict and a self-assessment only on a `correct` one, so the two
 * paths are disjoint by construction and never race for the same card.
 */
export async function amendResult(
	challenge: Challenge,
	grade: Grade,
	priorCards: Map<string, FsrsCardState | null>,
	now: number = Date.now()
): Promise<void> {
	if (challenge.type === 'match-pairs') return;

	for (const itemId of challenge.itemIds) {
		if (!priorCards.has(itemId)) continue;
		const prior = priorCards.get(itemId) ?? newCardState(now);
		// Deliberately ignores the stored card: what this re-grade must build on
		// is where the card stood *before* the review it is replacing.
		await updateItemAfterReview(
			itemId,
			() => reviewCard(prior, grade, now),
			{ at: now, grade },
			{ replaceLast: true }
		);
	}
}

/**
 * Compensating review for an answer the escalation overturned: the learner was
 * graded `wrong`, disputed it, and the model agreed the answer should have
 * counted (see `escalate`'s `overturn`).
 *
 * Every item on the challenge gets one `Good` review, exactly as if the answer
 * had been accepted in the first place.
 *
 * **This does not undo the `Again` review {@link applyResult} already wrote.**
 * FSRS has no inverse — the lapse it recorded stays on the card, and the item
 * lands where a "failed then recalled" pair would rather than where a clean
 * pass would. That is deliberate: a dispute is rare, and a card that is
 * slightly too conservative beats leaving a genuinely-known word stuck in
 * relearning. The result log entry is likewise left alone; only the card moves.
 *
 * Match-pairs is skipped for the same reason as in {@link applyResult}: those
 * rounds never touch SRS state at all.
 */
export async function applyOverturn(challenge: Challenge, now: number = Date.now()): Promise<void> {
	if (challenge.type === 'match-pairs') return;

	for (const itemId of challenge.itemIds) {
		await updateItemAfterReview(
			itemId,
			(stored) => reviewCard(asCard(stored) ?? newCardState(now), Grade.Good, now),
			{ at: now, grade: Grade.Good }
		);
	}
}
