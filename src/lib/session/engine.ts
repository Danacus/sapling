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
 * rather than consuming it. Practice is one stream that runs until the learner
 * stops (`./stream`): each next challenge is picked from what the pool holds
 * now ({@link nextPick}), and {@link generateChallenges} tops the pool up with
 * what it is missing ({@link planTopUp}) — in the background, as a task, when
 * the learner asks or when the words ahead in the stream want rows. Starting
 * never waits on the network.
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
	overturnResult,
	recordServe,
	reportChallenge as flagChallengeReported,
	updateItemAfterReview
} from '$lib/db';
import type { ChallengeRow, ReasoningEffort } from '$lib/db';
import { challengeOf } from '$lib/db';
import { MATCH_PAIRS_EVERY } from '$lib/db/generated/challenges';
import type { TopUpCoverage } from '$lib/db/generated/index';
import { getBatch, isMockMode } from '$lib/llm';
import type { BatchArgs, OnProgress, TokenUsage, Want } from '$lib/llm';
import { Grade, gradeFromResult, isDue } from '$lib/srs';
import { asWords, callChallenges } from '$lib/challenges/core';
import { storedDefFor } from '$lib/challenges/types';
import type { Challenge, KnowledgeItem, MatchPairsChallenge, Profile, Verdict } from '$lib/types';
import { servingFor, type DeviceServing, type Serving } from './serving';

export { deviceServing, servingFor, type DeviceServing, type Serving } from './serving';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** How many early-word challenges a match round follows — `crates/sapling-challenges`' `stream.rs`. */
export { MATCH_PAIRS_EVERY };

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
 * The canonical target-language audio for a challenge's answer — a
 * presentation fact (`$lib/challenges/display`), exported here where the
 * session screen has always found it.
 */
export { spokenAnswerFor } from '$lib/challenges/display';

/* -------------------------------------------------------------------------- */
/* The stream's decisions (pure)                                               */
/* -------------------------------------------------------------------------- */

export interface StreamOptions {
	/** What the pick is made against; starting values, the normal aim and no listening when absent. */
	serving?: Serving;
	/** The challenge ids this stream has already shown: never picked again. */
	served?: readonly string[];
	/**
	 * No batch can help a head with nothing: pass it for the first word further
	 * down the same list that has something. Absent, the head waits.
	 */
	pass?: boolean;
}

/** One challenge the stream serves, at the help level it is served at. */
export interface SessionPick {
	challenge: Challenge;
	/** The help level (`crates/sapling-challenges`' `help.rs`): what `presentationFor` shows and the answer records. */
	shown: string;
	/** The chance of a correct answer at that help level, given the word is remembered. */
	chance: number;
	/** Whether its word is due, rather than reviewed ahead. */
	due: boolean;
}

function streamArgs(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: StreamOptions
) {
	return {
		pool: [...pool],
		words: asWords(items),
		now,
		...(opts.serving === undefined ? {} : { serving: opts.serving }),
		...(opts.served === undefined ? {} : { served: [...opts.served] }),
		...(opts.pass ? { pass: true } : {})
	};
}

/** The head of the stream: its most urgent word, and the pick to serve unless there is none. */
export interface StreamHead {
	word: string;
	pick: SessionPick | null;
	/** Set when the head was passed: the word further down that `pick` is about. */
	instead?: string;
}

/**
 * Rust's (`crates/sapling-challenges`' `stream.rs`): the most urgent word (due
 * words first, most overdue first, then the words not yet due) and its
 * available row whose best help level sits closest to the aim — `pick: null`
 * while that word has nothing, which a refill is what fixes, unless `pass`
 * lets it be the first word further down with something (`instead`); `null`
 * only with no words at all. What plays is the row as stored, minus its
 * bookkeeping.
 */
export function streamHead(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: StreamOptions = {}
): StreamHead | null {
	const head = callChallenges('streamHead', streamArgs(pool, items, now, opts));
	if (!head) return null;
	const next = head.next;
	return {
		word: head.word,
		pick: next
			? {
					challenge: challengeOf(pool[next.at]!),
					shown: next.shown,
					chance: next.chance,
					due: next.due
				}
			: null,
		...(head.instead === undefined ? {} : { instead: head.instead })
	};
}

/** {@link streamHead}'s pick: the stream's next challenge, or `null` while its head has nothing. */
export function nextPick(
	pool: readonly ChallengeRow[],
	items: KnowledgeItem[],
	now: number,
	opts: StreamOptions = {}
): SessionPick | null {
	return streamHead(pool, items, now, opts)?.pick ?? null;
}

