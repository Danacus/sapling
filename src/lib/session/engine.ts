/**
 * Session engine: everything the learn screen needs that is not rendering.
 *
 * The split is deliberate. `+page.svelte` owns the *feel* (transitions,
 * keyboard, banners); this module owns the *rules* (what to generate, what an
 * answer is worth, what gets written to the database). Anything worth a unit
 * test lives here, and the pure half — {@link xpFor}, {@link comboAfter},
 * {@link planRefill}, {@link sessionSummary} — is testable without IndexedDB.
 *
 * Token economy, restated because it drives the refill policy below: one
 * batched `getBatch` call produces a whole lesson (~2.5k tokens), grading is
 * local and free, and only an explicit "explain this" spends more. So we
 * refill rarely and generously rather than often and thinly.
 */

import {
	addResult,
	addXp,
	enqueueChallenges,
	getAllItems,
	getItem,
	markChallengeDone,
	queuedCount,
	updateItemAfterReview,
	upsertItems
} from '$lib/db';
import { getBatch, isMockMode } from '$lib/llm';
import type { BatchArgs, RecentMistake, TokenUsage } from '$lib/llm';
import {
	accuracyFromHistory,
	gradeFromResult,
	newCardState,
	reviewCard,
	selectSessionItems,
	type FsrsCardState
} from '$lib/srs';
import type { Challenge, KnowledgeItem, Profile, Stats, Verdict } from '$lib/types';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Refill the queue as soon as fewer than this many challenges are left. */
export const REFILL_THRESHOLD = 5;

/** Challenges we ask the model for in one batch. */
export const BATCH_TARGET = 14;

/** How many LLM challenges one session plays at most. */
export const SESSION_LENGTH = 12;

/** A free, locally built match-pairs round is slotted in after every N answers. */
export const MATCH_PAIRS_EVERY = 4;

/** Flat XP for completing a match-pairs round (see {@link xpFor}). */
export const MATCH_PAIRS_XP = 5;

/** Combo length at which the streak bonus switches on. */
export const COMBO_THRESHOLD = 3;

/** Ceiling on the per-answer combo bonus. */
export const MAX_COMBO_BONUS = 10;

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
	/** Exactly what the learner produced, for the result log and escalation. */
	answerGiven: string;
	verdict: Verdict;
	/** Milliseconds from "challenge shown" to "answer submitted". */
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

/* -------------------------------------------------------------------------- */
/* Refill planning (pure)                                                      */
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

export interface PlanRefillOptions {
	/** Cap on due items pulled into one batch. Defaults to the SRS default (12). */
	maxItems?: number;
	/** Challenges requested. Defaults to {@link BATCH_TARGET}. */
	count?: number;
	/** Optional "you got these wrong lately" hints for the prompt. */
	recentMistakes?: RecentMistake[];
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

	const args: BatchArgs = {
		profile: {
			nativeLanguage: profile.nativeLanguage,
			targetLanguage: profile.targetLanguage,
			level: profile.level,
			interests: profile.interests
		},
		reviewItems: reviewItems.map((item) => ({
			id: item.id,
			term: item.term,
			meaning: item.meaning
		})),
		newItemSlots,
		count: opts.count ?? BATCH_TARGET,
		...(opts.recentMistakes?.length ? { recentMistakes: opts.recentMistakes } : {})
	};

	return { args, reviewItems, newItemSlots, recentAccuracy };
}

/* -------------------------------------------------------------------------- */
/* Refill (database + LLM)                                                     */
/* -------------------------------------------------------------------------- */

/** What a refill attempt did, for the UI's banner and dev console. */
export interface RefillInfo {
	/** False when the queue was already deep enough and nothing was generated. */
	refilled: boolean;
	queuedBefore: number;
	queuedAfter: number;
	addedChallenges: number;
	/** Freshly introduced words, already persisted with initialized card state. */
	newItems: KnowledgeItem[];
	usage: TokenUsage;
	/** True when the offline mock produced this batch (no key configured). */
	mock: boolean;
	/** Every item known after the refill — the match-pairs pool. */
	items: KnowledgeItem[];
	plan?: RefillPlan;
}

