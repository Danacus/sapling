<!--
  The session screen — the part of the app people actually spend time in.

  Shape of a session:
    boot decides between two paths. A leftover queue (the learner quit mid-
    session last time) offers a choice — continue it as-is, no topic prompt
    and no refill, ending gracefully whenever it runs dry; or clear it and
    fall into the topic picker. An empty queue goes straight to the topic
    picker. Either way that's: topic → refill the queue (one batched LLM
    call) → play up to 12 generated challenges, slipping a free
    locally-built match-pairs round in after every 4th → summary.

  Rules and writes live in `$lib/session/engine`; this file owns pacing, motion
  and everything the learner sees. The one invariant worth stating: a challenge
  only leaves the queue once `applyResult` has marked it done, so the pending
  write is always awaited before pulling the next one.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { fade, fly, scale } from 'svelte/transition';

	import {
		clearQueue,
		getAllItems,
		getProfile,
		getStats,
		localDay,
		queuedCount,
		takeNextChallenge
	} from '$lib/db';
	import { LlmError, isMockMode, makeMatchPairsChallenge } from '$lib/llm';
	import type { ProgressStep } from '$lib/llm';
	import {
		MATCH_PAIRS_EVERY,
		MATCH_PAIRS_XP,
		SESSION_LENGTH,
		SKIP_ANSWER,
		applyOverturn,
		applyResult,
		bankSessionXp,
		comboAfter,
		COMBO_THRESHOLD,
		runRefillIfNeeded,
		sessionSummary,
		wantsMatchRound,
		xpFor,
		type AnswerEvent,
		type SessionAnswer
	} from '$lib/session/engine';
	import { motionMs } from '$lib/session/motion';
	import type { Challenge, KnowledgeItem, Profile, Stats, Verdict } from '$lib/types';
	import {
		addRecentTopic,
		getCurrentTopic,
		getRecentTopics,
		getShowRomanization,
		setCurrentTopic
	} from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	import Cloze from './Cloze.svelte';
	import FeedbackBanner from './FeedbackBanner.svelte';
	import MatchPairs from './MatchPairs.svelte';
	import MultipleChoice from './MultipleChoice.svelte';
	import TypedTranslation from './TypedTranslation.svelte';

	/** Conversational scenarios offered on the topic screen. */
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

	type Phase = 'choice' | 'topic' | 'preparing' | 'error' | 'playing' | 'summary';

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

	let phase = $state<Phase>('topic');
	let errorMessage = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let mock = $state(false);

	/* Choice screen (leftover queue) ------------------------------------------ */
	/** Challenges left over from a previous session, as seen at boot. */
	let leftoverCount = $state(0);
	/** The topic those leftovers were generated for, if any was recorded. */
	let leftoverTopic = $state<string | undefined>(undefined);

	/* Topic screen ------------------------------------------------------------ */
	let topicInput = $state('');
	let recentTopics = $state<string[]>([]);
	/** The topic actually used to boot the session, carried across a retry. */
	let sessionTopic = $state<string | undefined>(undefined);
	/** Whether the in-flight/retryable boot should skip the refill (continue path). */
	let skipRefill = $state(false);

	const topicChips = $derived([
		...TOPIC_SUGGESTIONS,
		...(profile?.interests ?? []).slice(0, 2).map((interest) => `Chatting about ${interest}`)
	]);

	/** Every known item; the pool the free match-pairs rounds are drawn from. */
	let items = $state<KnowledgeItem[]>([]);
	let newWords = $state<KnowledgeItem[]>([]);

	let current = $state<Challenge | null>(null);
	let feedback = $state<Feedback | null>(null);
	let answers = $state<SessionAnswer[]>([]);
	let combo = $state(0);
	let bestCombo = $state(0);
	let llmAnswered = $state(0);
	let lastMatchAfter = $state(-1);
	let plannedLlm = $state(SESSION_LENGTH);

	let endStats = $state<Stats | undefined>(undefined);
	let goalNewlyReached = $state(false);
	let todayXpBefore = 0;

	let showQuitConfirm = $state(false);
	let leaving = $state(false);
	let toast = $state<{ id: number; amount: number } | null>(null);
	let toastSeq = 0;

	/** When the current challenge was first shown; used for a skip's response time. */
	let challengeShownAt = Date.now();

	/* Preparing screen -------------------------------------------------------- */

	/**
	 * One step of the refill, as reported by `runRefillIfNeeded`. `endedAt` is
	 * filled in when the *next* step starts (or when the refill finishes), which
	 * is what makes the list honest about where the seconds went — especially
	 * whether they went into the model call.
	 */
	interface PrepStep {
		label: string;
		startedAt: number;
		endedAt?: number;
	}

	let prepSteps = $state<PrepStep[]>([]);
	/** Ticks while preparing, so the running step's counter moves. */
	let prepNow = $state(Date.now());
	/** Total refill time, shown briefly once the session starts. */
	let prepTotalMs = $state<number | null>(null);

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
	 * without waiting for it, but `continueSession` awaits it before the next
	 * `takeNextChallenge`, because that is what actually removes the answered
	 * challenge from the queue.
	 */
	let pendingWrite: Promise<void> = Promise.resolve();

	/* ---------------------------------------------------------------------- */
	/* Boot                                                                    */
	/* ---------------------------------------------------------------------- */

	let booted = false;

	$effect(() => {
		if (booted || !browser) return;
		booted = true;
		void loadBootScreen();
	});

	$effect(() => {
		if (phase !== 'preparing') return;
		const timer = setInterval(() => (prepNow = Date.now()), 100);
		return () => clearInterval(timer);
	});

	/**
	 * Decides which screen greets the learner: a leftover queue offers a
	 * choice between resuming it and starting fresh; an empty one goes
	 * straight to the topic picker, which *is* the "new session" path there.
	 * Skipped straight past if there is no profile yet.
	 */
	async function loadBootScreen(): Promise<void> {
		const loaded = await getProfile();
		if (!loaded) {
			// The layout sends profile-less visitors to onboarding; nothing to do.
			return;
		}
		profile = loaded;

		const queued = await queuedCount();
		if (queued > 0) {
			leftoverCount = queued;
			leftoverTopic = getCurrentTopic();
			phase = 'choice';
		} else {
			showTopicScreen();
		}
	}

	function showTopicScreen(): void {
		recentTopics = getRecentTopics();
		topicInput = '';
		phase = 'topic';
	}

	/** "Continue session" on the choice screen: plays the existing queue as-is. */
	function continueLeftoverSession(): void {
		sessionTopic = leftoverTopic;
		skipRefill = true;
		void boot(leftoverTopic, { skipRefill: true });
	}

	/** "New session" on the choice screen: drops the leftovers, then the topic picker takes over. */
	async function startNewSession(): Promise<void> {
		await clearQueue();
		setCurrentTopic(undefined);
		showTopicScreen();
	}

	/** "Start" / Enter on the topic screen: banks the topic, then boots the session. */
	function startWithTopic(): void {
		const trimmed = topicInput.trim();
		if (trimmed) recentTopics = addRecentTopic(trimmed);
		sessionTopic = trimmed || undefined;
		skipRefill = false;
		void boot(sessionTopic, { skipRefill: false });
	}

	async function boot(topic: string | undefined, opts: { skipRefill: boolean }): Promise<void> {
		phase = 'preparing';
		errorMessage = '';
		prepSteps = [];
		prepTotalMs = null;
		const prepStartedAt = Date.now();
		prepNow = prepStartedAt;

		try {
			if (!profile) {
				const loaded = await getProfile();
				if (!loaded) {
					// The layout sends profile-less visitors to onboarding; nothing to do.
					return;
				}
				profile = loaded;
			}

			const stats = await getStats();
			todayXpBefore = stats.history.find((e) => e.day === localDay(Date.now()))?.xp ?? 0;

			if (opts.skipRefill) {
				// Continuing a leftover queue: no topic prompt, no LLM call — just
				// play what's already there. The session ends gracefully (existing
				// dry-queue path in `advance`) whenever it runs out.
				mock = isMockMode();
				items = await getAllItems();
				newWords = [];
				plannedLlm = Math.min(SESSION_LENGTH, await queuedCount());
			} else {
				const info = await runRefillIfNeeded(profile, {
					onProgress: recordPrepStep,
					...(topic ? { topic } : {})
				});
				mock = info.mock || isMockMode();
				items = info.items;
				newWords = info.newItems;
				plannedLlm = Math.min(SESSION_LENGTH, info.queuedAfter);
				setCurrentTopic(topic);

				// Close the last step and keep the total around for a few seconds, so
				// "that felt long" can be checked against a number. Never blocking.
				const finishedAt = Date.now();
				prepSteps = closeOpenStep(prepSteps, finishedAt);
				prepTotalMs = finishedAt - prepStartedAt;
				setTimeout(() => (prepTotalMs = null), 5000);
			}

			phase = 'playing';
			await advance();
		} catch (cause) {
			errorMessage =
				cause instanceof LlmError
					? cause.message
					: cause instanceof Error
						? cause.message
						: 'Something went wrong preparing your session.';
			phase = 'error';
		}
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

		if (llmAnswered >= SESSION_LENGTH) {
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

		const next = await takeNextChallenge();
		if (!next) {
			// Queue ran dry mid-session (a short batch, or a session resumed after
			// most of it was already played). End on what we have.
			await finish();
			return;
		}
		show(next);
	}

	function show(challenge: Challenge): void {
		challengeShownAt = Date.now();
		current = challenge;
	}

	function correctAnswerFor(challenge: Challenge): string {
		switch (challenge.type) {
			case 'multiple-choice':
				return challenge.options[challenge.correctIndex];
			case 'cloze':
			case 'typed-translation':
				return challenge.acceptedAnswers[0] ?? '';
			case 'match-pairs':
				return '';
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
			correctAnswer: correctAnswerFor(challenge),
			...(event.closestAccepted ? { closestAccepted: event.closestAccepted } : {}),
			...(challenge.explanation ? { explanation: challenge.explanation } : {}),
			xp
		};

		if (xp > 0) toast = { id: ++toastSeq, amount: xp };

		// Fire-and-follow: the banner animates now, the write lands underneath it.
		pendingWrite = applyResult(challenge, {
			verdict: event.verdict,
			answerGiven: event.answerGiven,
			responseMs: event.responseMs,
			now: Date.now()
		}).catch(() => {
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

	async function continueSession(): Promise<void> {
		// Drop the banner first so it slides out while the write finishes; the
		// queue read below must not happen until `markChallengeDone` has landed,
		// or `takeNextChallenge` hands back the challenge just answered.
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
	}

	function requestQuit(): void {
		if (answers.length > 0 && phase === 'playing') {
			showQuitConfirm = true;
			return;
		}
		void quit();
	}

	/** Leaves early, but banks whatever was earned — progress is never punished. */
	async function quit(): Promise<void> {
		if (leaving) return;
		leaving = true;
		showQuitConfirm = false;
		try {
			await pendingWrite;
			const summary = sessionSummary(answers);
			if (summary.xp > 0) await bankSessionXp(summary.xp);
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

	/** Words introduced this session that the learner actually met in a challenge. */
	const learnedWords = $derived.by(() => {
		const practised = new Set(answers.flatMap((a) => a.itemIds));
		const met = newWords.filter((word) => practised.has(word.id));
		return met.length > 0 ? met : newWords;
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
	const isLastStep = $derived(llmAnswered >= SESSION_LENGTH || stepsDone >= totalSteps);

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();
</script>

<svelte:head>
	<title>Session</title>
</svelte:head>

<main class="shell">
	{#if phase === 'choice'}
		<div class="centered">
			<div class="card choice-card">
				<h1>Pick up where you left off?</h1>
				<p class="hint">
					{#if leftoverTopic}
						You have {leftoverCount} challenge{leftoverCount === 1 ? '' : 's'} left from “{leftoverTopic}”.
					{:else}
						You have {leftoverCount} challenge{leftoverCount === 1 ? '' : 's'} waiting in your queue.
					{/if}
				</p>

				<button
					type="button"
					class="btn btn-primary btn-block choice-btn"
					onclick={continueLeftoverSession}
				>
					Continue session · {leftoverCount} left
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-block choice-btn"
					onclick={() => void startNewSession()}
				>
					New session
				</button>
			</div>
		</div>
	{:else if phase === 'topic'}
		<div class="centered">
			<div class="card topic-card">
				<h1>What do you want to talk about today?</h1>
				<p class="hint">Optional — pick or type a scenario and today's lesson leans into it.</p>

				<input
					class="input topic-input"
					type="text"
					bind:value={topicInput}
					placeholder="e.g. checking into a hotel…"
					autocomplete="off"
					aria-label="Session topic"
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							startWithTopic();
						}
					}}
				/>

				<div class="chip-row">
					{#each topicChips as chip (chip)}
						<button
							type="button"
							class="chip"
							class:selected={topicInput.trim().toLowerCase() === chip.toLowerCase()}
							onclick={() => (topicInput = chip)}
						>
							{chip}
						</button>
					{/each}
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

				<button type="button" class="btn btn-primary btn-block start-btn" onclick={startWithTopic}>
					{topicInput.trim() ? 'Start' : 'Skip — just review'}
				</button>
			</div>
		</div>
	{:else if phase === 'preparing'}
		<div class="centered" role="status" aria-live="polite">
			<Spinner />
			<h1 class="prep-title">Preparing your session…</h1>
			<ul class="prep-steps">
				{#each prepSteps as step, index (index)}
					{@const done = step.endedAt !== undefined}
					<li class:done>
						{#if done}
							<span class="prep-mark" aria-hidden="true">✓</span>
						{:else}
							<span class="prep-mark prep-spinner" aria-hidden="true"></span>
						{/if}
						<span class="prep-label">{step.label}</span>
						<span class="prep-secs">{stepSeconds(step)}s</span>
					</li>
				{/each}
			</ul>
		</div>
	{:else if phase === 'error'}
		<div class="centered">
			<div class="card error-card">
				<p class="error-emoji" aria-hidden="true">🧩</p>
				<h1>We couldn't build a lesson</h1>
				<p class="error-message" role="alert">{errorMessage}</p>
				<div class="error-actions">
					<button
						type="button"
						class="btn btn-primary"
						onclick={() => void boot(sessionTopic, { skipRefill })}
					>
						Retry
					</button>
					<a class="btn btn-ghost" href="/">Back</a>
				</div>
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
					<p class="lead">Your queue is empty right now — come back in a bit.</p>
				{:else}
					<p class="summary-emoji" aria-hidden="true">{accuracyPct >= 80 ? '🎉' : '💪'}</p>
					<h1>Session complete!</h1>

					<div class="xp-hero">
						<span class="xp-number">+{summary.xp}</span>
						<span class="xp-label">XP</span>
					</div>

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
							<span class="stat-value">🔥 {endStats?.streakDays ?? 0}</span>
							<span class="stat-label">Day streak</span>
						</div>
					</div>

					{#if bestCombo >= COMBO_THRESHOLD}
						<p class="combo-note">Best combo this session: {bestCombo} in a row 🔥</p>
					{/if}

					{#if goalNewlyReached}
						<p class="goal-hit">🏆 Daily goal reached — {profile?.dailyGoalXp} XP. See you tomorrow?</p>
					{/if}

					{#if learnedWords.length > 0}
						<section class="new-words">
							<h2>New words</h2>
							<ul>
								{#each learnedWords as word (word.id)}
									<li>
										<div class="word-text">
											<span class="term-row">
												<span class="term">{word.term}</span>
												<SpeakButton text={word.term} lang={targetLanguage} size="sm" />
											</span>
											{#if showRomanization && word.romanization}
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
			<button type="button" class="quit" onclick={requestQuit} aria-label="Quit session">×</button>

			<div class="progress" role="progressbar" aria-valuenow={stepsDone} aria-valuemin={0} aria-valuemax={totalSteps} aria-label="Session progress">
				{#each Array.from({ length: totalSteps }, (_, i) => i) as index (index)}
					<span class="segment" class:filled={index < stepsDone}></span>
				{/each}
			</div>

			{#if combo >= COMBO_THRESHOLD}
				<div class="combo" in:scale={{ duration: motionMs(240), start: 0.5 }} title="Answer streak">
					<span aria-hidden="true">🔥</span>
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

		{#if prepTotalMs !== null}
			<p class="prep-total" transition:fade={{ duration: motionMs(200) }}>
				Lesson ready in {(prepTotalMs / 1000).toFixed(1)}s
			</p>
		{/if}

		{#if mock}
			<p class="mock-banner">
				Practice mode — add your OpenRouter key in <a href="/settings">Settings</a> for personalized
				content.
			</p>
		{/if}

		<section class="stage" class:with-banner={feedback !== null}>
			{#if current}
				{#key current.id}
					<div
						class="challenge"
						in:fly={{ x: 40, duration: motionMs(240), delay: motionMs(80) }}
						out:fly={{ x: -40, duration: motionMs(160) }}
					>
						{#if current.type === 'multiple-choice'}
							<MultipleChoice challenge={current} onanswer={handleAnswer} {targetLanguage} />
						{:else if current.type === 'cloze'}
							<Cloze challenge={current} onanswer={handleAnswer} {targetLanguage} />
						{:else if current.type === 'typed-translation'}
							<TypedTranslation
								challenge={current}
								onanswer={handleAnswer}
								{targetLanguage}
								{nativeLanguage}
							/>
						{:else}
							<MatchPairs challenge={current} onanswer={handleAnswer} />
						{/if}

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
			/>
		{/if}

		{#if showQuitConfirm}
			<div class="overlay" transition:fade={{ duration: motionMs(150) }}>
				<div class="card quit-card" in:scale={{ duration: motionMs(200), start: 0.92 }}>
					<h2>Leave the session?</h2>
					<p class="hint">
						You've earned {summary.xp} XP so far — we'll keep it. The rest of the lesson stays in your
						queue.
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

	/* Choice (leftover queue) ------------------------------------------------- */

	.choice-card {
		text-align: center;
	}

	.choice-btn {
		margin-top: 1rem;
	}

	.choice-btn:first-of-type {
		margin-top: 1.5rem;
	}

	/* Topic ------------------------------------------------------------------ */

	.topic-card {
		text-align: center;
	}

	.topic-input {
		margin: 1.1rem 0 1rem;
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}

	.chip {
		padding: 0.4rem 0.85rem;
		border: 2px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.chip:hover {
		border-color: var(--border-strong);
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
	}

	.recent {
		margin-top: 1.1rem;
	}

	.recent-label {
		margin: 0 0 0.5rem;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.start-btn {
		margin-top: 1.5rem;
	}

	/* Preparing ------------------------------------------------------------ */

	.prep-title {
		margin: 0.5rem 0 0;
		font-size: 1.3rem;
	}

	.prep-steps {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		width: 100%;
		max-width: 20rem;
		margin: 0.25rem 0 0;
		padding: 0;
		list-style: none;
		font-size: 0.85rem;
		color: var(--text-muted);
		text-align: left;
	}

	.prep-steps li {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.prep-steps li.done {
		opacity: 0.65;
	}

	.prep-mark {
		flex: 0 0 1rem;
		font-weight: 900;
	}

	.prep-spinner {
		align-self: center;
		width: 0.7rem;
		height: 0.7rem;
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
	}

	.prep-total {
		margin: 0;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--text-muted);
		text-align: center;
	}

	/* Error ---------------------------------------------------------------- */

	.error-card {
		text-align: center;
	}

	.error-emoji {
		margin: 0 0 0.5rem;
		font-size: 2.5rem;
	}

	.error-message {
		color: var(--text-muted);
	}

	.error-actions {
		display: flex;
		justify-content: center;
		gap: 0.6rem;
	}

	/* Top bar -------------------------------------------------------------- */

	.topbar {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.quit {
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		font-size: 1.6rem;
		line-height: 1;
		cursor: pointer;
	}

	.quit:hover {
		background: var(--surface-alt);
		color: var(--text);
	}

	.quit:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.progress {
		display: flex;
		flex: 1;
		gap: 3px;
		min-width: 0;
	}

	.segment {
		flex: 1;
		height: 0.7rem;
		border-radius: 999px;
		background: var(--surface-alt);
		transition: background 0.3s ease;
	}

	.segment.filled {
		background: var(--primary);
	}

	.combo,
	.combo-spacer {
		flex: 0 0 auto;
		min-width: 3rem;
	}

	.combo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
		padding: 0.25rem 0.55rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--amber) 18%, var(--surface));
		color: var(--amber);
		font-weight: 900;
		font-size: 0.9rem;
	}

	.xp-toast {
		position: absolute;
		left: 50%;
		bottom: -0.25rem;
		padding: 0.15rem 0.55rem;
		border-radius: 999px;
		background: var(--primary);
		color: var(--text-inverse);
		font-size: 0.85rem;
		font-weight: 900;
		pointer-events: none;
		animation: ll-float-up 1.1s ease-out forwards;
	}

	/* Mock banner ---------------------------------------------------------- */

	.mock-banner {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.82rem;
		font-weight: 700;
		text-align: center;
	}

	/* Stage ---------------------------------------------------------------- */

	.stage {
		position: relative;
		display: flex;
		flex: 1;
		min-height: 0;
		padding-bottom: 1rem;
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
		font-size: 0.82rem;
		opacity: 0.75;
	}

	.skip-btn:hover {
		opacity: 1;
	}

	/* Quit confirmation ---------------------------------------------------- */

	.overlay {
		position: fixed;
		inset: 0;
		z-index: 30;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: rgb(9 12 18 / 55%);
	}

	.quit-card {
		max-width: 24rem;
		text-align: center;
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

	.summary-card {
		position: relative;
		z-index: 1;
		text-align: center;
	}

	.summary-emoji {
		margin: 0;
		font-size: 3rem;
		line-height: 1;
		animation: ll-pop 0.6s ease both;
	}

	.lead {
		color: var(--text-muted);
	}

	.xp-hero {
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: 0.4rem;
		margin: 0.75rem 0 1.5rem;
		color: var(--primary-strong);
	}

	.xp-number {
		font-size: 3rem;
		font-weight: 900;
		letter-spacing: -0.03em;
		line-height: 1;
	}

	.xp-label {
		font-size: 1.1rem;
		font-weight: 900;
		letter-spacing: 0.08em;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.75rem 0.4rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.stat-value {
		font-size: 1.25rem;
		font-weight: 900;
	}

	.stat-label {
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.combo-note {
		margin: 1rem 0 0;
		font-weight: 800;
		color: var(--amber);
	}

	.goal-hit {
		margin: 1rem 0 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius);
		background: var(--primary-soft);
		color: var(--primary-strong);
		font-weight: 800;
	}

	.new-words {
		margin-top: 1.5rem;
		text-align: left;
	}

	.new-words h2 {
		margin: 0 0 0.5rem;
		font-size: 0.78rem;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.new-words ul {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.new-words li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0.7rem;
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
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

	.new-words .term {
		font-weight: 800;
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

		.summary-emoji,
		.xp-toast {
			animation: none;
		}
	}

	@media (max-width: 480px) {
		.stat-value {
			font-size: 1.05rem;
		}

		.xp-number {
			font-size: 2.4rem;
		}
	}
</style>
