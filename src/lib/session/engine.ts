/**
 * Session engine: everything the learn screen needs that is not rendering.
 *
 * The split is deliberate. `+page.svelte` owns the *feel* (transitions,
 * keyboard, banners); this module owns the *rules* (what to play, what an
 * answer is worth, what gets written to the database). Anything worth a unit
 * test lives here, and the pure half — {@link xpFor}, {@link comboAfter},
 * {@link planRefill}, {@link planSession}, {@link sessionSummary} — is testable
 * without IndexedDB.
 *
 * **Generation and play are decoupled.** Every challenge ever generated lives
 * in a persistent pool (`challenges` in IndexedDB); answering one stamps it
 * rather than consuming it. {@link generateChallenges} is an explicit,
 * backgroundable user action that adds to the pool, and {@link planSession}
 * assembles a session out of whatever is already there — so starting is
 * instant, always, and never waits on the network.
 *
 * Token economy, restated because it is what allows that: one batched
 * `getBatch` call produces a whole lesson (~2.5k tokens), grading is local and
 * free, and only an explicit "explain this" spends more. So we generate rarely
 * and generously, and get many sessions out of each batch by recycling.
 */

import {
	addResult,
	addToPool,
	addXp,
	getAllItems,
	getChallengesByIds,
	getItem,
	getPool,
	recentResults,
	recordServe,
	reportChallenge as flagChallengeReported,
	updateItemAfterReview,
	upsertItems
} from '$lib/db';
import type { ChallengeRow } from '$lib/db';
import { getBatch, isMockMode } from '$lib/llm';
import type { BatchArgs, OnProgress, RecentMistake, TokenUsage } from '$lib/llm';
import {
	Grade,
	accuracyFromHistory,
	gradeFromResult,
	isDue,
	newCardState,
	reviewCard,
	selectSessionItems,
	type FsrsCardState
} from '$lib/srs';
import type {
	Challenge,
	ChallengeResult,
	KnowledgeItem,
	Profile,
	Stats,
	Verdict
} from '$lib/types';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Challenges we ask the model for in one batch. */
export const BATCH_TARGET = 14;

/**
 * How long a challenge rests after being served before it may be planned again.
 *
 * The pool is recycled, but not tightly: re-seeing the exact same sentence a
 * few minutes later trains *the card* — the shape of that one prompt and the
 * answer that goes with it — rather than the word underneath. Three days is
 * long enough that the sentence has to be re-read rather than recognized, and
 * short enough that a modest pool still covers a daily habit.
 */
export const RESERVE_GAP = 3 * 24 * 60 * 60 * 1000;

/**
 * A planned session shorter than this is reported as `poolLow`, so the start
 * screen can nudge towards generating. Deliberately below {@link BATCH_TARGET}:
 * a slightly short session is still a session, and nagging on every visit is
 * how a nudge becomes wallpaper.
 */
export const POOL_LOW_THRESHOLD = 8;

/**
 * Hard ceiling on LLM challenges in one session. {@link BATCH_TARGET} is what
 * actually sizes a session; this only exists so a pool that has grown large
 * cannot turn one sitting into a marathon.
 */
export const SESSION_LENGTH = 20;

/** A free, locally built match-pairs round is slotted in after every N answers. */
export const MATCH_PAIRS_EVERY = 4;

/** Flat XP for completing a match-pairs round (see {@link xpFor}). */
export const MATCH_PAIRS_XP = 5;

/** Combo length at which the streak bonus switches on. */
export const COMBO_THRESHOLD = 3;

/** Ceiling on the per-answer combo bonus. */
export const MAX_COMBO_BONUS = 10;

/**
 * `answerGiven` written when the learner presses "Too hard — skip".
 *
 * It is a `wrong` answer in every respect (no XP, combo broken, FSRS `Again`) —
 * "I could not produce it" is exactly what `Again` encodes. The literal string
 * also travels into the next batch prompt as a `recentMistakes.gave` value,
 * where it means "that format was too demanding for this word".
 */