export interface RunRefillOptions {
	now?: number;
	signal?: AbortSignal;
	/** Generate even when the queue is deep enough. */
	force?: boolean;
	maxItems?: number;
	count?: number;
}

/**
 * Tops the challenge queue up when it has run low.
 *
 * Order matters: new items are persisted *with real FSRS card state* before the
 * challenges that reference them are enqueued, so the queue can never point at
 * an item that does not exist yet. `getBatch` hands back `fsrsCard: null` by
 * design (the LLM layer must not depend on ts-fsrs) — initializing it is this
 * function's job.
 *
 * `LlmError` is deliberately **not** caught: its `message` is already written
 * for a human, and the learn screen renders it with a retry button.
 */
export async function runRefillIfNeeded(
	profile: Profile,
	opts: RunRefillOptions = {}
): Promise<RefillInfo> {
	const now = opts.now ?? Date.now();
	const queuedBefore = await queuedCount();
	const mock = isMockMode();

	if (!opts.force && queuedBefore >= REFILL_THRESHOLD) {
		return {
			refilled: false,
			queuedBefore,
			queuedAfter: queuedBefore,
			addedChallenges: 0,
			newItems: [],
			usage: { promptTokens: 0, completionTokens: 0 },
			mock,
			items: await getAllItems()
		};
	}

	const items = await getAllItems();
	const plan = planRefill(items, profile, now, {
		...(opts.maxItems === undefined ? {} : { maxItems: opts.maxItems }),
		...(opts.count === undefined ? {} : { count: opts.count })
	});

	const batch = await getBatch(plan.args, opts.signal ? { signal: opts.signal } : {});

	// The LLM layer leaves `fsrsCard` null on purpose; give every new word a
	// real, due-now card before it reaches the database.
	const newItems: KnowledgeItem[] = batch.newItems.map((item) => ({
		...item,
		fsrsCard: newCardState(now)
	}));

	await upsertItems(newItems);
	await enqueueChallenges(batch.challenges);

	return {
		refilled: true,
		queuedBefore,
		queuedAfter: await queuedCount(),
		addedChallenges: batch.challenges.length,
		newItems,
		usage: batch.usage,
		mock,
		items: [...items, ...newItems],
		plan
	};
}

/* -------------------------------------------------------------------------- */
/* Applying an answer (database)                                               */
/* -------------------------------------------------------------------------- */

/** Everything `applyResult` needs about one answered challenge. */
export interface AnswerOutcome {
	verdict: Verdict;
	/** Raw input, stored for review screens. */
	answerGiven: string;
	/** Time from "challenge shown" to "answer submitted"; sharpens the grade. */
	responseMs?: number;
	/** Epoch ms; defaults to `Date.now()`. */
	now?: number;
}

/**
 * Persists one answer: SRS card updates, the result log entry, and removal from
 * the queue. All database writes for an answered challenge happen here, so
 * components never import a repository.
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
 */
export async function applyResult(challenge: Challenge, outcome: AnswerOutcome): Promise<void> {
	const now = outcome.now ?? Date.now();

	if (challenge.type !== 'match-pairs') {
		const grade = gradeFromResult(outcome.verdict, outcome.responseMs);
		for (const itemId of challenge.itemIds) {
			const item = await getItem(itemId);
			if (!item) continue;
			const card = (item.fsrsCard as FsrsCardState | null | undefined) ?? newCardState(now);
			await updateItemAfterReview(itemId, reviewCard(card, grade, now), { at: now, grade });
		}
	}

	await addResult({
		challengeId: challenge.id,
		verdict: outcome.verdict,
		answerGiven: outcome.answerGiven,
		at: now
	});

	// Ephemeral match-pairs rounds were never enqueued; Dexie's `update` on a
	// missing key is a no-op, so this stays a single unconditional call.
	await markChallengeDone(challenge.id);
}

/**
 * Banks the session's XP in one write and returns the fresh stats (streak
 * included). Called once, at the end of a session or on an early quit — never
 * per answer, so a session shows up as a single entry in the day's history.
 */
export async function bankSessionXp(xp: number, now: number = Date.now()): Promise<Stats> {
	return addXp(Math.max(0, Math.round(xp)), now);
}
