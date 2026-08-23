<script lang="ts">
	import { browser } from '$app/environment';

	import { deleteItem, getAllItems, getPool, getProfile, getStats, localDay } from '$lib/db';
	import { isDue, wordStrength, type FsrsCardState } from '$lib/srs';
	import type { KnowledgeItem, Profile, Stats } from '$lib/types';
	import ProgressBar from '$lib/ui/ProgressBar.svelte';
	import { getShowRomanization } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const WEAK_PREVIEW_COUNT = 10;

	/** Read once — the toggle lives in Settings, not mid-page. */
	const showRomanization = getShowRomanization();

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let stats = $state<Stats | undefined>(undefined);
	let now = $state(Date.now());
	let showAllWeak = $state(false);
	/** Challenges in the pool — an upper bound on what a session could draw from. */
	let pooled = $state(0);
	/** Word list in edit mode: every row grows a delete button. Off by default. */
	let managing = $state(false);
	let manageError = $state('');

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getStats(), getPool()])
			.then(([loadedProfile, loadedItems, loadedStats, pool]) => {
				if (cancelled) return;
				profile = loadedProfile;
				items = loadedItems;
				stats = loadedStats;
				pooled = pool.length;
				now = Date.now();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your progress.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** `fsrsCard` is `unknown` on the domain type; a missing card means "brand new". */
	function cardState(item: KnowledgeItem): FsrsCardState | null {
		return (item.fsrsCard as FsrsCardState | null | undefined) ?? null;
	}

	const targetLanguage = $derived(profile?.targetLanguage?.trim() || 'your new language');
	/** The real language name — `targetLanguage` above carries a display fallback. */
	const speechLanguage = $derived(profile?.targetLanguage?.trim() ?? '');
	const streakDays = $derived(stats?.streakDays ?? 0);

	const dailyGoalXp = $derived(profile?.dailyGoalXp ?? 0);
	const todayXp = $derived(stats?.history.find((entry) => entry.day === localDay(now))?.xp ?? 0);
	const goalFraction = $derived(dailyGoalXp > 0 ? todayXp / dailyGoalXp : 0);
	const goalReached = $derived(dailyGoalXp > 0 && todayXp >= dailyGoalXp);

	const dueCount = $derived(
		items.filter((item) => {
			const card = cardState(item);
			return !card || isDue(card, now);
		}).length
	);

	interface WeightedItem {
		item: KnowledgeItem;
		strength: number;
	}

	const weakestFirst: WeightedItem[] = $derived(
		items
			.map((item) => {
				const card = cardState(item);
				return { item, strength: card ? wordStrength(card, now) : 0 };
			})
			.sort((a, b) => a.strength - b.strength)
	);

	const visibleWeakest = $derived(
		showAllWeak ? weakestFirst : weakestFirst.slice(0, WEAK_PREVIEW_COUNT)
	);

	/**
	 * Forgets a word for good — its meaning, its history and its SRS card.
	 *
	 * Confirmed by name, because there is no undo: the only way back is to meet
	 * the word again in a future lesson, as a brand-new item. Queued challenges
	 * that referenced it stay playable and simply grade nothing (see
	 * `applyResult`), so nothing has to be swept.
	 */
	async function removeItem(item: KnowledgeItem): Promise<void> {
		if (!confirm(`Forget "${item.term}"? Its progress and review history go with it.`)) return;
		try {
			await deleteItem(item.id);
			items = items.filter((candidate) => candidate.id !== item.id);
			manageError = '';
		} catch (cause) {
			manageError = cause instanceof Error ? cause.message : 'Could not delete that word.';
		}
	}

	/**
	 * Red below 0.5, amber below 0.85, green above — which on the `wordStrength`
	 * scale is roughly "under 5 days of stability", "under 18 days", and "mature".
	 */
	function strengthColor(strength: number): string {
		if (strength < 0.5) return 'var(--danger)';
		if (strength < 0.85) return 'var(--amber)';
		return 'var(--primary)';
	}
</script>

<svelte:head>
	<title>{profile ? `Learning ${targetLanguage}` : 'Dashboard'}</title>
</svelte:head>

<main class="shell">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<header class="topbar">
			<div>
				<p class="eyebrow">Learning</p>
				<h1>{targetLanguage}</h1>
			</div>
			<div class="topbar-actions">
				<div class="streak" class:dimmed={streakDays === 0} title="Current streak">
					<span aria-hidden="true">🔥</span>
					<span>{streakDays}</span>
				</div>
				<a class="gear" href="/settings" aria-label="Settings">⚙️</a>
			</div>
		</header>

		<section class="card goal-card">
			<div class="goal-head">
				<h2>Today's goal</h2>
				<span class="goal-figure">{todayXp} / {dailyGoalXp} XP</span>
			</div>
			<ProgressBar
				value={goalFraction}
				color={goalReached ? 'var(--primary)' : 'var(--accent)'}
				label="Daily XP goal progress"
			/>
			{#if goalReached}
				<p class="goal-note celebrate">🎉 Goal reached — nice work today!</p>
			{:else if dailyGoalXp > 0}
				<p class="goal-note">{Math.max(0, dailyGoalXp - todayXp)} XP to go.</p>
			{/if}
		</section>

		<section class="card start-card">
			<a class="btn btn-primary btn-block start-btn" href="/learn">Start session</a>
			{#if items.length === 0}
				<p class="hint centered">
					Your first session will introduce your first words in {targetLanguage}.
				</p>
			{:else if pooled === 0}
				<p class="hint centered">
					No challenges in your pool — generate a lesson to fill it back up.
				</p>
			{:else}
				<p class="hint centered">
					{dueCount === 0 ? 'No words due right now — great job staying on top of it!' : `${dueCount} word${dueCount === 1 ? '' : 's'} due for review`}
				</p>
			{/if}
		</section>

		{#if items.length > 0}
			<section class="card strength-card">
				<div class="strength-head">
					<h2>Word strength</h2>
					<div class="strength-tools">
						<span class="strength-count">{items.length} words known</span>
						<button
							type="button"
							class="btn btn-ghost manage-btn"
							onclick={() => {
								managing = !managing;
								manageError = '';
							}}
						>
							{managing ? 'Done' : 'Manage'}
						</button>
					</div>
				</div>
				<ul class="word-list">
					{#each visibleWeakest as entry (entry.item.id)}
						<li class="word-row">
							<div class="word-text">
								<span class="term-row">
									<span class="term">{entry.item.term}</span>
									<SpeakButton text={entry.item.term} lang={speechLanguage} size="sm" />
								</span>
								{#if showRomanization && entry.item.romanization}
									<span class="rom">{entry.item.romanization}</span>
								{/if}
								<span class="meaning">{entry.item.meaning}</span>
							</div>
							<div class="word-bar">
								<ProgressBar
									value={entry.strength}
									color={strengthColor(entry.strength)}
									label={`Recall strength for ${entry.item.term}`}
								/>
								{#if managing}
									<button
										type="button"
										class="forget"
										aria-label={`Forget ${entry.item.term}`}
										onclick={() => void removeItem(entry.item)}
									>
										✕
									</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
				{#if manageError}
					<p class="error manage-error" role="alert">{manageError}</p>
				{/if}
				{#if weakestFirst.length > WEAK_PREVIEW_COUNT}
					<button type="button" class="btn btn-ghost show-all" onclick={() => (showAllWeak = !showAllWeak)}>
						{showAllWeak ? 'Show fewer' : `Show all ${weakestFirst.length}`}
					</button>
				{/if}
			</section>
		{/if}
	{/if}
</main>

<style>
	.shell {
		max-width: 34rem;
		margin: 0 auto;
		padding: 2rem 1rem 4rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.eyebrow {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.7rem;
	}

	.topbar-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.streak {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.4rem 0.75rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--border);
		font-weight: 800;
	}

	.streak.dimmed {
		opacity: 0.45;
		filter: grayscale(0.6);
	}

	.gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 999px;
		background: var(--surface);
		border: 1px solid var(--border);
		font-size: 1.1rem;
		text-decoration: none;
	}

	.card {
		max-width: none;
	}

	.goal-head,
	.strength-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.goal-head h2,
	.strength-head h2 {
		margin: 0;
		font-size: 1.1rem;
	}

	.goal-figure,
	.strength-count {
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	.goal-note {
		margin: 0.6rem 0 0;
		font-size: 0.9rem;
		color: var(--text-muted);
	}

	.goal-note.celebrate {
		color: var(--primary-strong);
		font-weight: 800;
	}

	.start-card {
		text-align: center;
	}

	.start-btn {
		font-size: 1.05rem;
		padding: 1.1rem 1.5rem;
	}

	.hint.centered {
		margin: 0.85rem 0 0;
		text-align: center;
	}

	.word-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.word-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
	}

	.strength-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.manage-btn {
		padding: 0.3rem 0.65rem;
		font-size: 0.8rem;
	}

	/* The bar shares its column with the delete button in manage mode; without
	   it the flex row is a single full-width child and nothing moves. */
	.word-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.word-bar :global(.bar) {
		flex: 1;
		min-width: 0;
	}

	.forget {
		flex: 0 0 auto;
		width: 1.6rem;
		height: 1.6rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.75rem;
		line-height: 1;
		cursor: pointer;
	}

	.forget:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	.forget:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.manage-error {
		margin-top: 0.85rem;
	}

	.word-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.term-row {
		display: flex;
		align-items: center;
		gap: 0.15rem;
		min-width: 0;
	}

	.term {
		font-weight: 800;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.word-text :global(.rom) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meaning {
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.show-all {
		display: block;
		width: 100%;
		margin-top: 1rem;
	}

	.error {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	@media (max-width: 480px) {
		.word-row {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}
	}
</style>