export const SKIP_ANSWER = '(skipped)';

/** How many trouble words are worth carrying into the next batch prompt. */
export const MAX_RECENT_MISTAKES = 8;

/** How far back {@link generateChallenges} reads the result log for those. */
export const RECENT_RESULTS_WINDOW = 30;

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

/** Props shared by every challenge component. */
export interface ChallengeProps<C extends Challenge> {
	challenge: C;
	/** Fired once, when the learner commits. Components then lock themselves. */
	onanswer: (event: AnswerEvent) => void;
}

/* -------------------------------------------------------------------------- */
/* Scoring (pure)                                                              */
/* -------------------------------------------------------------------------- */

/**
 * XP for one answered challenge.
 *
 * Base, by verdict:
 * - `correct` → 10
 * - `almost`  → 8 (a missing accent or a one-character typo still counts)
 * - `wrong`   → 0
 *
 * Combo bonus: `comboCount` is the number of consecutive non-`wrong` answers
 * *including this one*. From a combo of {@link COMBO_THRESHOLD} onwards each
 * answer earns `2 × (combo − 2)` extra XP, capped at {@link MAX_COMBO_BONUS} —
 * so combo 3 pays +2, combo 4 pays +4 … combo 7 and up pay +10. A `wrong`
 * answer scores nothing at all (no base, no bonus) and resets the combo, which
 * is what makes a long streak feel worth protecting.
 *
 * Match-pairs rounds do not go through this function: they are worth a flat
 * {@link MATCH_PAIRS_XP} regardless of combo, because they are locally
 * generated filler rather than graded practice.
 */
export function xpFor(verdict: Verdict, comboCount: number): number {
	if (verdict === 'wrong') return 0;
	const base = verdict === 'correct' ? 10 : 8;
	if (comboCount < COMBO_THRESHOLD) return base;
	const bonus = Math.min(MAX_COMBO_BONUS, 2 * (comboCount - (COMBO_THRESHOLD - 1)));
	return base + bonus;
}

/** The combo counter after `verdict`: `wrong` breaks it, anything else extends it. */
export function comboAfter(verdict: Verdict, comboCount: number): number {
	return verdict === 'wrong' ? 0 : comboCount + 1;
}

/** One answered challenge, as kept by the session for its end screen. */
export interface SessionAnswer {
	challengeId: string;
	type: Challenge['type'];
	verdict: Verdict;
	xp: number;
	/** Item ids exercised; empty for match-pairs (it touches no SRS state). */
	itemIds: string[];
}

/** End-of-session figures. */
export interface SessionSummary {
	answered: number;
	correct: number;
	almost: number;
	wrong: number;
	xp: number;
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
	let xp = 0;
	const items = new Set<string>();

	for (const answer of answers) {
		if (answer.verdict === 'correct') correct++;
		else if (answer.verdict === 'almost') almost++;
		else wrong++;
		xp += answer.xp;
		for (const id of answer.itemIds) items.add(id);
	}

	const answered = answers.length;
	return {
		answered,
		correct,
		almost,
		wrong,
		xp,
		accuracy: answered === 0 ? 0 : (correct + almost) / answered,
		itemsPracticed: items.size
	};
}

/**
 * True when a free match-pairs round should be slotted in before the next
 * generated challenge: after every {@link MATCH_PAIRS_EVERY}th answered LLM
 * challenge, and never twice at the same count.
 */
export function wantsMatchRound(llmAnswered: number, lastMatchAfter: number): boolean {
	return (
		llmAnswered > 0 && llmAnswered % MATCH_PAIRS_EVERY === 0 && lastMatchAfter !== llmAnswered
	);
}

