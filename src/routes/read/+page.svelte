<!--
  The library: every text the learner has kept, as a gallery of cards, and
  four ways to one more behind four buttons in the header. The library is
  the page; adding is asked for, so each button opens a drawer under the header
  and nothing opens one by itself — not even on an empty library, whose one
  line points up at the buttons instead.

  Video and Text are free and local (`VideoImport`, `TextImport`: the core's
  `importSource` cuts, `addText` stores). Textbook reads a lesson's pages with a
  vision model as the `textbook-import` task and stores nothing until the
  learner has reviewed it (`TextbookImport`). Write one for me is a paid call run as
  the `read-generate` task, which also saves, so a text lands whether or not the
  learner stayed. Both the open drawer (`?tab=`, absent is closed) and the
  filter (`?show=`, absent is all) are the URL, independently, so Home can open
  the Text drawer and the way back lands where the learner was.
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

	import { isVideo, libraryHref, showFrom, shown, tabFrom } from './compose';
	import type { Show, Tab } from './compose';
	import MediaCard from './MediaCard.svelte';
	import TextbookImport from './TextbookImport.svelte';
	import TextImport from './TextImport.svelte';
	import VideoImport from './VideoImport.svelte';

	/** `short` is the phone's label, where three buttons share one row. */
	const TABS: readonly { id: Tab; label: string; short: string; heading: string }[] = [
		{ id: 'video', label: 'Video', short: 'Video', heading: 'Add a video' },
		{ id: 'text', label: 'Text', short: 'Text', heading: 'Add a text' },
		{ id: 'textbook', label: 'Textbook', short: 'Book', heading: 'Import a textbook lesson' },
		{ id: 'write', label: 'Write one for me', short: 'Write', heading: 'Write one for me' }
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
	const show = $derived(showFrom(page.url.searchParams.get('show')));
	const heading = $derived(TABS.find(({ id }) => id === tab)?.heading ?? '');

	const videoCount = $derived(texts.filter(isVideo).length);
	const filters = $derived<readonly { id: Show; label: string; count: number }[]>([
		{ id: 'all', label: 'All', count: texts.length },
		{ id: 'videos', label: 'Videos', count: videoCount },
		{ id: 'texts', label: 'Texts', count: texts.length - videoCount }
	]);
	const visible = $derived(shown(texts, show));

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

<main class="shell shell-full">
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
		<div class="library">
			<header class="topbar ll-rise">
				<BackLink href="/explore" label="Back to explore" />
				<div class="identity">
					<p class="eyebrow">Sapling</p>
					<h1>Media</h1>
				</div>
				<!-- Links, not buttons: the open drawer is a URL fact, and the open one
				     links back to the closed library. -->
				<nav class="adders" aria-label="Add to your media">
					{#each TABS as { id, label, short } (id)}
						<a
							class="adder"
							class:is-on={tab === id}
							href={libraryHref(tab === id ? undefined : id, show)}
							aria-expanded={tab === id}
							aria-controls="add-drawer"
							data-sveltekit-replacestate
							data-sveltekit-noscroll
							data-sveltekit-keepfocus
						>
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
								{#if id === 'video'}
									<rect x="3.4" y="6.2" width="12.4" height="11.6" rx="2" />
									<path d="m15.8 12 4.8-3.2v6.4L15.8 12z" />
								{:else if id === 'textbook'}
									<path
										d="M12 6.6c-1.8-1.3-4.4-1.9-7.4-1.8v12.6c3-.1 5.6.5 7.4 1.8 1.8-1.3 4.4-1.9 7.4-1.8V4.8c-3-.1-5.6.5-7.4 1.8z"
									/>
									<path d="M12 6.6v12.6" />
								{:else if id === 'text'}
									<path
										d="M6.4 3.6h7.6l4.6 4.6v11.4a.8.8 0 0 1-.8.8H6.4a.8.8 0 0 1-.8-.8V4.4a.8.8 0 0 1 .8-.8z"
									/>
									<path d="M13.6 3.8v4.8h4.8M8.8 12.6h6.4M8.8 16h4.4" />
								{:else}
									<path d="m14.6 5.4 4 4L8.8 19.2l-4.6.6.6-4.6z" />
									<path d="m12.8 7.2 4 4" />
								{/if}
							</svg>
							<span class="adder-long">{label}</span>
							<span class="adder-short">{short}</span>
						</a>
					{/each}
				</nav>
			</header>

			{#if mockMode}
				<p class="mock-hint">
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

			<!-- Always in the tree, only hidden: both import forms stay mounted, so
			     a half-filled form and a caption fetch in flight survive switching
			     drawers and closing them. -->
			<section
				id="add-drawer"
				class="card drawer"
				hidden={!tab}
				aria-labelledby="add-drawer-heading"
			>
				<div class="drawer-head">
					<h2 id="add-drawer-heading">{heading}</h2>
					<a
						class="drawer-close"
						href={libraryHref(undefined, show)}
						aria-label="Close"
						data-sveltekit-replacestate
						data-sveltekit-noscroll
						data-sveltekit-keepfocus
					>
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							<path d="m7 7 10 10M17 7 7 17" />
						</svg>
					</a>
				</div>

				<div class="pane pane-video" hidden={tab !== 'video'}>
					<VideoImport {busy} />
				</div>
				<div class="pane" hidden={tab !== 'text'}>
					<TextImport {busy} />
				</div>
				<div class="pane" hidden={tab !== 'textbook'}>
					<TextbookImport {profile} {items} />
				</div>

				{#if tab === 'write'}
					<div class="pane">
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
					</div>
				{/if}
			</section>

			<section class="shelf ll-rise" style="animation-delay: 120ms" aria-labelledby="shelf-head">
				<div class="shelf-bar">
					<h2 id="shelf-head" class="shelf-head">
						Your media <span class="shelf-count">{texts.length}</span>
					</h2>
					{#if texts.length > 0}
						<nav class="filters" aria-label="Show">
							{#each filters as { id, label, count } (id)}
								<a
									class="filter"
									class:is-on={show === id}
									href={libraryHref(tab, id)}
									aria-current={show === id ? 'true' : undefined}
									data-sveltekit-replacestate
									data-sveltekit-noscroll
									data-sveltekit-keepfocus
								>
									{label} <span class="filter-count">· {count}</span>
								</a>
							{/each}
						</nav>
					{/if}
				</div>

				{#if texts.length === 0}
					<p class="hint empty">
						Nothing here yet. Add a video or a text, or have one written, with the buttons above.
					</p>
				{:else if visible.length === 0}
					<p class="hint empty">
						{show === 'videos'
							? 'No videos yet — add one with Video above.'
							: 'No texts yet — add one with Text above, or have one written.'}
					</p>
				{:else}
					<ul class="grid">
						{#each visible as text (text.id)}
							<li><MediaCard {text} /></li>
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

	/* Header, drawer, shelf: one stack at every width. The gallery is what
	   spends the width, not a second column beside it. */
	.library {
		display: grid;
		gap: var(--gap);
	}

	/* On a phone the three adders are a row of their own under the title; at
	   ≥48rem they move up beside it, on the right. */
	.topbar {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.9rem 0.75rem;
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

	/* The adders ----------------------------------------------------------- */

	/* Four ways onto one shelf. Each is a toggle for its drawer, so the open
	   one is drawn pressed — inked in — and pressing it again closes it. */
	.adders {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
	}

	.adder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		min-height: 44px;
		padding: 0.55rem 0.5rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font-size: 0.85rem;
		font-weight: 700;
		line-height: 1.2;
		text-align: center;
		text-decoration: none;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.adder:hover:not(.is-on) {
		border-color: var(--text-muted);
		background: var(--surface-alt);
	}

	.adder.is-on {
		border-color: var(--text);
		background: var(--text);
		color: var(--text-inverse);
	}

	.adder:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.adder-long {
		display: none;
	}

	@media (min-width: 48rem) {
		.topbar {
			grid-template-columns: auto minmax(0, 1fr) auto;
		}

		.adders {
			grid-column: auto;
			display: flex;
		}

		.adder {
			flex-direction: row;
			gap: 0.45rem;
			padding: 0.55rem 0.95rem;
		}

		.adder-long {
			display: inline;
		}

		.adder-short {
			display: none;
		}
	}

	/* The drawer ----------------------------------------------------------- */

	/* The page's whole width, like the grid under it; what is inside keeps its
	   own measure (`.pane`). */
	.drawer {
		max-width: none;
	}

	.drawer[hidden] {
		display: none;
	}

	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin: -0.4rem -0.4rem 1rem 0;
	}

	.drawer-head h2 {
		margin: 0;
		font-size: 1.15rem;
	}

	.drawer-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 44px;
		height: 44px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.drawer-close:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.drawer-close:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* A form is not made better by a 70rem input: each pane keeps the reading
	   measure, and the Video one — two columns at ≥48rem — the facing pair's. */
	.pane {
		max-width: var(--measure);
	}

	.pane-video {
		max-width: var(--measure-broad);
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

	.shelf-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem 1rem;
		margin-bottom: 1rem;
	}

	.shelf-head {
		margin: 0;
		font-size: 1.05rem;
	}

	.shelf-count {
		margin-left: 0.2rem;
		font-family: var(--font);
		font-size: 0.85rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	/* Which of the shelf is showing: a segmented control, since it is one
	   choice of three. Links, so the filter is a URL fact the way back keeps. */
	.filters {
		display: flex;
		gap: 0.25rem;
		padding: 0.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.filter {
		flex: 1 1 auto;
		min-width: 0;
		padding: 0.45rem 0.75rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font-size: 0.82rem;
		font-weight: 700;
		line-height: 1.25;
		text-align: center;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.filter:hover:not(.is-on) {
		color: var(--text);
	}

	.filter.is-on {
		border-color: var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.filter:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.filter-count {
		font-weight: 400;
		font-variant-numeric: tabular-nums;
	}

	/* A grid of many small cards — what `.shell-full` is for. Width buys
	   columns, never a bigger card: two on a phone, three wide, four broad. */
	.grid {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem 0.75rem;
		margin: 0;
		padding: 0;
	}

	@media (min-width: 48rem) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: var(--gap);
		}
	}

	@media (min-width: 72rem) {
		.grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	.empty {
		max-width: var(--measure);
		margin: 0;
		padding: 1rem 0;
		text-wrap: balance;
	}
</style>
