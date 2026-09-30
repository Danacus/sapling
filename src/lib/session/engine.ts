/**
 * Session engine: everything the learn screen needs that is not rendering.
 *
 * The split is deliberate. `+page.svelte` owns the *feel* (transitions,
 * keyboard, banners); this module orchestrates the *rules* — what to play and
 * what the pool is missing, which Rust decides (`crates/sapling-challenges`,
 * through `$lib/challenges/core`), and every database write during play,
 * which only this module makes.
 *
 * **Generation and play are decoupled.** Every challenge ever generated lives
 * in a persistent pool (the `challenges` table); answering one stamps it
 * rather than consuming it. {@link generateChallenges} is an explicit,
 * backgroundable user action that tops the pool up with what it is missing
 * ({@link planTopUp}), and {@link planSession} assembles a session out of
 * whatever is already there — so starting is instant, always, and never waits
 * on the network.
 *
 * Token economy, restated because it is what allows that: one `getBatch` call
 * fills the whole top-up — internally a handful of short concurrent requests,
 * one per challenge kind, each against its own cached system prompt, see
 * `crates/sapling-llm`'s `lesson.rs` — grading is local and free, and only an explicit
 * "explain this" spends more. So we generate only what the pool lacks, and get
 * many sessions out of each challenge by recycling. `getBatch` is still one
 * `await` from here: cutting the brief into requests, per-request retries and
 * dropping a request that fails are all below the seam.
 */

import {
	addResult,
	addToPool,
	getAllItems,
	getDifficultyParts,
	getPool,
	getProfile,
	recordServe,
	reportChallenge as flagChallengeReported,
	updateItemAfterReview
} from '$lib/db';
import type { ChallengeRow, ReasoningEffort } from '$lib/db';
import { challengeOf } from '$lib/db';
import { SESSION_LENGTH } from '$lib/db/generated/challenges';
import type { TopUpCoverage } from '$lib/db/generated/index';
import { getBatch, isMockMode } from '$lib/llm';
import type { BatchArgs, OnProgress, TokenUsage, Want } from '$lib/llm';
import { Grade, gradeFromResult, isDue } from '$lib/srs';
import { asWords, callChallenges } from '$lib/challenges/core';
import { storedDefFor } from '$lib/challenges/types';
import type { Challenge, KnowledgeItem, Profile, Verdict } from '$lib/types';
import { servingFor, type DeviceServing, type Serving } from './serving';

export { deviceServing, servingFor, type DeviceServing, type Serving } from './serving';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The most model-written challenges one session serves — `crates/sapling-challenges`'
 * `pool.rs`, which also owns the rest gap, the session target and the match
 * round spacing.
 */
export { SESSION_LENGTH };

/**
 * `answerGiven` written when the learner presses "Too hard — skip".
 *
 * It is a `wrong` answer in every respect, FSRS `Again` included —
 * "I could not produce it" is exactly what `Again` encodes — and the
 * difficulty model learns from it like any other miss: the word's skill falls
 * and the row reads harder, so the next pick and the next top-up both ask
 * less of the word.
 */
export const SKIP_ANSWER = '(skipped)';

/* -------------------------------------------------------------------------- */
/* The component contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The challenge component contract and the answer event it emits, both declared
 * in `$lib/challenges/props` — a rendering contract, next to the components
 * that implement it, and now the one place both halves live. Re-exported here
 * so every existing importer of this module keeps finding them.
 */
