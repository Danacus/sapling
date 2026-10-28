<!--
  The library: every text the learner has kept, and three ways to one more —
  the composer (doing) opposite the shelf (state), composer first on a phone,
  where an empty shelf is the common case.

  Video and Text are free and local (`VideoImport`, `TextImport`: the core's
  `importSource` cuts, `addText` stores). Write one for me is a paid call run as
  the `read-generate` task, which also saves, so a text lands whether or not the
  learner stayed. The tab is `?tab=` so Explore and the way back can name one.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';

	import { getAllItems, getKnownTerms, getProfile, getTexts } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import { MAX_FOCUS_WORDS, MAX_TOPIC_CHARS } from '$lib/reading';
	import { selectSessionItems } from '$lib/srs';
	import { SETTLED, rootOf, startTask, taskOutcome } from '$lib/tasks';
	import type { Task } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	import { extent, tabFrom } from './compose';
	import type { Tab } from './compose';
	import TextImport from './TextImport.svelte';
	import VideoImport from './VideoImport.svelte';

	const TABS: readonly { id: Tab; label: string }[] = [
		{ id: 'video', label: 'Video' },
		{ id: 'text', label: 'Text' },
		{ id: 'write', label: 'Write one for me' }
	];

	/** Nudges, not choices — the same shape `/converse` offers over its topic box. */
	const EXAMPLE_TOPICS = ['A morning at the market', 'A letter from home', 'Something spooky'];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let texts = $state<ReadingText[]>([]);
	let mockMode = $state(false);

	const tab = $derived(tabFrom(page.url.searchParams.get('tab')));
	let topic = $state('');
	/** A text being written, read from the runner so it survives leaving and coming back. */
	const busy = $derived(taskStore.running.some((task) => task.kind === 'read-generate'));
	let composeError = $state('');

	// A finished text opens only while this page is on screen, never into
	// whatever the learner has moved on to.
	let left = false;
	onDestroy(() => {
		left = true;
	});

	/**
	 * Ids of the `read-generate` records this page started: which of the
	 * runner's records are its business. Not `$state` — only ever added to
	 * beside a change the effect below already watches.
	 */
	const mine = new Set<string>();
	/** Records already acted on, so a re-run effect never fires an outcome twice. */
	const handled = new Set<string>();
	/** One `goto` per page: two texts landing at once must not race. */
	let navigating = false;

	const dates = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getTexts()])
			.then(([loadedProfile, loadedItems, loadedTexts]) => {
				if (cancelled) return;
				// `undefined` means the root layout is about to redirect to onboarding.
				if (!loadedProfile) return;
				profile = loadedProfile;
				items = loadedItems;
				texts = loadedTexts;
				mockMode = isMockMode();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open your library.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** The garden plus legacy known marks: everything the model may use freely. */
	async function vocabularyNow(): Promise<string[]> {
		const known = await getKnownTerms();
		return [...items.map((item) => item.term), ...known];
	}

	// Outcomes are read from the runner's records, not the promise `startTask`
	// returned: a Retry in the tray is a new record with a new promise.
	$effect(() => {
		const tasks = taskStore.tasks;
		for (const task of tasks) {
			if (handled.has(task.id) || !mine.has(rootOf(tasks, task.id))) continue;
			// Adopt a retry at once, so dismissing its ancestors keeps it ours.
			mine.add(task.id);
			if (!SETTLED.has(task.status)) continue;
			handled.add(task.id);
			void react(task);
		}
	});

	async function react(task: Task): Promise<void> {
		if (task.kind !== 'read-generate') return;
		const outcome = await taskOutcome(task.kind, task.id);
		if (!outcome || left) return;
		if (outcome.status === 'failed') composeError = outcome.error;
		else if (outcome.status === 'done' && !navigating) {
			navigating = true;
			await goto(`/read/${outcome.result.id}`);
		}
	}

	async function generate() {
		if (!profile || busy) return;
		composeError = '';
		const chosen = topic.trim();

		let vocabulary: string[];
		try {
			vocabulary = await vocabularyNow();
		} catch (cause) {
			composeError = cause instanceof Error ? cause.message : 'Could not write a text just now.';
			return;
		}
		// The schedule's most overdue words, so a text is a genuine review too.
		const { reviewItems } = selectSessionItems(items, {
			now: Date.now(),
			maxItems: MAX_FOCUS_WORDS
		});

		const { id } = startTask('read-generate', {
			profile,
			vocabulary,
			focus: reviewItems.map((item) => ({ term: item.term, meaning: item.meaning })),
			wordCount: items.length,
			...(chosen ? { topic: chosen } : {})
		});
		mine.add(id);
	}
</script>

<svelte:head>
	<title>Sapling · Media</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<header class="topbar">
			<BackLink href="/explore" label="Back to explore" />
		</header>
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<div class="spread">
			<header class="topbar spread-full ll-rise">
				<BackLink href="/explore" label="Back to explore" />
				<div class="identity">
					<p class="eyebrow">Sapling</p>
					<h1>Media</h1>
				</div>
			</header>

			{#if mockMode}
				<p class="mock-hint spread-full">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.4" />
						<path d="M12 7.8v4.6" />
						<path d="M12 16.1h.01" />
					</svg>
					<span>
						No API key configured — written texts come from a fixed offline sample, and a word you
						look up gets a placeholder meaning.
					</span>
				</p>
			{/if}

			<section class="card compose-card ll-rise" style="animation-delay: 120ms">
				<nav class="tabs" aria-label="Add to your media">
					{#each TABS as { id, label } (id)}
						<a
							class="tab"
							class:is-on={tab === id}
							href="?tab={id}"
							aria-current={tab === id ? 'page' : undefined}
							data-sveltekit-replacestate
							data-sveltekit-noscroll
							data-sveltekit-keepfocus
						>
							{label}
						</a>
					{/each}
				</nav>

				<!-- Both import forms stay mounted, so a half-filled form and a caption
				     fetch in flight survive a tab switch. -->
				<div hidden={tab !== 'video'}>
					<VideoImport {busy} />
				</div>
				<div hidden={tab !== 'text'}>
					<TextImport {busy} />
				</div>

				{#if tab === 'write'}
					<label class="field tight">
						<span class="label">What about?</span>
						<input
							class="input"
							type="text"
							placeholder="Leave it blank and I'll choose"
							maxlength={MAX_TOPIC_CHARS}
							disabled={busy}
							bind:value={topic}
							onkeydown={(event) => {
								if (event.key === 'Enter') void generate();
							}}
						/>
					</label>

					<div class="examples">
						{#each EXAMPLE_TOPICS as example (example)}
							<button
								type="button"
								class="example-chip"
								disabled={busy}
								onclick={() => (topic = example)}
							>
								{example}
							</button>
						{/each}
					</div>

					<button
						type="button"
						class="btn btn-primary btn-block go"
						disabled={busy}
						onclick={() => void generate()}
					>
						{busy ? 'Writing…' : composeError ? 'Try again' : 'Generate'}
					</button>

					<p class="hint">
						{#if items.length === 0}
							Your garden is empty, so this one is written from scratch.
						{:else}
							Written from your {items.length} word{items.length === 1 ? '' : 's'}.
						{/if}
					</p>

					{#if composeError}
						<p class="error" role="alert">{composeError}</p>
					{/if}
				{/if}
			</section>

			<section class="shelf ll-rise" style="animation-delay: 180ms">
				<h2 class="shelf-head">Your media</h2>
				{#if texts.length === 0}
					<p class="hint empty">
						Nothing on the shelf yet — the first thing you import or have written lands here.
					</p>
				{:else}
					<ul class="texts">
						{#each texts as text (text.id)}
							<li>
								<a class="text-row" href="/read/{text.id}">
									<span class="text-title">{text.title}</span>
									<span class="text-meta">
										<span class="badge badge-{text.source}">
											{text.source === 'generated' ? 'written' : 'imported'}
										</span>
										<span>{dates.format(text.createdAt)}</span>
										<span>{extent(text.segments)}</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</main>

<style>
	/* Width and the side gutter belong to the global `.shell`/`.shell-broad`
	   pair; only the vertical rhythm is this route's. */
	.shell {
		padding-block: 1.5rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	/* One hand for every icon here: 24-unit box, hairline stroke, round joins. */
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
		align-items: center;
		gap: 0.75rem;
	}

	.identity {
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.05rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.1;
	}

	/* A pencilled-in note in the margin, not a banner — same as `/converse`. */
	.mock-hint {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border-strong));
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
		color: var(--text);
		font-size: 0.82rem;
		line-height: 1.4;
	}

	.mock-hint .ico {
		width: 1.05rem;
		height: 1.05rem;
		margin-top: 0.06rem;
		color: var(--accent);
	}

	/* The composer ------------------------------------------------------- */

	/* Three ways onto one shelf: a segmented control, since the choice is which
	   form is showing. Links, so the tab is a URL fact a deep link can name. */
	.tabs {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1.1rem;
		padding: 0.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.tab {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font-size: 0.85rem;
		font-weight: 700;
		line-height: 1.25;
		text-align: center;
		text-decoration: none;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.tab:hover:not(.is-on) {
		color: var(--text);
	}

	.tab.is-on {
		border-color: var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.tab:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.field.tight {
		margin-bottom: 0.75rem;
	}

	.examples {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.1rem;
	}

	.example-chip {
		padding: 0.35rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.example-chip:hover:not(:disabled) {
		border-color: var(--text-muted);
		color: var(--text);
	}

	.example-chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.go {
		padding: 0.85rem 1.4rem;
	}

	.error {
		margin: 0.9rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	/* The shelf ----------------------------------------------------------- */

	.shelf-head {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}

	/* Not a card: a run of rows reads as a list of things, and a card around it
	   would claim the shelf is one object. */
	.texts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.text-row {
		display: block;
		padding: 0.85rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.text-row:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.text-row:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.text-title {
		display: block;
		font-family: var(--font-display);
		font-size: 1.02rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.text-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
		margin-top: 0.3rem;
		font-size: 0.78rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	/* Where a text came from, in one word. The two are peers — an imported text is
	   not a lesser one — so they differ in hue, not in weight. */
	.badge {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.badge-generated {
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.badge-imported {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.empty {
		margin: 0;
		padding: 1rem 0;
		text-wrap: balance;
	}
</style>
