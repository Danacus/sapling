<!--
  The session screen — the part of the app people actually spend time in.

  Shape of a visit: one start screen shows what the pool holds ("N challenges
  ready · M words due"), and offers two independent actions. **Start session**
  plays a plan the engine assembled from challenges that already exist — no
  network, no waiting, ever. **Generate new lesson** spends one batched LLM
  call in the *background*, adding to the pool; the learner can start playing
  while it runs, and whatever it produces is simply there next time.

  Then: play the planned challenges, slipping a free locally-built match-pairs
  round in after every 4th → summary.

  Rules and writes live in `$lib/session/engine`; this file owns pacing, motion
  and everything the learner sees. The invariant worth stating: the session is
  planned once, up front, and nothing reads the database mid-play — `advance`
  walks an array. `pendingWrite` is still awaited before advancing, because a
  self-assessment must land on top of the review it re-grades.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { fade, fly, scale, slide } from 'svelte/transition';

	import { correctAnswerText, spokenAnswerFor } from '$lib/challenges/display';
	import { getProfile, getStats, localDay } from '$lib/db';
	import { LlmError, isMockMode, makeMatchPairsChallenge } from '$lib/llm';
	import type { ProgressStep } from '$lib/llm';
	import {
		MATCH_PAIRS_EVERY,
		MATCH_PAIRS_XP,
		SKIP_ANSWER,
		amendResult,
		applyOverturn,
		applyResult,
		bankSessionXp,
		comboAfter,
		COMBO_THRESHOLD,
		generateChallenges,
		isListeningChallenge,
		reportChallenge,
		sessionSummary,
		startSession,
		wantsMatchRound,
		xpFor,
		type AnswerEvent,
		type SessionAnswer,
		type SessionPlan
	} from '$lib/session/engine';
	import { motionMs } from '$lib/session/motion';
	import { shouldShowReading } from '$lib/session/romanization';
	import type { FsrsCardState, Grade } from '$lib/srs';
	import { runSync } from '$lib/sync/run';
	import { warmSpeech } from '$lib/tts';
	import type { Challenge, KnowledgeItem, Profile, Stats, Verdict } from '$lib/types';
	import {
		addRecentTopic,
		getListeningMode,
		getRecentTopics,
		getReviewOnlyMode,
		getRomanizationMode,
		setReviewOnlyMode
	} from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	import ChallengeHost from './ChallengeHost.svelte';
	import FeedbackBanner from './FeedbackBanner.svelte';

	/** Conversational scenarios offered next to the topic field. */
	const TOPIC_SUGGESTIONS = [
		'Ordering in a restaurant',
		'Talking about your hobbies',
		'Making plans with a friend',
		'Asking for directions',
		'Small talk with a colleague',
		'At the market',
		'Introducing yourself',
		'Talking about your weekend'
	];

	/**
	 * How many suggestions the topic row shows before it offers the rest. The
	 * full list is eight-plus chips — a wall of pills the learner has to read
	 * past to reach the one button that matters — so the closed row is a taste
	 * and "+n more" is the way to the whole shelf.
	 */
	const CHIP_PREVIEW = 4;

	type Phase = 'loading' | 'start' | 'playing' | 'summary';

	interface Feedback {
		challenge: Challenge;
		verdict: Verdict;
		answerGiven: string;
		correctAnswer: string;
		closestAccepted?: string;
		explanation?: string;
		xp: number;
		/** An escalation overturned a `wrong` grade; see {@link overturnCurrent}. */
		overturned?: boolean;
	}

	let phase = $state<Phase>('loading');
	let bootError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let mock = $state(false);

	/* Start screen ------------------------------------------------------------ */

	/** The plan the pool currently supports, re-read whenever the pool moves. */
	let plan = $state<SessionPlan | null>(null);
	let topicInput = $state('');
	let recentTopics = $state<string[]>([]);
	let reviewOnlyMode = $state(false);
	/** A generation is in flight; the button is latched and the log is live. */
	let generating = $state(false);
	let genError = $state('');
	/** "Extra practice" plan is being fetched; latches that button. */
	let practiceLoading = $state(false);
	/** The fetched practice plan came back empty — nothing ahead of schedule to review. */
	let practiceEmpty = $state(false);

	/**
	 * Presentation-only: the learner's explicit choice about the "New lesson"
	 * disclosure. `null` means they have not touched it, so it follows
	 * {@link genAutoOpen}; once they open or close it their choice sticks.
	 */
	let genOpenChoice = $state<boolean | null>(null);
	/** Presentation-only: the topic row has been asked for the rest of its chips. */
	let showAllChips = $state(false);

	const topicChips = $derived([
		...TOPIC_SUGGESTIONS,
		...(profile?.interests ?? []).slice(0, 2).map((interest) => `Chatting about ${interest}`)
	]);

	/**
	 * The trimmed suggestion row: the first {@link CHIP_PREVIEW}, plus whichever
	 * chip is currently picked so a selection made from the expanded row does not
	 * vanish when the row closes again.
	 */
	const visibleChips = $derived.by(() => {
		if (showAllChips) return topicChips;
		const head = topicChips.slice(0, CHIP_PREVIEW);
		const key = topicInput.trim().toLowerCase();
		const picked = topicChips.find((chip) => chip.toLowerCase() === key);
		return picked && !head.includes(picked) ? [...head, picked] : head;
	});

	const readyCount = $derived(plan?.readyCount ?? 0);
	const dueCount = $derived(plan?.dueCount ?? 0);
	const canStart = $derived((plan?.challenges.length ?? 0) > 0);
	/**
	 * Worth nudging towards a fresh lesson: nothing to play, or barely anything.
	 * Suppressed under review-only — generating would only add new vocabulary,
	 * which that mode is specifically trying to keep out of the session.
	 */
	const nudgeGenerate = $derived(plan !== null && !reviewOnlyMode && (plan.poolLow || !canStart));
	/**
	 * The pool has ever held material — enough to offer "Extra practice" even
	 * when nothing is due right now. Whether the practice plan actually turns
	 * up anything is only known once fetched; see {@link practiceEmpty}.
	 */
	const hasPoolMaterial = $derived((plan?.items.length ?? 0) > 0);

	/**
	 * The one contextual message the card is allowed to show, picked by priority:
	 * review-only with nothing due beats nothing-to-play beats a thinning pool.
	 * Three stacked amber boxes were three ways of saying "here is your next
	 * move" at once, which is no priority at all — this slot says it once.
	 */
	const notice = $derived.by(() => {
		if (plan === null) return '';

		// Review-only owns the empty case: generating is off the table in this
		// mode, so the way out is Extra practice or switching back.
		if (reviewOnlyMode && !canStart) {
			return hasPoolMaterial
				? 'Nothing due for review yet — Extra practice reviews ahead of schedule, or switch to All words to add new vocabulary.'
				: 'Nothing due for review yet. Switch to All words to add new vocabulary.';
		}

		if (!nudgeGenerate) return '';

		const body = canStart
			? 'Running low on fresh material — a new lesson tops the pool back up.'
			: hasPoolMaterial
				? 'Nothing due right now — try Extra practice above, or open New lesson below.'
				: 'Nothing to practise yet. Generate a lesson to get started.';
		return mock ? `${body} In practice mode it's instant and free.` : body;
	});

	/* Session ----------------------------------------------------------------- */

	/** The planned challenges, in order, and how far into them we are. */
	let queue: Challenge[] = [];
	let nextIndex = 0;

	/** Every known item; what the free match-pairs rounds are drawn from. */
	let items = $state<KnowledgeItem[]>([]);
	let newWords = $state<KnowledgeItem[]>([]);

	let current = $state<Challenge | null>(null);
	/**
	 * Whether {@link current} renders its readings. Rolled once per served
	 * challenge in {@link show} — under the adaptive mode the answer is a coin
	 * flip weighted by how well the challenge's words are known, and it has to
	 * stay put for as long as the challenge is on screen.
	 */
	let currentReadings = $state(true);
	let feedback = $state<Feedback | null>(null);
	let answers = $state<SessionAnswer[]>([]);
	let combo = $state(0);
	let bestCombo = $state(0);
	let llmAnswered = $state(0);
	let lastMatchAfter = $state(-1);
	let plannedLlm = $state(0);

	let endStats = $state<Stats | undefined>(undefined);
	let goalNewlyReached = $state(false);
	let todayXpBefore = 0;

	let showQuitConfirm = $state(false);
	let leaving = $state(false);
	let toast = $state<{ id: number; amount: number } | null>(null);
	let toastSeq = 0;

	/** When the current challenge was first shown; used for a skip's response time. */
	let challengeShownAt = Date.now();

	/* Generation log ---------------------------------------------------------- */

	/**
	 * One step of a generation run, as reported by `generateChallenges`.
	 * `endedAt` is filled in when the *next* step starts (or when the run
	 * finishes), which is what makes the list honest about where the seconds
	 * went — especially whether they went into the model call.
	 */
	interface PrepStep {
		label: string;
		startedAt: number;
		endedAt?: number;
	}

	let prepSteps = $state<PrepStep[]>([]);
	/** Ticks while generating, so the running step's counter moves. */
	let prepNow = $state(Date.now());
	/** Total generation time, kept on screen once the lesson has landed. */
	let prepTotalMs = $state<number | null>(null);

	/**
	 * Where the "New lesson" disclosure sits before the learner has an opinion:
	 * open whenever a run has something to show (in flight, its ledger, a
	 * failure to retry), and open when generating is genuinely the *only* way
	 * forward. A merely thinning pool gets the highlight (`.urged`) instead —
	 * a hint, not a drawer opening itself in the learner's face.
	 */
	const genAutoOpen = $derived(
		generating || genError !== '' || prepSteps.length > 0 || (nudgeGenerate && !canStart)
	);
	/**
	 * An explicit tap always wins, so the caret never has a dead click — and the
	 * two Generate buttons set the choice themselves, which is what keeps the
	 * ledger on screen through a run the learner started.
	 */
	const genOpen = $derived(genOpenChoice ?? genAutoOpen);

	/** Closes whichever step is still open at `at`. */
	function closeOpenStep(steps: PrepStep[], at: number): PrepStep[] {
		return steps.map((step) => (step.endedAt === undefined ? { ...step, endedAt: at } : step));
	}

	function recordPrepStep(step: ProgressStep): void {
		const at = Date.now();
		prepNow = at;
		prepSteps = [...closeOpenStep(prepSteps, at), { label: step.label, startedAt: at }];
	}

	function stepSeconds(step: PrepStep): string {
		return (((step.endedAt ?? prepNow) - step.startedAt) / 1000).toFixed(1);
	}

	/**
	 * The in-flight `applyResult`. Never dropped on the floor: the UI advances
	 * without waiting for it, but `continueSession` awaits it, so a rating given
	 * as the learner reaches for Continue still lands on top of the review it
	 * re-grades rather than racing it.
	 */
	let pendingWrite: Promise<void> = Promise.resolve();

	/**
	 * The same write, kept for its value: the card state each item on the current
	 * challenge had *before* it was graded. {@link assessCurrent} needs it to
	 * recompute the review rather than stack a second one on top. Never rejects —
	 * a failed write yields an empty map, and amending nothing is the right
	 * outcome there.
	 */
	let pendingPriors: Promise<Map<string, FsrsCardState | null>> = Promise.resolve(new Map());

	/* ---------------------------------------------------------------------- */
	/* Boot                                                                    */
	/* ---------------------------------------------------------------------- */

	let booted = false;

	$effect(() => {
		if (booted || !browser) return;
		booted = true;
		void loadStartScreen();
	});

	$effect(() => {
		if (!generating) return;
		const timer = setInterval(() => (prepNow = Date.now()), 100);
		return () => clearInterval(timer);
	});

	/**
	 * Boot: read the profile and plan a session from what the pool already
	 * holds. No LLM call, no threshold check, nothing that can fail slowly —
	 * this is why the start screen appears immediately however empty or full
	 * the pool is. Skipped straight past if there is no profile yet.
	 */
	async function loadStartScreen(): Promise<void> {
		try {
			const loaded = await getProfile();
			if (!loaded) {
				// The layout sends profile-less visitors to onboarding; nothing to do.
				return;
			}
			profile = loaded;
			mock = isMockMode();
			recentTopics = getRecentTopics();
			reviewOnlyMode = getReviewOnlyMode();
			await refreshPlan();
		} catch (cause) {
			bootError = cause instanceof Error ? cause.message : 'Could not read your progress.';
		}
		phase = 'start';
	}

	/** Re-plans from the pool: at boot, and whenever a generation has landed. */
	async function refreshPlan(): Promise<void> {
		plan = await startSession({ reviewOnly: reviewOnlyMode });
	}

	/** The learner flipped Review only: persist it and re-plan immediately. */
	function toggleReviewOnly(on: boolean): void {
		reviewOnlyMode = on;
		setReviewOnlyMode(on);
		void refreshPlan();
	}

	/**
	 * "Generate new lesson": one batched LLM call, in the background.
	 *
	 * Deliberately not awaited by anything the learner is waiting on — they can
	 * start a session from existing material while this runs, and if they do,
	 * the finished batch just sits in the pool for next time. The only thing it
	 * touches on completion is the plan behind the start screen.
	 */
	async function generate(): Promise<void> {
		if (generating || !profile) return;
		generating = true;
		genError = '';
		prepSteps = [];
		prepTotalMs = null;
		const startedAt = Date.now();
		prepNow = startedAt;

		const topic = topicInput.trim();
		if (topic) recentTopics = addRecentTopic(topic);

		try {
			await generateChallenges(profile, {
				onProgress: recordPrepStep,
				...(topic ? { topic } : {})
			});

			// Close the last step and keep the total on screen, so "that felt long"
			// can be checked against a number.
			const finishedAt = Date.now();
			prepSteps = closeOpenStep(prepSteps, finishedAt);
			prepTotalMs = finishedAt - startedAt;

			// The pool moved: re-plan so the counts and the Start button are honest.
			// Harmless mid-session — the running session plays its own array.
			await refreshPlan();
		} catch (cause) {
			genError =
				cause instanceof LlmError
					? cause.message
					: cause instanceof Error
						? cause.message
						: 'Something went wrong building your lesson.';
			prepSteps = [];
			prepTotalMs = null;
		} finally {
			generating = false;
		}
	}

	/**
	 * "Start session": plays the plan the start screen was already showing.
	 * Instant by construction — the challenges were chosen at boot.
	 */
	async function beginSession(): Promise<void> {
		if (!plan) return;
		await playPlan(plan);
	}

	/**
	 * "Extra practice": fetches a plan that reviews words *ahead* of schedule
	 * from the existing pool — no generation, no new vocabulary — and, if it
	 * turns up anything, plays it through the exact same setup as a normal
	 * session. Latched like {@link generate}'s button while the fetch is in
	 * flight; an empty result surfaces inline rather than silently no-opping.
	 */
	async function beginPractice(): Promise<void> {
		if (practiceLoading) return;
		practiceLoading = true;
		practiceEmpty = false;
		try {
			const ready = await startSession({ practice: true, reviewOnly: reviewOnlyMode });
			if (ready.challenges.length === 0) {
				practiceEmpty = true;
				return;
			}
			await playPlan(ready);
		} finally {
			practiceLoading = false;
		}
	}

	/**
	 * Shared setup for both "Start session" and "Extra practice": turns a
	 * {@link SessionPlan} into the playing phase. Kept as one function so the
	 * two entry points can never drift on match-pairs filtering or bookkeeping.
	 */
	async function playPlan(ready: SessionPlan): Promise<void> {
		if (ready.challenges.length === 0) return;

		queue = ready.challenges;
		nextIndex = 0;
		// Match-pairs rounds are drawn from `items` mid-session (see `advance`); under
		// review-only, a never-reviewed word must not sneak in there either.
		items = reviewOnlyMode ? ready.items.filter((item) => item.history.length > 0) : ready.items;
		plannedLlm = ready.challenges.length;
		newWords = firstTimeWords(ready);

		answers = [];
		combo = 0;
		bestCombo = 0;
		llmAnswered = 0;
		lastMatchAfter = -1;

		const stats = await getStats();
		todayXpBefore = stats.history.find((e) => e.day === localDay(Date.now()))?.xp ?? 0;

		phase = 'playing';
		await advance();
	}

	/**
	 * The words in this session the learner has never been reviewed on — what the
	 * summary calls "New words".
	 *
	 * Generation no longer bookends a session, so "introduced by this batch" is
	 * not a thing the session can know any more; an empty review history is the
	 * honest local stand-in, and it stays true for a word that was generated
	 * yesterday but is only being met now.
	 */
	function firstTimeWords(ready: SessionPlan): KnowledgeItem[] {
		const exercised = new Set(ready.challenges.flatMap((challenge) => challenge.itemIds));
		return ready.items.filter((item) => exercised.has(item.id) && item.history.length === 0);
	}

	/* ---------------------------------------------------------------------- */
	/* Session flow                                                            */
	/* ---------------------------------------------------------------------- */

	/**
	 * Total steps the progress bar plans for: the generated challenges we can
	 * actually serve, plus one free match round after every {@link
	 * MATCH_PAIRS_EVERY}th of them (never after the last one — the session ends
	 * there).
	 */
	const plannedMatches = $derived(
		items.length >= 4 ? Math.floor(Math.max(0, plannedLlm - 1) / MATCH_PAIRS_EVERY) : 0
	);
	const totalSteps = $derived(Math.max(1, plannedLlm + plannedMatches));
	const stepsDone = $derived(answers.length);

	async function advance(): Promise<void> {
		feedback = null;

		// The plan is the session: when it is walked, we are done. Checked before
		// the match round below so a session never ends on free filler.
		if (nextIndex >= queue.length) {
			await finish();
			return;
		}

		// A free round costs nothing and needs four known words to be worth playing.
		if (items.length >= 4 && wantsMatchRound(llmAnswered, lastMatchAfter)) {
			const match = makeMatchPairsChallenge(items);
			if (match) {
				lastMatchAfter = llmAnswered;
				show(match);
				return;
			}
		}

		show(queue[nextIndex++]);
	}

	function show(challenge: Challenge): void {
		const at = Date.now();
		challengeShownAt = at;
		currentReadings = shouldShowReading(romanizationMode, challenge, items, at);
		current = challenge;
		// Warm the answer's audio while the learner is still thinking: Kokoro
		// takes a second or two per phrase, answering takes longer, so the
		// banner's auto-play finds the clip already local and plays instantly
		// instead of trailing the grade. Fire-and-forget; a failed warm just
		// means the real speak synthesizes as before.
		const answerAudio = spokenAnswerFor(challenge);
		if (answerAudio) void warmSpeech(answerAudio, targetLanguage);
		// A listening challenge plays its *prompt* the moment it appears, with
		// nothing on screen to read in the meantime — so that clip is the one
		// warming actually matters for. Warmed here rather than in the component
		// so the same rule decides both.
		if (isListeningChallenge(challenge, listeningEnabled) && challenge.type === 'multiple-choice') {
			void warmSpeech(challenge.prompt, targetLanguage);
		}
	}

	function handleAnswer(event: AnswerEvent): void {
		const challenge = current;
		if (!challenge || feedback) return;

		const isMatch = challenge.type === 'match-pairs';

		// A match round neither extends nor breaks the combo: it is a whole
		// multi-tap round, not one graded answer, and it pays a flat rate.
		const nextCombo = isMatch ? combo : comboAfter(event.verdict, combo);
		const xp = isMatch ? MATCH_PAIRS_XP : xpFor(event.verdict, nextCombo);

		combo = nextCombo;
		if (combo > bestCombo) bestCombo = combo;
		if (!isMatch) llmAnswered++;

		answers = [
			...answers,
			{
				challengeId: challenge.id,
				type: challenge.type,
				verdict: event.verdict,
				xp,
				itemIds: isMatch ? [] : challenge.itemIds
			}
		];

		feedback = {
			challenge,
			verdict: event.verdict,
			answerGiven: event.answerGiven,
			correctAnswer: correctAnswerText(challenge),
			...(event.closestAccepted ? { closestAccepted: event.closestAccepted } : {}),
			...(challenge.explanation ? { explanation: challenge.explanation } : {}),
			xp
		};

		if (xp > 0) toast = { id: ++toastSeq, amount: xp };

		// Fire-and-follow: the banner animates now, the write lands underneath it.
		// The one promise is held twice — as `pendingPriors` for its value (the
		// pre-answer cards a self-assessment would re-grade from) and as
		// `pendingWrite` for its completion, which is what the session awaits before
		// touching the queue again. Neither is ever dropped.
		pendingPriors = applyResult(challenge, {
			verdict: event.verdict,
			answerGiven: event.answerGiven,
			responseMs: event.responseMs,
			now: Date.now()
		}).catch(() => {
			// A failed write must not eat the session; the answer is already scored.
			return new Map<string, FsrsCardState | null>();
		});
		pendingWrite = pendingPriors.then(() => undefined);
	}

	/**
	 * The learner rated a correct answer Hard / Good / Easy before continuing.
	 *
	 * Explicit self-assessment is the only route to an FSRS `Easy` (see
	 * `gradeFromResult`), so this is the learner steering their own schedule
	 * rather than a guess made from response time. `amendResult` recomputes the
	 * review from the captured pre-answer cards and replaces the history entry,
	 * so switching between grades stays exact however often it happens.
	 *
	 * Chained onto `pendingWrite` for the usual reason: the original review must
	 * be on the card (and its history entry appended) before the amend rewrites
	 * it. `continueSession` awaits the same chain, so even a rating given as the
	 * learner reaches for Continue lands before the next challenge is pulled.
	 *
	 * XP is untouched: it prices the verdict, not the grade — "that was hard" is
	 * not a smaller correct answer.
	 */
	function assessCurrent(grade: Grade): void {
		const fb = feedback;
		if (!fb) return;
		const priors = pendingPriors;
		pendingWrite = pendingWrite
			.then(async () => {
				await amendResult(fb.challenge, grade, await priors, Date.now());
			})
			.catch(() => {
				// A failed write must not eat the session; the answer is already scored.
			});
	}

	/**
	 * The learner disputed a `wrong` grade and the explain call agreed with them
	 * (`overturn: true`). Everything the original answer cost is handed back:
	 *
	 * - **Banner**: repaints as accepted (`FeedbackBanner`'s `overturned`).
	 * - **XP**: paid at `xpFor('correct', combo)` minus the 0 already scored.
	 * - **Summary**: the logged answer flips to `correct`, so `sessionSummary`
	 *   recomputes correct/wrong and accuracy on its own.
	 * - **SRS**: `applyOverturn` writes one `Good` review per item, chained
	 *   *after* the original write so it lands on top of the `Again`.
	 *
	 * What it deliberately does **not** do: restore the combo. The streak broke
	 * live, on screen, and un-breaking it would retro-pay every answer since —
	 * so the overturned answer is paid at the base rate (combo is 0 here) and
	 * the next correct answer starts a fresh streak. Nor does it rewrite the
	 * result log: the learner really did answer this at the time, and the entry
	 * is history, not score.
	 */
	function overturnCurrent(): void {
		const fb = feedback;
		if (!fb || fb.overturned || fb.verdict !== 'wrong') return;

		// `combo` is 0 here — the wrong answer reset it, and no answer has been
		// taken since (the banner is still up). Written as a lookup anyway so the
		// XP always matches whatever the combo rules say at this moment.
		const gained = Math.max(0, xpFor('correct', combo) - fb.xp);

		feedback = { ...fb, overturned: true, xp: fb.xp + gained };

		answers = answers.map((answer) =>
			answer.challengeId === fb.challenge.id
				? { ...answer, verdict: 'correct', xp: answer.xp + gained }
				: answer
		);

		if (gained > 0) toast = { id: ++toastSeq, amount: gained };

		// After the pending `applyResult`: the Again review must already be on the
		// card before the compensating Good review goes on top of it.
		pendingWrite = pendingWrite
			.then(() => applyOverturn(fb.challenge, Date.now()))
			.catch(() => {
				// A failed write must not eat the session; the XP is already scored.
			});
	}

	/**
	 * "Too hard — skip": an answer event like any other, with the verdict a skip
	 * honestly deserves. `wrong` costs the combo and pays nothing, and
	 * `applyResult` grades the item FSRS-`Again` — which is exactly "I could not
	 * produce this". The word then travels into the next batch prompt as a
	 * `recentMistakes` entry with `gave: '(skipped)'`, asking the model for an
	 * easier format next time.
	 */
	function skipCurrent(): void {
		const challenge = current;
		if (!challenge || feedback || challenge.type === 'match-pairs') return;
		handleAnswer({
			answerGiven: SKIP_ANSWER,
			verdict: 'wrong',
			responseMs: Date.now() - challengeShownAt
		});
	}

	/**
	 * The learner flagged this challenge as broken. It is excluded from every
	 * future plan, immediately and permanently — but the session does *not*
	 * advance: a challenge worth reporting is usually one they still want
	 * explained. Chained onto `pendingWrite` like every other write, and
	 * swallowed on failure for the same reason.
	 */
	function reportCurrent(): void {
		const fb = feedback;
		if (!fb) return;
		pendingWrite = pendingWrite.then(() => reportChallenge(fb.challenge)).catch(() => {
			// A failed write must not eat the session; the banner already said thanks.
		});
	}

	async function continueSession(): Promise<void> {
		// Drop the banner first so it slides out while the write finishes, then
		// wait for it: a self-assessment given at the last moment is chained onto
		// the same promise and must land before the next challenge is shown.
		feedback = null;
		await pendingWrite;
		await advance();
	}

	async function finish(): Promise<void> {
		await pendingWrite;
		current = null;
		feedback = null;

		const summary = sessionSummary(answers);
		const goal = profile?.dailyGoalXp ?? 0;
		goalNewlyReached = goal > 0 && todayXpBefore < goal && todayXpBefore + summary.xp >= goal;

		endStats = summary.xp > 0 ? await bankSessionXp(summary.xp) : await getStats();
		phase = 'summary';

		// Fire-and-forget (§9): a device should pick up what other devices did
		// while this session was in progress, but the summary screen must never
		// wait on the network. `runSync` never throws and no-ops when unconfigured.
		void runSync();
	}

	function requestQuit(): void {
		if (answers.length > 0 && phase === 'playing') {
			showQuitConfirm = true;
			return;
		}
		void quit();
	}

	/**
	 * Leaves early, but banks whatever was earned — progress is never punished.
	 *
	 * Nothing to clean up: challenges are only stamped as served when they are
	 * answered, so everything the learner did not reach is still in the pool and
	 * simply gets planned again next time.
	 */
	async function quit(): Promise<void> {
		if (leaving) return;
		leaving = true;
		showQuitConfirm = false;
		try {
			await pendingWrite;
			const summary = sessionSummary(answers);
			if (summary.xp > 0) await bankSessionXp(summary.xp);
			// Fire-and-forget (§9) — must not delay the navigation below.
			void runSync();
		} catch {
			/* leaving anyway */
		}
		await goto('/');
	}

	/* ---------------------------------------------------------------------- */
	/* Summary figures                                                         */
	/* ---------------------------------------------------------------------- */

	const summary = $derived(sessionSummary(answers));
	const accuracyPct = $derived(Math.round(summary.accuracy * 100));

	const strengthened = $derived.by(() => {
		const fresh = new Set(newWords.map((i) => i.id));
		const seen = new Set<string>();
		for (const answer of answers) {
			for (const id of answer.itemIds) if (!fresh.has(id)) seen.add(id);
		}
		return seen.size;
	});

	/**
	 * First-time words the learner actually reached. No fallback to the planned
	 * set: `newWords` now names every never-reviewed word the *plan* touched, so
	 * listing unmet ones on an early quit would claim words they never saw.
	 */
	const learnedWords = $derived.by(() => {
		const practised = new Set(answers.flatMap((a) => a.itemIds));
		return newWords.filter((word) => practised.has(word.id));
	});

	const confetti = $derived.by(() => {
		if (phase !== 'summary') return [];
		const colors = ['var(--primary)', 'var(--accent)', 'var(--amber)', 'var(--warn)'];
		return Array.from({ length: 36 }, (_, i) => ({
			id: i,
			left: Math.round(Math.random() * 100),
			delay: Math.round(Math.random() * 1600),
			duration: 2200 + Math.round(Math.random() * 1800),
			size: 6 + Math.round(Math.random() * 7),
			color: colors[i % colors.length],
			round: i % 3 === 0
		}));
	});

	const targetLanguage = $derived(profile?.targetLanguage ?? '');
	const nativeLanguage = $derived(profile?.nativeLanguage ?? '');
	const isLastStep = $derived(llmAnswered >= plannedLlm || stepsDone >= totalSteps);

	/** Read once — the toggles live in Settings, not mid-session. */
	const romanizationMode = getRomanizationMode();
	const listeningEnabled = getListeningMode();
	/**
	 * The summary's new-word list. A word the session just introduced is by
	 * definition not one the learner owns, so adaptive mode has nothing to fade
	 * out here — only an explicit Off hides these readings.
	 */
	const showNewWordReadings = romanizationMode !== 'off';
</script>

<svelte:head>
	<title>Session</title>
</svelte:head>

<main class="shell">
	{#if phase === 'loading'}
		<div class="centered"><Spinner /></div>
	{:else if phase === 'start'}
		<!--
		  The start screen as one journal entry: today's figures ruled into two
		  columns, the mode that produced them directly under, then the single
		  green button the whole card exists for. Everything else is quieter than
		  that button by construction — the secondary action is a hairline ghost,
		  the guidance is one message rather than a stack of boxes, and the
		  generator is folded away until it is asked for or genuinely needed.
		-->
		<div class="centered">
			<div class="card start-card ll-rise">
				<h1>Ready when you are</h1>
				<hr class="stitch" />

				{#if bootError}
					<p class="error-message boot-error" role="alert">{bootError}</p>
				{:else}
					<div class="ledger ll-rise" style="animation-delay: 70ms">
						<div class="figure">
							<span class="fig-num">{readyCount}</span>
							<span class="fig-label">Challenge{readyCount === 1 ? '' : 's'} ready</span>
						</div>
						<div class="figure">
							<span class="fig-num" class:pending={dueCount > 0}>{dueCount}</span>
							<span class="fig-label">Word{dueCount === 1 ? '' : 's'} due</span>
						</div>
					</div>
				{/if}

				<div class="mode-block ll-rise" style="animation-delay: 120ms">
					<div class="mode" role="group" aria-label="Session mode">
						<button
							type="button"
							class="mode-opt"
							class:on={!reviewOnlyMode}
							aria-pressed={!reviewOnlyMode}
							onclick={() => toggleReviewOnly(false)}
						>
							All words
						</button>
						<button
							type="button"
							class="mode-opt"
							class:on={reviewOnlyMode}
							aria-pressed={reviewOnlyMode}
							onclick={() => toggleReviewOnly(true)}
						>
							Review only
						</button>
					</div>
					<p class="mode-note">
						{reviewOnlyMode
							? 'No new words, nothing generated.'
							: 'New words can join the session.'}
					</p>
				</div>

				<div class="act ll-rise" style="animation-delay: 170ms">
					<button
						type="button"
						class="btn btn-primary btn-block start-btn"
						disabled={!canStart}
						onclick={() => void beginSession()}
					>
						Start session
					</button>

					{#if hasPoolMaterial}
						<div class="secondary">
							<button
								type="button"
								class="btn btn-ghost practice-btn"
								disabled={practiceLoading}
								title="Reviews words before they're due, from material you already have — no new words, nothing generated."
								onclick={() => void beginPractice()}
							>
								{practiceLoading ? 'Fetching…' : 'Extra practice'}
							</button>
							<p class="practice-note" class:empty={practiceEmpty}>
								{practiceEmpty
									? 'Nothing to practise yet — generate a lesson first.'
									: "Reviews words before they're due."}
							</p>
						</div>
					{/if}
				</div>

				{#if notice}
					<p class="nudge ll-rise" style="animation-delay: 220ms">{notice}</p>
				{/if}

				{#if !reviewOnlyMode}
					<section class="generate ll-rise" style="animation-delay: 260ms">
						<button
							type="button"
							class="disclosure"
							class:open={genOpen}
							class:urged={nudgeGenerate}
							aria-expanded={genOpen}
							aria-controls="new-lesson-panel"
							onclick={() => (genOpenChoice = !genOpen)}
						>
							<span>New lesson</span>
							{#if generating}
								<span class="disc-meta">Generating…</span>
							{/if}
							<span class="disc-caret" aria-hidden="true">
								<svg class="ico" viewBox="0 0 24 24"><path d="m9.6 6.3 5.7 5.7-5.7 5.7" /></svg>
							</span>
						</button>

						{#if genOpen}
							<div
								class="gen-panel"
								id="new-lesson-panel"
								transition:slide={{ duration: motionMs(220) }}
							>
								<p class="hint gen-hint">
									Optional — pick or type a scenario and the lesson leans into it.
								</p>

								<input
									class="input topic-input"
									type="text"
									bind:value={topicInput}
									placeholder="e.g. checking into a hotel…"
									autocomplete="off"
									aria-label="Lesson topic"
									onkeydown={(event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											genOpenChoice = true;
											void generate();
										}
									}}
								/>

								<div class="chip-row">
									{#each visibleChips as chip (chip)}
										<button
											type="button"
											class="chip"
											class:selected={topicInput.trim().toLowerCase() === chip.toLowerCase()}
											onclick={() => (topicInput = chip)}
										>
											{chip}
										</button>
									{/each}
									{#if !showAllChips && topicChips.length > CHIP_PREVIEW}
										<button
											type="button"
											class="chip chip-more"
											onclick={() => (showAllChips = true)}
										>
											+{topicChips.length - CHIP_PREVIEW} more
										</button>
									{/if}
								</div>

								{#if recentTopics.length > 0}
									<div class="recent">
										<p class="recent-label">Recent</p>
										<div class="chip-row">
											{#each recentTopics as recent (recent)}
												<button type="button" class="chip" onclick={() => (topicInput = recent)}>
													{recent}
												</button>
											{/each}
										</div>
									</div>
								{/if}

								<button
									type="button"
									class="btn btn-block generate-btn"
									disabled={generating}
									onclick={() => {
										genOpenChoice = true;
										void generate();
									}}
								>
									{generating ? 'Generating…' : 'Generate new lesson'}
								</button>

								{#if prepSteps.length > 0}
									<ul class="prep-steps" role="status" aria-live="polite">
										{#each prepSteps as step, index (index)}
											{@const done = step.endedAt !== undefined}
											<li class:done>
												{#if done}
													<span class="prep-mark" aria-hidden="true">
														<svg class="ico" viewBox="0 0 24 24"
															><path d="m5 12.8 4.4 4.4L19 7.6" /></svg
														>
													</span>
												{:else}
													<span class="prep-mark prep-spinner" aria-hidden="true"></span>
												{/if}
												<span class="prep-label">{step.label}</span>
												<span class="prep-secs">{stepSeconds(step)}s</span>
											</li>
										{/each}
									</ul>
									{#if prepTotalMs !== null}
										<p class="prep-total" transition:fade={{ duration: motionMs(200) }}>
											Lesson ready in {(prepTotalMs / 1000).toFixed(1)}s — it's in the pool.
										</p>
									{/if}
								{/if}

								{#if genError}
									<div class="gen-error">
										<p class="error-message" role="alert">{genError}</p>
										<button
											type="button"
											class="btn btn-ghost retry-btn"
											onclick={() => {
												genOpenChoice = true;
												void generate();
											}}
										>
											Try again
										</button>
									</div>
								{/if}
							</div>
						{/if}
					</section>
				{/if}
			</div>
		</div>
	{:else if phase === 'summary'}
		<div class="summary" in:scale={{ duration: motionMs(320), start: 0.94 }}>
			<div class="confetti" aria-hidden="true">
				{#each confetti as piece (piece.id)}
					<span
						class="piece"
						class:round={piece.round}
						style="left:{piece.left}%; width:{piece.size}px; height:{piece.size *
							1.6}px; background:{piece.color}; animation-delay:{piece.delay}ms; animation-duration:{piece.duration}ms;"
					></span>
				{/each}
			</div>

			<div class="card summary-card">
				{#if summary.answered === 0}
					<h1>Nothing to practise</h1>
					<p class="lead">Your pool has nothing ready right now — generate a new lesson.</p>
				{:else}
					<!-- The brand glyph, pressed into the page: a sprout in a specimen
					     frame. Two leaves for a session that went well, one for a session
					     that is still growing — the same distinction the two emoji drew,
					     said in the app's own hand. -->
					<p class="summary-mark" aria-hidden="true">
						<span class="medal" class:thriving={accuracyPct >= 80}>
							<svg class="ico sprout" viewBox="0 0 24 24">
								<path d="M12 21v-8.6" />
								{#if accuracyPct >= 80}
									<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
								{/if}
								<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
							</svg>
						</span>
					</p>
					<h1>Session complete</h1>

					<div class="xp-hero">
						<span class="xp-number">+{summary.xp}</span>
						<span class="xp-label">XP</span>
					</div>

					<hr class="stitch" />

					<div class="stat-grid">
						<div class="stat">
							<span class="stat-value">{accuracyPct}%</span>
							<span class="stat-label">Accuracy</span>
						</div>
						<div class="stat">
							<span class="stat-value">{strengthened}</span>
							<span class="stat-label">Words strengthened</span>
						</div>
						<div class="stat">
							<span class="stat-value streak-value">
								<svg class="ico sprout" viewBox="0 0 24 24" aria-hidden="true">
									<path d="M12 21v-8.6" />
									<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
									<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
								</svg>
								{endStats?.streakDays ?? 0}
							</span>
							<span class="stat-label">Day streak</span>
						</div>
					</div>

					{#if bestCombo >= COMBO_THRESHOLD}
						<p class="combo-note">
							<svg class="ico spark" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 3.6 13.7 9.1 19.2 10.8 13.7 12.5 12 18 10.3 12.5 4.8 10.8 10.3 9.1Z" />
							</svg>
							Best combo this session: {bestCombo} in a row
						</p>
					{/if}

					{#if goalNewlyReached}
						<p class="goal-hit">
							<svg class="ico spark" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 3.6 13.7 9.1 19.2 10.8 13.7 12.5 12 18 10.3 12.5 4.8 10.8 10.3 9.1Z" />
							</svg>
							Daily goal reached — {profile?.dailyGoalXp} XP. See you tomorrow?
						</p>
					{/if}

					{#if learnedWords.length > 0}
						<section class="new-words">
							<h2>New words</h2>
							<hr class="stitch" />
							<ul>
								{#each learnedWords as word (word.id)}
									<li>
										<div class="word-text">
											<span class="term-row">
												<span class="term">{word.term}</span>
												<SpeakButton text={word.term} lang={targetLanguage} size="sm" />
											</span>
											{#if showNewWordReadings && word.romanization}
												<span class="rom">{word.romanization}</span>
											{/if}
										</div>
										<span class="meaning">{word.meaning}</span>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				{/if}

				<a class="btn btn-primary btn-block back-btn" href="/">Back to dashboard</a>
			</div>
		</div>
	{:else}
		<header class="topbar">
			<button type="button" class="quit" onclick={requestQuit} aria-label="Quit session">
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
			</button>

			<div class="progress" role="progressbar" aria-valuenow={stepsDone} aria-valuemin={0} aria-valuemax={totalSteps} aria-label="Session progress">
				{#each Array.from({ length: totalSteps }, (_, i) => i) as index (index)}
					<span class="segment" class:filled={index < stepsDone}></span>
				{/each}
			</div>

			{#if combo >= COMBO_THRESHOLD}
				<div class="combo" in:scale={{ duration: motionMs(240), start: 0.5 }} title="Answer streak">
					<svg class="ico spark" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M12 3.6 13.7 9.1 19.2 10.8 13.7 12.5 12 18 10.3 12.5 4.8 10.8 10.3 9.1Z" />
					</svg>
					<span>{combo}</span>
				</div>
			{:else}
				<div class="combo-spacer" aria-hidden="true"></div>
			{/if}

			{#if toast}
				{#key toast.id}
					<span class="xp-toast" aria-hidden="true">+{toast.amount}</span>
				{/key}
			{/if}
		</header>

		{#if mock}
			<p class="mock-banner">
				Practice mode — add your OpenRouter key in <a href="/settings">Settings</a> for personalized
				content.
			</p>
		{/if}

		<section class="stage" class:with-banner={feedback !== null}>
			{#if current}
				{#key current.id}
					<!--
					  The app's one entrance beat, borrowed for the challenge swap: the
					  same 9px lift `.ll-rise` plays on the home cards, so a new challenge
					  settles onto the page rather than sliding in from the side.
					  `motionMs` collapses it to an instant cut under
					  `prefers-reduced-motion`.

					  Deliberately an `in:` on its own. An `out:` here keeps the leaving
					  challenge mounted *alongside* the arriving one for the length of its
					  transition, and the stage then has to find room for both — which is
					  what the swap used to flicker: two `width: 100%` children in one
					  flex row, each shrunk to half the stage, every line rewrapped, then
					  snapped back. The single-cell grid below makes that impossible now;
					  one transition keeps it that way. There is no delay either — a delay
					  only ever existed to let an outgoing element get out of the way.
					-->
					<div class="challenge" in:fly={{ y: 9, duration: motionMs(320) }}>
						<ChallengeHost
							challenge={current}
							onanswer={handleAnswer}
							{targetLanguage}
							{nativeLanguage}
							showReadings={currentReadings}
						/>

						{#if current.type !== 'match-pairs' && !feedback}
							<button type="button" class="btn btn-ghost skip-btn" onclick={skipCurrent}>
								Too hard — skip
							</button>
						{/if}
					</div>
				{/key}
			{:else}
				<div class="centered"><Spinner /></div>
			{/if}
		</section>

		{#if feedback}
			<FeedbackBanner
				challenge={feedback.challenge}
				verdict={feedback.verdict}
				answerGiven={feedback.answerGiven}
				correctAnswer={feedback.correctAnswer}
				closestAccepted={feedback.closestAccepted}
				explanation={feedback.explanation}
				xp={feedback.xp}
				skipped={feedback.answerGiven === SKIP_ANSWER}
				{nativeLanguage}
				{targetLanguage}
				last={isLastStep}
				overturned={feedback.overturned ?? false}
				oncontinue={() => void continueSession()}
				onoverturn={overturnCurrent}
				onassess={assessCurrent}
				onreport={reportCurrent}
			/>
		{/if}

		{#if showQuitConfirm}
			<div class="overlay" transition:fade={{ duration: motionMs(150) }}>
				<div class="card quit-card" in:scale={{ duration: motionMs(200), start: 0.92 }}>
					<h2>Leave the session?</h2>
					<p class="hint">
						You've earned {summary.xp} XP so far — we'll keep it. Whatever you haven't played stays in
						your pool for next time.
					</p>
					<div class="quit-actions">
						<button type="button" class="btn btn-primary" onclick={() => (showQuitConfirm = false)}>
							Keep going
						</button>
						<button type="button" class="btn btn-ghost" onclick={() => void quit()} disabled={leaving}>
							Quit
						</button>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</main>

<style>
	.shell {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 34rem;
		min-height: 100dvh;
		margin: 0 auto;
		padding: 1rem 1rem 2rem;
	}

	.centered {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		flex: 1;
		min-height: 60dvh;
		text-align: center;
	}

	/* One hand for every icon on this screen, matching the dashboard: 24-unit
	   box, hairline stroke, round joins. Set here rather than per-<svg> so the
	   weight can never drift between the quit ✕, the combo spark and the
	   summary's sprout. */
	.ico {
		width: 1.2rem;
		height: 1.2rem;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* The one filled mark in the set — it is a burst, not a diagram. */
	.spark {
		fill: currentColor;
		stroke-width: 1.2;
	}

	/* Start ------------------------------------------------------------------- */

	/*
	  Left-ranged, not centred. The start screen is a page of the journal — a
	  heading, today's figures, then the action — and a ledger only reads as a
	  ledger when its columns share a left edge. The summary card stays centred:
	  that one is a celebration, this one is a plan.
	*/
	.start-card {
		width: 100%;
		text-align: left;
	}

	.start-card h1 {
		font-size: clamp(1.6rem, 7vw, 1.95rem);
	}

	.start-card h1 + .stitch {
		margin: 0.9rem 0 1.3rem;
	}

	.boot-error {
		margin-bottom: 1.3rem;
	}

	/*
	  Today's entry: two ruled columns, hairline between, nothing boxed — the
	  same treatment the summary gives its figures, because a page of numbers
	  should read as a page wherever it appears in the app. The figures carry
	  the display face at h1 scale, which is what makes the pool state the first
	  thing the eye lands on rather than a muted sentence it has to parse.
	*/
	.ledger {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.figure {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
		padding-right: 0.9rem;
	}

	.figure + .figure {
		padding-right: 0;
		padding-left: 1.1rem;
		border-left: 1px solid var(--border);
	}

	.fig-num {
		font-family: var(--font-display);
		font-size: clamp(2.1rem, 9.5vw, 2.7rem);
		font-weight: 800;
		font-variation-settings:
			'SOFT' 32,
			'WONK' 1;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.025em;
		line-height: 1;
	}

	/* Work waiting on the learner wears the terracotta; everything else is ink.
	   One accent, used only where it means "this is the thing that's due". */
	.fig-num.pending {
		color: var(--accent);
	}

	.fig-label {
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-muted);
		text-wrap: balance;
	}

	/* Mode ------------------------------------------------------------------ */

	.mode-block {
		margin-top: 1.4rem;
	}

	/*
	  Two paper tabs in a ruled tray — the settings switch's vocabulary (inset
	  trough, hairline frame, `--radius-sm`) laid out as a segmented control.
	  It sits directly under the figures because it is what produced them: flip
	  it and both numbers re-plan.
	*/
	.mode {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		box-shadow: inset 0 1px 2px rgb(60 50 20 / 8%);
	}

	.mode-opt {
		padding: 0.45rem 0.5rem;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.84rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.mode-opt:hover:not(.on) {
		color: var(--text);
	}

	.mode-opt:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.mode-opt.on {
		border-color: var(--border-strong);
		background: var(--surface);
		color: var(--text);
		font-weight: 700;
	}

	/* The sentence the old checkbox label carried, moved under the control it
	   describes and swapped for whichever half is active. */
	.mode-note {
		margin: 0.45rem 0 0;
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	/* Actions --------------------------------------------------------------- */

	.act {
		margin-top: 1.35rem;
	}

	.secondary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.45rem 0.75rem;
		margin-top: 0.85rem;
	}

	/* An outlined ghost, deliberately a third of the green button's weight —
	   available, never competing. Its full explanation lives in the `title`. */
	.practice-btn {
		flex: 0 0 auto;
		padding: 0.5rem 0.85rem;
		border-color: var(--border);
		font-size: 0.85rem;
	}

	.practice-note {
		flex: 1 1 9rem;
		min-width: 0;
		margin: 0;
		font-size: 0.78rem;
		color: var(--text-muted);
		text-wrap: balance;
	}

	.practice-note.empty {
		color: var(--accent);
		font-weight: 700;
	}

	/* One message, never a stack; see the `notice` derived for the priority. */
	.nudge {
		margin: 1.15rem 0 0;
		padding: 0.6rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.85rem;
		font-weight: 500;
		text-wrap: balance;
	}

	/* New lesson ------------------------------------------------------------ */

	.generate {
		margin-top: 1.5rem;
	}

	/* A closed drawer in the page's own hand: hairline frame, Karla 700, a
	   chevron that turns. Closed it costs one line; open it is the only thing
	   below the fold. */
	.disclosure {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.7rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.disclosure:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.disclosure:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* When the pool is thin the drawer picks up the notice's tint, so the
	   message and the way to answer it read as one move rather than two. */
	.disclosure.urged {
		border-color: color-mix(in srgb, var(--accent) 38%, transparent);
		background: var(--accent-soft);
	}

	.disclosure.urged:hover {
		border-color: var(--accent);
	}

	.disc-meta {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.disc-caret {
		display: inline-flex;
		margin-left: auto;
		color: var(--text-muted);
		transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.disc-caret .ico {
		width: 1rem;
		height: 1rem;
	}

	.disclosure.open .disc-caret {
		transform: rotate(90deg);
	}

	.gen-panel {
		padding-top: 1.1rem;
	}

	.gen-hint {
		margin: 0 0 0.85rem;
	}

	.topic-input {
		margin: 0 0 0.8rem;
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.generate-btn {
		margin-top: 1.15rem;
		border-color: var(--border-strong);
	}

	.gen-error {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.7rem;
		margin-top: 0.9rem;
	}

	/* The boxed error carries no margins of its own, so the place it lands
	   spaces it: full width under the generate button. */
	.gen-error .error-message {
		align-self: stretch;
	}

	.retry-btn {
		padding: 0.5rem 0.85rem;
		border-color: var(--border);
		font-size: 0.85rem;
	}

	/* True chips, so the pill survives — in the app's settled chip voice:
	   hairline, Karla 500, terracotta when picked. */
	.chip {
		padding: 0.34rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.83rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.chip:hover {
		border-color: var(--text-muted);
		background: var(--surface-alt);
		color: var(--text);
	}

	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.chip.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 700;
	}

	/* "+n more": the shelf, in the chip voice but dashed — an opening, not an
	   option. It disappears the moment the whole row is out. */
	.chip-more {
		border-style: dashed;
		font-weight: 600;
	}

	.recent {
		margin-top: 0.9rem;
	}

	.recent-label {
		margin: 0 0 0.45rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* The one thing on the screen that is allowed to be loud. */
	.start-btn {
		padding: 1.05rem 1.5rem;
		font-size: 1.05rem;
		letter-spacing: 0.005em;
	}

	/* Generation log ------------------------------------------------------- */

	/* A ruled ledger of what the run is doing and where the seconds went —
	   hairline between entries, the same rule the word lists use. */
	.prep-steps {
		display: flex;
		flex-direction: column;
		width: 100%;
		margin: 1.1rem 0 0;
		padding: 0;
		list-style: none;
		font-size: 0.84rem;
		color: var(--text-muted);
	}

	.prep-steps li {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.35rem 0;
	}

	.prep-steps li + li {
		border-top: 1px solid var(--border);
	}

	.prep-steps li.done {
		opacity: 0.65;
	}

	.prep-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 1rem;
	}

	.prep-mark .ico {
		width: 0.95rem;
		height: 0.95rem;
		stroke-width: 1.9;
	}

	.prep-spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 2px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: ll-step-spin 0.8s linear infinite;
	}

	@keyframes ll-step-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.prep-spinner {
			animation-duration: 2.4s;
		}
	}

	.prep-steps li.done .prep-mark {
		color: var(--primary);
	}

	.prep-label {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.prep-steps li:not(.done) .prep-label {
		color: var(--text);
		font-weight: 700;
	}

	.prep-secs {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}

	.prep-total {
		margin: 0.6rem 0 0;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	/* Errors --------------------------------------------------------------- */

	/* The app's one error treatment: hairline frame over a 12% danger tint. */
	.error-message {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.88rem;
		font-weight: 700;
	}

	/* Top bar -------------------------------------------------------------- */

	.topbar {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	/* A 10px squircle with a hairline, like every icon control in the app. */
	.quit {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		line-height: 1;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.quit:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.quit:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/*
	  Progress as a row of ruled ticks rather than beads — squared ends, a
	  hairline trough, ink laid into the paper as each step is answered. The
	  same measure `ProgressBar` draws on the dashboard, cut into segments.
	*/
	.progress {
		display: flex;
		flex: 1;
		gap: 3px;
		min-width: 0;
	}

	.segment {
		flex: 1;
		height: 0.55rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: var(--surface-alt);
		box-shadow: inset 0 1px 2px color-mix(in srgb, var(--border-strong) 30%, transparent);
		transition:
			background 0.3s ease,
			border-color 0.3s ease;
	}

	.segment.filled {
		border-color: var(--primary-strong);
		background: var(--primary);
		box-shadow: none;
	}

	.combo,
	.combo-spacer {
		flex: 0 0 auto;
		min-width: 3rem;
	}

	/* The streak, as a tab in the same row as the quit control. */
	.combo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		height: 2.25rem;
		padding: 0 0.5rem;
		border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--amber) 18%, var(--surface));
		color: color-mix(in srgb, var(--amber) 62%, var(--text));
		font-weight: 700;
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
	}

	.combo .ico {
		width: 1rem;
		height: 1rem;
	}

	/* The XP receipt floating up out of the bar — a stamp, not a bubble. */
	.xp-toast {
		position: absolute;
		left: 50%;
		bottom: -0.25rem;
		padding: 0.15rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--primary);
		color: var(--text-inverse);
		font-size: 0.85rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
		animation: ll-float-up 1.1s ease-out forwards;
	}

	/* Mock banner ---------------------------------------------------------- */

	.mock-banner {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 500;
		text-align: center;
		text-wrap: balance;
	}

	/* Stage ---------------------------------------------------------------- */

	/*
	  A single-cell grid, not a flex row.

	  Whatever the stage is showing goes in the one cell, so two challenges can
	  never end up dividing the width between them mid-swap — the failure the
	  old flex row had, and the reason a swap flickered. The row is `1fr` rather
	  than `auto` on purpose: it has to fill the stage's height, because that is
	  what `.check`'s `margin-top: auto` pins the submit button to. Its automatic
	  minimum still lets a tall challenge push past it rather than clip.
	*/
	.stage {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: 1fr;
		flex: 1;
		min-height: 0;
		padding-bottom: 1rem;
		/* The banner arriving and leaving changes this by 14rem; glide it, or
		   the challenge's last row jerks that far at exactly the moment the
		   next one is arriving. Paired with the banner's own 260ms fly. */
		transition: padding-bottom 0.24s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.stage > .challenge,
	.stage > .centered {
		grid-area: 1 / 1;
		min-width: 0;
	}

	/* Keep the last row of the challenge clear of the feedback banner. */
	.stage.with-banner {
		padding-bottom: 15rem;
	}

	.challenge {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	/* Deliberately quiet: an escape hatch, not an invitation. */
	.skip-btn {
		align-self: center;
		margin-top: 1rem;
		padding: 0.5rem 0.9rem;
		font-size: 0.8rem;
		font-weight: 500;
		opacity: 0.7;
	}

	.skip-btn:hover {
		opacity: 1;
	}

	/* Quit confirmation ---------------------------------------------------- */

	/*
	  A warm ink wash, never a blue-grey scrim. `--scrim` points at whichever
	  token is *dark* in the current palette — the page ink on paper, the
	  inverse ink on moss — so the overlay stays warm in both without a single
	  literal colour.
	*/
	.overlay {
		--scrim: var(--text);
		position: fixed;
		inset: 0;
		z-index: 30;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: color-mix(in srgb, var(--scrim) 62%, transparent);
	}

	@media (prefers-color-scheme: dark) {
		.overlay {
			--scrim: var(--text-inverse);
		}
	}

	.quit-card {
		max-width: 24rem;
		text-align: center;
	}

	.quit-card h2 {
		font-size: 1.2rem;
	}

	.quit-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 1.25rem;
	}

	/* Summary -------------------------------------------------------------- */

	.summary {
		position: relative;
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: center;
	}

	/* The end of the session is the app's brand moment, so the card is set with
	   a little more air and a faint leaf wash rising from the top — the same
	   gradient the dashboard's start card wears, turned the other way up. */
	.summary-card {
		position: relative;
		z-index: 1;
		text-align: center;
		background:
			linear-gradient(
				170deg,
				color-mix(in srgb, var(--primary-soft) 65%, var(--surface)),
				var(--surface) 55%
			),
			var(--surface);
	}

	.summary-card h1 {
		margin: 0;
		font-size: clamp(1.7rem, 7.5vw, 2.1rem);
	}

	/* A pressed specimen label: the sprout mounted on tinted paper inside a
	   stitched frame, exactly as onboarding mounts its step marks. */
	.summary-mark {
		margin: 0 0 0.9rem;
		line-height: 1;
	}

	.medal {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3.4rem;
		height: 3.4rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--primary-soft) 65%, transparent);
		color: var(--primary-strong);
		animation: ll-pop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}

	.medal .ico {
		width: 2rem;
		height: 2rem;
		stroke-width: 1.4;
	}

	/* A clean run earns the second leaf and a terracotta frame. */
	.medal.thriving {
		border-style: solid;
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.lead {
		color: var(--text-muted);
		text-wrap: balance;
	}

	/* The figure the whole screen is built around. */
	.xp-hero {
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: 0.35rem;
		margin: 0.85rem 0 0;
		color: var(--primary-strong);
	}

	.xp-number {
		font-family: var(--font-display);
		font-size: 3.2rem;
		font-weight: 700;
		font-variation-settings:
			'SOFT' 32,
			'WONK' 1;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.025em;
		line-height: 1;
	}

	.xp-label {
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.xp-hero + .stitch {
		margin: 1.25rem 0 1.1rem;
	}

	/*
	  Three ruled columns rather than three cards: hairline dividers between
	  them, nothing boxed. A page of figures reads as a page, not as tiles.
	*/
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1rem 0.35rem;
	}

	.stat + .stat {
		border-left: 1px solid var(--border);
	}

	.stat-value {
		font-family: var(--font-display);
		font-size: 1.35rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.streak-value {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.streak-value .ico {
		width: 1.05rem;
		height: 1.05rem;
		color: var(--primary);
	}

	.stat-label {
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
		text-wrap: balance;
	}

	.combo-note,
	.goal-hit {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		text-wrap: balance;
	}

	.combo-note {
		margin: 1.1rem 0 0;
		font-size: 0.92rem;
		font-weight: 700;
		color: color-mix(in srgb, var(--amber) 62%, var(--text));
	}

	.combo-note .spark {
		color: var(--amber);
	}

	.goal-hit {
		margin: 1rem 0 0;
		padding: 0.65rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
		border-radius: var(--radius-sm);
		background: var(--primary-soft);
		color: var(--primary-strong);
		font-size: 0.92rem;
		font-weight: 700;
	}

	.goal-hit .spark {
		color: var(--accent);
	}

	.new-words {
		margin-top: 1.6rem;
		text-align: left;
	}

	.new-words h2 {
		margin: 0;
		font-family: var(--font);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.new-words h2 + .stitch {
		margin: 0.4rem 0 0.2rem;
	}

	/* A ruled ledger, matching the dashboard's word list: a page of entries,
	   not a stack of chips. */
	.new-words ul {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.new-words li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.55rem 0;
	}

	.new-words li + li {
		border-top: 1px solid var(--border);
	}

	.new-words .word-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.new-words .term-row {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		min-width: 0;
	}

	/* The specimen itself, in the display face — the one target-language
	   moment left on the summary. */
	.new-words .term {
		font-family: var(--font-display);
		font-size: 1.05rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		overflow-wrap: anywhere;
	}

	.new-words .word-text :global(.rom) {
		overflow-wrap: anywhere;
	}

	.new-words .meaning {
		color: var(--text-muted);
		font-size: 0.9rem;
		text-align: right;
		overflow-wrap: anywhere;
	}

	.back-btn {
		margin-top: 1.75rem;
		font-size: 1rem;
		padding: 0.95rem 1.4rem;
		text-decoration: none;
	}

	/* Confetti ------------------------------------------------------------- */

	.confetti {
		position: fixed;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 0;
	}

	.piece {
		position: absolute;
		top: -10vh;
		border-radius: 2px;
		animation-name: ll-confetti-fall;
		animation-timing-function: linear;
		animation-fill-mode: both;
	}

	.piece.round {
		border-radius: 999px;
	}

	@media (prefers-reduced-motion: reduce) {
		.confetti {
			display: none;
		}

		.medal,
		.xp-toast {
			animation: none;
		}

		.quit,
		.segment,
		.chip,
		.combo,
		.stage,
		.mode-opt,
		.disclosure,
		.disc-caret {
			transition: none;
		}
	}

	@media (max-width: 480px) {
		.figure {
			padding-right: 0.6rem;
		}

		.figure + .figure {
			padding-left: 0.8rem;
		}

		.fig-label {
			font-size: 0.62rem;
			letter-spacing: 0.07em;
		}

		.stat-value {
			font-size: 1.15rem;
		}

		.stat-label {
			font-size: 0.62rem;
			letter-spacing: 0.06em;
		}

		.xp-number {
			font-size: 2.6rem;
		}
	}
</style>