export type { AnswerEvent, ChallengeProps } from '$lib/challenges/props';

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
 * queue the learn screen walks — built at plan time so the TTS warm loop, the
 * progress math and the walk all see the same session. Rust decides where the
 * rounds go and builds them (`crates/sapling-challenges`' `session.rs`): one
 * after every fourth challenge that touches an early word, never last, five
 * pairs where the words allow. `seed` replays the rounds' draws.
 */
export function interleaveMatchRounds(
	challenges: Challenge[],
	items: KnowledgeItem[],
	seed?: number
): Challenge[] {
	const slots = callChallenges('interleaveMatchRounds', {
		plan: challenges.map((challenge) => challenge.itemIds),
		words: asWords(items),
		...(seed === undefined ? {} : { seed })
	});
	return slots.map((slot) => (typeof slot === 'number' ? challenges[slot]! : slot));
}

/**
 * The canonical target-language audio for a challenge's answer — a
 * presentation fact (`$lib/challenges/display`), exported here where the
 * session screen has always found it.
 */
export { spokenAnswerFor } from '$lib/challenges/display';

/* -------------------------------------------------------------------------- */
/* Session planning                                                            */
/* -------------------------------------------------------------------------- */

export interface PlanSessionOptions {
	/** Slots to aim for; Rust's `BATCH_TARGET` when absent. */
	target?: number;
	/** Hard ceiling, whatever `target` says; {@link SESSION_LENGTH} when absent. */
	limit?: number;
	/** What the picks are made against; starting values, the normal aim and no listening when absent. */
	serving?: Serving;
}

/** One planned challenge, at the help level it is served at. */
export interface SessionPick {
	challenge: Challenge;
	/** The help level (`crates/sapling-challenges`' `help.rs`): what `presentationFor` shows and the answer records. */
	shown: string;
	/** The predicted chance of a correct answer at that help level. */
	chance: number;
}

/**
 * Builds the session: which pooled challenges to play, in order, and at which
 * help level. Rust plans it (`crates/sapling-challenges`' `session.rs`) — due
 * words first, most overdue first, each claiming the row whose best help level
 * puts its predicted chance closest to the aim, then the words not yet due,
 * then the leftovers; a row that fits no help level for its words is never
 * served — and hands back positions into `pool`, so what plays is the row as
 * stored, minus its bookkeeping.
 */
export function planSession(
	pool: ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanSessionOptions = {}
): SessionPick[] {
	const planned = callChallenges('planSession', {
		pool,
		words: asWords(items),
		now,
		...(opts.serving === undefined ? {} : { serving: opts.serving }),
		...(opts.target === undefined ? {} : { target: opts.target }),
		...(opts.limit === undefined ? {} : { limit: opts.limit })
	});
	return planned.map(({ at, shown, chance }) => ({
		challenge: challengeOf(pool[at]!),
		shown,
		chance
	}));
}

/* -------------------------------------------------------------------------- */
/* Top-up planning                                                             */
/* -------------------------------------------------------------------------- */

export interface PlanTopUpOptions {
	/** What coverage is judged against; see {@link PlanSessionOptions.serving}. */
	serving?: Serving;
	/** Replays the tie-breaks between equally good kinds. */
	seed?: number;
}

/**
 * The wants the pool is missing, most urgent word first — Rust's
 * (`crates/sapling-challenges`' `topup.rs`): a word with no rested row that
 * fits it wants two written, each a kind that can reach the difficulty that
 * would put the word at the aim, at the length worked back from it.
 */
export function planTopUp(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: PlanTopUpOptions = {}
): Want[] {
	return callChallenges('planTopUp', {
		pool: [...pool],
		words: asWords(items),
		now,
		...(opts.serving === undefined ? {} : { serving: opts.serving }),
		...(opts.seed === undefined ? {} : { seed: opts.seed })
	});
}

/** The same walk as {@link planTopUp}, counted: the start screen's figure and the button's count. */
export function topUpCoverage(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	serving?: Serving
): TopUpCoverage {
	return callChallenges('topUpCoverage', {
		pool: [...pool],
		words: asWords(items),
		now,
		...(serving === undefined ? {} : { serving })
	});
}

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
 * The brief is {@link planTopUp}'s: two wants for every word no rested row
 * fits, walked most urgent first over the whole collection, and nothing at all
 * for a word already covered. A batch is written *about* vocabulary the learner
 * already has and introduces none of its own — new words arrive through the
 * assistant and conversation mode — so a learner with no words has no wants,
 * and one whose every word is covered has none either. Both come back as an
 * empty `wants`, and {@link generateChallenges} says which before spending
 * anything.
 *
 * No clock, no database, no network: `now` is passed in.
 */
export function planRefill(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	profile: Profile,
	now: number,
	opts: PlanRefillOptions = {}
): BatchArgs {
	const wants = planTopUp(pool, items, now, {
		...(opts.serving === undefined ? {} : { serving: opts.serving }),
		...(opts.seed === undefined ? {} : { seed: opts.seed })
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
		// The romanization rides along for one reason: the prompt needs it to
		// tell two same-spelled cards apart. It is dropped again
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
	/**
	 * The generation knobs from `$lib/db/settings`, read by the task that starts
	 * a top-up and forwarded to `getBatch` unchanged. Absent means the built-in
	 * defaults (`REQUEST_ITEMS`, the model's own reasoning effort).
	 */
	itemsPerRequest?: number;
	reasoningEffort?: ReasoningEffort;
	/**
	 * This device's help-level bounds; read from the preferences when absent
	 * (`deviceServing`), so a top-up judges coverage exactly as a session on
	 * this device would serve.
	 */
	device?: DeviceServing;
}

/**
 * Tops the pool up. The learner asked for this.
 *
 * There is no threshold and no "if needed" about *when*: generating is a
 * deliberate button press, it is the only thing in the app that spends tokens
 * on content, and the pool it adds to is never drained by playing. What gets
 * written, though, is exactly what the pool is missing ({@link planTopUp}),
 * most urgent word first — so a second press straight after the first buys the
 * next words down the list rather than a third copy of what the pool already
 * holds, and once the whole collection is covered it has nothing to ask for and
 * says so. The caller runs this in the background — a session can be played
 * from existing material while it is in flight, and the new challenges simply
 * show up in the pool for next time.
 *
 * **It writes challenges and nothing else.** A top-up is drilling practice for
 * vocabulary the learner already has, so nothing here touches the item table:
 * new words are added deliberately, by the learner and the assistant, through
 * `add_words` (`$lib/assistant`, `$lib/conversation`). That is why the batch
 * needs no dedupe pass and no id remapping — there is no proposed vocabulary to
 * fork the collection with — and why a challenge citing an id the resolver
 * could not place is simply dropped by the resolver rather than dragging
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

	const [pool, items, parts] = await Promise.all([getPool(), getAllItems(), getDifficultyParts()]);

	const args = planRefill(pool, items, profile, now, {
		serving: servingFor(profile, parts, opts.device),
		...(opts.topic === undefined ? {} : { topic: opts.topic })
	});

	// Said here, before any request step is announced, so an empty brief is
	// never reported as a model that returned nothing.
	if (args.wants.length === 0) {
		throw new Error(
			items.length === 0
				? 'There are no words to write challenges about yet.'
				: 'Every word you have already has fresh challenges waiting. Play a session, then generate again.'
		);
	}

	const batch = await getBatch(args, {
		...(opts.signal ? { signal: opts.signal } : {}),
		...(progress ? { onProgress: progress } : {}),
		...(opts.itemsPerRequest === undefined ? {} : { itemsPerRequest: opts.itemsPerRequest }),
		...(opts.reasoningEffort === undefined ? {} : { reasoningEffort: opts.reasoningEffort })
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
	/** The challenges to play, in order, each at its help level. Empty means there is nothing to do. */
	picks: SessionPick[];
	/** The same challenges, without their help levels. */
	challenges: Challenge[];
	/** Every item known right now — the match-pairs pool and the item lookup. */
	items: KnowledgeItem[];
	/** Words whose card is due at `now`. */
	dueCount: number;
	/**
	 * How well the pool covers the words this session will serve, and what a
	 * top-up would write — the same `planTopUp` walk generation makes, counted
	 * rather than planned (`topUpCoverage`). This is the start screen's freshness
	 * figure and the Generate button's label in one: "N of M due words have fresh
	 * challenges" is exactly the question the learner is asking, and `wants`
	 * being zero is exactly when the button has nothing left to write and says
	 * so. A pool-wide count of rested rows used to stand here, and it could say
	 * "running low" on a day every due word was already covered.
	 */
	topUp: TopUpCoverage;
}

export type { TopUpCoverage };

export interface StartSessionOptions extends Omit<PlanSessionOptions, 'serving'> {
	/** Epoch ms; defaults to `Date.now()`. */
	now?: number;
	/** This device's help-level bounds; read from the preferences when absent. */
	device?: DeviceServing;
}

/**
 * Reads the pool and plans a session from it. No network, no generation, no
 * waiting: this is what makes "Start session" instant, whatever state the
 * learner's key or connection is in.
 *
 * Cheap enough to re-run whenever the pool may have moved (a background
 * generation finishing, say) so the start screen's counts stay honest. The
 * counts describe the *schedule* and the *pool*, not the plan: `dueCount` is
 * what is actually due (the plan routinely reaches past it into early review),
 * and `topUp` is what the next generation would find missing.
 */
export async function startSession(opts: StartSessionOptions = {}): Promise<SessionPlan> {
	const now = opts.now ?? Date.now();
	const { now: _now, device, ...planOpts } = opts;

	const [pool, items, parts, profile] = await Promise.all([
		getPool(),
		getAllItems(),
		getDifficultyParts(),
		getProfile()
	]);
	const serving = servingFor(profile, parts, device);
	const picks = planSession(pool, items, now, { ...planOpts, serving });
	const dueCount = items.filter((item) => isDue(item, now)).length;

	return {
		picks,
		challenges: picks.map((pick) => pick.challenge),
		items,
		dueCount,
		topUp: topUpCoverage(pool, items, now, serving)
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
	if (!storedDefFor(challenge).pooled) return;
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
	/** See {@link AnswerEvent.itemVerdicts}; absent preserves one verdict per challenge. */
	itemVerdicts?: readonly { itemId: string; verdict: Verdict }[];
	/**
	 * The help level the challenge was shown at — the served presentation's
	 * `shown`. Logged with the result, because it is what the difficulty model
	 * learns from; absent for a screen nothing served (a bare render).
	 */
	shown?: string;
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
 * Returns the ids it actually filed a review for — the challenge's items minus
 * any that no longer exist. That set is what {@link amendResult} needs to know
 * *which* reviews it may re-grade; the cards themselves it does not need, because
 * the rewind is the core's. Match-pairs returns an empty set; callers with
 * nothing to amend can ignore the value.
 */
export async function applyResult(
	challenge: Challenge,
	outcome: AnswerOutcome
): Promise<Set<string>> {
	const now = outcome.now ?? Date.now();
	const reviewed = new Set<string>();

	if (storedDefFor(challenge).reviewsSrs) {
		const verdictByItem = new Map(outcome.itemVerdicts?.map((item) => [item.itemId, item.verdict]));
		for (const itemId of challenge.itemIds) {
			const verdict = verdictByItem.get(itemId) ?? outcome.verdict;
			const { existed } = await updateItemAfterReview(itemId, {
				at: now,
				grade: gradeFromResult(verdict)
			});
			if (existed) reviewed.add(itemId);
		}
	}

	await addResult({
		challengeId: challenge.id,
		verdict: outcome.verdict,
		answerGiven: outcome.answerGiven,
		at: now,
		...(outcome.shown === undefined ? {} : { shown: outcome.shown })
	});

	// Ephemeral match-pairs rounds were never pooled; `recordServe` no-ops on a
	// missing id, so this stays a single unconditional call.
	await recordServe(challenge.id, now);

	return reviewed;
}

/**
 * Re-grades the review {@link applyResult} just wrote, because the learner said
 * so: after a correct answer the banner offers Hard / Good / Easy, and touching
 * it means "that was not a plain Good".
 *
 * The rewind is exact rather than compensating, and it is the core's: `replaceLast`
 * makes the new entry *supersede* the one that review appended, and the
 * materializer then refolds the item's whole log from its introduction. So the
 * card lands where a single review at this grade would have left it, not where
 * a nudge from the Good would. A second *appended* review would instead inflate
 * `reps` and double-count the answer in the item's recent grades. Refolding is
 * also what makes repeated calls safe: assessing Easy and then Hard lands exactly
 * where assessing Hard once would, because neither builds on the card it is
 * about to replace.
 *
 * Match-pairs is a no-op, for the reason given in {@link applyResult}, and so
 * is any item the challenge names but that review skipped (deleted mid-session)
 * — absence from `reviewed` is the signal.
 *
 * No interaction with {@link applyOverturn}: an overturn only ever fires on a
 * `wrong` verdict and a self-assessment only on a `correct` one, so the two
 * paths are disjoint by construction and never race for the same card.
 */
export async function amendResult(
	challenge: Challenge,
	grade: Grade,
	reviewed: ReadonlySet<string>,
	now: number = Date.now()
): Promise<void> {
	if (!storedDefFor(challenge).reviewsSrs) return;

	for (const itemId of challenge.itemIds) {
		if (!reviewed.has(itemId)) continue;
		await updateItemAfterReview(itemId, { at: now, grade }, { replaceLast: true });
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
export async function applyOverturn(
	challenge: Challenge,
	now: number = Date.now(),
	/**
	 * For a composite challenge, only the items the original answer actually
	 * graded wrong should receive compensation. Omit it for legacy one-verdict
	 * formats, whose whole challenge received the wrong grade.
	 */
	wrongItemIds?: ReadonlySet<string>
): Promise<void> {
	if (!storedDefFor(challenge).reviewsSrs) return;

	for (const itemId of challenge.itemIds) {
		if (wrongItemIds && !wrongItemIds.has(itemId)) continue;
		await updateItemAfterReview(itemId, { at: now, grade: Grade.Good });
	}
}
