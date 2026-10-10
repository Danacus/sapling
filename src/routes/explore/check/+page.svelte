<!--
  "Check what you know": a quick way to fill the garden with the words the
  learner already recognises, by tapping them in a grid.

  Deliberately dumb. A grid is twenty words the model proposes, minus anything
  already in the library or already shown this run (`check.ts`' repeat filter,
  which never trusts the model to have done it); the only thing that steers the
  next grid is the share tapped in this one (`nextStep`). Nothing new is
  stored: a tapped word becomes an ordinary fresh card through `addWords`, at
  every Next, so stopping at any moment loses nothing already tapped and sent.

  Two modes, one screen, the same tiles. `check` (the default) adapts as it
  goes. `?mode=starter` is for a learner with nothing to recognise yet: pick a
  topic, and its dozen first words arrive already selected, to keep or untap.

  The batch fetch is not a task (`.claude/rules/tasks.md`): like the reader's
  lookup it is one short call whose answer this screen alone shows, and the
  words it adds land through the repositories the moment they are added.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { SvelteSet } from 'svelte/reactivity';

	import { addWords } from '$lib/assistant';
	import { getAllItems, getProfile } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import type { CheckStep, SuggestedWord } from '$lib/llm';
	import type { Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import { CHECK_COUNT, GRID_SIZE, STARTER_COUNT, fetchGrid, firstCheck, nextStep } from './check';
	import type { TakenWord } from './check';

	/** Nudges, not choices: the topic box takes anything. */
	const TOPICS = ['Greetings', 'Food', 'Travel', 'Family', 'Work'];

	const mode = $derived(page.url.searchParams.get('mode') === 'starter' ? 'starter' : 'check');

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let library = $state.raw<TakenWord[]>([]);
	/** How a check run opens, from the library as it was loaded (`firstCheck`). */
	let opening = $state.raw<ReturnType<typeof firstCheck>>({ step: 'start', seed: [] });
	let mockMode = $state(false);

	/** `start` is the intro (check) or the topic picker (starter). */
	let phase = $state<'start' | 'grid' | 'done'>('start');
	let topic = $state('');
	let grid = $state.raw<SuggestedWord[]>([]);
	/** Everything shown this run, oldest first: never offered again. */
	let shown = $state.raw<SuggestedWord[]>([]);
	/** Indices into `grid`. */
	const selected = new SvelteSet<number>();
	/** Indices into `grid` already sent to `addWords`: kept, and no longer untappable. */
	const sent = new SvelteSet<number>();
	let busy = $state(false);
	let error = $state('');
	let addedTotal = $state(0);

	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		Promise.all([getProfile(), getAllItems()])
			.then(([loadedProfile, items]) => {
				if (cancelled) return;
				// `undefined` means the root layout is about to redirect to onboarding.
				if (!loadedProfile) return;
				profile = loadedProfile;
				library = items.map(({ term, romanization }) => ({ term, romanization }));
				opening = firstCheck(items);
				mockMode = isMockMode();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open your words.';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	function show(words: SuggestedWord[], preselect: boolean) {
		if (words.length === 0) throw new Error('No new words came back this time. Try again.');
		grid = words;
		shown = [...shown, ...words];
		selected.clear();
		sent.clear();
		if (preselect) words.forEach((_, i) => selected.add(i));
		phase = 'grid';
	}

	/** One grid for the current mode, filtered against the library and the run. */
	async function load(step: CheckStep) {
		if (!profile) return;
		const starter = mode === 'starter';
		const words = await fetchGrid({
			args: {
				profile,
				// The level is read off the library, which this run is growing.
				wordCount: library.length,
				mode,
				...(starter ? { topic: topic.trim() } : { step })
			},
			library,
			shown,
			// Steers the run off the words the learner already has; a starter
			// grid is about its topic instead.
			seed: starter ? [] : opening.seed,
			limit: starter ? STARTER_COUNT : GRID_SIZE,
			count: starter ? STARTER_COUNT : CHECK_COUNT
		});
		show(words, starter);
	}

	/**
	 * The selected words not yet sent, through `add_words` — which skips
	 * anything already there rather than failing, so the counter reads what it
	 * actually added.
	 */
	async function commit() {
		const pending = [...selected].filter((i) => !sent.has(i)).sort((a, b) => a - b);
		const words = pending.map((i) => grid[i]).filter((word) => word !== undefined);
		if (words.length === 0) return;
		const outcome = await addWords(
			words.map(({ term, meaning, romanization }) => ({
				term,
				meaning,
				...(romanization ? { romanization } : {})
			}))
		);
		if (!outcome.ok) throw new Error(outcome.summary || 'Could not add those words.');
		const result = outcome.result as { added?: unknown[] } | null;
		addedTotal += Array.isArray(result?.added) ? result.added.length : words.length;
		for (const i of pending) sent.add(i);
		library = [...library, ...words];
	}

	/**
	 * Adds what is selected, then either finishes or fetches the next grid. A
	 * failure leaves the grid where it is: what was already sent stays sent, so
	 * pressing again only fetches.
	 */
	async function advance(finish: boolean) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await commit();
			if (finish) {
				phase = 'done';
				return;
			}
			await load(nextStep(selected.size, grid.length));
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Something went wrong. Try again.';
		} finally {
			busy = false;
		}
	}

	async function begin() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await load(opening.step);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not fetch words. Try again.';
		} finally {
			busy = false;
		}
	}

	function toggle(i: number) {
		if (busy || sent.has(i)) return;
		if (selected.has(i)) selected.delete(i);
		else selected.add(i);
	}

	const plural = (n: number) => `${n} word${n === 1 ? '' : 's'}`;