/**
 * The canonical target-language audio for a challenge's answer, or `''` when
 * there is nothing worth hearing (the answer is in the learner's own language,
 * or the round has no single answer).
 *
 * One function, two consumers, on purpose: the feedback banner speaks this the
 * moment an answer is graded, and the session screen *pre-synthesizes* it the
 * moment the challenge is shown — the learner takes seconds to answer while
 * Kokoro takes one or two to render, so warming here is what makes the
 * auto-play land instantly instead of arriving late. If the two computed the
 * string independently, a drift between them would silently turn every warm
 * into a miss.
 *
 * Always the canonical script form — `acceptedAnswers[0]`, which the resolver
 * pins (see `answerVariants` in `$lib/llm/generate`) — never a romanized
 * variant: TTS reads Latin letters as Latin letters. A cloze speaks the whole
 * sentence with the blank filled, because how the word sounds *in place* is
 * the thing the learner is missing.
 */
export function spokenAnswerFor(challenge: Challenge): string {
	if (challenge.type === 'match-pairs' || challenge.direction !== 'toTarget') return '';
	if (challenge.type === 'multiple-choice') {
		return challenge.options[challenge.correctIndex]?.trim() ?? '';
	}
	const canonical = challenge.acceptedAnswers[0]?.trim() ?? '';
	if (!canonical) return '';
	if (challenge.type === 'cloze') return challenge.sentence.split('___').join(canonical);
	return canonical;
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
function cardOf(item: KnowledgeItem): FsrsCardState | null {
	return (item.fsrsCard as FsrsCardState | null | undefined) ?? null;
}

/** True while a pooled challenge may be planned again. */
function isEligible(row: ChallengeRow, knownItemIds: Set<string>, now: number): boolean {
	if (row.reported) return false;
	// A challenge whose vocabulary the learner deleted grades nothing and often
	// no longer even makes sense; it is dead weight, not practice.
	if (row.itemIds.length === 0) return false;
	if (!row.itemIds.every((id) => knownItemIds.has(id))) return false;
	if (row.lastServedAt === null) return true;
	return now - row.lastServedAt >= RESERVE_GAP;
}

/**
 * Ranks two eligible challenges by how much we want to serve them *next*.
 *
 * Never-served first (a fresh batch — and the new vocabulary in it — has to be
 * able to surface at all), newest generation first within those so the batch
 * the learner just paid for leads; then served ones, least recently first, so
 * recycling rotates through the pool instead of favouring one corner of it.
 * Ids break every remaining tie, which is what keeps a plan reproducible.
 */
function byFreshness(a: ChallengeRow, b: ChallengeRow): number {
	const aNew = a.lastServedAt === null;
	const bNew = b.lastServedAt === null;
	if (aNew !== bNew) return aNew ? -1 : 1;
	if (aNew && bNew) return b.generatedAt - a.generatedAt || (a.id < b.id ? -1 : 1);
	return (a.lastServedAt ?? 0) - (b.lastServedAt ?? 0) || (a.id < b.id ? -1 : 1);
}

/**
 * Builds the session: which pooled challenges to play, in order.
 *
 * **Due beats fresh, and that is the whole design.** The obvious cheap version
 * — score every challenge by freshness and take the top N — quietly kills
 * spaced repetition, because each new batch is newer than everything already
 * pooled and so crowds out every review that came due in the meantime. So the
 * walk is item-first: every due word, most overdue first, claims the best
 * challenge that exercises it; freshness only decides *which* of that word's
 * challenges wins, and only then fills whatever slots are left over.
 *
 * A second pass gives due items a second challenge each before the leftovers
 * are handed to fresh material: two angles on a word that is genuinely due is
 * worth more than one more sentence about a word that is not.
 *
 * Eligibility is checked once, up front: not reported, every `itemIds` entry
 * still resolving to a real item, and either never served or rested for
 * {@link RESERVE_GAP}.
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
	const limit = Math.max(0, opts.limit ?? SESSION_LENGTH);
	const target = Math.min(Math.max(0, opts.target ?? BATCH_TARGET), limit);
	if (target === 0) return [];

	const knownItemIds = new Set(items.map((item) => item.id));
	const eligible = pool.filter((row) => isEligible(row, knownItemIds, now)).sort(byFreshness);

	// Which challenges exercise which word, each bucket already in serve order.
	const byItem = new Map<string, ChallengeRow[]>();
	for (const row of eligible) {
		for (const id of row.itemIds) {
			const bucket = byItem.get(id);
			if (bucket) bucket.push(row);
			else byItem.set(id, [row]);
		}
	}

	// Most overdue first. A card-less item is treated as due right now: it was
	// introduced but never scheduled, so it belongs in this session, just not
	// ahead of words the learner is actually late on.
	const dueItems = items
		.filter((item) => {
			const card = cardOf(item);
			return card === null || isDue(card, now);
		})
		.sort((a, b) => (cardOf(a)?.due ?? now) - (cardOf(b)?.due ?? now) || (a.id < b.id ? -1 : 1));

	const chosen: ChallengeRow[] = [];
	const taken = new Set<string>();

	for (let pass = 0; pass < 2 && chosen.length < target; pass++) {
		for (const item of dueItems) {
			if (chosen.length >= target) break;
			const next = byItem.get(item.id)?.find((row) => !taken.has(row.id));
			if (!next) continue;
			taken.add(next.id);
			chosen.push(next);
		}
	}

	// Whatever is left: the fresh batch that no due word claimed, then the
	// least-recently-served leftovers. `eligible` is already in that order.
	for (const row of eligible) {
		if (chosen.length >= target) break;
		if (taken.has(row.id)) continue;
		taken.add(row.id);
		chosen.push(row);
	}

	return chosen.map(toChallenge);
}

/**
 * Sheds the pool bookkeeping so the session and its components see a plain
 * domain `Challenge`. The cast is unavoidable: a rest-destructure over a
 * discriminated union produces an `Omit` that no longer narrows on `type`,
 * even though every field of it survived.
 */
function toChallenge(row: ChallengeRow): Challenge {
	const {
		generatedAt: _generatedAt,
		timesServed: _timesServed,
		lastServedAt: _lastServedAt,
		reported: _reported,
		topic: _topic,
		...challenge
	} = row;
	return challenge as Challenge;
}

/* -------------------------------------------------------------------------- */
/* Batch-request planning (pure)                                               */
/* -------------------------------------------------------------------------- */

/** What {@link planRefill} decided, ready to hand to `getBatch`. */
export interface RefillPlan {
	/** Exactly the argument object `getBatch` expects. */
	args: BatchArgs;
	/** The due items the batch will exercise (full objects, for the UI). */
	reviewItems: KnowledgeItem[];
	/** How many brand-new words the batch may introduce. */
	newItemSlots: number;
	/** Trailing-week accuracy that paced `newItemSlots`; `undefined` on day one. */
	recentAccuracy: number | undefined;
}

/**
 * Turns the answer log back into "you got these wrong lately" hints.
 *
 * A `ChallengeResult` only records *which challenge* was missed, so the words
 * behind it have to be recovered: result → challenge row → `itemIds` → item
 * terms. Anything that no longer resolves (a challenge or item the learner
 * deleted) is skipped silently — a missing hint is not worth an error.
 *
 * `results` are expected newest-first (as {@link recentResults} returns them);
 * only the first mistake per term survives, so the list stays short and recent.
 * Match-pairs rounds are ignored: they are free recognition filler, never
 * evidence that a word is hard.
 *
 * Pure: no clock, no database.
 */
export function deriveRecentMistakes(
	results: ChallengeResult[],
	challenges: Challenge[],
	items: KnowledgeItem[],
	limit: number = MAX_RECENT_MISTAKES
): RecentMistake[] {
	const challengeById = new Map(challenges.map((challenge) => [challenge.id, challenge]));
	const termById = new Map(items.map((item) => [item.id, item.term]));

	const out: RecentMistake[] = [];
	const seen = new Set<string>();

	for (const result of results) {
		if (out.length >= limit) break;
		if (result.verdict !== 'wrong') continue;

		const challenge = challengeById.get(result.challengeId);
		if (!challenge || challenge.type === 'match-pairs') continue;

		const gave = result.answerGiven.trim() || '(no answer)';
		for (const itemId of challenge.itemIds) {
			if (out.length >= limit) break;
			const term = termById.get(itemId)?.trim();
			if (!term) continue;
			const key = termKey(term);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ term, gave });
		}
	}

	return out;
}

