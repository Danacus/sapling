<!--
  The Textbook drawer: a whole book — one PDF, or a photo or scan per page —
  read by a vision model into its chapters, reviewed here, and only then kept.
  Reading is the `textbook-import` task, so the form is free while the pages
  are read and the tray carries the detail; it saves nothing. The review keeps
  the book's structure — chapters, then sections: dialogues with their
  speakers, sentences, vocabulary — and lets the learner name the book, leave
  chapters out, and correct or drop a line or a word. Import is `addTextbook`,
  then the book's page.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';

	import {
		addTextbook,
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
	import {
		chapterName,
		chapterSummary,
		MAX_PAGES,
		openPages,
		pageRange,
		pagesOf,
		type Chapter
	} from '$lib/textbook';
	import type { Profile } from '$lib/types';
	import ModelPicker from '$lib/ui/ModelPicker.svelte';

	import { baseName } from './compose';
	import FileSlot from './FileSlot.svelte';

	interface Props {
		profile: Profile | undefined;
	}

	let { profile }: Props = $props();

	/** Short names for the two measured models; anything else shows its id. */
	const MODEL_NAMES: Record<string, string> = {
		'google/gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
		'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5'
	};

	const KIND_NAMES = { dialogue: 'Dialogue', sentences: 'Sentences', words: 'Words' } as const;

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

	/** The book under review: its chapters as the learner edits them. */
	let review = $state<{ name: string; failed: number[] } | undefined>(undefined);
	let chapters = $state<Chapter[]>([]);
	let included = $state<boolean[]>([]);
	/** Dropped lines and words, by "chapter/section/index". */
	let dropped = $state<Record<string, boolean>>({});
	let title = $state('');
	let adding = $state(false);

	let left = false;
	onDestroy(() => {
		left = true;
	});

	const name = $derived(files.length === 1 ? baseName(files[0].name) : files.length ? 'Pages' : '');
	const range = $derived(pageRange(from, to, pageCount));
	const tooMany = $derived(range !== undefined && range.to - range.from + 1 > MAX_PAGES);

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
		const result = outcome.result;
		error = '';
		review = { name: result.name, failed: result.failed };
		chapters = structuredClone(result.chapters);
		included = result.chapters.map(() => true);
		dropped = {};
		title = '';
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
			// The whole book, unless the learner narrows it.
			from = 1;
			to = Math.min(source.count, MAX_PAGES);
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

	function toggle(key: string) {
		dropped[key] = !dropped[key];
	}

	/** The book as it will be kept: included chapters, kept lines and words, trimmed. */
	const kept = $derived(
		chapters.flatMap((chapter, c) => {
			if (!included[c]) return [];
			const sections = chapter.sections.flatMap((section, s) => {
				const lines = section.lines
					.map((line, l) => ({ ...line, text: line.text.trim(), key: `${c}/${s}/${l}` }))
					.filter((line) => line.text && !dropped[line.key])
					.map(({ key: _key, ...line }) => line);
				const words = section.words
					.map((word, w) => ({ ...word, term: word.term.trim(), key: `${c}/${s}/w${w}` }))
					.filter((word) => word.term && !dropped[word.key])
					.map(({ key: _key, ...word }) => word);
				return lines.length || words.length ? [{ ...section, lines, words }] : [];
			});
			const titled = chapter.title?.trim();
			return sections.length
				? [{ ...chapter, ...(titled ? { title: titled } : { title: undefined }), sections }]
				: [];
		})
	);

	async function keep() {
		if (!review || adding || kept.length === 0) return;
		adding = true;
		error = '';
		try {
			const id = newUuid();
			await addTextbook({
				id,
				title: title.trim() || review.name || 'Textbook',
				...(files.length === 1 ? { fileName: files[0].name } : {}),
				chapters: kept,
				createdAt: Date.now()
			});
			review = undefined;
			files = [];
			pageCount = 0;
			if (!left) await goto(`/read/book/${id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not import that book.';
		} finally {
			adding = false;
		}
	}
</script>

{#if review}
	<label class="field title-field">
		<span class="label">The book’s title</span>
		<input
			class="input"
			type="text"
			placeholder={review.name || 'Textbook'}
			disabled={adding}
			bind:value={title}
		/>
	</label>

	<h3 class="sub">
		Chapters <span class="note">{kept.length} of {chapters.length} to keep</span>
	</h3>
	{#if review.failed.length > 0}
		<p class="hint">
			Page{review.failed.length === 1 ? '' : 's'}
			{review.failed.join(', ')} could not be read and {review.failed.length === 1 ? 'is' : 'are'}
			missing.
		</p>
	{/if}

	<ol class="chapters">
		{#each chapters as chapter, c (c)}
			<li class="chapter" class:is-off={!included[c]}>
				<details>
					<summary>
						<input
							type="checkbox"
							aria-label={`Keep ${chapterName(chapter)}`}
							disabled={adding}
							bind:checked={included[c]}
							onclick={(event) => event.stopPropagation()}
						/>
						<span class="chapter-head">
							<span class="chapter-name">{chapterName(chapter)}</span>
							<span class="chapter-meta"
								>{[pagesOf(chapter), chapterSummary(chapter)].filter(Boolean).join(' · ')}</span
							>
						</span>
					</summary>

					<label class="field chapter-title">
						<span class="label">Chapter title</span>
						<input
							class="input"
							type="text"
							placeholder={chapter.label ? `Lesson ${chapter.label}` : 'Introduction'}
							disabled={adding || !included[c]}
							bind:value={chapters[c].title}
						/>
					</label>

					{#each chapter.sections as section, s (s)}
						<section class="section">
							<p class="section-head">
								<span class="kind">{KIND_NAMES[section.kind]}</span>
								{#if section.number}<span class="number">{section.number}</span>{/if}
								{#if section.heading}<span class="heading">{section.heading}</span>{/if}
							</p>
							{#if section.lines.length > 0}
								<ul class="lines">
									{#each section.lines as line, l (l)}
										{@const key = `${c}/${s}/${l}`}
										<li class="line" class:is-off={dropped[key]}>
											{#if line.speaker}<span class="speaker">{line.speaker}</span>{/if}
											<input
												class="line-text"
												type="text"
												aria-label={`Line ${l + 1} of ${chapterName(chapter)}`}
												disabled={adding || dropped[key] || !included[c]}
												bind:value={chapters[c].sections[s].lines[l].text}
											/>
											<button
												type="button"
												class="line-toggle"
												aria-label={dropped[key] ? 'Keep this line' : 'Leave out this line'}
												disabled={adding || !included[c]}
												onclick={() => toggle(key)}
											>
												<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
													{#if dropped[key]}
														<path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" />
														<path d="M5.2 4.6v3.6h3.6" />
													{:else}
														<path d="m7 7 10 10M17 7 7 17" />
													{/if}
												</svg>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
							{#if section.words.length > 0}
								<ul class="lines">
									{#each section.words as word, w (w)}
										{@const key = `${c}/${s}/w${w}`}
										<li class="line word" class:is-off={dropped[key]}>
											<input
												class="line-text term"
												type="text"
												aria-label={`Word ${w + 1} of ${chapterName(chapter)}`}
												disabled={adding || dropped[key] || !included[c]}
												bind:value={chapters[c].sections[s].words[w].term}
											/>
											<span class="gloss"
												>{[word.notes, word.meaning].filter(Boolean).join(' · ')}</span
											>
											<button
												type="button"
												class="line-toggle"
												aria-label={dropped[key] ? 'Keep this word' : 'Leave out this word'}
												disabled={adding || !included[c]}
												onclick={() => toggle(key)}
											>
												<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
													{#if dropped[key]}
														<path d="M5.5 12a6.5 6.5 0 1 0 2-4.7" />
														<path d="M5.2 4.6v3.6h3.6" />
													{:else}
														<path d="m7 7 10 10M17 7 7 17" />
													{/if}
												</svg>
											</button>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/each}
				</details>
			</li>
		{/each}
	</ol>

	<div class="actions">
		<button
			type="button"
			class="btn btn-primary go"
			disabled={adding || kept.length === 0}
			onclick={() => void keep()}
		>
			{adding ? 'Importing…' : `Import ${kept.length} chapter${kept.length === 1 ? '' : 's'}`}
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
			<p class="hint">At most {MAX_PAGES} pages at a time.</p>
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
		{reading ? 'Reading…' : error ? 'Try again' : 'Read the book'}
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
		margin: 0;
		list-style: none;
		padding: 0;
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
	.chapters {
		margin: 0 0 1.25rem;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.5rem;
	}

	.chapter {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	.chapter.is-off .chapter-name {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.chapter summary {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 2.75rem;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		list-style: none;
	}

	.chapter summary::-webkit-details-marker {
		display: none;
	}

	.chapter summary input {
		width: 1.25rem;
		height: 1.25rem;
		flex: none;
		accent-color: var(--primary);
	}

	.chapter-head {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.chapter-name {
		font-weight: 700;
	}

	.chapter-meta {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.chapter-title {
		margin: 0.25rem 0.75rem 0.75rem;
	}

	.section {
		margin: 0 0.75rem 0.9rem;
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.5rem;
		align-items: baseline;
		margin: 0 0 0.35rem;
		font-size: 0.85rem;
	}

	.kind {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.number {
		font-weight: 700;
	}

	.heading {
		color: var(--text-muted);
	}

	.speaker {
		flex: none;
		min-width: 2rem;
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	.word .term {
		flex: 0 1 9rem;
	}

	.gloss {
		flex: 1;
		min-width: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