/**
 * How many words ahead the stream keeps written for: enough to keep
 * answering, at `paceMs` a challenge, while a batch that takes `batchMs` comes back.
 */
export function lowWaterMark(paceMs?: number, batchMs?: number): number {
	return callChallenges('lowWaterMark', {
		...(paceMs === undefined ? {} : { paceMs }),
		...(batchMs === undefined ? {} : { batchMs })
	});
}

/** Whether a challenge counts towards the next match round: it is about an early word. */
export function isEarlyChallenge(challenge: Challenge, items: KnowledgeItem[]): boolean {
	return callChallenges('isEarly', { itemIds: challenge.itemIds, words: asWords(items) });
}

/** A free match round drawn from the early words, or `null` when there are too few. `seed` replays it. */
export function matchRound(items: KnowledgeItem[], seed?: number): MatchPairsChallenge | null {
	return callChallenges('matchRound', {
		words: asWords(items),
		...(seed === undefined ? {} : { seed })
	});
}

/* -------------------------------------------------------------------------- */
/* Top-up planning                                                             */
/* -------------------------------------------------------------------------- */

export interface PlanTopUpOptions {
	/** What a row is judged against; see {@link StreamOptions.serving}. */
	serving?: Serving;
	/** The ids a stream has already shown: they cover nothing, as they serve nothing. */
	served?: readonly string[];
	/** Words a stream has already asked a refill for: they want nothing. */
	asked?: readonly string[];
	/** How many of the words ahead to write for — the stream's mark; every word when absent. */
	limit?: number;
	/** Replays the tie-breaks between equally good kinds. */
	seed?: number;
}

/**
 * The wants the words ahead are missing, most urgent word first — Rust's
 * (`crates/sapling-challenges`' `topup.rs`): of the same list the stream
 * serves from, a word with no available row wants two written, each a kind
 * that can reach it, at the length worked back from the aim.
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
		...(opts.served === undefined ? {} : { served: [...opts.served] }),
		...(opts.asked === undefined ? {} : { asked: [...opts.asked] }),
		...(opts.limit === undefined ? {} : { limit: opts.limit }),
		...(opts.seed === undefined ? {} : { seed: opts.seed })
	});
}

/** The start screen's figure and what a press would write, off the same list as {@link planTopUp}. */
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
 * The brief is {@link planTopUp}'s: two wants for every word with no row
 * available, walked most urgent first — over the stream's next `limit` words
 * for a refill, the whole collection for a press — and nothing at all for a
 * word already covered. A batch is written *about* vocabulary the learner
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
	const wants = planTopUp(pool, items, now, opts);
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
		// The skill rides along for the writer alone, never the prompt: a passage
		// about two words is judged by their average, so a row is counted as a
		// want filled only once it fits them together (`lesson.rs`' `fill_request`,
		// against the same `serving` the wants were planned with).
		...(items.length
			? {
					knownItems: items.map((item) => ({
						id: item.id,
						term: item.term,
						...(item.romanization ? { romanization: item.romanization } : {}),
						...(item.skill === undefined ? {} : { skill: item.skill })
					}))
				}
			: {}),
		...(opts.serving === undefined ? {} : { serving: opts.serving }),
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
	 * (`deviceServing`), so a top-up judges rows exactly as a stream on this
	 * device would serve them.
	 */
	device?: DeviceServing;
	/** A stream's refill: what it has shown, the words it already asked for, and how many words ahead it writes for. */
	served?: readonly string[];
	asked?: readonly string[];
	limit?: number;
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
		...(opts.served === undefined ? {} : { served: opts.served }),
		...(opts.asked === undefined ? {} : { asked: opts.asked }),
		...(opts.limit === undefined ? {} : { limit: opts.limit }),
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
/* The start screen (database)                                                 */
/* -------------------------------------------------------------------------- */

/** What the learn screen shows before the stream starts. */
export interface PracticeOverview {
	/** Every item known right now. */
	items: KnowledgeItem[];
	/** Words whose card is due at `now`. */
	dueCount: number;
	/** The first challenge the stream would serve; `null` while its first word has nothing. */
	first: SessionPick | null;
	/**
	 * Whether any word in the list has something: what the stream serves, by
	 * passing its head, when no batch can be written for that word.
	 */
	anything: boolean;
	/**
	 * How well the pool covers the upcoming words, and what a press would
	 * write — read off the list the stream serves from (`topUpCoverage`). The start screen's figure and the Generate
	 * button's label in one: "N of M due words have fresh challenges" is exactly
	 * the question the learner is asking, and `wants` being zero is exactly when
	 * the button has nothing left to write and says so.
	 */
	topUp: TopUpCoverage;
}

