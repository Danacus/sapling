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
	import { hasLocalRomanizer, loadRomanizer, type Romanizer } from '$lib/romanize';
	import { targetTagOf } from '$lib/text';
	import {
		chapterName,
		chapterSummary,
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
	let romanizer = $state<Romanizer | null>(null);
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
					.then((loaded) => {
						if (!cancelled && loaded) {
							romanizer = loaded;
							tokenize = (source, terms) => loaded.tokenize(source, terms);
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

	/**
	 * A listed word's reading, always from the local romanizer, never from the
	 * book or the model: where the chapter's lines use it, the reading it has
	 * there (context settles a polyphone); else the learner's own card's, if
	 * they hold it (the stored reading is what tells two same-spelled cards
	 * apart); else the word romanized on its own, as the garden shows one — a
	 * list word the chapter's lines never use has no other context to give.
	 */
	function readingOf(term: string): string | undefined {
		const key = wordKey(term);
		const inContext = readings.get(key);
		if (inContext) return inContext;
		const held = items.find((item) => wordKey(item.term) === key)?.romanization?.trim();
		if (held) return held;
		if (!romanizer) return undefined;
		const alone = romanizer
			.tokenize(term.trim(), [term.trim()])
			.map((token) => token.reading)
			.filter(Boolean)
			.join(' ');
		return alone || undefined;
	}

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
			reading: readingOf(word.term) ?? null,
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
			const entry = toNewWord(word, meaning, readingOf(word.term));
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

	/* ---- The spread -------------------------------------------------------- */

	/**
	 * Whether the spread is open, asked of the viewport: at ≥48rem a chapter
	 * that has both lines and word lists opens to two facing pages — the
	 * chapter's text on the left, its word lists (and the word card, when one
	 * is open) on the right. A phone keeps the book's own order in one column.
	 * The 48rem is the stylesheet's, repeated as `layout.md` says it must be.
	 */
	let wide = $state(false);
	$effect(() => {
		const query = window.matchMedia('(min-width: 48rem)');
		const sync = () => (wide = query.matches);
		sync();
		query.addEventListener('change', sync);
		return () => query.removeEventListener('change', sync);
	});

	/** Section indices, split into the chapter's text and its word lists. */
	const textSections = $derived(
		(chapter?.sections ?? []).flatMap((section, s) => (section.kind === 'words' ? [] : [s]))
	);
	const wordSections = $derived(
		(chapter?.sections ?? []).flatMap((section, s) => (section.kind === 'words' ? [s] : []))
	);
	const facing = $derived(wide && textSections.length > 0 && wordSections.length > 0);

	/**
	 * Each line's voice in a dialogue: the first speaker, the second, or
	 * anyone else — so the two sides of a conversation read apart at a glance.
	 * A line with no speaker continues the one before it.
	 */
	function voicesOf(lines: { speaker?: string }[]): number[] {
		const order: string[] = [];
		let current = -1;
		return lines.map((line) => {
			const speaker = line.speaker?.trim();
			if (speaker) {
				let at = order.indexOf(speaker);
				if (at < 0) at = order.push(speaker) - 1;
				current = at;
			}
			return current;
		});
	}

	/** How many of a list's words are already in the learner's garden. */
	function heldIn(s: number): number {
		return (chapter?.sections[s].words ?? []).filter((word) => garden.has(wordKey(word.term)))
			.length;
	}
</script>

{#snippet line(words: ReadingWord[], sentence: string)}<span class="line-text" {lang}
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

{#snippet sectionHead(s: number)}
	{@const section = chapter?.sections[s]}
	{#if section && (section.number || section.heading)}
		<h2 class="section-head">
			{#if section.number}<span class="number">{section.number}</span>{/if}
			{#if section.heading}<span class="heading" {lang}>{section.heading}</span>{/if}
		</h2>
	{/if}
{/snippet}

{#snippet textSection(s: number)}
	{@const section = chapter!.sections[s]}
	<section class="section">
		{@render sectionHead(s)}
		{#if section.kind === 'dialogue'}
			{@const voices = voicesOf(section.lines)}
			<ol class="dialogue">
				{#each section.lines as entry, l (l)}
					<li
						class="turn"
						class:continues={!entry.speaker}
						data-voice={voices[l] < 0 ? undefined : Math.min(voices[l], 2)}
					>
						<span class="speaker" {lang}>{entry.speaker ?? ''}</span>
						<span class="said">{@render line(annotated[s][l], entry.text)}</span>
						<span class="speak"><SpeakButton text={entry.text} {lang} size="sm" /></span>
					</li>
				{/each}
			</ol>
		{:else}
			<ol class="sentences">
				{#each section.lines as entry, l (l)}
					<li class="sentence">
						<span class="said">{@render line(annotated[s][l], entry.text)}</span>
						<span class="speak"><SpeakButton text={entry.text} {lang} size="sm" /></span>
					</li>
				{/each}
			</ol>
		{/if}
	</section>
{/snippet}

{#snippet wordSection(s: number)}
	{@const section = chapter!.sections[s]}
	{@const addable = addableIn(s)}
	{@const bare = bareIn(s)}
	{@const held = heldIn(s)}
	<section class="section word-list">
		<div class="list-head">
			{@render sectionHead(s)}
			<p class="list-count">
				{section.words.length}
				{section.words.length === 1 ? 'word' : 'words'}{#if held > 0}, {held} in your garden{/if}
			</p>
		</div>
		<ul class="entries">
			{#each section.words as word, w (w)}
				{@const key = wordKey(word.term)}
				{@const reading = readingOf(word.term)}
				{@const have = garden.has(key)}
				{@const gloss = meaningOf(word)}
				<li class="entry" class:held={have} class:open={picked?.term === word.term}>
					<button type="button" class="entry-term" onclick={() => pickListed(word)}>
						{#if reading}<span class="entry-reading">{reading}</span>{/if}
						<span class="entry-word" {lang}>{word.term}</span>
					</button>
					<span class="entry-gloss">
						{#if word.notes}<span class="entry-notes">{word.notes}</span>{/if}
						{#if word.proper}<span class="tag">name</span>{/if}
						{#if gloss}
							<span
								class="entry-meaning"
								class:found={!word.meaning}
								title={word.meaning ? undefined : 'Found for you, not printed in the book'}
								>{gloss}</span
							>
						{:else}
							<span class="entry-meaning missing">No meaning printed</span>
						{/if}
					</span>
					<span class="entry-state">
						{#if have}
							<span class="have" title="In your words">
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
									><path d="m5 12.5 4.5 4.5L19 7.5" /></svg
								>
								<span class="sr-only">In your words</span>
							</span>
						{:else}
							<button
								type="button"
								class="add"
								aria-label={`Add ${word.term}`}
								title="Add to my words"
								disabled={addingAll !== undefined}
								onclick={() => pickListed(word)}
							>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
									><path d="M12 5v14M5 12h14" /></svg
								>
							</button>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
		{#if bare.length > 0 || addable.length > 1}
			<div class="list-actions">
				{#if addable.length > 1}
					<button
						type="button"
						class="btn btn-primary"
						disabled={addingAll !== undefined}
						onclick={() => void addSection(s)}
					>
						{addingAll === s ? 'Adding…' : `Add all ${addable.length}`}
					</button>
				{/if}
				{#if bare.length > 0}
					<button
						type="button"
						class="btn btn-ghost hairline"
						disabled={finding !== undefined}
						onclick={() => void findMeanings(s)}
					>
						{finding === s ? 'Finding meanings…' : `Find meanings for ${bare.length}`}
					</button>
				{/if}
			</div>
		{/if}
	</section>
{/snippet}

{#snippet card(docked: boolean)}
	{#if picked}
		<div class="card word-card" class:docked role="dialog" aria-label={`The word ${picked.term}`}>
			<div class="card-head">
				<div class="card-title">
					{#if picked.reading}<span class="card-reading">{picked.reading}</span>{/if}
					<span class="card-term" {lang}>{picked.term}</span>
				</div>
				<button type="button" class="close" aria-label="Close" onclick={() => (picked = undefined)}>
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
						><path d="m7 7 10 10M17 7 7 17" /></svg
					>
				</button>
			</div>
			{#if picked.notes}<p class="card-notes">{picked.notes}</p>{/if}
			{#if picked.tracked}
				<p class="card-meaning">{picked.tracked.meaning}</p>
				<p class="card-status">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
						><path d="m5 12.5 4.5 4.5L19 7.5" /></svg
					>
					In your words
				</p>
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
{/snippet}

<main class="shell" class:shell-broad={facing} class:shell-wide={!facing}>
	<header class="topbar ll-rise">
		<BackLink href={`/read/book/${id}`} label="Back to the book" />
		<div class="identity">
			<p class="eyebrow">{book?.title ?? 'Textbook'}</p>
			<h1 {lang}>{chapter ? chapterName(chapter) : 'Chapter'}</h1>
			{#if chapter}
				{@const meta = [pagesOf(chapter), chapterSummary(chapter)].filter(Boolean).join(' · ')}
				{#if meta}<p class="meta">{meta}</p>{/if}
			{/if}
		</div>
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if !book || !chapter}
		<p class="empty">That chapter is not in your library.</p>
	{:else}
		{#if addedNote}<p class="added" aria-live="polite">{addedNote}</p>{/if}

		{#if chapter.sections.length === 0}
			<p class="empty">Nothing was read from this chapter's pages.</p>
		{:else if facing}
			<div class="spread pages">
				<div class="page-text">
					{#each textSections as s (s)}{@render textSection(s)}{/each}
				</div>
				<aside class="page-words" aria-label="Words in this chapter">
					{@render card(true)}
					{#each wordSections as s (s)}{@render wordSection(s)}{/each}
				</aside>
			</div>
		{:else}
			<div class="column">
				{#each chapter.sections as section, s (s)}
					{#if section.kind === 'words'}{@render wordSection(s)}{:else}{@render textSection(s)}{/if}
				{/each}
			</div>
		{/if}

		{#if prev || next}
			<nav class="chapter-nav" aria-label="Chapters">
				{#if prev}
					<a class="turn-page" href={`/read/book/${id}/${prev}`}>
						<span class="turn-label">
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
								><path d="m14 6-6 6 6 6" /></svg
							>
							Previous chapter
						</span>
						<span class="turn-name" {lang}>{chapterName(book.chapters[prev - 1])}</span>
					</a>
				{/if}
				{#if next}
					<a class="turn-page next" href={`/read/book/${id}/${next}`}>
						<span class="turn-label">
							Next chapter
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
								><path d="m10 6 6 6-6 6" /></svg
							>
						</span>
						<span class="turn-name" {lang}>{chapterName(book.chapters[next - 1])}</span>
					</a>
				{/if}
			</nav>
		{/if}
	{/if}
</main>

{#if !facing}{@render card(false)}{/if}

<style>
	.shell {
		padding-block: var(--gutter) 14rem;
	}

	/* The header ------------------------------------------------------------ */

	.topbar {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		margin-bottom: 1.75rem;
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
		margin: 0.1rem 0 0;
		font-size: 1.7rem;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.meta {
		margin: 0.35rem 0 0;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	.empty {
		color: var(--text-muted);
	}

	.added {
		margin: 0 0 1.25rem;
		padding: 0.55rem 0.8rem;
		border-radius: var(--radius-sm);
		background: var(--primary-soft);
		color: var(--primary-strong);
		font-weight: 700;
		font-size: 0.9rem;
		max-width: var(--measure);
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

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.ico {
		width: 1.1rem;
		height: 1.1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		flex: none;
	}

	/* The page and the spread ----------------------------------------------- */

	.column,
	.page-text {
		display: grid;
		gap: 2.25rem;
	}

	.column > .section {
		max-width: var(--measure);
	}

	.column > .word-list {
		max-width: var(--measure-wide);
	}

	/* The text takes the reading measure; the word lists face it. */
	.pages {
		grid-template-columns: minmax(0, var(--measure)) minmax(0, 1fr);
		column-gap: calc(var(--gutter) * 1.25);
	}

	.page-words {
		position: sticky;
		top: var(--gutter);
		display: grid;
		gap: 2rem;
		max-height: calc(100dvh - 2 * var(--gutter));
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 1.15rem 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}

	/* The top padding, kept off the scroller so a docked card sits flush. */
	.page-words > :first-child:not(.word-card) {
		margin-top: 1.1rem;
	}

	/* Sections --------------------------------------------------------------- */

	.section-head {
		display: flex;
		align-items: baseline;
		gap: 0.65rem;
		margin: 0 0 0.85rem;
		font-size: 1.05rem;
		font-weight: 700;
		line-height: 1.3;
	}

	/* The book's own number for the section, set as a numeral, not a badge. */
	.number {
		font-family: var(--font-display);
		font-size: 1.45rem;
		font-weight: 600;
		line-height: 1;
		color: var(--accent);
		font-variant-numeric: lining-nums;
	}

	.dialogue,
	.sentences {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* One grid for the whole dialogue, so every speaker's name shares a column. */
	.dialogue {
		display: grid;
		grid-template-columns: fit-content(6.5rem) minmax(0, 1fr) auto;
		column-gap: 0.85rem;
		row-gap: 0.15rem;
	}

	.turn {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: baseline;
		--voice: var(--text-muted);
	}

	.turn[data-voice='0'] {
		--voice: var(--primary-strong);
	}

	.turn[data-voice='1'] {
		--voice: var(--accent);
	}

	/* A new speaker opens a little air above them; a continuation does not. */
	.turn:not(.continues) + .turn:not(.continues),
	.turn.continues + .turn:not(.continues) {
		margin-top: 0.35rem;
	}

	.speaker {
		padding-top: 0.15rem;
		color: var(--voice);
		font-size: 0.9rem;
		font-weight: 700;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.turn .said {
		padding-left: 0.75rem;
		border-left: 2px solid color-mix(in srgb, var(--voice) 45%, transparent);
	}

	.sentences {
		display: grid;
		gap: 0.35rem;
	}

	.sentence {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 0.75rem;
	}

	.sentence .said {
		padding-left: 0.75rem;
		border-left: 2px solid var(--border);
	}

	.said {
		font-size: 1.25rem;
		line-height: 2.1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.speak {
		align-self: center;
		opacity: 0.7;
	}

	.turn:hover .speak,
	.sentence:hover .speak,
	.speak:focus-within {
		opacity: 1;
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

	/* Word lists ------------------------------------------------------------- */

	.list-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 1rem;
		margin-bottom: 0.35rem;
	}

	.list-head .section-head {
		margin: 0;
	}

	.list-count {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.82rem;
	}

	/* One grid for the list, so every meaning starts on the same line. */
	.entries {
		display: grid;
		grid-template-columns: fit-content(9rem) minmax(0, 1fr) auto;
		column-gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.entry {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		align-items: center;
		padding: 0.45rem 0;
		border-top: 1px solid var(--border);
	}

	.entry:last-child {
		border-bottom: 1px solid var(--border);
	}

	.entry-term {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.05rem;
		margin: -0.2rem -0.4rem;
		padding: 0.2rem 0.4rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.entry-term:hover,
	.entry.open .entry-term {
		background: color-mix(in srgb, var(--primary) 12%, transparent);
	}

	.entry-reading {
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		line-height: 1.2;
	}

	.entry-word {
		font-size: 1.3rem;
		font-weight: 700;
		line-height: 1.3;
	}

	.entry-gloss {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.1rem 0.5rem;
		min-width: 0;
	}

	.entry-notes {
		color: var(--text-muted);
		font-size: 0.82rem;
		font-style: italic;
	}

	.tag {
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--surface-alt);
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.entry-meaning {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* A meaning the book did not print: the learner's to check before filing it. */
	.entry-meaning.found {
		font-style: italic;
		color: var(--text-muted);
	}

	.entry-meaning.missing {
		color: color-mix(in srgb, var(--text-muted) 75%, transparent);
		font-size: 0.85rem;
	}

	.held .entry-word,
	.held .entry-meaning {
		color: var(--text-muted);
	}

	.entry-state {
		display: grid;
		place-items: center;
	}

	.have,
	.add {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius);
	}

	.have {
		color: var(--primary);
	}

	.add {
		padding: 0;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--primary-strong);
		cursor: pointer;
	}

	.add:hover:not(:disabled) {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.add:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.list-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 0.9rem;
	}

	.btn.hairline {
		border-color: var(--border);
	}

	.page-words .list-actions .btn {
		padding: 0.55rem 1rem;
		font-size: 0.88rem;
	}

	/* Turning the page -------------------------------------------------------- */

	.chapter-nav {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		max-width: var(--measure-wide);
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	.turn-page {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		padding: 0.75rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
	}

	.turn-page:hover {
		border-color: var(--border-strong);
	}

	.turn-page.next {
		grid-column: 2;
		align-items: flex-end;
		text-align: right;
	}

	.turn-label {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.turn-label .ico {
		width: 0.95rem;
		height: 0.95rem;
	}

	.turn-name {
		font-weight: 700;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	/* The word card: a sheet at the foot, or the top of the facing page. ------ */

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

	/* Docked, it sits atop the word lists and stays put while they scroll. */
	.word-card.docked {
		position: sticky;
		top: 0;
		right: auto;
		bottom: auto;
		left: auto;
		z-index: 1;
		width: auto;
		max-width: none;
		margin: 0 -1.15rem;
		padding: 1.1rem 1.15rem 1.25rem;
		border: 0;
		border-bottom: 1px solid var(--border);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		background: var(--surface-alt);
		box-shadow: none;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.card-title {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.card-reading {
		color: var(--accent);
		font-size: 0.95rem;
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.card-term {
		font-size: 2rem;
		font-weight: 700;
		line-height: 1.2;
	}

	.close {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		margin: -0.4rem -0.5rem 0 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close:hover {
		background: var(--surface-alt);
		color: var(--text);
	}

	.card-notes {
		margin: 0.15rem 0 0.6rem;
		font-size: 0.85rem;
		font-style: italic;
		color: var(--text-muted);
	}

	.card-status {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		font-weight: 700;
		color: var(--primary-strong);
	}

	.card-meaning {
		margin: 0.4rem 0 0;
		font-size: 1.1rem;
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

		.topbar {
			margin-bottom: 2.25rem;
		}

		.topbar h1 {
			font-size: 2rem;
		}

		.chapter-nav {
			max-width: none;
		}
	}
</style>
