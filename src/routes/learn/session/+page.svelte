<!--
  The session screen — the part of the app people actually spend time in.

  This route starts the plan that `/learn` prepared, plays its challenges with
  a locally-built match-pairs round after every fourth, then shows the summary.
  There is no setup or generation UI here: crossing the route boundary is what
  makes the experience focused and safe to reload or leave.

  Rules and writes live in `$lib/session/engine`; this file owns pacing, motion
  and everything the learner sees. The invariant worth stating: the session is
  planned once, up front, and nothing reads the database mid-play — `advance`
  walks an array. `pendingWrite` is still awaited before advancing, because a
  self-assessment must land on top of the review it re-grades.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import { fade, fly, scale } from 'svelte/transition';

	import { audioTextsFor, correctAnswerText } from '$lib/challenges/display';
	import { presentationFor, type Presentation } from '$lib/challenges/serve/presentation';
	import { STORED_TYPE_DEFS, storedDefFor } from '$lib/challenges/types';
	import { getDailyActivity, getProfile, streakFrom } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import { loadRomanizer, type Romanizer } from '$lib/romanize';
	import {
		SKIP_ANSWER,
		amendResult,
		applyOverturn,
		applyResult,
		interleaveMatchRounds,
		reportChallenge,
		sessionSummary,
		startSession,
		type AnswerEvent,
		type SessionAnswer,
		type SessionPlan
	} from '$lib/session/engine';
	import { motionMs } from '$lib/session/motion';
	import type { Grade } from '$lib/srs';
	import { runSync } from '$lib/sync';
	import { taskStore } from '$lib/tasks/store.svelte';
	import { getTtsEngine, preloadVoice, sherpaSupports, warmSpeech } from '$lib/tts';
	import type { Challenge, KnowledgeItem, Profile, Verdict } from '$lib/types';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	import ChallengeHost from '../ChallengeHost.svelte';
	import FeedbackBanner from '../FeedbackBanner.svelte';

	type Phase = 'loading' | 'playing' | 'summary';

	interface Feedback {
		challenge: Challenge;
		verdict: Verdict;
		answerGiven: string;
		correctAnswer: string;
		closestAccepted?: string;
		/** Per-gap evidence for composite challenges; retained for an overturn. */
		itemVerdicts?: AnswerEvent['itemVerdicts'];
		explanation?: string;
		/** An escalation overturned a `wrong` grade; see {@link overturnCurrent}. */
		overturned?: boolean;
		/**
		 * The presentation this challenge was actually served with — captured off
		 * `currentPresentation` the instant feedback is built, so a later challenge
		 * swap (the queue has already moved on by the time the banner asks) can
		 * never change what an escalation for *this* answer is judged against.
		 * Threaded to `FeedbackBanner` and on to `getEscalation`
		 * (`$lib/llm/escalation`), which needs it to know what the learner's screen
		 * actually showed rather than assuming the full stored row was on it.
		 */
		presentation?: Presentation;
	}

	let phase = $state<Phase>('loading');
	let profile = $state<Profile | undefined>(undefined);
	let mock = $state(false);

	/* Session ----------------------------------------------------------------- */

	/**
	 * The whole session in order — generated challenges *and* the free match
	 * rounds spliced between them — and how far into it we are.
	 */
	let queue: Challenge[] = [];
	let nextIndex = 0;

	/** Every known item; what the free match-pairs rounds are drawn from. */
	let items = $state<KnowledgeItem[]>([]);
	let newWords = $state<KnowledgeItem[]>([]);

	let current = $state<Challenge | null>(null);
	/**
	 * Everything about {@link current} decided at serve time rather than
	 * written by the model — the native-language hint, the cloze/multi-cloze
	 * bank size, the word-order distractor-tile count, and which readings to
	 * show. Built once in {@link show} from the challenge's weakest word and
	 * the learner's mode, and for the same reason: a row carries its full
	 * content for life, and only the rung the word is at *now* says how much of
	 * it the learner still needs. The readings travel inside the same object so
	 * a component has one serve-time prop, not two.
	 */
	let currentPresentation = $state<Presentation | undefined>(undefined);
	/**
	 * The learner's local romanizer, once its chunk has landed. `null` until then
	 * — and forever, for a language that has none; see {@link loadStartScreen}.
	 */
	let romanizer = $state<Romanizer | null>(null);
	let feedback = $state<Feedback | null>(null);
	let answers = $state<SessionAnswer[]>([]);
	let plannedLlm = $state(0);
	/** {@link queue}'s length, mirrored into state for the progress bar. */
	let plannedSteps = $state(0);

	/** Day streak after this session, folded out of the answer log by {@link finish}. */
	let endStreak = $state(0);

	let showQuitConfirm = $state(false);
	let leaving = $state(false);

	/** When the current challenge was first shown; used for a skip's response time. */
	let challengeShownAt = Date.now();

	/**
	 * The in-flight `applyResult`. Never dropped on the floor: the UI advances
	 * without waiting for it, but `continueSession` awaits it, so a rating given
	 * as the learner reaches for Continue still lands on top of the review it
	 * re-grades rather than racing it.
	 */
	let pendingWrite: Promise<void> = Promise.resolve();

	/**
	 * The same write, kept for its value: which items on the current challenge
	 * actually got a review. {@link assessCurrent} needs it so a re-grade replaces
	 * one of *those* rather than appending a fresh review to a word the answer
	 * skipped. Never rejects — a failed write yields an empty set, and amending
	 * nothing is the right outcome there.
	 */
	let pendingReviewed: Promise<Set<string>> = Promise.resolve(new Set());

	/* ---------------------------------------------------------------------- */
	/* Boot                                                                    */
	/* ---------------------------------------------------------------------- */

	let booted = false;

	$effect(() => {
		if (booted || !browser) return;
		booted = true;
		void loadStartScreen();
	});

	/**
	 * A challenge on the table is the one screen the task tray must stay out of:
	 * it would sit on the feedback banner. Back the moment play ends, and on
	 * the way out of this page whatever the phase was.
	 */
	$effect(() => {
		taskStore.setHidden(phase === 'playing');
		return () => taskStore.setHidden(false);
	});

	/**
	 * Boot: read the profile and independently rebuild the plan `/learn` just
	 * showed. Planning is local and deterministic over the current pool, so the
	 * route needs no transient state handoff from its parent.
	 */
	async function loadStartScreen(): Promise<void> {
		try {
			const loaded = await getProfile();
			if (!loaded) {
				// The layout sends profile-less visitors to onboarding; nothing to do.
				return;
			}
			profile = loaded;
			// Fire-and-forget: this fetches a lazy chunk (pinyin's dictionary is not
			// small), and nothing waits on it. Resolving `null` — no local romanizer
			// for this language — and resolving late are the same case as far as the
			// components are concerned: they fall back to the stored, LLM-written
			// romanization strings, so at worst the first challenge of a session
			// renders the way the whole app did before ruby existed.
			void loadRomanizer(loaded.targetLanguage).then((loadedRomanizer) => {
				romanizer = loadedRomanizer;
			});
			mock = isMockMode();
			const ready = await startSession();
			if (ready.challenges.length === 0) {
				await goto('/learn');
				return;
			}
			await playPlan(ready);
		} catch {
			await goto('/learn');
		}
	}

	/**
	 * Turns a {@link SessionPlan} into the playing phase: match-pairs filtering,
	 * queue assembly, audio warm-up.
	 */
	async function playPlan(ready: SessionPlan): Promise<void> {
		if (ready.challenges.length === 0) return;

		// Match rounds are drawn from `items`, so it has to be settled first. Every
		// word the learner has is fair game, never-reviewed ones included — that is
		// exactly the vocabulary a session exists to drill.
		items = ready.items;
		// The free rounds are spliced in here, before anything walks the session —
		// `warmSession` below is the reason: a round that only came into existence
		// mid-play could never have its tile audio pre-rendered.
		queue = interleaveMatchRounds(ready.challenges, items);
		nextIndex = 0;
		plannedLlm = ready.challenges.length;
		plannedSteps = queue.length;
		newWords = firstTimeWords(ready);

		answers = [];

		// Audio, ahead of the learner: boot the engine now rather than inside the
		// first spoken challenge, and start rendering the session's clips in play
		// order. A previous run — an early quit straight into another session —
		// is dropped first, so only this session's queue is being warmed.
		cancelWarming();
		bootSpeech();
		warmSession(queue);

		phase = 'playing';
		await advance();
	}

	/**
	 * The words in this session the learner has never been reviewed on — what the
	 * summary calls "New words".
	 *
	 * A session introduces no vocabulary; these words were added elsewhere — in
	 * conversation, or by asking the tutor — and this is simply the first time
	 * the learner is being *drilled* on them. An empty review history is the
	 * honest local test for that, and it stays true for a word added a week ago
	 * that is only now coming up.
	 */
	function firstTimeWords(ready: SessionPlan): KnowledgeItem[] {
		const exercised = new Set(ready.challenges.flatMap((challenge) => challenge.itemIds));
		return ready.items.filter(
			(item) => exercised.has(item.id) && (item.reviewCount ?? item.history.length) === 0
		);
	}

	/* ---------------------------------------------------------------------- */
	/* Audio warm-up                                                           */
	/* ---------------------------------------------------------------------- */

	/**
	 * Which warm-up run is current. Every loop captures it before it starts and
	 * re-checks it between phrases, so {@link cancelWarming} — one increment — is
	 * the whole of stopping them: a finished session, an early quit, or the
	 * screen going away leaves nothing rendering audio for a session that is over.
	 */
	let warmGeneration = 0;

	function cancelWarming(): void {
		warmGeneration++;
	}

	onDestroy(cancelWarming);

	/**
	 * Renders `texts` into the audio caches, **one at a time**.
	 *
	 * The sequencing is the entire mechanism, and it is deliberate: the sherpa
	 * worker synthesizes FIFO, so a warm loop that fired the whole session at
	 * once would put a hundred phrases in front of the one clip the learner just
	 * asked to hear. Keeping at most one warm in flight means a live `speak`
	 * waits behind a single synthesis, and `$lib/tts`'s `inflight` map does the
	 * rest — a real `speak` of a phrase this loop is already rendering joins that
	 * render instead of queueing a second one. That pair is why there is no
	 * priority queue here, and why one should not be added.
	 */
	async function warmTexts(texts: string[], generation: number): Promise<void> {
		for (const text of texts) {
			if (generation !== warmGeneration) return;
			await warmSpeech(text, targetLanguage);
		}
	}

	/**
	 * Pre-synthesizes the whole session, in the order it will be played.
	 *
	 * A clip takes Kokoro a second or two and a challenge takes the learner
	 * rather longer, so a loop that starts with the session stays comfortably
	 * ahead of it after the first challenge or two — which is the difference
	 * between audio that is simply there and audio that lands after the moment
	 * it belonged to. It sees the *whole* session because the free match rounds
	 * are spliced into the queue at plan time — improvised rounds used to be
	 * invisible here, and arrived with cold tiles. Nothing waits on it and every
	 * failure is swallowed inside `warmSpeech`; the queue is walked by value, and
	 * it never grows mid-session (a background generation lands in the *pool*, and
	 * only the next plan sees it), so there is nothing here to keep in sync.
	 */
	function warmSession(challenges: Challenge[]): void {
		const generation = warmGeneration;
		void warmTexts(
			challenges.flatMap((challenge) => audioTextsFor(challenge)),
			generation
		);
	}

	/**
	 * Starts Kokoro's worker and model load the moment a session begins.
	 *
	 * Not a new download decision — the first `speak` fetches exactly the same
	 * artifacts — just one taken off the critical path: booting lazily means the
	 * learner pays for it inside the first spoken challenge, which is the one
	 * place in the session where they are waiting on audio with nothing to read.
	 */
	function bootSpeech(): void {
		if (getTtsEngine() !== 'kokoro' || !sherpaSupports(targetLanguage)) return;
		void preloadVoice(targetLanguage).catch(() => {
			// A failed preload is not the learner's problem: `speak` falls back.
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Session flow                                                            */
	/* ---------------------------------------------------------------------- */

	/**
	 * Total steps the progress bar plans for. The queue already *is* the session,
	 * free match rounds included, so this is just its length — there is no second
	 * source of challenges left to predict.
	 */
	const totalSteps = $derived(Math.max(1, plannedSteps));
	const stepsDone = $derived(answers.length);
	/** Answered generated challenges: what `plannedLlm` is counted against. */
	const llmAnswered = $derived(
		answers.filter((answer) => STORED_TYPE_DEFS[answer.type].reviewsSrs).length
	);

	async function advance(): Promise<void> {
		feedback = null;

		// The queue is the session: when it is walked, we are done. The free rounds
		// are already in it — `interleaveMatchRounds` put them there, and that is
		// also where the "never end on filler" rule lives.
		if (nextIndex >= queue.length) {
			await finish();
			return;
		}

		show(queue[nextIndex++]);
	}

	function show(challenge: Challenge): void {
		const at = Date.now();
		challengeShownAt = at;
		currentPresentation = presentationFor(challenge, items, { romanizationMode });
		current = challenge;
		// Warm this challenge's own audio while the learner is still reading it.
		// The queue loop covers the whole session now, so it has usually got there
		// first — but not for the first challenge, which is shown the same tick the
		// loop starts, and not for a clip the audio cache has since evicted.
		// Fire-and-forget: a failed warm just means the real `speak` synthesizes as
		// it always did.
		void warmTexts(audioTextsFor(challenge), warmGeneration);
	}

	function handleAnswer(event: AnswerEvent): void {
		const challenge = current;
		if (!challenge || feedback) return;

		// The challenge's own def answers "does this feed SRS?", so the session
		// never names a type: a round that does not review carries no item ids.
		const reviewsSrs = storedDefFor(challenge).reviewsSrs;

		answers = [
			...answers,
			{
				challengeId: challenge.id,
				type: challenge.type,
				verdict: event.verdict,
				itemIds: reviewsSrs ? challenge.itemIds : []
			}
		];

		feedback = {
			challenge,
			verdict: event.verdict,
			answerGiven: event.answerGiven,
			correctAnswer: correctAnswerText(challenge),
			...(event.closestAccepted ? { closestAccepted: event.closestAccepted } : {}),
			...(event.itemVerdicts ? { itemVerdicts: event.itemVerdicts } : {}),
			...(challenge.explanation ? { explanation: challenge.explanation } : {}),
			...(currentPresentation ? { presentation: currentPresentation } : {})
		};

		// Fire-and-follow: the banner animates now, the write lands underneath it.
		// The one promise is held twice — as `pendingReviewed` for its value (the
		// items a self-assessment may re-grade) and as `pendingWrite` for its
		// completion, which is what the session awaits before touching the queue
		// again. Neither is ever dropped.
		pendingReviewed = applyResult(challenge, {
			verdict: event.verdict,
			answerGiven: event.answerGiven,
			responseMs: event.responseMs,
			...(event.itemVerdicts ? { itemVerdicts: event.itemVerdicts } : {}),
			now: Date.now()
		}).catch(() => {
			// A failed write must not eat the session; the answer is already logged.
			return new Set<string>();
		});
		pendingWrite = pendingReviewed.then(() => undefined);
	}

	/**
	 * The learner rated a correct answer Hard / Good / Easy before continuing.
	 *
	 * Explicit self-assessment is the only route to an FSRS `Easy` (see
	 * `gradeFromResult`), so this is the learner steering their own schedule
	 * rather than a guess made from response time. `amendResult` *replaces* the
	 * history entry and the core refolds the word's log from scratch, so
	 * switching between grades stays exact however often it happens.
	 *
	 * Chained onto `pendingWrite` for the usual reason: the original review must
	 * be on the card (and its history entry appended) before the amend rewrites
	 * it. `continueSession` awaits the same chain, so even a rating given as the
	 * learner reaches for Continue lands before the next challenge is pulled.
	 *
	 * The session summary is untouched: it counts verdicts, not grades — "that
	 * was hard" is not a less correct answer.
	 */
	function assessCurrent(grade: Grade): void {
		const fb = feedback;
		if (!fb) return;
		const reviewed = pendingReviewed;
		pendingWrite = pendingWrite
			.then(async () => {
				await amendResult(fb.challenge, grade, await reviewed, Date.now());
			})
			.catch(() => {
				// A failed write must not eat the session; the answer is already logged.
			});
	}

	/**
	 * The learner disputed a `wrong` grade and the explain call agreed with them
	 * (`overturn: true`). Everything the original answer cost is handed back:
	 *
	 * - **Banner**: repaints as accepted (`FeedbackBanner`'s `overturned`).
	 * - **Summary**: the logged answer flips to `correct`, so `sessionSummary`
	 *   recomputes correct/wrong and accuracy on its own.
	 * - **SRS**: `applyOverturn` writes one `Good` review per item, chained
	 *   *after* the original write so it lands on top of the `Again`.
	 *
	 * What it deliberately does **not** do: rewrite the result log. The learner
	 * really did answer this at the time, and the entry is history.
	 */
	function overturnCurrent(): void {
		const fb = feedback;
		if (!fb || fb.overturned || fb.verdict !== 'wrong') return;

		feedback = { ...fb, overturned: true };

		answers = answers.map((answer) =>
			answer.challengeId === fb.challenge.id ? { ...answer, verdict: 'correct' } : answer
		);

		// After the pending `applyResult`: the Again review must already be on the
		// card before the compensating Good review goes on top of it.
		const wrongItemIds = fb.itemVerdicts
			? new Set(
					fb.itemVerdicts.filter((item) => item.verdict === 'wrong').map((item) => item.itemId)
				)
			: undefined;
		pendingWrite = pendingWrite
			.then(() => applyOverturn(fb.challenge, Date.now(), wrongItemIds))
			.catch(() => {
				// A failed write must not eat the session; the banner already repainted.
			});
	}

	/**
	 * "Skip": an answer event like any other, with the verdict a skip
	 * honestly deserves. `wrong` counts as a miss in the summary, and
	 * `applyResult` grades the item FSRS-`Again` — which is exactly "I could not
	 * produce this". That grade lowers the word's strength, and so the ladder
	 * rung the next top-up writes it at; nothing else carries the skip forward.
	 */
	function skipCurrent(): void {
		const challenge = current;
		if (!challenge || feedback || !storedDefFor(challenge).reviewsSrs) return;
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
		pendingWrite = pendingWrite
			.then(() => reportChallenge(fb.challenge))
			.catch(() => {
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
		// Nothing left to say: the summary screen is silent, so any phrase still
		// queued for synthesis is work nobody asked for.
		cancelWarming();
		current = null;
		feedback = null;

		// The streak is derived, not bookkept: `pendingWrite` is settled above, so
		// this session's own results are already in the log being folded.
		endStreak = streakFrom((await getDailyActivity()).map((entry) => entry.day));
		phase = 'summary';
		// The session's writes are in the log; the summary is a moment nobody is
		// waiting on, so it is the natural place to push them.
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
	 * Leaves early. Everything answered is already written — results and reviews
	 * land per answer, not at the end — so there is nothing to bank.
	 *
	 * Nothing to clean up either: challenges are only stamped as served when they
	 * are answered, so everything the learner did not reach is still in the pool
	 * and simply gets planned again next time.
	 */
	async function quit(): Promise<void> {
		if (leaving) return;
		leaving = true;
		showQuitConfirm = false;
		// The rest of the session will not be played; stop rendering its audio.
		cancelWarming();
		try {
			await pendingWrite;
		} catch {
			/* leaving anyway */
		}
		await goto('/learn');
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

	/**
	 * The vocabulary the romanizer groups its tokens around, so a word the
	 * learner is studying comes back as one token keyed by its own term and can
	 * hide its reading on its own schedule.
	 */
	const vocabTerms = $derived(items.map((item) => item.term));

	/**
	 * The tokenizer handed to every challenge component, pre-bound to that
	 * vocabulary — or `null`, which is the signal to keep rendering the stored
	 * romanization strings.
	 */
	const tokenize = $derived.by(() => {
		// Captured by value, so the closure cannot outlive the check that made it.
		const ready = romanizer;
		return ready ? (text: string) => ready.tokenize(text, vocabTerms) : null;
	});

	const targetLanguage = $derived(profile?.targetLanguage ?? '');
	const nativeLanguage = $derived(profile?.nativeLanguage ?? '');
	const isLastStep = $derived(llmAnswered >= plannedLlm || stepsDone >= totalSteps);

	/** Read once — the toggle lives in Settings, not mid-session. */
	const romanizationMode = getRomanizationMode();
	/**
	 * The summary's new-word list. A word the learner has just been drilled on
	 * for the first time is by definition not one they own yet, so adaptive mode
	 * has nothing to fade out here — only an explicit Off hides these readings.
	 */
	const showNewWordReadings = romanizationMode !== 'off';
</script>

<svelte:head>
	<title>Sapling · Session</title>
</svelte:head>

<main class="shell">
	<!--
	  Setup belongs to the persistent Practice destination. This focused route
	  owns the quit ✕ during play and the explicit return on its summary, so it
	  never competes with the app shell for a way out.

	  Leaving while a top-up is generating is safe and needs no guard: the task
	  runner owns the job, its status and its cancel (see `.claude/rules/tasks.md`),
	  the pool is written when it lands, and the tray follows the learner to
	  whatever page they went to.
	-->
	{#if phase === 'loading'}
		<div class="centered"><Spinner /></div>
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

					<div class="score-hero">
						<span class="score-number">{summary.correct + summary.almost}/{summary.answered}</span>
						<span class="score-label">correct</span>
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
								{endStreak}
							</span>
							<span class="stat-label">Day streak</span>
						</div>
					</div>

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

				<a class="btn btn-primary btn-block back-btn" href="/learn">Back to Practice</a>
			</div>
		</div>
	{:else}
		<!--
		  Header, the mock banner and the stage travel together as one column —
		  see `.session` below, which is what a wide/tall viewport caps and
		  centres without touching the fixed-position banner or overlay that
		  follow it.
		-->
		<div class="session">
			<header class="topbar">
				<button type="button" class="quit" onclick={requestQuit} aria-label="Quit session">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
						><path d="m7 7 10 10M17 7 7 17" /></svg
					>
				</button>

				<div
					class="progress"
					role="progressbar"
					aria-valuenow={stepsDone}
					aria-valuemin={0}
					aria-valuemax={totalSteps}
					aria-label="Session progress"
				>
					{#each Array.from({ length: totalSteps }, (_, i) => i) as index (index)}
						<span class="segment" class:filled={index < stepsDone}></span>
					{/each}
				</div>

				<div class="topbar-spacer" aria-hidden="true"></div>
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
								presentation={currentPresentation}
								{tokenize}
							/>

							{#if storedDefFor(current).reviewsSrs && !feedback}
								<button type="button" class="btn btn-ghost skip-btn" onclick={skipCurrent}>
									Skip
								</button>
							{/if}
						</div>
					{/key}
				{:else}
					<div class="centered"><Spinner /></div>
				{/if}
			</section>
		</div>

		{#if feedback}
			<FeedbackBanner
				challenge={feedback.challenge}
				verdict={feedback.verdict}
				answerGiven={feedback.answerGiven}
				correctAnswer={feedback.correctAnswer}
				closestAccepted={feedback.closestAccepted}
				explanation={feedback.explanation}
				presentation={feedback.presentation}
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
					<p class="hint">Answers so far are saved.</p>
					<div class="quit-actions">
						<button type="button" class="btn btn-primary" onclick={() => (showQuitConfirm = false)}>
							Keep going
						</button>
						<button
							type="button"
							class="btn btn-ghost"
							onclick={() => void quit()}
							disabled={leaving}
						>
							Quit
						</button>
					</div>
				</div>
			</div>
		{/if}
	{/if}
</main>

<style>
	/*
	  Width and horizontal padding now come from the global `.shell` in
	  app.css — this scoped block only keeps what genuinely differs on this
	  route: the full viewport height, and the flex column that gives
	  `.check`'s `margin-top: auto` something stretched to pin itself against.
	*/
	.shell {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-height: 100dvh;
		padding-block: 1rem 2rem;
	}

	@media (min-width: 72rem) {
		/*
		  72rem is "broad" — a real desk, with height to spare as well as
		  width. `.session` below stops filling the viewport and centring the
		  leftover space here is what turns a challenge that used to stretch
		  the length of the window into a card sitting in the middle of it.
		  Harmless on the start/summary screens: their one child is already
		  `flex: 1` and leaves no leftover space to centre.
		*/
		.shell {
			justify-content: center;
		}
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
	   weight can never drift between the quit ✕ and the summary's sprout. */
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

	/* Session column --------------------------------------------------------- */

	/*
	  Header, the mock banner and the stage, kept in one flex column so a wide
	  viewport can cap and centre this group (see the `min-width: 72rem` rule
	  below) without touching the start or summary screens, which already
	  centre their own single child. `min-height: 0` is what lets `.stage`
	  shrink inside it instead of a flex item's default `auto` blowing past a
	  short viewport.
	*/
	.session {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		width: 100%;
		flex: 1;
		min-height: 0;
	}

	@media (min-width: 72rem) {
		/*
		  `.check`'s `margin-top: auto` only needs *some* stretched ancestor to
		  pin itself against — it does not need that ancestor to be the full
		  viewport. Letting `.session` size to its own content instead of
		  filling the screen is the other half of the `.shell` rule above: the
		  challenge card is now exactly as tall as it needs to be, centred in
		  whatever room is left.
		*/
		.session {
			flex: none;
		}
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

	/* Balances the quit control so the progress row stays optically centred. */
	.topbar-spacer {
		flex: 0 0 auto;
		min-width: 3rem;
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
	.score-hero {
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: 0.35rem;
		margin: 0.85rem 0 0;
		color: var(--primary-strong);
	}

	.score-number {
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

	.score-label {
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.score-hero + .stitch {
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

		.medal {
			animation: none;
		}

		.quit,
		.segment,
		.stage {
			transition: none;
		}
	}

	@media (max-width: 480px) {
		.stat-value {
			font-size: 1.15rem;
		}

		.stat-label {
			font-size: 0.62rem;
			letter-spacing: 0.06em;
		}

		.score-number {
			font-size: 2.6rem;
		}
	}
</style>