export type { TopUpCoverage };

export interface OverviewOptions {
	/** Epoch ms; defaults to `Date.now()`. */
	now?: number;
	/** This device's help-level bounds; read from the preferences when absent. */
	device?: DeviceServing;
}

/**
 * Reads the pool and says what practice would start with. No network, no
 * generation, no waiting. Cheap enough to re-run whenever the pool may have
 * moved (a background generation finishing, say) so the start screen's counts
 * stay honest.
 */
export async function practiceOverview(opts: OverviewOptions = {}): Promise<PracticeOverview> {
	const now = opts.now ?? Date.now();
	const [pool, items, parts, profile] = await Promise.all([
		getPool(),
		getAllItems(),
		getDifficultyParts(),
		getProfile()
	]);
	const serving = servingFor(profile, parts, opts.device);
	const first = nextPick(pool, items, now, { serving });
	return {
		items,
		dueCount: items.filter((item) => isDue(item, now)).length,
		first,
		anything: first !== null || nextPick(pool, items, now, { serving, pass: true }) !== null,
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
 * No race with {@link applyOverturn}: an overturn only ever fires on a
 * `wrong` verdict and a self-assessment only on a `correct` one, and both
 * supersede the newest review rather than stacking on it — so whichever
 * comes last is the one review the answer leaves.
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

/** What an overturned answer needs to be undone exactly. */
export interface OverturnedAnswer {
	/**
	 * The answer's own instant — {@link AnswerOutcome.now}, which its reviews
	 * and its result share. The superseding reviews land at it, and the
	 * overturn names the result by it.
	 */
	answeredAt: number;
	/** What {@link applyResult} returned: the items it filed a review for. */
	reviewed: ReadonlySet<string>;
	/**
	 * The per-gap verdicts of a composite answer; only the gaps graded wrong
	 * are overturned. Absent for a one-verdict format, whose whole challenge
	 * was wrong.
	 */
	itemVerdicts?: readonly { itemId: string; verdict: Verdict }[];
}

/**
 * What an overturned answer counts as: every gap graded wrong becomes
 * correct, so the worst verdict left is `almost` where a gap was almost, and
 * `correct` otherwise.
 */
export function overturnedVerdict(
	itemVerdicts?: readonly { itemId: string; verdict: Verdict }[]
): Verdict {
	return itemVerdicts?.some((item) => item.verdict === 'almost') ? 'almost' : 'correct';
}

/**
 * Undoes an answer the escalation overturned — the learner was graded
 * `wrong`, disputed it, and the model agreed it should have counted (see
 * `escalate`'s `overturn`) — **exactly**: afterwards the store holds what an
 * answer accepted on the spot would have left, for FSRS and for the
 * difficulty model alike.
 *
 * - **FSRS.** Each wrong item's `Again` review is *superseded* by a `Good` at
 *   the answer's own instant (`replaceLast`, as {@link amendResult} re-grades
 *   one), and the core refolds the card from the item's whole log — so it
 *   lands where a single `Good` would have, not where "failed, then recalled"
 *   would. A gap that was right keeps its review.
 * - **The difficulty model.** The answer is logged as overturned
 *   (`overturnResult`, a `resultOverturned` event naming it by challenge and
 *   `at`), and the replay reads it at {@link overturnedVerdict} — so the word's
 *   skill and the row's correction move as for a success, not a miss. The
 *   result row itself keeps what was answered: it is history, and the review
 *   screens show it.
 *
 * Answers the verdict the answer now counts as. Match-pairs never reviews and
 * never reaches here; it is a no-op that answers `correct`.
 */
export async function applyOverturn(
	challenge: Challenge,
	answer: OverturnedAnswer
): Promise<Verdict> {
	const verdict = overturnedVerdict(answer.itemVerdicts);
	if (!storedDefFor(challenge).reviewsSrs) return verdict;

	const verdictOf = new Map(answer.itemVerdicts?.map((item) => [item.itemId, item.verdict]));
	for (const itemId of challenge.itemIds) {
		if (!answer.reviewed.has(itemId)) continue;
		if ((verdictOf.get(itemId) ?? 'wrong') !== 'wrong') continue;
		await updateItemAfterReview(
			itemId,
			{ at: answer.answeredAt, grade: Grade.Good },
			{ replaceLast: true }
		);
	}
	await overturnResult({ challengeId: challenge.id, answeredAt: answer.answeredAt, verdict });
	return verdict;
}
