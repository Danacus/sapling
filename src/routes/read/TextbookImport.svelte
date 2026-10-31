<!--
  The Textbook drawer: a lesson's pages — one PDF, or a photo or scan per page —
  read by a vision model into a text and a word list, reviewed here, and only
  then kept. Reading is the `textbook-import` task, so the form is free while
  the pages are read and the tray carries the detail; it saves nothing. Import
  is this form's: `addText` for the lines, `addWords` for the ticked words —
  the one route by which vocabulary enters the collection.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';

	import { addWords } from '$lib/assistant';
	import {
		addText,
		DEFAULT_TEXTBOOK_MODEL,
		getBaseUrl,
		getTextbookModel,
		setTextbookModel,
		TEXTBOOK_MODEL_SUGGESTIONS
	} from '$lib/db';
	import { newUuid } from '$lib/device';
	import { isMockMode } from '$lib/llm';
	import { isOpenRouterEndpoint } from '$lib/llm/openrouter-auth';
	import { SETTLED, rootOf, startTask, taskOutcome } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';
	import { termKey } from '$lib/text';
	import {
		MAX_PAGES,
		openPages,
		pageRange,
		startsPicked,
		toNewWord,
		type TextbookDraft
	} from '$lib/textbook';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import ModelPicker from '$lib/ui/ModelPicker.svelte';

	import { baseName } from './compose';
	import FileSlot from './FileSlot.svelte';

	interface Props {
		profile: Profile | undefined;
		/** The learner's words: a listed word they already have starts unticked. */
		items: KnowledgeItem[];
	}

	let { profile, items }: Props = $props();

	/** Short names for the two measured models; anything else shows its id. */
	const MODEL_NAMES: Record<string, string> = {
		'google/gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
		'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5'
	};

	let files = $state<File[]>([]);
	let pageCount = $state(0);
	let opening = $state(false);
	let from = $state(1);
	let to = $state(1);
	let error = $state('');

	// Both suggestions are OpenRouter ids: another endpoint reads with the
	// learner's own model unless they name one.
	const onOpenRouter = isOpenRouterEndpoint(getBaseUrl());
	let model = $state(getTextbookModel() ?? (onOpenRouter ? DEFAULT_TEXTBOOK_MODEL : ''));
	let otherModel = $state(false);

	let review = $state<{ draft: TextbookDraft; name: string } | undefined>(undefined);
	let title = $state('');
	let picked = $state<boolean[]>([]);
	/** The lines as the learner corrects them, and which they keep. */
	let lineTexts = $state<string[]>([]);
	let kept = $state<boolean[]>([]);
	let meanings = $state<string[]>([]);
	let adding = $state(false);

	let left = false;
	onDestroy(() => {
		left = true;
	});

	const name = $derived(files.length === 1 ? baseName(files[0].name) : files.length ? 'Pages' : '');
	const range = $derived(pageRange(from, to, pageCount));
	const tooMany = $derived(range !== undefined && range.to - range.from + 1 > MAX_PAGES);
	const known = $derived(new Set(items.map((item) => termKey(item.term))));

	// Reads this form started. Records, not promises: a Retry in the tray is a
	// new record descending from ours (`tasks.md`).
	const mine = new Set<string>();
	const handled = new Set<string>();
	const reading = $derived(
		taskStore.tasks.some(
			(task) => !SETTLED.has(task.status) && mine.has(rootOf(taskStore.tasks, task.id))
		)
	);

	$effect(() => {
		const tasks = taskStore.tasks;
		for (const task of tasks) {
			if (handled.has(task.id)) continue;
			if (!mine.has(rootOf(tasks, task.id))) continue;
			mine.add(task.id);
			if (!SETTLED.has(task.status)) continue;
			handled.add(task.id);
			void landed(task.id);
		}
	});

	async function landed(id: string) {
		const outcome = await taskOutcome('textbook-import', id);
		if (!outcome || left) return;
		if (outcome.status === 'failed') error = outcome.error;
		if (outcome.status !== 'done') return;
		const { draft, name } = outcome.result;
		error = '';
		review = { draft, name };
		title = '';
		lineTexts = draft.segments.map((segment) => segment.text);
		kept = draft.segments.map(() => true);
		picked = draft.words.map((word) => startsPicked(word, known) && Boolean(word.meaning));
		meanings = draft.words.map((word) => word.meaning ?? '');
	}

	async function choose(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const chosen = [...(input.files ?? [])];
		input.value = '';
		if (chosen.length === 0) return;
		error = '';
		opening = true;
		try {
			const source = await openPages(chosen);
			source.close();
			files = chosen;
			pageCount = source.count;
			from = 1;
			// Photos are the pages the learner chose; a PDF is a book, read a lesson at a time.
			to = chosen.length > 1 ? Math.min(source.count, MAX_PAGES) : 1;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that.';
		} finally {
			opening = false;
		}
	}

	function read() {
		if (!profile || !range || tooMany || reading) return;
		error = '';
		review = undefined;
		const { id } = startTask('textbook-import', {
			profile: {
				nativeLanguage: profile.nativeLanguage,
				targetLanguage: profile.targetLanguage
			},
			files,
			from: range.from,
			to: range.to,
			...(model.trim() ? { model: model.trim() } : {}),
			name
		});
		mine.add(id);
	}

	function pickModel(id: string) {
		model = id;
		setTextbookModel(id === DEFAULT_TEXTBOOK_MODEL ? '' : id);
	}

	const wordsToAdd = $derived(
		review
			? review.draft.words.flatMap((word, i) => {
					const filed = picked[i] ? toNewWord(word, meanings[i] ?? '') : undefined;
					return filed ? [filed] : [];
				})
			: []
	);

	const linesToKeep = $derived(
		review
			? lineTexts.flatMap((text, i) => (kept[i] && text.trim() ? [{ text: text.trim() }] : []))
			: []
	);

	async function keep() {
		if (!review || adding) return;
		const { draft } = review;
		adding = true;
		error = '';
		try {
			let opened: string | undefined;
			if (linesToKeep.length > 0) {
				const text: ReadingText = {
					id: newUuid(),
					title: title.trim() || draft.title || review.name || 'Untitled',
					source: 'imported',
					segments: linesToKeep,
					createdAt: Date.now()
				};
				await addText(text);
				opened = text.id;
			}
			if (wordsToAdd.length > 0) await addWords(wordsToAdd);
			review = undefined;
			files = [];
			pageCount = 0;
			if (opened && !left) await goto(`/read/${opened}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not import that lesson.';
		} finally {
			adding = false;
		}
	}
</script>

{#if review}
	{@const draft = review.draft}
	<label class="field title-field">
		<span class="label">Title <span class="note">optional</span></span>
		<input
			class="input"
			type="text"
			placeholder={draft.title || review.name || 'Untitled'}
			disabled={adding}
			bind:value={title}
		/>
	</label>

	{#if draft.segments.length > 0}
		<h3 class="sub">
			The text <span class="note">{linesToKeep.length} of {draft.segments.length} lines</span>
		</h3>
		<ul class="lines">
			{#each draft.segments as _, i (i)}
				<li class="line" class:is-off={!kept[i]}>
					<input
						class="line-text"
						type="text"
						aria-label={`Line ${i + 1}`}
						disabled={adding || !kept[i]}
						bind:value={lineTexts[i]}
					/>
					<button
						type="button"
						class="line-toggle"
						aria-label={kept[i] ? `Leave out line ${i + 1}` : `Keep line ${i + 1}`}
						disabled={adding}
						onclick={() => {
							kept[i] = !kept[i];
						}}
					>
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							{#if kept[i]}
								<path d="m7 7 10 10M17 7 7 17" />
							{:else}
								<path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" />
								<path d="M5.2 4.6v3.6h3.6" />
							{/if}
						</svg>
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if draft.words.length > 0}
		<h3 class="sub">
			Words <span class="note">{wordsToAdd.length} of {draft.words.length} to add</span>
		</h3>
		<ul class="words">
			{#each draft.words as word, i (i)}
				{@const held = known.has(termKey(word.term))}
				<li class="word" class:is-off={!picked[i]}>
					<input
						type="checkbox"
						aria-label={`Add ${word.term}`}
						disabled={adding || !(meanings[i] ?? '').trim()}
						bind:checked={picked[i]}
					/>
					<span class="term">
						<span class="term-text">{word.term}</span>
						{#if word.reading}<span class="reading">{word.reading}</span>{/if}
						{#if word.notes}<span class="notes">{word.notes}</span>{/if}
						{#if held}<span class="notes">in your words</span>{/if}
						{#if word.proper}<span class="notes">name</span>{/if}
					</span>
					<input
						class="input meaning"
						type="text"
						aria-label={`Meaning of ${word.term}`}
						placeholder="Meaning"
						disabled={adding}
						bind:value={meanings[i]}
						oninput={() => {
							if (!(meanings[i] ?? '').trim()) picked[i] = false;
						}}
					/>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="actions">
		<button
			type="button"
			class="btn btn-primary go"
			disabled={adding || (linesToKeep.length === 0 && wordsToAdd.length === 0)}
			onclick={() => void keep()}
		>
			{adding ? 'Importing…' : 'Import'}
		</button>
		<button
			type="button"
			class="btn btn-ghost"
			disabled={adding}
			onclick={() => {
				review = undefined;
			}}
		>
			Discard
		</button>
	</div>
{:else}
	<div class="upload">
		<FileSlot
			label={files.length
				? `${name} · ${pageCount} page${pageCount === 1 ? '' : 's'}`
				: 'Upload a PDF or page images'}
			accept=".pdf,application/pdf,image/*"
			icon="upload"
			multiple
			disabled={opening || reading}
			onchange={(event) => void choose(event)}
		/>
	</div>

	{#if pageCount > 1}
		<div class="range">
			<label class="field">
				<span class="label">From page</span>
				<input
					class="input"
					type="number"
					min="1"
					max={pageCount}
					disabled={reading}
					bind:value={from}
				/>
			</label>
			<label class="field">
				<span class="label">To page</span>
				<input
					class="input"
					type="number"
					min="1"
					max={pageCount}
					disabled={reading}
					bind:value={to}
				/>
			</label>
		</div>
		{#if tooMany}
			<p class="hint">One lesson at a time: at most {MAX_PAGES} pages.</p>
		{/if}
	{/if}

	{#if !isMockMode()}
		<div class="field">
			<span class="label">Read with</span>
			<div class="chips">
				{#if onOpenRouter}
					{#each TEXTBOOK_MODEL_SUGGESTIONS as id (id)}
						<button
							type="button"
							class="chip"
							class:is-on={model === id && !otherModel}
							disabled={reading}
							onclick={() => {
								otherModel = false;
								pickModel(id);
							}}
						>
							{MODEL_NAMES[id] ?? id}
						</button>
					{/each}
				{/if}
				<button
					type="button"
					class="chip"
					class:is-on={otherModel ||
						(!TEXTBOOK_MODEL_SUGGESTIONS.includes(model) && Boolean(model))}
					disabled={reading}
					onclick={() => {
						otherModel = !otherModel;
					}}
				>
					{!TEXTBOOK_MODEL_SUGGESTIONS.includes(model) && model ? model : 'Another model'}
				</button>
			</div>
			{#if otherModel}
				<div class="other">
					<ModelPicker
						label="A model that reads images"
						baseUrl={getBaseUrl()}
						bind:value={() => model, (id) => pickModel(id)}
					/>
				</div>
			{/if}
		</div>
	{/if}

	<button
		type="button"
		class="btn btn-primary btn-block go"
		disabled={!profile || !range || tooMany || reading || opening}
		onclick={read}
	>
		{reading ? 'Reading…' : error ? 'Try again' : 'Read the pages'}
	</button>
{/if}

{#if error}
	<p class="error" role="alert">{error}</p>
{/if}

<style>
	.upload {
		margin-bottom: 0.9rem;
	}

	.range {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.range .field {
		margin-bottom: 0.9rem;
	}

	.hint {
		margin: -0.4rem 0 0.9rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.chip {
		min-height: 2.75rem;
		padding: 0.4rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
		overflow-wrap: anywhere;
	}

	.chip.is-on {
		border-color: var(--text);
		background: var(--text);
		color: var(--bg);
	}

	.chip:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.other {
		margin-top: 0.75rem;
	}

	.field {
		margin-bottom: 1rem;
	}

	.title-field {
		margin-bottom: 1rem;
	}

	.note {
		margin-left: 0.35rem;
		font-weight: 400;
		letter-spacing: 0.04em;
		text-transform: none;
		opacity: 0.8;
	}

	.sub {
		margin: 0 0 0.5rem;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.lines {
		margin: 0 0 1.25rem;
		list-style: none;
		padding: 0.25rem;
		max-height: 22rem;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.line {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	/* A line reads as text until it is being corrected. */
	.line-text {
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 1rem;
		line-height: 1.5;
	}

	.line-text:hover:not(:disabled) {
		border-color: var(--border);
	}

	.line-text:focus {
		outline: none;
		border-color: var(--primary);
		background: var(--surface);
	}

	.line.is-off .line-text {
		text-decoration: line-through;
		color: var(--text-muted);
	}

	.line-toggle {
		flex: none;
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.line-toggle:hover {
		color: var(--text);
		background: color-mix(in srgb, var(--text) 6%, transparent);
	}

	.line-toggle .ico {
		width: 1.1rem;
		height: 1.1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.words {
		margin: 0 0 1.25rem;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.5rem;
	}

	.word {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 0.35rem 0.65rem;
	}

	.word input[type='checkbox'] {
		width: 1.25rem;
		height: 1.25rem;
		accent-color: var(--primary);
	}

	.word.is-off .term {
		opacity: 0.6;
	}

	.term {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.5rem;
		min-width: 0;
	}

	.term-text {
		font-weight: 700;
		font-size: 1.05rem;
	}

	.reading,
	.notes {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.meaning {
		grid-column: 2;
	}

	.actions {
		display: flex;
		gap: 0.75rem;
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

	@media (min-width: 48rem) {
		.word {
			grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
		}

		.meaning {
			grid-column: 3;
		}
	}
</style>
