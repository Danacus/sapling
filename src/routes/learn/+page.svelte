<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';

	import { getProfile } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import { startSession, type SessionPlan } from '$lib/session/engine';
	import { startTask } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';
	import type { Profile } from '$lib/types';
	import { addRecentTopic, getRecentTopics } from '$lib/ui/prefs';
	import Spinner from '$lib/ui/Spinner.svelte';

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
	const CHIP_PREVIEW = 4;

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let plan = $state<SessionPlan | null>(null);
	let mock = $state(false);
	let topicInput = $state('');
	let recentTopics = $state<string[]>([]);
	let showAllChips = $state(false);

	const topUp = $derived(taskStore.latestOf('top-up'));
	const generating = $derived(topUp?.status === 'queued' || topUp?.status === 'running');
	const genError = $derived(
		topUp?.status === 'failed' ? (topUp.error ?? 'Something went wrong building your lesson.') : ''
	);
	const genSummary = $derived(topUp?.status === 'done' ? (topUp.summary ?? '') : '');

	const dueCount = $derived(plan?.dueCount ?? 0);
	const upcoming = $derived(plan?.topUp.upcoming ?? 0);
	const covered = $derived(plan?.topUp.covered ?? 0);
	const wants = $derived(plan?.topUp.wants ?? 0);
	const dueFigure = $derived(plan?.topUp.due ?? false);
	const uncovered = $derived(upcoming - covered);
	const canStart = $derived((plan?.challenges.length ?? 0) > 0);
	const hasWords = $derived((plan?.items.length ?? 0) > 0);
	const aheadOfSchedule = $derived(canStart && dueCount === 0);
	const nudgeGenerate = $derived(
		plan !== null && hasWords && (!canStart || (wants > 0 && covered * 2 <= upcoming))
	);

	const topicChips = $derived([
		...TOPIC_SUGGESTIONS,
		...(profile?.interests ?? []).slice(0, 2).map((interest) => `Chatting about ${interest}`)
	]);

	const visibleChips = $derived.by(() => {
		if (showAllChips) return topicChips;
		const head = topicChips.slice(0, CHIP_PREVIEW);
		const key = topicInput.trim().toLowerCase();
		const picked = topicChips.find((chip) => chip.toLowerCase() === key);
		return picked && !head.includes(picked) ? [...head, picked] : head;
	});

	interface NoticeAction {
		href: string;
		label: string;
	}

	const notice = $derived.by((): { body: string; actions: NoticeAction[] } | null => {
		if (plan === null) return null;
		if (!hasWords) {
			return {
				body: 'No words yet — a lesson practises words you already have.',
				actions: [
					{ href: '/converse', label: 'Have a conversation' },
					{ href: '/chat', label: 'Ask the assistant' }
				]
			};
		}

		const say = (body: string) => ({
			body: mock ? `${body} In practice mode it's instant and free.` : body,
			actions: []
		});

		if (!canStart) return say('Nothing to practise yet.');
		if (nudgeGenerate) {
			return say(
				`${uncovered} of those still ${uncovered === 1 ? 'needs' : 'need'} a challenge — a new lesson writes ${wants}.`
			);
		}
		if (aheadOfSchedule) {
			return {
				body: "Nothing due right now — this session reviews words before they're due.",
				actions: []
			};
		}
		return null;
	});

	let replannedFor = '';
	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		loading = true;
		loadError = '';

		getProfile()
			.then(async (loaded) => {
				if (cancelled || !loaded) return;
				profile = loaded;
				mock = isMockMode();
				recentTopics = getRecentTopics();
				plan = await startSession();
				if (!cancelled) loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not read your progress.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (topUp?.status !== 'done' || topUp.id === replannedFor) return;
		replannedFor = topUp.id;
		void startSession().then((next) => (plan = next));
	});

	function generate(): void {
		if (generating || !profile || !hasWords || wants === 0) return;
		const topic = topicInput.trim();
		if (topic) recentTopics = addRecentTopic(topic);
		startTask('top-up', { profile, ...(topic ? { topic } : {}) });
	}

	async function beginSession(): Promise<void> {
		if (!canStart) return;
		await goto('/learn/session');
	}
