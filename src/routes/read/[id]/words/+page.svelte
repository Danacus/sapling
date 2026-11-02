<!--
  The words of one text the learner does not have yet — a typed or imported
  text, a video's transcript alike — to add several at once.

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

	import { getAllItems, getKnownTerms, getProfile, getText } from '$lib/db';
	import {
		annotateSentence,
		harvestWords,
		tokenizeByTerms,
		type AnnotateContext,
		type TokenizeFn,
		type WordCandidate
	} from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import { targetTagOf } from '$lib/text';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import WordHarvest, { type HarvestGroup } from '$lib/ui/WordHarvest.svelte';

	const id = $derived(page.params.id ?? '');

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let text = $state<ReadingText | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);
	/** The last add's summary, kept here so it outlives the list emptying. */
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

	const groups = $derived<HarvestGroup[]>([
		{
			key: 'text',
			words: candidates.map((word) => ({
				id: word.id,
				term: word.term,
				reading: word.reading,
				sentence: word.sentence,
				tags: [
					...(word.count > 1 ? [`×${word.count}`] : []),
					...(word.known ? ['marked known'] : [])
				]
			}))
		}
	]);

	async function added(_ids: string[], summary: string) {
		outcome = summary;
		// Garden words now: reloading drops them from the list.
		items = await getAllItems();
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
	{:else if profile}
		<WordHarvest
			{profile}
			{groups}
			summary={`${candidates.length} word${candidates.length === 1 ? '' : 's'} you don't have yet`}
			onadded={added}
		/>
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

	.outcome {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.error {
		color: var(--danger);
		font-weight: 700;
	}
</style>
