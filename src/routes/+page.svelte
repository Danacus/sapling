<script lang="ts">
	import { browser } from '$app/environment';

	import {
		activityByDay,
		getAllItems,
		getAllResults,
		getPool,
		getProfile,
		streakFrom
	} from '$lib/db';
	import { hideReadingProbability } from '$lib/session/romanization';
	import { isDue, wordStrength, type FsrsCardState } from '$lib/srs';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import ProgressBar from '$lib/ui/ProgressBar.svelte';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const WEAK_PREVIEW_COUNT = 10;

	/** Read once — the setting lives in Settings, not mid-page. */
	const romanizationMode = getRomanizationMode();

	/**
	 * Whether a word in the list shows its reading. Adaptive mode deliberately
	 * does not roll a coin here: a static list has no recall to aid, and a
	 * reading that appeared and vanished between visits would read as a bug. It
	 * hides only what the learner fully owns — the same words adaptive mode
	 * always hides mid-session.
	 */
	function showsReading(strength: number): boolean {
		if (romanizationMode === 'on') return true;
		if (romanizationMode === 'off') return false;
		return hideReadingProbability(strength) < 1;
	}

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	/** The run of consecutive days with an answer in it, folded out of the log. */
	let streakDays = $state(0);
	let now = $state(Date.now());
	let showAllWeak = $state(false);
	/** Challenges in the pool — an upper bound on what a session could draw from. */
	let pooled = $state(0);

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getAllResults(), getPool()])
			.then(([loadedProfile, loadedItems, results, pool]) => {
				if (cancelled) return;
				profile = loadedProfile;
				items = loadedItems;
				streakDays = streakFrom(activityByDay(results).map((entry) => entry.day));
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
	<title>{profile ? `Sapling · ${targetLanguage}` : 'Sapling'}</title>
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
		<header class="topbar ll-rise">
			<div class="identity">
				<p class="eyebrow">Learning</p>
				<h1>{targetLanguage}</h1>
			</div>
			<div class="topbar-actions">
				<div class="streak" class:dimmed={streakDays === 0} title="Current streak">
					<svg class="ico sprout" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M12 21v-8.6" />
						<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
						<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
					</svg>
					<span>{streakDays}</span>
				</div>
				<a class="gear" href="/chat" aria-label="Assistant">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path
							d="M20.3 12.2c0 4-3.7 7.2-8.2 7.2a9.4 9.4 0 0 1-2.5-.3L4.6 20.5l1.3-3.7a6.9 6.9 0 0 1-2.2-4.6C3.7 8.2 7.4 5 11.9 5s8.4 3.2 8.4 7.2Z"
						/>
						<path d="M9 11.9h.01M12 11.9h.01M15 11.9h.01" />
					</svg>
				</a>
				<a class="gear" href="/profile" aria-label="Profile">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="8.4" r="3.4" />
						<path d="M4.9 19.6c.7-3.4 3.5-5.5 7.1-5.5s6.4 2.1 7.1 5.5" />
					</svg>
				</a>
				<a class="gear" href="/settings" aria-label="Settings">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M4 8.2h8.4M17.4 8.2H20M4 15.8h2.6M11.6 15.8H20" />
						<circle cx="15" cy="8.2" r="2.3" />
						<circle cx="9" cy="15.8" r="2.3" />
					</svg>
				</a>
			</div>
		</header>

		<section class="card start-card ll-rise" style="animation-delay: 120ms">
			<svg class="watermark" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M12 21v-8.6" />
				<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
				<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
			</svg>
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
			<section class="card strength-card ll-rise" style="animation-delay: 180ms">
				<div class="strength-head">
					<h2>Word strength</h2>
					<div class="strength-tools">
						<span class="strength-count">{items.length} words known</span>
						<a class="btn btn-ghost words-link" href="/words">All words</a>
					</div>
				</div>
				<hr class="stitch" />
				<ul class="word-list">
					{#each visibleWeakest as entry (entry.item.id)}
						<li class="word-row">
							<div class="word-text">
								<span class="term-row">
									<span class="term">{entry.item.term}</span>
									<SpeakButton text={entry.item.term} lang={speechLanguage} size="sm" />
								</span>
								{#if showsReading(entry.strength) && entry.item.romanization}
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
							</div>
						</li>
					{/each}
				</ul>
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

	/* Every icon on this screen is the same hand: 24-unit box, hairline stroke,
	   round joins. The attributes live here rather than on each <svg> so the
	   markup stays readable and the weight can never drift between icons. */
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

	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.identity {
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.1rem;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: clamp(1.75rem, 8vw, 2.3rem);
		line-height: 1.05;
		overflow-wrap: break-word;
	}

	.topbar-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		/* Optically aligned with the language name, not the eyebrow above it. */
		padding-top: 0.15rem;
	}

	/* Topbar controls are label tabs, not pills: the same 2.25rem square with a
	   hairline and a squared-off radius, so the streak count reads as one of
	   the row rather than a badge stuck onto it. */
	.streak,
	.gear {
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.streak {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0 0.6rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.sprout {
		color: var(--primary);
	}

	.streak.dimmed {
		opacity: 0.5;
		filter: grayscale(0.7);
	}

	.gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		color: var(--text-muted);
		text-decoration: none;
	}

	.gear:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.gear:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.card {
		max-width: none;
	}

	.strength-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.strength-head h2 {
		margin: 0;
		font-size: 1.15rem;
	}

	.strength-count {
		font-size: 0.82rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		color: var(--text-muted);
	}

	.strength-head + .stitch {
		margin: 0 0 1rem;
	}

	.start-card {
		position: relative;
		/* Own stacking context, so the watermark's `z-index: -1` lands behind
		   the button and above the card's own background rather than escaping
		   to the page. */
		isolation: isolate;
		overflow: hidden;
		text-align: center;
		background:
			linear-gradient(
				160deg,
				color-mix(in srgb, var(--primary-soft) 70%, var(--surface)),
				var(--surface) 62%
			),
			var(--surface);
	}

	/* The brand sprout, pressed faintly into the page behind the one button
	   that matters. Used exactly once in the app — a watermark stops being a
	   watermark the moment it repeats. */
	.watermark {
		position: absolute;
		z-index: -1;
		right: -1.4rem;
		bottom: -2rem;
		width: 9.5rem;
		height: 9.5rem;
		fill: none;
		stroke: var(--primary);
		stroke-width: 1.1;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.12;
		pointer-events: none;
	}

	.start-btn {
		font-size: 1.05rem;
		padding: 1.05rem 1.5rem;
		letter-spacing: 0.005em;
	}

	.hint.centered {
		margin: 0.9rem 0 0;
		text-align: center;
		text-wrap: balance;
	}

	/* A ruled ledger: rows separated by the same hairline the cards use, so a
	   long word list reads as a page of entries rather than floating chips. */
	.word-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.word-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0;
	}

	.word-row + .word-row {
		border-top: 1px solid var(--border);
	}

	.strength-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.words-link {
		padding: 0.28rem 0.7rem;
		border-color: var(--border);
		font-size: 0.78rem;
		/* An anchor wearing .btn arrives underlined; the control must read as a
		   button, not a link in a box. */
		text-decoration: none;
	}

	.word-bar :global(.bar) {
		min-width: 0;
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
		font-weight: 700;
		letter-spacing: -0.005em;
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
		margin-top: 0.9rem;
		border-top: 1px dashed var(--border-strong);
		border-radius: 0 0 var(--radius) var(--radius);
		font-size: 0.85rem;
	}

	.error {
		margin: 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	@media (max-width: 480px) {
		.word-row {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}
	}

	@media (max-width: 380px) {
		/* At the narrowest phone the language name needs the whole line; the
		   controls drop under it rather than squeezing the headline. */
		.topbar {
			flex-direction: column;
			align-items: stretch;
		}

		.topbar-actions {
			padding-top: 0;
		}
	}
</style>
