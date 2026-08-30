<!--
  The reading library: every text the learner has kept, and the two doors to one
  more.

  A spread, and the pairing is the usual one — the *doing* (write me one, or
  paste one in) opposite the *state* (what is already on the shelf). On a phone
  the composer comes first, because an empty shelf is the common case on the day
  someone finds this page.

  The two doors cost the same round trip and differ only in what the model is
  asked for: `generateReadingText` writes a text out of the garden, while
  `annotateReadingText` takes a text the learner brought and only annotates it —
  the sentences are cut here, locally, so what lands on the reader is exactly
  what was pasted. Both come back as a draft; this page mints the id and the
  timestamp and stores it, which is the whole reason `$lib/reading` can stay
  stateless.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';

	import { addText, getAllItems, getKnownTerms, getProfile, getTexts } from '$lib/db';
	import { newUuid } from '$lib/device';
	import { isMockMode } from '$lib/llm';
	import {
		MAX_FOCUS_WORDS,
		MAX_IMPORT_CHARS,
		MAX_TOPIC_CHARS,
		annotateReadingText,
		generateReadingText,
		splitSentences
	} from '$lib/reading';
	import { selectSessionItems } from '$lib/srs';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** Nudges, not choices — the same shape `/converse` offers over its topic box. */
	const EXAMPLE_TOPICS = ['A morning at the market', 'A letter from home', 'Something spooky'];

	/** Which composer is open. Not a mode: the two write the same kind of text. */
	type Door = 'write' | 'paste';

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let texts = $state<ReadingText[]>([]);
	let mockMode = $state(false);

	let door = $state<Door>('write');
	let topic = $state('');
	let title = $state('');
	let pasted = $state('');
	/** One flag for both doors — a page that is mid-call has nothing else to do. */
	let busy = $state(false);
	let composeError = $state('');

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
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
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

	const pastedLength = $derived(pasted.length);

	function pickDoor(next: Door) {
		door = next;
		// The other door's failure is not this one's news.
		composeError = '';
	}

	/**
	 * Everything the model may use freely: the garden, plus the words the learner
	 * has marked known.
	 *
	 * That union *is* the point of the mark. A known word needs no gloss and no
	 * card, so handing it over lets a text be written with the function words and
	 * the furniture the learner already reads, instead of only out of the couple
	 * of hundred terms the scheduler happens to be tracking.
	 */
	async function vocabularyNow(): Promise<string[]> {
		const known = await getKnownTerms();
		return [...items.map((item) => item.term), ...known];
	}

	/** Mints the id and the timestamp, stores the text, and opens it. */
	async function keep(draft: Omit<ReadingText, 'id' | 'createdAt'>) {
		const text: ReadingText = { ...draft, id: newUuid(), createdAt: Date.now() };
		await addText(text);
		await goto(`/read/${text.id}`);
	}

	/** Door one: a text written out of the learner's own words. */
	async function generate() {
		if (!profile || busy) return;
		busy = true;
		composeError = '';
		const chosen = topic.trim();

		try {
			const vocabulary = await vocabularyNow();
			// The focus list is the schedule's, so a text is a genuine review and not
			// only pleasant reading — most overdue first, capped where the prompt caps
			// it.
			const { reviewItems } = selectSessionItems(items, {
				now: Date.now(),
				maxItems: MAX_FOCUS_WORDS
			});

			const draft = await generateReadingText({
				profile,
				vocabulary,
				focus: reviewItems.map((item) => ({ term: item.term, meaning: item.meaning })),
				...(chosen ? { topic: chosen } : {})
			});

			await keep({
				title: draft.title,
				source: 'generated',
				...(chosen ? { topic: chosen } : {}),
				sentences: draft.sentences,
				glossary: draft.glossary
			});
		} catch (cause) {
			composeError = cause instanceof Error ? cause.message : 'Could not write a text just now.';
		} finally {
			busy = false;
		}
	}

	/** Door two: a text the learner brought, cut here and annotated there. */
	async function add() {
		if (!profile || busy) return;

		const sentences = splitSentences(pasted);
		if (sentences.length === 0) {
			composeError = 'There is nothing to read in that yet.';
			return;
		}

		busy = true;
		composeError = '';
		const own = title.trim();

		try {
			const vocabulary = await vocabularyNow();
			const draft = await annotateReadingText({
				profile,
				vocabulary,
				sentences,
				...(own ? { title: own } : {})
			});

			await keep({
				title: draft.title,
				source: 'imported',
				sentences: draft.sentences,
				glossary: draft.glossary
			});
		} catch (cause) {
			composeError = cause instanceof Error ? cause.message : 'Could not annotate that text.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sapling · Reading</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<div class="spread">
			<header class="topbar spread-full ll-rise">
				<a class="back" href="/" aria-label="Back to home">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
					</svg>
				</a>
				<div class="identity">
					<p class="eyebrow">Sapling</p>
					<h1>Reading</h1>
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
						No API key configured — texts come from a fixed offline sample, and a pasted one gets
						placeholder translations.
					</span>
				</p>
			{/if}

			<!-- Doing. First in source order, so the phone meets the composer before
			     a shelf that may well be empty. -->
			<section class="card compose-card ll-rise" style="animation-delay: 120ms">
				<div class="doors" role="group" aria-label="Where the text comes from">
					<button
						type="button"
						class="door"
						class:is-on={door === 'write'}
						aria-pressed={door === 'write'}
						disabled={busy}
						onclick={() => pickDoor('write')}
					>
						Write one for me
					</button>
					<button
						type="button"
						class="door"
						class:is-on={door === 'paste'}
						aria-pressed={door === 'paste'}
						disabled={busy}
						onclick={() => pickDoor('paste')}
					>
						Paste a text
					</button>
				</div>

				{#if door === 'write'}
					<label class="field">
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

					<!-- An empty garden is allowed through: the model still writes
					     something readable at the learner's level. It just has nothing of
					     theirs to build from, which is worth saying once here rather than
					     discovering in the text. -->
					<p class="hint">
						{#if items.length === 0}
							Texts get much better once there are words in your garden — this one will be written
							from scratch.
						{:else}
							Written from your {items.length} word{items.length === 1 ? '' : 's'}, around whatever
							is due.
						{/if}
					</p>
				{:else}
					<label class="field">
						<span class="label">Title</span>
						<input
							class="input"
							type="text"
							placeholder="Optional — I'll name it otherwise"
							disabled={busy}
							bind:value={title}
						/>
					</label>

					<label class="field paste-field">
						<span class="label">The text</span>
						<textarea
							class="input paste-input"
							rows="8"
							placeholder="An article, a song, a transcript…"
							maxlength={MAX_IMPORT_CHARS}
							disabled={busy}
							bind:value={pasted}></textarea>
					</label>

					<p class="counter" class:near={pastedLength > MAX_IMPORT_CHARS * 0.9}>
						{pastedLength} / {MAX_IMPORT_CHARS}
					</p>

					<button
						type="button"
						class="btn btn-primary btn-block go"
						disabled={busy || pasted.trim() === ''}
						onclick={() => void add()}
					>
						{busy ? 'Annotating…' : composeError ? 'Try again' : 'Add'}
					</button>

					<p class="hint">
						Kept word for word. Only the readings, the translations and the glossary are added.
					</p>
				{/if}

				{#if composeError}
					<p class="error" role="alert">{composeError}</p>
				{/if}
			</section>

			<!-- State: the shelf. -->
			<section class="shelf ll-rise" style="animation-delay: 180ms">
				<h2 class="shelf-head">Your texts</h2>
				{#if texts.length === 0}
					<p class="hint empty">Nothing on the shelf yet — the first text you make lands here.</p>
				{:else}
					<ul class="texts">
						{#each texts as text (text.id)}
							<li>
								<a class="text-row" href="/read/{text.id}">
									<span class="text-title">{text.title}</span>
									<span class="text-meta">
										<span class="badge badge-{text.source}">
											{text.source === 'generated' ? 'written' : 'brought'}
										</span>
										<span>{dates.format(text.createdAt)}</span>
										<span
											>{text.sentences.length} sentence{text.sentences.length === 1
												? ''
												: 's'}</span
										>
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

	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.back:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.back:focus-visible {
		outline: none;
		box-shadow: var(--ring);
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

	/* Two doors onto one shelf, so they are a segmented control rather than two
	   buttons: the choice is which composer is showing, not which feature the
	   learner is using. */
	.doors {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1.1rem;
		padding: 0.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.door {
		flex: 1 1 0;
		min-width: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.door:hover:not(:disabled):not(.is-on) {
		color: var(--text);
	}

	.door.is-on {
		border-color: var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.door:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.door:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.field:last-of-type {
		margin-bottom: 0.75rem;
	}

	.paste-input {
		min-height: 9rem;
		line-height: 1.5;
		resize: vertical;
	}

	/* Tucked under the box's right edge, where a word count belongs. */
	.counter {
		margin: -0.35rem 0 0.9rem;
		text-align: right;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.counter.near {
		color: var(--accent);
		font-weight: 700;
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

	/* Where a text came from, in one word. The two are peers — a brought text is
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

	@media (max-width: 400px) {
		.doors {
			flex-direction: column;
		}
	}
</style>