export interface PlanRefillOptions {
	/** Cap on due items pulled into one batch. Defaults to the SRS default (12). */
	maxItems?: number;
	/** Challenges requested. Defaults to {@link BATCH_TARGET}. */
	count?: number;
	/**
	 * Ready-made "you got these wrong lately" hints. Takes precedence over
	 * {@link recentResults}/{@link recentChallenges}, which are the usual input.
	 */
	recentMistakes?: RecentMistake[];
	/** Answer log, newest first; fed to {@link deriveRecentMistakes}. */
	recentResults?: ChallengeResult[];
	/** The challenge rows those results point at, in any order. */
	recentChallenges?: Challenge[];
	/**
	 * Free-form scenario for this lesson, e.g. `'ordering in a restaurant'`.
	 * Blank/whitespace-only is treated the same as absent — the key is only
	 * added to {@link BatchArgs} when it carries real content.
	 */
	topic?: string;
}

/**
 * Turns the learner's whole item collection into one batch request.
 *
 * Pure: no clock, no database, no network. `now` is passed in so the SRS
 * decisions are reproducible in tests.
 */
export function planRefill(
	items: KnowledgeItem[],
	profile: Profile,
	now: number,
	opts: PlanRefillOptions = {}
): RefillPlan {
	const recentAccuracy = accuracyFromHistory(items, { now });
	const { reviewItems, newItemSlots } = selectSessionItems(items, {
		now,
		recentAccuracy,
		...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems })
	});

	const topic = opts.topic?.trim();

	const recentMistakes =
		opts.recentMistakes ??
		deriveRecentMistakes(opts.recentResults ?? [], opts.recentChallenges ?? [], items);

	const args: BatchArgs = {
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
		reviewItems: reviewItems.map((item) => ({
			id: item.id,
			term: item.term,
			meaning: item.meaning
		})),
		newItemSlots,
		count: opts.count ?? BATCH_TARGET,
		// The whole vocabulary, not just the due slice: without it the model
		// re-proposes words the learner already has and the dedupe silently eats
		// the batch's new-word slots ("asked for 3 new words, got 1"). The ids
		// ride along for the resolver's term index; only the terms reach the
		// prompt.
		...(items.length
			? { knownItems: items.map((item) => ({ id: item.id, term: item.term })) }
			: {}),
		// Both are difficulty dials for the prompt: how the learner is doing, and
		// which words they are currently losing. Omitted when there is nothing to
		// say, so a day-one batch pays no tokens for them.
		...(recentAccuracy === undefined
			? {}
			: { recentAccuracy: Math.round(recentAccuracy * 100) / 100 }),
		...(recentMistakes.length ? { recentMistakes } : {}),
		...(topic ? { topic } : {})
	};

	return { args, reviewItems, newItemSlots, recentAccuracy };
}

