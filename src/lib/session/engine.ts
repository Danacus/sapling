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
	getChallengesByIds,
	getItem,
	markChallengeDone,
	queuedCount,
	recentResults,
	updateItemAfterReview,
	upsertItems
} from '$lib/db';
import { getBatch, isMockMode } from '$lib/llm';
import type { BatchArgs, OnProgress, RecentMistake, TokenUsage } from '$lib/llm';
import {
	Grade,
	accuracyFromHistory,
	gradeFromResult,
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

/** Refill the queue as soon as fewer than this many challenges are left. */
export const REFILL_THRESHOLD = 5;

/** Challenges we ask the model for in one batch. */
export const BATCH_TARGET = 14;

/**
 * Hard ceiling on LLM challenges in one session. A session normally ends when
 * the queue runs dry, not here — the batch size ({@link BATCH_TARGET}) is what
 * actually sizes a session. The ceiling only exists so a queue that piled up
 * (several aborted sessions in a row) cannot turn into a marathon.
 *
 * Keep this ≥ {@link BATCH_TARGET}: a ceiling below the batch size makes every
 * completed session strand `BATCH_TARGET - SESSION_LENGTH` challenges, which
 * then nag as a stub "continue session" forever.
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

/** How far back {@link runRefillIfNeeded} reads the result log for those. */
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
	 * Free-form scenario for this session, e.g. `'ordering in a restaurant'`.
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
			interests: profile.interests
		},
		reviewItems: reviewItems.map((item) => ({
			id: item.id,
			term: item.term,
			meaning: item.meaning
		})),
		newItemSlots,
		count: opts.count ?? BATCH_TARGET,
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
	/** Forwarded to {@link planRefill}; see {@link PlanRefillOptions.topic}. */
	topic?: string;
	/**
	 * Called as each phase of the refill starts, so the learn screen can show
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
	const progress = opts.onProgress;

	progress?.({ id: 'queue-check', label: 'Checking your queue' });
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

	progress?.({ id: 'select-items', label: 'Selecting review words' });
	const items = await getAllItems();

	// The trouble list for the prompt: recent misses, resolved back to the words
	// they exercised. Done rows stay in the challenges table, so this is a plain
	// lookup — bounded by RECENT_RESULTS_WINDOW so it stays one cheap read.
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
	await enqueueChallenges(challenges);

	return {
		refilled: true,
		queuedBefore,
		queuedAfter: await queuedCount(),
		addedChallenges: challenges.length,
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
	/**
	 * Time from "challenge shown" to "answer submitted". Recorded, not graded on:
	 * see {@link AnswerEvent.responseMs}.
	 */
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

	// Ephemeral match-pairs rounds were never enqueued; Dexie's `update` on a
	// missing key is a no-op, so this stays a single unconditional call.
	await markChallengeDone(challenge.id);

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
