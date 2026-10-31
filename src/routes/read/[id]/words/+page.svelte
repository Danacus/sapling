<!--
  The words of one text the learner does not have yet — a typed or imported
  text, a textbook lesson, a video's transcript alike — to add several at once.

  The list is the reader's own: every segment through `annotateSentence` with
  the same tokenizer and the same garden, then `harvestWords` — so a word here
  is a word there, and its reading is the romanizer's (`$lib/romanize`), never a
  model's. Nothing is ticked for the learner. Meanings are a button's paid call
  (`glossWords`, each word with its sentence) and land in editable fields;
  "Add" files the ticked words that have one through `addWords` — the one route
  by which vocabulary enters the collection — and they leave the list, because
  they are garden words now.
-->
<script lang="ts">
	import { page } from '$app/state';

	import { addWords, type NewWord } from '$lib/assistant';
	import { getAllItems, getKnownTerms, getProfile, getText } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import {
		annotateSentence,
		glossWords,
		harvestWords,
		tokenizeByTerms,
		type AnnotateContext,
		type TokenizeFn,
		type WordCandidate
	} from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import { targetTagOf, termKey } from '$lib/text';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const id = $derived(page.params.id ?? '');

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let text = $state<ReadingText | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);

	/** Ticked words and typed or found meanings, by candidate id. */
	let picked = $state<Record<string, boolean>>({});
	let meanings = $state<Record<string, string>>({});
	let finding = $state(false);
	let adding = $state(false);
	let error = $state('');
	let outcome = $state('');

	$effect(() => {
		const textId = id;
		let cancelled = false;
		loading = true;
		Promise.all([getProfile(), getText(textId), getAllItems(), getKnownTerms()])
			.then(([loadedProfile, loadedText, loadedItems, known]) => {
				if (cancelled || !loadedProfile) return;
				profile = loadedProfile;
				text = loadedText;
				items = loadedItems;
				knownTerms = known;
				loading = false;
				if (!loadedText || !hasLocalRomanizer(targetTagOf(loadedProfile))) return;
				// The reader's lazy romanizer: words first, then their real readings.
				void loadRomanizer(targetTagOf(loadedProfile))
					.then((romanizer) => {
						if (!cancelled && romanizer) {
							tokenize = (source, terms) => romanizer.tokenize(source, terms);
						}
					})
					.catch(() => undefined);
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open that text.';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	// 'on': every reading, whatever the learner shows while reading — this is
	// what a word is filed with, not what the page hides.
	const ctx = $derived<AnnotateContext>({ items, knownTerms, mode: 'on', rolls: new Map() });
	const candidates = $derived<WordCandidate[]>(
		text
			? harvestWords(
					text.segments.map((segment) => ({
						text: segment.text,
						words: annotateSentence(segment.text, tokenize, ctx)
					}))
				)
			: []
	);

	const tickedCount = $derived(candidates.filter((word) => picked[word.id]).length);
	const needMeaning = $derived(
		candidates.filter((word) => picked[word.id] && !(meanings[word.id] ?? '').trim())
	);
	const toFile = $derived<NewWord[]>(
		candidates.flatMap((word) => {
			const meaning = (meanings[word.id] ?? '').trim();
			if (!picked[word.id] || !meaning) return [];
			return [
				{ term: word.term, meaning, ...(word.reading ? { romanization: word.reading } : {}) }
			];
		})
	);

	function tickAll(on: boolean) {
		picked = Object.fromEntries(candidates.map((word) => [word.id, on]));
	}

	async function findMeanings() {
		if (!profile || finding || needMeaning.length === 0) return;
		const asked = needMeaning;
		finding = true;
		error = '';
		try {
			const glossed = await glossWords({
				profile: {
					nativeLanguage: profile.nativeLanguage,
					targetLanguage: profile.targetLanguage
				},
				words: asked.map((word) => ({ term: word.term, sentence: word.sentence }))
			});
			const byTerm = new Map(glossed.map((gloss) => [termKey(gloss.term), gloss.meaning]));
			const filled = { ...meanings };
			for (const word of asked) {
				const meaning = byTerm.get(termKey(word.term));
				if (meaning && !(filled[word.id] ?? '').trim()) filled[word.id] = meaning;
			}
			meanings = filled;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not find those meanings.';
		} finally {
			finding = false;
		}
	}

	async function add() {
		if (adding || toFile.length === 0) return;
		adding = true;
		error = '';
		outcome = '';
		try {
			const result = await addWords(toFile);
			outcome = result.summary;
			// Garden words now: reloading drops them from the list.
			items = await getAllItems();
			picked = {};
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not add those words.';
		} finally {
			adding = false;
		}
	}
</script>

<main class="shell shell-wide">
	<header class="topbar ll-rise">
		<BackLink href={`/read/${id}`} label="Back to the text" />
		<div class="identity">
			<p class="eyebrow">Words</p>
			<h1>{text?.title ?? 'Words in this text'}</h1>
		</div>
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if !text}
		<p class="empty">That text is not in your library.</p>
	{:else if candidates.length === 0}
		<p class="empty">Every word in this text is already in your garden.</p>
		{#if outcome}<p class="outcome" aria-live="polite">{outcome}</p>{/if}
	{:else}
		<div class="bar">
			<p class="count">
				{candidates.length} word{candidates.length === 1 ? '' : 's'} you don't have yet{#if tickedCount}
					· {tickedCount} ticked{/if}
			</p>
			<div class="bar-actions">
				<button
					type="button"
					class="btn btn-ghost"
					disabled={adding}
					onclick={() => tickAll(tickedCount === 0)}
				>
					{tickedCount === 0 ? 'Tick all' : 'Untick all'}
				</button>
				<button
					type="button"
					class="btn"
					disabled={finding || adding || needMeaning.length === 0}
					onclick={() => void findMeanings()}
				>
					{finding ? 'Finding meanings…' : 'Find meanings'}
				</button>
				<button
					type="button"
					class="btn btn-primary"
					disabled={adding || toFile.length === 0}
					onclick={() => void add()}
				>
					{adding ? 'Adding…' : `Add ${toFile.length} word${toFile.length === 1 ? '' : 's'}`}
				</button>
			</div>
			{#if error}
				<p class="error" role="alert">{error}</p>
			{:else if outcome}
				<p class="outcome" aria-live="polite">{outcome}</p>
			{:else if needMeaning.length > 0 && !finding}
				<p class="hint">
					{needMeaning.length} ticked word{needMeaning.length === 1 ? ' needs' : 's need'} a meaning:
					type it, or find {needMeaning.length === 1 ? 'it' : 'them'}{isMockMode()
						? ' (offline sample meanings)'
						: ''}.
				</p>
			{/if}
		</div>

		<ul class="words">
			{#each candidates as word (word.id)}
				<li class="word" class:is-on={picked[word.id]}>
					<label class="pick">
						<input type="checkbox" disabled={adding} bind:checked={picked[word.id]} />
						<span class="term">
							<span class="term-text">{word.term}</span>
							{#if word.reading}<span class="reading">{word.reading}</span>{/if}
							{#if word.count > 1}<span class="tag">×{word.count}</span>{/if}
							{#if word.known}<span class="tag">marked known</span>{/if}
						</span>
					</label>
					<input
						class="input meaning"
						type="text"
						placeholder="Meaning"
						aria-label={`Meaning of ${word.term}`}
						disabled={adding}
						bind:value={meanings[word.id]}
						oninput={() => {
							if ((meanings[word.id] ?? '').trim()) picked[word.id] = true;
						}}
					/>
					<p class="sentence">{word.sentence}</p>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	.shell {
		padding-block: var(--gutter) 6rem;
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
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

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	.empty {
		color: var(--text-muted);
	}

	/* The actions stay in reach down a long list: a video's transcript can hold hundreds. */
	.bar {
		position: sticky;
		top: 0;
		z-index: 2;
		margin: 0 calc(-1 * var(--gutter)) 0.75rem;
		padding: 0.75rem var(--gutter);
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}

	.count {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.hint,
	.outcome {
		margin: 0.6rem 0 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.outcome {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.error {
		margin: 0.6rem 0 0;
		padding: 0.55rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.words {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.25rem;
	}

	.word {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.35rem;
		padding: 0.6rem 0.25rem;
		border-bottom: 1px solid var(--border);
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-height: 2.75rem;
		cursor: pointer;
	}

	.pick input {
		width: 1.25rem;
		height: 1.25rem;
		flex: none;
		accent-color: var(--primary);
	}

	.term {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.5rem;
		min-width: 0;
	}

	.term-text {
		font-size: 1.15rem;
		font-weight: 700;
	}

	.reading,
	.tag {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.sentence {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (min-width: 48rem) {
		.word {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
			column-gap: 1rem;
		}

		.sentence {
			grid-column: 1 / -1;
		}
	}
</style>