</script>

<svelte:head>
	<title>Sapling · Check what you know</title>
</svelte:head>

<main class="shell shell-broad">
	<header class="topbar ll-rise">
		<BackLink href="/explore" label="Back to explore" />
		<div class="identity">
			<p class="eyebrow">Explore</p>
			<h1>{mode === 'starter' ? 'Start with a topic' : 'Check what you know'}</h1>
		</div>
		{#if addedTotal > 0 && phase === 'grid'}
			<p class="counter" aria-live="polite">{addedTotal} added</p>
		{/if}
	</header>

	{#if loadError}
		<div class="card"><p class="error" role="alert">{loadError}</p></div>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if phase === 'done'}
		<section class="card summary ll-rise">
			<h2>{plural(addedTotal)} added</h2>
			<p>
				{addedTotal > 0
					? 'They are in your garden now and will come back when it is time to practise.'
					: 'Nothing new this time. Your garden is as you left it.'}
			</p>
			<div class="summary-actions">
				{#if addedTotal > 0}
					<a class="btn btn-primary" href="/learn">Practice now</a>
				{/if}
				<a class="btn" href="/explore">Back to Explore</a>
			</div>
		</section>
	{:else if phase === 'start'}
		{#if mockMode}
			<p class="mock-hint">
				Offline demo: the words come from a fixed list. Add an API key in
				<a href="/settings">Settings</a> for real ones.
			</p>
		{/if}
		<section class="card intro ll-rise" style="animation-delay: 80ms">
			{#if mode === 'check'}
				<p>
					Tap every word you recognise. Each tap shows its meaning, so you can untap one you got
					wrong. The words you keep join your garden, and the next set gets harder or easier with
					how many you knew.
				</p>
				<button
					type="button"
					class="btn btn-primary btn-block go"
					disabled={busy}
					onclick={() => void begin()}
				>
					{busy ? 'Fetching words…' : error ? 'Try again' : 'Start'}
				</button>
				<p class="hint switch">
					New to the language? <a href="/explore/check?mode=starter" onclick={() => (error = '')}
						>Start with a topic instead</a
					>.
				</p>
			{:else}
				<label class="field">
					<span class="label">Which topic?</span>
					<input
						class="input"
						type="text"
						placeholder="Anything: the kitchen, football, the doctor"
						disabled={busy}
						bind:value={topic}
						onkeydown={(event) => {
							if (event.key === 'Enter' && topic.trim()) void begin();
						}}
					/>
				</label>
				<div class="topics">
					{#each TOPICS as preset (preset)}
						<button
							type="button"
							class="topic-chip"
							aria-pressed={topic === preset}
							disabled={busy}
							onclick={() => (topic = preset)}
						>
							{preset}
						</button>
					{/each}
				</div>
				<button
					type="button"
					class="btn btn-primary btn-block go"
					disabled={busy || !topic.trim()}
					onclick={() => void begin()}
				>
					{busy ? 'Fetching words…' : error ? 'Try again' : 'Show words'}
				</button>
				<p class="hint switch">
					Know a few words already? <a href="/explore/check" onclick={() => (error = '')}
						>Check what you know</a
					>.
				</p>
			{/if}
			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}
		</section>
	{:else}
		<p class="lead">
			{mode === 'starter'
				? `Words for “${topic.trim()}”. Untap any you don't want.`
				: 'Tap the words you recognise.'}
		</p>
		<ul class="tiles" class:dim={busy}>
			{#each grid as word, i (i)}
				<li>
					<button
						type="button"
						class="tap tile"
						class:on={selected.has(i)}
						aria-pressed={selected.has(i)}
						disabled={busy || sent.has(i)}
						onclick={() => toggle(i)}
					>
						<span class="term">{word.term}</span>
						{#if word.romanization}
							<span class="rom">{word.romanization}</span>
						{/if}
						{#if selected.has(i)}
							<span class="meaning">{word.meaning}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>

		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		<div class="actions">
			{#if mode === 'starter'}
				<button
					type="button"
					class="btn btn-primary"
					disabled={busy}
					onclick={() => void advance(true)}
				>
					Add these
				</button>
				<button type="button" class="btn" disabled={busy} onclick={() => void advance(false)}>
					{busy ? 'Fetching words…' : 'More on this topic'}
				</button>
			{:else}
				<button
					type="button"
					class="btn btn-primary"
					disabled={busy}
					onclick={() => void advance(false)}
				>
					{busy ? 'Fetching words…' : error ? 'Try again' : 'Next'}
				</button>
				<button type="button" class="btn" disabled={busy} onclick={() => void advance(true)}>
					Done
				</button>
			{/if}
		</div>
		<p class="hint">Selected words join your garden each time you move on.</p>
	{/if}
</main>

<style>
	/* Width and the side gutter belong to the global `.shell`/`.shell-broad`
	   pair; only the vertical rhythm is this route's. */
	.shell {
		display: flex;
		flex-direction: column;
		gap: var(--gap);
		padding-block: 1.5rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 50dvh;
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.identity {
		min-width: 0;
		flex: 1;
	}

	.eyebrow {
		margin: 0;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.1;
	}

	.counter {
		margin: 0;
		padding: 0.3rem 0.7rem;
		border-radius: 999px;
		background: var(--primary-soft);
		color: var(--primary-strong);
		font-size: 0.85rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.mock-hint {
		max-width: var(--measure);
		margin: 0;
		padding: 0.6rem 0.75rem;
		border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border-strong));
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
		font-size: 0.82rem;
		line-height: 1.4;
	}

	.intro > p:first-child {
		margin: 0 0 1.1rem;
		line-height: 1.55;
	}

	.switch {
		margin-top: 0.9rem;
		text-align: center;
	}

	.topics {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.1rem;
	}

	.topic-chip {
		padding: 0.35rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
	}

	.topic-chip[aria-pressed='true'] {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.topic-chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.lead {
		max-width: var(--measure);
		margin: 0;
		color: var(--text-muted);
	}

	/* A grid of many small things: width buys columns here, never longer lines. */
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
		transition: opacity 0.15s ease;
	}

	.tiles.dim {
		opacity: 0.6;
	}

	.tile {
		display: flex;
		width: 100%;
		min-height: 4.5rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.1rem;
		padding: 0.7rem 0.6rem;
		text-align: center;
		overflow-wrap: anywhere;
	}

	.tile.on {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.tile:disabled {
		cursor: default;
	}

	.term {
		font-size: 1.1rem;
	}

	.meaning {
		margin-top: 0.2rem;
		color: var(--primary-strong);
		font-size: 0.82rem;
		font-weight: 500;
	}

	.actions,
	.summary-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.actions .btn {
		flex: 1 1 10rem;
	}

	.actions + .hint {
		margin: 0;
	}

	.summary h2 {
		margin: 0 0 0.5rem;
	}

	.summary p {
		margin: 0 0 1.2rem;
		color: var(--text-muted);
		line-height: 1.5;
	}

	.error {
		max-width: var(--measure);
		margin: 0.9rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	@media (min-width: 48rem) {
		.tiles {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}

		.actions {
			max-width: var(--measure);
		}
	}

	@media (min-width: 72rem) {
		.tiles {
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tiles {
			transition: none;
		}
	}
</style>