</script>

<svelte:head>
	<title>Sapling · Practice</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading"><Spinner /></div>
	{:else}
		<header class="practice-head ll-rise">
			<p class="eyebrow">Tend what is growing</p>
			<h1>Practice</h1>
			<p>Review the words that need you now, or prepare fresh challenges for later.</p>
		</header>

		<div class="practice-grid">
			<section class="card ready-card ll-rise" style="animation-delay: 70ms">
				<p class="card-kicker">Your next session</p>
				<h2>
					{#if dueCount > 0}
						{dueCount} word{dueCount === 1 ? '' : 's'} ready
					{:else if canStart}
						A session is ready
					{:else}
						Prepare your next session
					{/if}
				</h2>
				<hr class="stitch" />

				{#if loadError}
					<p class="error-message" role="alert">{loadError}</p>
				{:else}
					<div class="ledger">
						<div class="figure">
							<span class="fig-num" class:pending={covered < upcoming}>
								{covered}<span class="fig-of">/{upcoming}</span>
							</span>
							<span class="fig-label">
								{dueFigure ? 'Due' : 'Next'} word{upcoming === 1 ? '' : 's'} with fresh challenges
							</span>
						</div>
						<div class="figure">
							<span class="fig-num" class:pending={dueCount > 0}>{dueCount}</span>
							<span class="fig-label">Word{dueCount === 1 ? '' : 's'} due</span>
						</div>
					</div>
				{/if}

				<button
					type="button"
					class="btn btn-primary btn-block start-btn"
					disabled={!canStart}
					onclick={() => void beginSession()}
				>
					Start session
				</button>

				{#if notice}
					<div class="nudge">
						<p>{notice.body}</p>
						{#if notice.actions.length > 0}
							<div class="nudge-acts">
								{#each notice.actions as action (action.href)}
									<a class="btn btn-ghost nudge-btn" href={action.href}>{action.label}</a>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</section>

			<section
				class="card lesson-card ll-rise"
				class:urged={nudgeGenerate}
				style="animation-delay: 140ms"
			>
				<div class="lesson-heading">
					<span class="lesson-mark" aria-hidden="true">
						<svg class="ico" viewBox="0 0 24 24">
							<path d="M5 6.2h14v11.6H5z" />
							<path d="M8.2 9.3h7.6M8.2 12.2h5.4" />
							<path d="m15.7 15.1 1 1 2.1-2.3" />
						</svg>
					</span>
					<div>
						<p class="card-kicker">Fresh material</p>
						<h2>Write a new lesson</h2>
					</div>
					{#if generating}<span class="generation-state">Generating…</span>{/if}
				</div>
				<p class="lesson-copy">
					Create challenges from words already in your garden. Add a topic if you want a particular
					setting.
				</p>

				<label class="field topic-field">
					<span class="label">Topic <span class="optional">optional</span></span>
					<input
						class="input"
						type="text"
						bind:value={topicInput}
						placeholder="e.g. checking into a hotel"
						autocomplete="off"
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								generate();
							}
						}}
					/>
				</label>

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
						<button type="button" class="chip chip-more" onclick={() => (showAllChips = true)}>
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
					disabled={generating || !hasWords || wants === 0}
					onclick={generate}
				>
					{#if generating}
						Generating…
					{:else if !hasWords}
						Add words before writing a lesson
					{:else if wants === 0}
						Everything is covered
					{:else}
						Write {wants} new challenge{wants === 1 ? '' : 's'}
					{/if}
				</button>

				{#if genSummary}<p class="gen-summary">{genSummary}</p>{/if}
				{#if genError}
					<div class="gen-error">
						<p class="error-message" role="alert">{genError}</p>
						<button type="button" class="btn btn-ghost retry-btn" onclick={generate}
							>Try again</button
						>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</main>

<style>
	.shell {
		display: flex;
		min-height: calc(100dvh - 4rem);
		flex-direction: column;
		gap: clamp(1.5rem, 4vw, 2.5rem);
		padding-block: 2.25rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	.practice-head {
		max-width: 38rem;
	}

	.eyebrow,
	.card-kicker {
		margin: 0 0 0.2rem;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
		font-size: 0.7rem;
		font-weight: 750;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.practice-head h1 {
		margin: 0;
		font-size: clamp(2.2rem, 8vw, 3.4rem);
		line-height: 1;
	}

	.practice-head > p:last-child {
		margin: 0.75rem 0 0;
		color: var(--text-muted);
		font-size: 1.02rem;
		line-height: 1.55;
	}

	.practice-grid {
		display: grid;
		gap: var(--gap);
		align-items: start;
	}

	.ready-card,
	.lesson-card {
		max-width: none;
	}

	.ready-card h2,
	.lesson-card h2 {
		margin: 0;
		font-size: clamp(1.45rem, 6vw, 1.9rem);
	}

	.ready-card h2 + .stitch {
		margin: 0.9rem 0 1.3rem;
	}

	.ledger {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.figure {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.3rem;
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
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.025em;
		line-height: 1;
	}

	.fig-num.pending {
		color: var(--accent);
	}

	.fig-of {
		color: var(--text-muted);
		font-size: 0.55em;
		font-weight: 700;
	}

	.fig-label {
		color: var(--text-muted);
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		text-wrap: balance;
	}

	.start-btn {
		margin-top: 1.35rem;
		padding: 1.05rem 1.5rem;
		font-size: 1.05rem;
	}

	.nudge {
		margin-top: 1.15rem;
		padding: 0.6rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		font-size: 0.85rem;
	}

	.nudge p {
		margin: 0;
	}

	.nudge-acts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.7rem;
	}

	.nudge-btn {
		padding: 0.42rem 0.8rem;
		background: var(--surface);
		font-size: 0.82rem;
	}

	.lesson-card {
		transition:
			border-color 0.18s ease,
			background 0.18s ease;
	}

	.lesson-card.urged {
		border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
		background: linear-gradient(
			155deg,
			color-mix(in srgb, var(--accent-soft) 58%, var(--surface)),
			var(--surface) 48%
		);
	}

	.lesson-heading {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.lesson-mark {
		display: grid;
		place-items: center;
		width: 2.65rem;
		height: 2.65rem;
		flex: 0 0 auto;
		border-radius: var(--radius);
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.ico {
		width: 1.2rem;
		height: 1.2rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.generation-state {
		margin-left: auto;
		color: var(--primary-strong);
		font-size: 0.78rem;
		font-weight: 700;
	}

	.lesson-copy {
		margin: 1rem 0 1.2rem;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.topic-field {
		display: grid;
		gap: 0.4rem;
		margin-bottom: 0.8rem;
	}

	.optional {
		margin-left: 0.3rem;
		color: var(--text-muted);
		font-weight: 500;
		text-transform: none;
	}

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.chip {
		padding: 0.34rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.83rem;
		cursor: pointer;
	}

	.chip:hover,
	.chip.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
	}

	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.chip.selected {
		font-weight: 700;
	}

	.chip-more {
		border-style: dashed;
	}

	.recent {
		margin-top: 0.9rem;
	}

	.recent-label {
		margin: 0 0 0.45rem;
		color: var(--text-muted);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}

	.generate-btn {
		margin-top: 1.15rem;
		border-color: var(--border-strong);
	}

	.gen-summary {
		margin: 0.7rem 0 0;
		color: var(--text-muted);
		font-size: 0.88rem;
	}

	.gen-error {
		display: flex;
		align-items: flex-start;
		flex-direction: column;
		gap: 0.7rem;
		margin-top: 0.9rem;
	}

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

	.retry-btn {
		padding: 0.5rem 0.85rem;
	}

	@media (min-width: 48rem) {
		.practice-grid {
			grid-template-columns: minmax(0, 5fr) minmax(0, 4fr);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.lesson-card {
			transition: none;
		}
	}
</style>
