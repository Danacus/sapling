<!--
  One chapter of a textbook, in the structure the book prints it in: its
  sections in order, each drawn as what it is — a dialogue as speakers and
  their lines, standalone sentences as a list, a vocabulary list as a table of
  the book's words, notes and meanings. Not the reader: no pages of prose, no
  grading, nothing marked as read.

  Every word in a line is tappable and opens a small card: its reading, the
  learner's own meaning when it is in their garden, otherwise the book's
  meaning or a lookup, and "Add to my words" (`addWords`, the one way in). The
  readings are the app's own (`$lib/romanize`, never stored): each line is
  tokenized with the chapter's vocabulary as terms, so a listed word stays one
  word, and a listed word's reading is the one it has where the chapter uses it.
-->
<script lang="ts">
	import { page } from '$app/state';

	import { addWords } from '$lib/assistant';
	import { getAllItems, getKnownTerms, getProfile, getTextbook } from '$lib/db';
	import { getRomanizationMode } from '$lib/prefs';
	import {
		annotateSentence,
		glossWords,
		lookUpWord,
		tokenizeByTerms,
		wordKey,
		type AnnotateContext,
		type ReadingWord,
		type TokenizeFn
	} from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import { targetTagOf } from '$lib/text';
	import {
		chapterName,
		chapterTerms,
		pagesOf,
		toNewWord,
		type Textbook,
		type TextbookWord
	} from '$lib/textbook';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const id = $derived(page.params.id ?? '');
	const index = $derived(Math.max(0, Number.parseInt(page.params.chapter ?? '1', 10) - 1));

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let book = $state<Textbook | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);
	const mode = getRomanizationMode();

	$effect(() => {
		const bookId = id;
		let cancelled = false;
		loading = true;
		Promise.all([getProfile(), getTextbook(bookId), getAllItems(), getKnownTerms()])
			.then(([loadedProfile, loadedBook, loadedItems, known]) => {
				if (cancelled || !loadedProfile) return;
				profile = loadedProfile;
				book = loadedBook;
				items = loadedItems;
				knownTerms = known;
				loading = false;
				if (!hasLocalRomanizer(targetTagOf(loadedProfile))) return;
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
				loadError = cause instanceof Error ? cause.message : 'Could not open that book.';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const chapter = $derived(book?.chapters[index]);
	const lang = $derived(profile ? targetTagOf(profile) : undefined);
	const vocabulary = $derived(chapter ? chapterTerms(chapter) : []);
	/** The chapter's own words kept whole when a line is cut into words. */
	const withVocabulary = $derived<TokenizeFn>((text, terms) =>
		tokenize(text, [...(terms ?? []), ...vocabulary])
	);

	/** One roll map per chapter open, as the reader keeps one per text. */
	let rolls = new Map();
	$effect(() => {
		void index;
		rolls = new Map();
	});
	const ctx = $derived<AnnotateContext>({ items, knownTerms, mode, rolls });

	/** Every line of the chapter as words, by section and line. */
	const annotated = $derived(
		chapter
			? chapter.sections.map((section) =>
					section.lines.map((line) => annotateSentence(line.text, withVocabulary, ctx))
				)
			: []
	);

	/**
	 * Each word's reading where the chapter first uses it — every reading, 'on'
	 * whatever the learner shows, since this is what a word is filed with and
	 * what the vocabulary table prints.
	 */
	const readings = $derived.by(() => {
		const found = new Map<string, string>();
		if (!chapter) return found;
		const on: AnnotateContext = { items, knownTerms, mode: 'on', rolls: new Map() };
		for (const section of chapter.sections) {
			for (const line of section.lines) {
				for (const word of annotateSentence(line.text, withVocabulary, on)) {
					if (word.key && word.reading && !found.has(word.key)) found.set(word.key, word.reading);
				}
			}
		}
		return found;
	});

	/** The chapter's vocabulary entries by spelling: the book's meaning for a tapped word. */
	const listed = $derived(
		new Map(
			(chapter?.sections ?? []).flatMap((section) =>
				section.words.map((word) => [wordKey(word.term), word] as const)
			)
		)
	);

	/** Garden spellings: a listed word in here needs no Add. */
	const garden = $derived(new Set(items.map((item) => wordKey(item.term))));

	/* ---- The word card ----------------------------------------------------- */

	interface Picked {
		term: string;
		reading: string | null;
		sentence: string;
		tracked?: { meaning: string; reading?: string };
		notes?: string;
	}

	let picked = $state<Picked | undefined>(undefined);
	let meaning = $state('');
	let explanation = $state('');
	let looking = $state(false);
	let adding = $state(false);
	let cardError = $state('');
	let addedNote = $state('');

	function pick(word: ReadingWord, sentence: string) {
		if (!word.key) return;
		const entry = listed.get(word.key);
		picked = {
			term: word.text,
			reading: readings.get(word.key) ?? word.reading,
			sentence,
			...(word.gloss
				? {
						tracked: {
							meaning: word.gloss.meaning,
							...(word.gloss.reading ? { reading: word.gloss.reading } : {})
						}
					}
				: {}),
			...(entry?.notes ? { notes: entry.notes } : {})
		};
		meaning = entry?.meaning ?? '';
		explanation = '';
		cardError = '';
		addedNote = '';
	}

	function pickListed(word: TextbookWord) {
		const key = wordKey(word.term);
		const item = items.find((candidate) => wordKey(candidate.term) === key);
		picked = {
			term: word.term,
			reading: readings.get(key) ?? null,
			sentence: sentenceWith(word.term) ?? word.term,
			...(item
				? {
						tracked: {
							meaning: item.meaning,
							...(item.romanization ? { reading: item.romanization } : {})
						}
					}
				: {}),
			...(word.notes ? { notes: word.notes } : {})
		};
		meaning = meaningOf(word);
		explanation = '';
		cardError = '';
		addedNote = '';
	}

	/** The first line of the chapter that uses `term`: what a lookup reads it in. */
	function sentenceWith(term: string): string | undefined {
		return chapter?.sections.flatMap((s) => s.lines).find((line) => line.text.includes(term))?.text;
	}

	async function lookUp() {
		if (!picked || !profile || looking) return;
		const asked = picked;
		looking = true;
		cardError = '';
		try {
			const gloss = await lookUpWord({
				profile: {
					nativeLanguage: profile.nativeLanguage,
					targetLanguage: profile.targetLanguage
				},
				wordCount: items.length,
				term: asked.term,
				sentence: asked.sentence,
				...(book ? { title: book.title } : {})
			});
			if (picked !== asked) return;
			if (!meaning.trim()) meaning = gloss.meaning;
			explanation = gloss.explanation ?? '';
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not look that up.';
		} finally {
			looking = false;
		}
	}

	async function file(words: { word: Pick<TextbookWord, 'term' | 'notes'>; meaning: string }[]) {
		const filed = words.flatMap(({ word, meaning }) => {
			const entry = toNewWord(word, meaning, readings.get(wordKey(word.term)));
			return entry ? [entry] : [];
		});
		if (filed.length === 0) return '';
		const outcome = await addWords(filed);
		items = await getAllItems();
		return outcome.summary;
	}

	async function addPicked() {
		if (!picked || adding || !meaning.trim()) return;
		adding = true;
		cardError = '';
		try {
			addedNote = await file([
				{ word: { term: picked.term, notes: picked.notes }, meaning: meaning }
			]);
			picked = undefined;
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not add that word.';
		} finally {
			adding = false;
		}
	}

	/**
	 * Meanings found for listed words the book prints none for, by spelling.
	 * Kept for this open only: the book's own list is not rewritten.
	 */
	let found = $state<Record<string, string>>({});
	let finding = $state<number | undefined>(undefined);

	/** A listed word's meaning: the book's, else one found this open. */
	function meaningOf(word: TextbookWord): string {
		return word.meaning ?? found[wordKey(word.term)] ?? '';
	}

	/** The words of a list Add all would file: not names, not held, with a meaning. */
	function addableIn(s: number): TextbookWord[] {
		return (chapter?.sections[s].words ?? []).filter(
			(word) => !word.proper && meaningOf(word) && !garden.has(wordKey(word.term))
		);
	}

	function bareIn(s: number): TextbookWord[] {
		return (chapter?.sections[s].words ?? []).filter(
			(word) => !word.proper && !meaningOf(word) && !garden.has(wordKey(word.term))
		);
	}

	/** One gloss call for a list's words without a meaning, each with its sentence. */
	async function findMeanings(s: number) {
		if (!profile || finding !== undefined) return;
		const bare = bareIn(s);
		if (bare.length === 0) return;
		finding = s;
		try {
			const glossed = await glossWords({
				profile: {
					nativeLanguage: profile.nativeLanguage,
					targetLanguage: profile.targetLanguage
				},
				words: bare.map((word) => {
					const sentence = sentenceWith(word.term);
					return { term: word.term, ...(sentence ? { sentence } : {}) };
				})
			});
			const next = { ...found };
			for (const gloss of glossed) next[wordKey(gloss.term)] = gloss.meaning;
			found = next;
		} catch (cause) {
			addedNote = cause instanceof Error ? cause.message : 'Could not find those meanings.';
		} finally {
			finding = undefined;
		}
	}

	let addingAll = $state<number | undefined>(undefined);
	async function addSection(s: number) {
		if (!chapter || addingAll !== undefined) return;
		addingAll = s;
		try {
			const words = addableIn(s);
			addedNote = await file(words.map((word) => ({ word, meaning: meaningOf(word) })));
		} catch (cause) {
			addedNote = cause instanceof Error ? cause.message : 'Could not add those words.';
		} finally {
			addingAll = undefined;
		}
	}

	const prev = $derived(index > 0 ? index : undefined);
	const next = $derived(book && index + 1 < book.chapters.length ? index + 2 : undefined);
</script>

{#snippet line(words: ReadingWord[], sentence: string)}<span class="line-text"
		>{#each words as word, w (w)}{#if word.key}<button
					type="button"
					class="word"
					class:tracked={word.status === 'tracked'}
					class:open={picked?.term === word.text && picked.sentence === sentence}
					onclick={() => pick(word, sentence)}
					>{#if word.reading}<ruby>{word.text}<rt>{word.reading}</rt></ruby
						>{:else}{word.text}{/if}</button
				>{:else}{word.text}{/if}{/each}</span
	>{/snippet}

<main class="shell shell-wide">
	<header class="topbar ll-rise">
		<BackLink href={`/read/book/${id}`} label="Back to the book" />
		<div class="identity">
			<p class="eyebrow">{book?.title ?? 'Textbook'}</p>
			<h1>{chapter ? chapterName(chapter) : 'Chapter'}</h1>
		</div>
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if !book || !chapter}
		<p class="empty">That chapter is not in your library.</p>
	{:else}
		{#if pagesOf(chapter)}<p class="pages">{pagesOf(chapter)}</p>{/if}
		{#if addedNote}<p class="added" aria-live="polite">{addedNote}</p>{/if}

		{#each chapter.sections as section, s (s)}
			<section class="section" class:words-section={section.kind === 'words'}>
				{#if section.number || section.heading}
					<h2 class="section-head">
						{#if section.number}<span class="number">{section.number}</span>{/if}
						{#if section.heading}<span>{section.heading}</span>{/if}
					</h2>
				{/if}

				{#if section.kind === 'dialogue'}
					<ol class="dialogue">
						{#each section.lines as entry, l (l)}
							<li class="turn">
								<span class="speaker">{entry.speaker ?? ''}</span>
								<span class="said">{@render line(annotated[s][l], entry.text)}</span>
								<SpeakButton text={entry.text} {lang} size="sm" />
							</li>
						{/each}
					</ol>
				{:else if section.kind === 'sentences'}
					<ol class="sentences">
						{#each section.lines as entry, l (l)}
							<li class="sentence">
								<span class="said">{@render line(annotated[s][l], entry.text)}</span>
								<SpeakButton text={entry.text} {lang} size="sm" />
							</li>
						{/each}
					</ol>
				{:else}
					{@const addable = addableIn(s)}
					{@const bare = bareIn(s)}
					<table class="vocabulary">
						<tbody>
							{#each section.words as word, w (w)}
								{@const key = wordKey(word.term)}
								{@const reading = readings.get(key)}
								<tr class:held={garden.has(key)}>
									<th scope="row">
										<button type="button" class="term" onclick={() => pickListed(word)}>
											{#if reading}<ruby>{word.term}<rt>{reading}</rt></ruby>{:else}{word.term}{/if}
										</button>
									</th>
									<td class="notes">{word.notes ?? ''}{word.proper ? ' name' : ''}</td>
									<td class="meaning" class:found={!word.meaning && found[key]}
										>{meaningOf(word)}</td
									>
									<td class="state">
										{#if garden.has(key)}
											<span class="have" title="In your words">✓</span>
										{:else}
											<button
												type="button"
												class="btn btn-ghost add"
												disabled={addingAll !== undefined}
												onclick={() => pickListed(word)}>Add</button
											>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<div class="list-actions">
						{#if bare.length > 0}
							<button
								type="button"
								class="btn btn-ghost"
								disabled={finding !== undefined}
								onclick={() => void findMeanings(s)}
							>
								{finding === s ? 'Finding meanings…' : `Find meanings (${bare.length})`}
							</button>
						{/if}
						{#if addable.length > 1}
							<button
								type="button"
								class="btn"
								disabled={addingAll !== undefined}
								onclick={() => void addSection(s)}
							>
								{addingAll === s ? 'Adding…' : `Add all ${addable.length}`}
							</button>
						{/if}
					</div>
				{/if}
			</section>
		{/each}

		<nav class="chapter-nav" aria-label="Chapters">
			{#if prev}
				<a class="btn btn-ghost" href={`/read/book/${id}/${prev}`}
					>← {chapterName(book.chapters[prev - 1])}</a
				>
			{/if}
			{#if next}
				<a class="btn btn-ghost next" href={`/read/book/${id}/${next}`}
					>{chapterName(book.chapters[next - 1])} →</a
				>
			{/if}
		</nav>
	{/if}
</main>

{#if picked}
	<div class="card word-card" role="dialog" aria-label={`The word ${picked.term}`}>
		<div class="card-head">
			<p class="card-term">
				{picked.term}{#if picked.reading}<span class="card-reading">{picked.reading}</span>{/if}
			</p>
			<button type="button" class="close" aria-label="Close" onclick={() => (picked = undefined)}>
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
					><path d="m7 7 10 10M17 7 7 17" /></svg
				>
			</button>
		</div>
		{#if picked.notes}<p class="card-notes">{picked.notes}</p>{/if}
		{#if picked.tracked}
			<p class="card-meaning">{picked.tracked.meaning}</p>
			<p class="card-status">In your words</p>
		{:else}
			{#if explanation}<p class="card-explanation">{explanation}</p>{/if}
			<label class="field">
				<span class="label">Meaning</span>
				<input class="input" type="text" disabled={adding} bind:value={meaning} />
			</label>
			<div class="card-actions">
				{#if !meaning.trim()}
					<button
						type="button"
						class="btn btn-primary"
						disabled={looking}
						onclick={() => void lookUp()}
					>
						{looking ? 'Looking it up…' : 'What does this mean?'}
					</button>
				{:else}
					<button
						type="button"
						class="btn btn-primary"
						disabled={adding}
						onclick={() => void addPicked()}
					>
						{adding ? 'Adding…' : 'Add to my words'}
					</button>
					{#if !explanation}
						<button
							type="button"
							class="btn btn-ghost"
							disabled={looking}
							onclick={() => void lookUp()}
						>
							{looking ? 'Looking it up…' : 'Explain'}
						</button>
					{/if}
				{/if}
			</div>
			{#if cardError}<p class="error" role="alert">{cardError}</p>{/if}
		{/if}
	</div>
{/if}

<style>
	.shell {
		padding-block: var(--gutter) 14rem;
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	.empty,
	.pages {
		color: var(--text-muted);
	}

	.pages {
		margin: 0 0 1.25rem;
		font-size: 0.85rem;
	}

	.added {
		margin: 0 0 1rem;
		color: var(--primary-strong);
		font-weight: 700;
		font-size: 0.9rem;
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

	/* The sections ---------------------------------------------------------- */

	.section {
		margin: 0 0 1.75rem;
		max-width: var(--measure);
	}

	.section.words-section {
		max-width: var(--measure-wide);
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
		margin: 0 0 0.6rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid var(--border);
		font-size: 1rem;
		font-weight: 700;
	}

	.number {
		display: inline-grid;
		place-items: center;
		min-width: 1.6rem;
		padding: 0 0.35rem;
		border-radius: var(--radius-sm);
		background: var(--text);
		color: var(--bg);
		font-size: 0.85rem;
	}

	.dialogue,
	.sentences {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.35rem;
	}

	.turn {
		display: grid;
		grid-template-columns: minmax(2rem, auto) minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 0.75rem;
	}

	.sentence {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 0.75rem;
		padding-left: 0.9rem;
		border-left: 2px solid var(--border);
	}

	.speaker {
		font-weight: 700;
		font-size: 0.9rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.said {
		font-size: 1.2rem;
		line-height: 2;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* A word is a real button, wearing nothing a button wears. */
	.word {
		display: inline;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: none;
		color: inherit;
		font: inherit;
		line-height: inherit;
		cursor: pointer;
	}

	.word:hover,
	.word.open {
		background: color-mix(in srgb, var(--primary) 16%, transparent);
	}

	.word.tracked {
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, var(--primary) 55%, transparent);
		text-underline-offset: 0.3em;
	}

	ruby {
		ruby-position: over;
		ruby-align: center;
	}

	/* The reader's annotation, with a little air either side: two words' pinyin
	   side by side ("wǒ jiào") must not read as one. */
	rt {
		padding-inline: 0.15em;
		font-family: var(--font);
		font-size: max(0.5em, 0.72rem);
		font-weight: 500;
		letter-spacing: 0.02em;
		line-height: 1.2;
		color: var(--text-muted);
		user-select: none;
	}

	/* The vocabulary -------------------------------------------------------- */

	.vocabulary {
		width: 100%;
		border-collapse: collapse;
	}

	.vocabulary tr {
		border-bottom: 1px solid var(--border);
	}

	.vocabulary th,
	.vocabulary td {
		padding: 0.45rem 0.4rem;
		text-align: left;
		vertical-align: baseline;
	}

	.vocabulary th {
		font-weight: 400;
		white-space: nowrap;
	}

	.term {
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 1.2rem;
		font-weight: 700;
		line-height: 2;
		cursor: pointer;
	}

	.notes {
		font-size: 0.85rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.meaning {
		width: 100%;
	}

	.state {
		text-align: right;
		white-space: nowrap;
	}

	.held .term,
	.held .meaning {
		color: var(--text-muted);
	}

	.have {
		display: inline-grid;
		place-items: center;
		width: 2.75rem;
		color: var(--primary-strong);
		font-weight: 700;
	}

	.add {
		min-height: 2.25rem;
		padding: 0.25rem 0.75rem;
		font-size: 0.85rem;
	}

	.list-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.75rem;
	}

	/* A meaning the book did not print: the learner's to check before filing it. */
	.meaning.found {
		font-style: italic;
		color: var(--text-muted);
	}

	.chapter-nav {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.75rem;
		max-width: var(--measure-wide);
		margin-top: 2rem;
	}

	.chapter-nav .next {
		margin-left: auto;
	}

	/* The word card: a sheet at the foot, a floating card when there is room. */

	.word-card {
		position: fixed;
		z-index: 20;
		left: var(--gutter);
		right: var(--gutter);
		bottom: calc(var(--gutter) + 4.5rem);
		max-width: var(--measure);
		margin: 0 auto;
		box-shadow: 0 10px 40px color-mix(in srgb, var(--text) 18%, transparent);
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.card-term {
		margin: 0;
		font-size: 1.6rem;
		font-weight: 700;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.6rem;
	}

	.card-reading {
		font-size: 1rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	.close {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close .ico {
		width: 1.1rem;
		height: 1.1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.card-notes,
	.card-status {
		margin: 0.15rem 0 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.card-meaning {
		margin: 0.25rem 0;
		font-size: 1.05rem;
	}

	.card-explanation {
		margin: 0.25rem 0 0.75rem;
		font-size: 0.9rem;
		color: var(--text-muted);
	}

	.card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	@media (min-width: 48rem) {
		.word-card {
			bottom: var(--gutter);
		}
	}
</style>
