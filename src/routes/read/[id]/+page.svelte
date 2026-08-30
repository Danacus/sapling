<!--
  The reader: one stored text, with every word one tap from its meaning.

  The text itself is immutable — the sentences, the readings and the glossary are
  what the model wrote the day it was made. Everything the learner *sees* is
  decided here on every open, by `annotateSentence` against the garden and the
  marks as they stand today, which is why a text written last month shows this
  month's knowledge. The roll map that decides which tracked readings fade is
  created once per component instance and kept across re-annotations, so a word
  reads the same in sentence two and sentence nine.

  This page owns every write. `$lib/reading` never touches the database: it is
  handed the vocabulary and hands back words, and adding, marking and looking up
  all happen here through the repositories — which is what puts them in the sync
  log for free.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteSet } from 'svelte/reactivity';

	import { addWordsTool, defaultToolContext } from '$lib/assistant/tools';
	import {
		deleteText,
		getAllItems,
		getKnownTerms,
		getProfile,
		getText,
		markWord,
		recordLookup,
		updateItemAfterReview
	} from '$lib/db';
	import { annotateSentence, showSentenceReading, tokenizeByTerms, wordKey } from '$lib/reading';
	import type { AnnotateContext, ReadingWord, TokenizeFn } from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import type { Maturity } from '$lib/session/progression';
	import { Grade, newCardState, reviewCard, type FsrsCardState } from '$lib/srs';
	import { joinTokens, usesInterWordSpaces } from '$lib/text';
	import { speak, stopSpeaking, ttsAvailable, warmSpeech } from '$lib/tts';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** The garden's own bed names, so one word means one thing across the app. */
	const BEDS: Record<Maturity, string> = { new: 'sprouting', young: 'growing', solid: 'rooted' };

	let loading = $state(true);
	let loadError = $state('');
	/** The text is not here — deleted on this device or on another one. */
	let missing = $state(false);
	let profile = $state<Profile | undefined>(undefined);
	let text = $state<ReadingText | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);

	/**
	 * The romanizer's tokenizer once its lazy chunk lands, `tokenizeByTerms`
	 * until then and for every language that has none. Both produce the same
	 * token shape; only one of them brings readings.
	 */
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);

	/**
	 * One adaptive roll per word key, for the whole time this text is open. A
	 * plain `Map`, deliberately not `$state`: the annotator writes to it while a
	 * `$derived` is computing, and a reactive cache would turn that into a loop.
	 */
	const rolls = new Map<string, boolean>();
	/** Read once — the setting lives in Settings, not mid-text. */
	const mode = getRomanizationMode();
	let now = $state(Date.now());

	/** Which word's card is open, by position — so a write refreshes it in place. */
	let selected = $state<{ line: number; word: number } | null>(null);
	/** The whole-text translation and the stored reading are each one decision. */
	let showTranslation = $state(false);
	let showReading = $state(false);
	/** The meaning typed for a word nobody has glossed. */
	let meaningDraft = $state('');
	let writing = $state(false);
	let cardError = $state('');
	let pageError = $state('');
	let playing = $state(false);
	let confirming = $state(false);

	/**
	 * Garden words looked up while this text was open, by key — each has been
	 * graded `Again` once. Session-scoped on purpose: re-tapping a word you have
	 * already lost is not a second failure, but reopening the text tomorrow and
	 * needing it again is.
	 */
	const lapsed = new SvelteSet<string>();
	/** The Finished button's two steps, then its receipt. */
	let finishing = $state(false);
	let finished = $state(false);
	let summary = $state('');

	const lang = $derived(profile?.targetLanguage ?? '');

	const ctx: AnnotateContext = $derived({
		items,
		knownTerms,
		glossary: text?.glossary ?? [],
		mode,
		now,
		rolls
	});

	/** The whole text, annotated. Re-runs whenever the vocabulary or the marks move. */
	const lines = $derived(
		(text?.sentences ?? []).map((sentence) => ({
			sentence,
			words: annotateSentence(sentence.text, tokenize, ctx)
		}))
	);

	/**
	 * What sits between two sentences on the page: the script's own rule, decided
	 * from the text itself — a space for Spanish, nothing for Chinese.
	 */
	const gap = $derived(
		usesInterWordSpaces(lines.map((line) => line.sentence.text).join('')) ? ' ' : ''
	);

	/** True once the romanizer's tokenizer is in — every reading is then ruby. */
	const localReadings = $derived(tokenize !== tokenizeByTerms);

	const translation = $derived(
		joinTokens(lines.map((line) => line.sentence.translation ?? '').filter(Boolean))
	);

	/**
	 * The stored, sentence-wide readings as one block: the fallback for a language
	 * with no local romanizer. Never offered beside ruby — that would print every
	 * reading twice — and never under `'off'`.
	 */
	const storedReading = $derived(
		localReadings || mode === 'off'
			? ''
			: joinTokens(
					lines
						.filter((line) => line.sentence.reading && showSentenceReading(line.words, mode))
						.map((line) => line.sentence.reading ?? '')
				)
	);

	/**
	 * The open word, read back out of `lines` rather than captured on tap: after a
	 * write the text re-annotates and the card has to show the *new* status, not
	 * the one that was true when it was opened.
	 */
	const card = $derived(selected ? (lines[selected.line]?.words[selected.word] ?? null) : null);

	/**
	 * The reading shown on the card.
	 *
	 * The token's first — a local romanizer knows this occurrence's reading, and
	 * the glossary only knows the term's. Unlike the prose it ignores the fading
	 * rule: opening a card is the learner asking to have this word explained, and
	 * an answer with a piece held back is not an answer.
	 */
	const cardReading = $derived(card?.reading ?? card?.gloss?.reading ?? '');

	/** What "Add to my words" would file — the gloss, or what the learner typed. */
	const draftMeaning = $derived((card?.gloss?.meaning ?? meaningDraft).trim());

	$effect(() => {
		if (!browser) return;

		const id = page.params.id ?? '';
		let cancelled = false;
		loading = true;
		loadError = '';
		missing = false;

		Promise.all([getProfile(), getText(id), getAllItems(), getKnownTerms()])
			.then(([loadedProfile, loadedText, loadedItems, known]) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (!loadedProfile) return;

				profile = loadedProfile;
				items = loadedItems;
				knownTerms = known;
				now = Date.now();
				loading = false;

				if (!loadedText) {
					missing = true;
					return;
				}
				text = loadedText;

				if (!hasLocalRomanizer(loadedProfile.targetLanguage)) return;
				// A lazy chunk (pinyin's dictionary is not small), so the text renders
				// with the fallback tokenizer immediately and re-renders with real
				// per-word readings when it lands. A failed fetch simply leaves the
				// fallback in place — readings are a nicety, the text is not.
				void loadRomanizer(loadedProfile.targetLanguage)
					.then((romanizer) => {
						if (cancelled || !romanizer) return;
						tokenize = (source, terms) => romanizer.tokenize(source, terms);
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

	/** Nothing keeps speaking into a page the learner has left. */
	$effect(() => () => {
		playing = false;
		stopSpeaking();
	});

	/** Re-reads what a write changed; the roll map survives, so nothing re-rolls. */
	async function refresh() {
		const [loadedItems, known] = await Promise.all([getAllItems(), getKnownTerms()]);
		items = loadedItems;
		knownTerms = known;
		now = Date.now();
	}

	function statusLine(word: ReadingWord): string {
		if (word.status === 'tracked' && word.key && lapsed.has(word.key)) {
			return `Counted as forgotten · ${BEDS[word.maturity ?? 'new']}, back sooner`;
		}
		if (word.status === 'tracked') return `In your garden · ${BEDS[word.maturity ?? 'new']}`;
		if (word.status === 'known') return 'Marked known';
		if (word.status === 'new') return 'New word';
		return 'Not in your garden';
	}

	function close() {
		selected = null;
		confirming = false;
	}

	function open(line: number, index: number) {
		const target = lines[line]?.words[index];
		if (!target?.key || !text) return;

		selected = { line, word: index };
		meaningDraft = '';
		cardError = '';

		// A tap is a *lookup* — "I don't understand this, explain" — and it is the
		// one thing about a reading session that cannot be recovered afterwards.
		// Once per open, never awaited: a card must not wait on a write.
		void recordLookup(target.text, text.id, target.itemId);

		// On a garden word the lookup is also a lapse: recall failed in context,
		// with the reading often showing — the easiest conditions there are — so
		// it is graded `Again`, once per word per text. `add_words` and the drill
		// grade through the same repository call, so this lands in the ledger as
		// an ordinary review, amendable like any other.
		if (target.status === 'tracked' && target.itemId && !lapsed.has(target.key)) {
			lapsed.add(target.key);
			void review(target.itemId, Grade.Again).then(refresh);
		}
	}

	/** One graded review, exactly as the session engine files one. */
	function review(itemId: string, grade: Grade): Promise<unknown> {
		const at = Date.now();
		return updateItemAfterReview(
			itemId,
			(stored) =>
				reviewCard((stored as FsrsCardState | null | undefined) ?? newCardState(at), grade, at),
			{ at, grade }
		);
	}

	/** What Finished would do — counted live, so the confirm step can say it. */
	const finishPlan = $derived.by(() => {
		const read = new Map<string, string>();
		const fresh = new Map<string, string>();
		for (const line of lines) {
			for (const word of line.words) {
				if (!word.key) continue;
				if (word.status === 'tracked' && word.itemId && !lapsed.has(word.key)) {
					read.set(word.itemId, word.text);
				} else if (word.status === 'new') {
					fresh.set(word.key, word.gloss?.term ?? word.text);
				}
			}
		}
		return { read: [...read.keys()], fresh: [...fresh.values()] };
	});

	/**
	 * "Finished": the reading counted.
	 *
	 * Not looking a garden word up is the implicit `Good` — recall in context —
	 * but only at this explicit moment, never by scrolling past. And the `new`
	 * words that were read without a lookup are marked known: LingQ's paging,
	 * as one deliberate press rather than an accident of turning the page.
	 * `plain` words are left alone — unglossed, they are as likely to be a
	 * segmenter's slip as a word.
	 */
	async function finish() {
		if (!text || writing || finished) return;
		const { read, fresh } = finishPlan;

		writing = true;
		pageError = '';
		try {
			for (const itemId of read) await review(itemId, Grade.Good);
			for (const term of fresh) await markWord(term, true);
			await refresh();
			finished = true;
			finishing = false;
			const parts = [
				`${read.length} garden word${read.length === 1 ? '' : 's'} read fine`,
				...(lapsed.size > 0 ? [`${lapsed.size} forgotten`] : []),
				...(fresh.length > 0 ? [`${fresh.length} new marked known`] : [])
			];
			summary = parts.join(' · ');
		} catch (cause) {
			pageError = cause instanceof Error ? cause.message : 'Could not finish the text.';
		} finally {
			writing = false;
		}
	}

	/** `add_words`, verbatim: the one route by which vocabulary enters the garden. */
	async function addWord() {
		const target = card;
		if (!target || writing || draftMeaning === '') return;

		writing = true;
		cardError = '';
		try {
			const reading = cardReading;
			// The outcome is not inspected: `add_words` skips a word already in the
			// list rather than failing, and either way the card re-reads its status
			// from the refreshed garden — which is a better receipt than a sentence.
			await addWordsTool.run(
				{
					words: [
						{
							term: target.text,
							meaning: draftMeaning,
							...(reading ? { romanization: reading } : {})
						}
					]
				},
				defaultToolContext()
			);
			await refresh();
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not add that word.';
		} finally {
			writing = false;
		}
	}

	/** "I know this", and taking it back. A status declaration, never a review. */
	async function mark(known: boolean) {
		const target = card;
		if (!target?.key || writing) return;

		writing = true;
		cardError = '';
		try {
			// `wordMarks` is keyed by the term verbatim while a word's *status* is
			// matched by key, so unmarking has to name the spelling the mark was
			// stored under rather than the one this text happens to use.
			const stored = known
				? target.text
				: (knownTerms.find((term) => wordKey(term) === target.key) ?? target.text);
			await markWord(stored, known);
			await refresh();
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not save that.';
		} finally {
			writing = false;
		}
	}

	/**
	 * Reads the text aloud, sentence by sentence.
	 *
	 * Sequential on purpose — `speak` resolves when playback finishes, so awaiting
	 * it *is* the pacing. Pressing again cuts the current clip off; the loop then
	 * sees `playing` go false and stops rather than starting the next sentence.
	 *
	 * Synthesis runs *ahead* of playback: a second walk warms every sentence into
	 * the clip cache in order (Kokoro takes a second or two per sentence — as long
	 * as the gap the learner used to hear between them), so by the time the loop
	 * reaches a sentence its clip is local and the only pause left is the one a
	 * full stop deserves. The same trick the session screen plays for its
	 * feedback audio; warming is an optimisation only and every failure inside it
	 * is swallowed. One clip for the whole text was tried and sounded the same,
	 * and a chain starts sooner, stops cleanly and stays under Web Speech's
	 * long-utterance cutoff for the languages Kokoro does not cover.
	 */
	async function listen() {
		if (!text) return;
		if (playing) {
			playing = false;
			stopSpeaking();
			return;
		}

		playing = true;
		const sentences = text.sentences.map((sentence) => sentence.text);
		void (async () => {
			for (const sentence of sentences) {
				if (!playing) break;
				await warmSpeech(sentence, lang);
			}
		})();

		try {
			for (const sentence of sentences) {
				if (!playing) break;
				await speak(sentence, lang);
			}
		} finally {
			playing = false;
		}
	}

	/** Forgetting a text. Confirmed inline, because a modal is not a page's voice. */
	async function remove() {
		if (!text || writing) return;
		writing = true;
		pageError = '';
		try {
			stopSpeaking();
			await deleteText(text.id);
			await goto('/read');
		} catch (cause) {
			pageError = cause instanceof Error ? cause.message : 'Could not delete that text.';
			writing = false;
			confirming = false;
		}
	}

	/**
	 * The status and maturity classes the colours hang off. `w-new` means two
	 * things — a glossed stranger and a freshly planted word — so the CSS tells
	 * them apart by whether `w-tracked` is there too.
	 */
	function wordClass(word: ReadingWord): string {
		const lapse = word.key && lapsed.has(word.key) ? ' w-lapsed' : '';
		return `w w-${word.status}${word.maturity ? ` w-${word.maturity}` : ''}${lapse}`;
	}

	const dates = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});
</script>

<svelte:head>
	<title>{text ? `Sapling · ${text.title}` : 'Sapling · Reading'}</title>
</svelte:head>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') close();
	}}
/>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else if missing || !text}
		<div class="card gone">
			<h1>This text is gone</h1>
			<p class="hint">It was deleted, here or on another device.</p>
			<a class="btn btn-ghost" href="/read">Back to your texts</a>
		</div>
	{:else}
		<div class="spread reader-spread">
			<header class="topbar spread-full ll-rise">
				<a class="back" href="/read" aria-label="Back to your texts">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
					</svg>
				</a>
				<div class="identity">
					<p class="eyebrow">
						{text.source === 'generated' ? 'Written for you' : 'You brought this'} · {dates.format(
							text.createdAt
						)}
					</p>
					<h1>{text.title}</h1>
				</div>
				<div class="tools">
					<button
						type="button"
						class="btn btn-ghost tool"
						class:playing
						disabled={!ttsAvailable(lang)}
						title={ttsAvailable(lang)
							? 'Read the whole text aloud'
							: 'Speech is off — see Settings'}
						onclick={() => void listen()}
					>
						{playing ? 'Stop' : 'Listen'}
					</button>
					{#if finished}
						<span class="tool done" aria-live="polite">Finished</span>
					{:else if finishing}
						<button
							type="button"
							class="btn btn-ghost tool"
							disabled={writing}
							onclick={() => void finish()}
						>
							{writing ? 'Saving…' : 'Yes, done'}
						</button>
						<button type="button" class="btn btn-ghost tool" onclick={() => (finishing = false)}>
							Not yet
						</button>
					{:else}
						<button
							type="button"
							class="btn btn-ghost tool"
							title="Count this reading: garden words you did not look up are reviewed, new words become known"
							onclick={() => (finishing = true)}
						>
							Finished
						</button>
					{/if}
					{#if confirming}
						<button
							type="button"
							class="btn btn-ghost tool danger"
							disabled={writing}
							onclick={() => void remove()}
						>
							Delete for good
						</button>
						<button type="button" class="btn btn-ghost tool" onclick={() => (confirming = false)}>
							Keep
						</button>
					{:else}
						<button type="button" class="btn btn-ghost tool" onclick={() => (confirming = true)}>
							Delete
						</button>
					{/if}
				</div>
			</header>

			{#if pageError}
				<p class="error spread-full" role="alert">{pageError}</p>
			{/if}

			{#if finishing && !finished}
				<p class="hint spread-full">
					Count this reading? {finishPlan.read.length} garden word{finishPlan.read.length === 1
						? ''
						: 's'} you read without looking up will be reviewed as remembered{finishPlan.fresh
						.length > 0
						? `, and ${finishPlan.fresh.length} new word${finishPlan.fresh.length === 1 ? '' : 's'} marked known`
						: ''}.
				</p>
			{/if}

			{#if summary}
				<p class="hint summary spread-full">{summary}</p>
			{/if}

			<!-- The text. Capped at the reading measure whatever the column allows:
			     width buys the word card its own page, never a longer line. -->
			<div class="text-col" class:has-card={card !== null}>
				<ul class="legend" aria-label="What the underlines mean">
					<li><span class="swatch sw-new" aria-hidden="true"></span>new</li>
					<li><span class="swatch sw-growing" aria-hidden="true"></span>growing</li>
					<li><span class="swatch sw-known" aria-hidden="true"></span>known</li>
				</ul>

				<!-- One continuous body, not a list of sentences: the model returns
				     sentences because the annotation is keyed on them, but the learner
				     reads a text. Written without whitespace between the tokens — they
				     reproduce the sentence character for character, so a newline in the
				     template would land as a rendered space between every pair of them —
				     and the sentences are joined by `gap`, the script's own rule. -->
				<p class="prose">
					{#each lines as line, l (l)}{#if l > 0}{gap}{/if}<span class="sentence"
							>{#each line.words as word, w (w)}{#if word.key === undefined}{word.text}{:else}<button
										type="button"
										class={wordClass(word)}
										class:is-open={selected?.line === l && selected?.word === w}
										onclick={() => open(l, w)}
										>{#if word.reading}<ruby>{word.text}<rt>{word.reading}</rt></ruby
											>{:else}{word.text}{/if}</button
									>{/if}{/each}</span
						>{/each}
				</p>

				<!-- Reading the translation stays a decision, as in conversation mode;
				     so does the stored reading, which only exists here when there is no
				     ruby to carry it. -->
				{#if translation || storedReading}
					<div class="text-tools">
						{#if storedReading}
							<button type="button" class="reveal" onclick={() => (showReading = !showReading)}>
								{showReading ? 'Hide reading' : 'Reading'}
							</button>
						{/if}
						{#if translation}
							<button
								type="button"
								class="reveal"
								onclick={() => (showTranslation = !showTranslation)}
							>
								{showTranslation ? 'Hide translation' : 'Translation'}
							</button>
						{/if}
					</div>
				{/if}

				{#if showReading && storedReading}
					<p class="rom reading-block">{storedReading}</p>
				{/if}

				{#if showTranslation && translation}
					<p class="translation">{translation}</p>
				{/if}
			</div>

			<!-- The word card. A facing page at 48rem, a sheet at the foot of the
			     phone below it. -->
			<aside class="card-col" class:is-open={card !== null}>
				{#if card}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="word-term">{card.text}</p>
								{#if cardReading}<span class="rom">{cardReading}</span>{/if}
							</div>
							<SpeakButton text={card.text} {lang} />
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>

						<p class="word-status">{statusLine(card)}</p>

						{#if card.gloss}
							<p class="word-meaning">{card.gloss.meaning}</p>
						{/if}

						<!-- A tracked word has no actions here: the garden is where it is
						     managed, and a reading session is not the place to leave for it. -->
						{#if card.status !== 'tracked'}
							<hr class="stitch" />
						{/if}

						{#if card.status === 'tracked'}{:else if card.status === 'known'}
							<button
								type="button"
								class="btn btn-ghost btn-block"
								disabled={writing}
								onclick={() => void mark(false)}
							>
								Unmark
							</button>
						{:else}
							{#if !card.gloss}
								<label class="field">
									<span class="label">What does it mean?</span>
									<input
										class="input"
										type="text"
										placeholder="In {profile?.nativeLanguage ?? 'your language'}"
										disabled={writing}
										bind:value={meaningDraft}
										onkeydown={(event) => {
											if (event.key === 'Enter') void addWord();
										}}
									/>
								</label>
							{/if}
							<div class="word-actions">
								<button
									type="button"
									class="btn btn-primary"
									disabled={writing || draftMeaning === ''}
									onclick={() => void addWord()}
								>
									Add to my words
								</button>
								<button
									type="button"
									class="btn btn-ghost"
									disabled={writing}
									onclick={() => void mark(true)}
								>
									I know this
								</button>
							</div>
						{/if}

						{#if cardError}
							<p class="error card-error" role="alert">{cardError}</p>
						{/if}
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</main>

<style>
	/* Width and the side gutter are the global `.shell`/`.shell-broad` pair's
	   job; only the vertical rhythm is this route's own. */
	.shell {
		padding-block: 1.5rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	.gone h1 {
		font-size: 1.35rem;
	}

	.gone .btn {
		margin-top: 0.75rem;
		text-decoration: none;
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
		flex-wrap: wrap;
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
		flex: 1 1 12rem;
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.1rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.45rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.tools {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.tool {
		padding: 0.4rem 0.85rem;
		border-color: var(--border);
		font-size: 0.82rem;
	}

	.tool.playing {
		border-color: var(--primary);
		color: var(--primary-strong);
	}

	.tool.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		color: var(--danger);
	}

	.tool.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	/* The text ------------------------------------------------------------ */

	.text-col {
		max-width: var(--measure);
	}

	/* Room under the last line for the sheet that covers the foot of the phone. */
	.text-col.has-card {
		padding-bottom: 60dvh;
	}

	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin: 0 0 1.25rem;
		padding: 0 0 0.85rem;
		border-bottom: 1px dashed var(--border-strong);
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.swatch {
		display: inline-block;
		width: 1.1rem;
		height: 0;
		border-bottom: 2px solid currentColor;
	}

	.sw-new {
		color: var(--accent);
	}

	.sw-growing {
		color: color-mix(in srgb, var(--primary) 55%, var(--amber));
	}

	/* Known words carry no mark at all, so the swatch says "nothing here". */
	.sw-known {
		color: var(--border-strong);
		border-bottom-style: dotted;
	}

	/*
	  Target-script prose: a touch larger than body text because it is the
	  specimen, and set at 1.9 so ruby has somewhere to sit without the lines
	  colliding — the same figure `RubyText` uses for the same reason.
	*/
	.prose {
		margin: 0;
		font-size: 1.15rem;
		line-height: 1.9;
		overflow-wrap: anywhere;
	}

	/* A sentence is a run inside the paragraph, not a block of its own — the
	   span exists so a later slice can mark or play one, not to break the text. */
	.sentence {
		display: inline;
	}

	/*
	  A word is a real button — Tab reaches it, Enter opens it — wearing none of a
	  button's clothes. `display: inline` is what lets a long word wrap inside the
	  paragraph instead of being an unbreakable block in the middle of it.
	*/
	.w {
		display: inline;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.w:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.w ruby {
		ruby-position: over;
		ruby-align: center;
	}

	/*
	  The annotation wears `.rom`'s clothes: body face, muted ink, a touch of
	  tracking. Clamped at 0.72rem because pinyin legibility lives in the tone
	  marks, and below that ā/á/ǎ/à stop being distinguishable.
	*/
	.w rt {
		font-family: var(--font);
		font-size: max(0.5em, 0.72rem);
		font-weight: 500;
		font-variation-settings: normal;
		letter-spacing: 0.02em;
		line-height: 1.2;
		color: var(--text-muted);
		user-select: none;
	}

	/*
	  A word the text glosses: an accent underline, the loudest mark on the page,
	  because it is the one the reader most likely needs. `:not(.w-tracked)`
	  because a freshly planted word is `w-tracked w-new` and belongs to the beds
	  below, not here.
	*/
	.w-new:not(.w-tracked) {
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-decoration-thickness: 2px;
		text-underline-offset: 0.22em;
	}

	/* Tracked words wear the garden's own bed colours, softened: this is a text,
	   not a progress bar, and three saturated underlines would read as errors. */
	.w-tracked {
		text-decoration: underline;
		text-decoration-thickness: 1.5px;
		text-underline-offset: 0.22em;
	}

	/* A garden word looked up in this text: the underline keeps its bed colour
	   and loses its solidity. A change of texture, not of hue — one more colour
	   on a page that already carries three would read as an alarm. */
	.w-tracked.w-lapsed {
		text-decoration-style: dotted;
		text-decoration-thickness: 2px;
	}

	.tool.done {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--primary-strong);
		font-weight: 700;
	}

	.w-tracked.w-new {
		text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.w-tracked.w-young {
		text-decoration-color: color-mix(
			in srgb,
			color-mix(in srgb, var(--primary) 55%, var(--amber)) 55%,
			transparent
		);
	}

	.w-tracked.w-solid {
		text-decoration-color: color-mix(in srgb, var(--primary) 55%, transparent);
	}

	/* `known` and `plain` are deliberately bare — nothing to say about a word the
	   learner reads straight through. */

	.w.is-open {
		background: var(--primary-soft);
	}

	.text-tools {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-top: 0.9rem;
	}

	.reading-block {
		margin: 0.6rem 0 0;
		line-height: 1.6;
	}

	/* Reading the translation stays a decision, as it is in conversation mode. */
	.reveal {
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.8rem;
		text-decoration: underline dotted;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.reveal:hover {
		color: var(--text);
	}

	.reveal:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.translation {
		margin: 0.6rem 0 0;
		color: var(--text-muted);
		font-size: 0.95rem;
		line-height: 1.6;
	}

	/* The word card ------------------------------------------------------- */

	/*
	  The base case is a phone, so the card is a sheet pinned to the foot of the
	  viewport — the text stays where it was and the answer comes to the thumb.
	  The wide layout below turns it back into a facing page.
	*/
	.card-col.is-open {
		position: fixed;
		z-index: 20;
		left: 0;
		right: 0;
		bottom: 0;
		max-height: 58dvh;
		overflow-y: auto;
		padding-inline: var(--gutter);
		padding-bottom: env(safe-area-inset-bottom);
	}

	.word-card {
		padding: 1rem 1.1rem 1.2rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	.word-head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.word-id {
		flex: 1 1 auto;
		min-width: 0;
	}

	.word-term {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.4rem;
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close:hover {
		border-color: var(--border);
		background: var(--surface-alt);
		color: var(--text);
	}

	.close:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.word-status {
		margin: 0.5rem 0 0;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.word-meaning {
		margin: 0.3rem 0 0;
		font-size: 1.02rem;
		line-height: 1.45;
	}

	.word-card .stitch {
		margin: 0.9rem 0;
	}

	.word-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.word-actions .btn {
		flex: 1 1 9rem;
		padding: 0.65rem 1rem;
		font-size: 0.88rem;
	}

	.summary {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.error {
		margin: 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.card-error {
		margin-top: 0.75rem;
	}

	@media (min-width: 48rem) {
		/*
		  The spread opens: the text on one page, the word card on the other, and
		  the card follows the reader down instead of being scrolled past. Every
		  line here undoes one of the sheet's, which is the price of writing the
		  phone as the base case rather than as the exception.
		*/
		.card-col.is-open {
			position: sticky;
			z-index: auto;
			top: 1rem;
			left: auto;
			right: auto;
			bottom: auto;
			max-height: none;
			overflow: visible;
			padding-inline: 0;
			padding-bottom: 0;
		}

		.word-card {
			border-radius: var(--radius-lg);
		}

		.text-col.has-card {
			padding-bottom: 0;
		}
	}

	@media (min-width: 72rem) {
		/* Full desktop: the text is what the page is for, so it takes more of the
		   extra width than the card opposite it. */
		.reader-spread {
			grid-template-columns: 3fr 2fr;
		}
	}
</style>