/* -------------------------------------------------------------------------- */
/* Generation (database + LLM)                                                 */
/* -------------------------------------------------------------------------- */

/** What one generation run produced, for the UI's status area and dev console. */
export interface GenerateInfo {
	addedChallenges: number;
	/** Freshly introduced words, already persisted with initialized card state. */
	newItems: KnowledgeItem[];
	usage: TokenUsage;
	/** True when the offline mock produced this batch (no key configured). */
	mock: boolean;
	/** Every item known afterwards — the match-pairs pool. */
	items: KnowledgeItem[];
	plan: RefillPlan;
}

export interface GenerateOptions {
	now?: number;
	signal?: AbortSignal;
	maxItems?: number;
	count?: number;
	/** Forwarded to {@link planRefill}; see {@link PlanRefillOptions.topic}. */
	topic?: string;
	/**
	 * Called as each phase of generation starts, so the learn screen can show
	 * what is being waited on. Steps are reported, not measured: the caller times
	 * each one from its event to the next.
	 */
	onProgress?: OnProgress;
}

/** Case/whitespace-insensitive key used to tell whether two terms name the same word. */
function termKey(term: string): string {
	return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** What {@link dedupeNewItems} decided about one batch of freshly proposed vocabulary. */
export interface DedupeResult {
	/** Proposed items that are genuinely new — safe to persist. */
	newItems: KnowledgeItem[];
	/** Proposed-item id → existing item id, for every proposed item dropped as a duplicate. */
	idRemap: Map<string, string>;
}

/**
 * Filters newly proposed vocabulary against what the learner already has.
 *
 * The LLM only sees *due* items, so nothing stops it from re-proposing a word
 * the learner already knows under a fresh id (a different due item nudged the
 * model toward a word it had already taught). Persisting that would fork the
 * vocabulary into two entries with separate SRS histories, so any proposed
 * item whose `term` matches an existing item case/whitespace-insensitively is
 * dropped here instead, with its id remapped to the existing item's.
 *
 * Pure: no clock, no database.
 */
export function dedupeNewItems(
	existingItems: KnowledgeItem[],
	proposed: KnowledgeItem[]
): DedupeResult {
	const existingByTerm = new Map<string, KnowledgeItem>();
	for (const item of existingItems) existingByTerm.set(termKey(item.term), item);

	const newItems: KnowledgeItem[] = [];
	const idRemap = new Map<string, string>();
	for (const item of proposed) {
		const existing = existingByTerm.get(termKey(item.term));
		if (existing) idRemap.set(item.id, existing.id);
		else newItems.push(item);
	}
	return { newItems, idRemap };
}

/**
 * Rewrites every `itemIds` entry through `idRemap`, so challenges that
 * referenced a proposed item {@link dedupeNewItems} dropped now point at the
 * existing item instead. A no-op (same array, not a copy) when the remap is
 * empty, which is the common case.
 */
export function remapItemIds(challenges: Challenge[], idRemap: Map<string, string>): Challenge[] {
	if (idRemap.size === 0) return challenges;
	return challenges.map((challenge) => ({
		...challenge,
		itemIds: challenge.itemIds.map((id) => idRemap.get(id) ?? id)
	}));
}

/**
 * Writes one new lesson into the pool. The learner asked for this.
 *
 * There is no threshold and no "if needed": generating is a deliberate button
 * press, it is the only thing in the app that spends tokens on content, and the
 * pool it adds to is never drained by playing. The caller runs this in the
 * background — a session can be played from existing material while it is in
 * flight, and the batch simply shows up in the pool for next time.
 *
 * Order matters: new items are persisted *with real FSRS card state* before the
 * challenges that reference them are pooled, so the pool can never point at an
 * item that does not exist yet (which {@link planSession} would then discard as
 * ineligible). `getBatch` hands back `fsrsCard: null` by design — the LLM layer
 * must not depend on ts-fsrs — so initializing it is this function's job.
 *
 * `LlmError` is deliberately **not** caught: its `message` is already written
 * for a human, and the learn screen renders it inline with a retry button.
 */
export async function generateChallenges(
	profile: Profile,
	opts: GenerateOptions = {}
): Promise<GenerateInfo> {
	const now = opts.now ?? Date.now();
	const progress = opts.onProgress;
	const mock = isMockMode();

	progress?.({ id: 'select-items', label: 'Selecting review words' });
	const items = await getAllItems();

	// The trouble list for the prompt: recent misses, resolved back to the words
	// they exercised. Answered rows stay in the pool, so this is a plain lookup —
	// bounded by RECENT_RESULTS_WINDOW so it stays one cheap read.
	const results = await recentResults(RECENT_RESULTS_WINDOW);
	const missed = results.filter((result) => result.verdict === 'wrong');
	const recentChallenges = await getChallengesByIds([
		...new Set(missed.map((result) => result.challengeId))
	]);

	const plan = planRefill(items, profile, now, {
		recentResults: missed,
		recentChallenges,
		...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems }),
		...(opts.count === undefined ? {} : { count: opts.count }),
		...(opts.topic === undefined ? {} : { topic: opts.topic })
	});

	const batch = await getBatch(plan.args, {
		...(opts.signal ? { signal: opts.signal } : {}),
		...(progress ? { onProgress: progress } : {})
	});

	// The model can re-propose a word the learner already knows (it only sees
	// due items, not the whole collection); drop those before they fork the
	// vocabulary, and point any challenge that referenced one at the real item.
	const { newItems: proposed, idRemap } = dedupeNewItems(items, batch.newItems);
	const challenges = remapItemIds(batch.challenges, idRemap);

	// The LLM layer leaves `fsrsCard` null on purpose; give every new word a
	// real, due-now card before it reaches the database.
	const newItems: KnowledgeItem[] = proposed.map((item) => ({
		...item,
		fsrsCard: newCardState(now)
	}));

	progress?.({ id: 'save', label: 'Saving your lesson' });
	await upsertItems(newItems);
	await addToPool(challenges, now, opts.topic);

	return {
		addedChallenges: challenges.length,
		newItems,
		usage: batch.usage,
		mock,
		items: [...items, ...newItems],
		plan
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
	/** Pooled challenges that could be played at all (before session sizing). */
	readyCount: number;
	/** Words whose card is due at `now`. */
	dueCount: number;
	/**
	 * The plan came up short — recycling gaps and reported rows have eaten the
	 * pool. The UI nudges towards generating; it does not block starting.
	 */
	poolLow: boolean;
}

/**
 * Reads the pool and plans a session from it. No network, no generation, no
 * waiting: this is what makes "Start session" instant, whatever state the
 * learner's key or connection is in.
 *
 * Cheap enough to re-run whenever the pool may have moved (a background
 * generation finishing, say) so the start screen's counts stay honest.
 */
export async function startSession(
	opts: { now?: number } & PlanSessionOptions = {}
): Promise<SessionPlan> {
	const now = opts.now ?? Date.now();
	const { now: _now, ...planOpts } = opts;

	const [pool, items] = await Promise.all([getPool(), getAllItems()]);
	const challenges = planSession(pool, items, now, planOpts);

	const knownItemIds = new Set(items.map((item) => item.id));
	const readyCount = pool.filter((row) => isEligible(row, knownItemIds, now)).length;
	const dueCount = items.filter((item) => {
		const card = cardOf(item);
		return card === null || isDue(card, now);
	}).length;

	return {
		challenges,
		items,
		readyCount,
		dueCount,
		poolLow: challenges.length < POOL_LOW_THRESHOLD
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
 * (and would let a learner farm easy "Easy" grades for free). It is logged and
 * paid XP, and that is all. Its `itemIds` are still carried on the challenge for
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
			const item = await getItem(itemId);
			if (!item) continue;
			const prior = (item.fsrsCard as FsrsCardState | null | undefined) ?? null;
			priorCards.set(itemId, prior);
			await updateItemAfterReview(itemId, reviewCard(prior ?? newCardState(now), grade, now), {
				at: now,
				grade
			});
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
 * in {@link accuracyFromHistory}. Recomputing from the same priors every time
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
		await updateItemAfterReview(
			itemId,
			reviewCard(prior, grade, now),
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
		const item = await getItem(itemId);
		if (!item) continue;
		const card = (item.fsrsCard as FsrsCardState | null | undefined) ?? newCardState(now);
		await updateItemAfterReview(itemId, reviewCard(card, Grade.Good, now), {
			at: now,
			grade: Grade.Good
		});
	}
}

/**
 * Banks the session's XP in one write and returns the fresh stats (streak
 * included). Called once, at the end of a session or on an early quit — never
 * per answer, so a session shows up as a single entry in the day's history.
 */
export async function bankSessionXp(xp: number, now: number = Date.now()): Promise<Stats> {
	return addXp(Math.max(0, Math.round(xp)), now);
}
