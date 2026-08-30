<!--
  The reader: one stored text, a page at a time, with every word one tap from its
  meaning.

  The text itself is immutable — the sentences, the readings and the glossary are
  what the model wrote the day it was made. Everything the learner *sees* is
  decided here on every open, by `annotateSentence` against the garden and the
  marks as they stand today, which is why a text written last month shows this
  month's knowledge. The roll map that decides which tracked readings fade is
  created once per component instance and kept across re-annotations, so a word
  reads the same in sentence two and sentence nine — which is also why `lines`
  stays the annotation of the *whole* text and only the rendering is paged.

  Pages are `paginate`'s ranges over those sentences and the current one is
  `?p=` in the URL, clamped. Nothing about the position is stored: a text
  reopened from the library starts at page 1, deliberately, because a stored
  bookmark is a fact to sync and a page is cheap to skip past.

  This page owns every write. `$lib/reading` never touches the database: it is
  handed the vocabulary and hands back words, and adding, marking and looking up
  all happen here through the repositories — which is what puts them in the sync
  log for free. Reading is also review, scoped to the page: a lookup on a garden
  word is `Again` and confirming the page is `Good` for the rest of its garden
  words — both governed by the grade the word last got *today*, read back out of
  the item's own `recentGrades` rather than held in a set here, so the state
  survives a reload and agrees with the drill.
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
		localDay,
		markWord,
		recordLookup,
		updateItemAfterReview
	} from '$lib/db';
	import {
		annotateSentence,
		paginate,
		showSentenceReading,
		tokenizeByTerms,
		wordKey
	} from '$lib/reading';
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
	/**
	 * What the side panel shows when no word is open: a confirmation. One slot
	 * for every card the page has — the word, "finished?", "delete?" — so a
	 * confirmation never reshapes the header or lands above the text, and it
	 * arrives where the eye already looks for a card (facing page on a desk,
	 * sheet at the foot of a phone).
	 */
	let panel = $state<'finish' | 'delete' | null>(null);

	/**
	 * Words tapped on *this page*, by key — cleared whenever the page turns.
	 *
	 * Page-scoped on purpose: a word looked up on page one and then read fine on
	 * page three is exactly the re-encounter reading mode is for, and the `Again`
	 * put its card into relearning, so the later `Good` is what graduates it. What
	 * stops the same word collecting a `Good` on every page is not this set but
	 * the grade it already carries today.
	 */
	const tapped = new SvelteSet<string>();
	/** Every word tapped while this text was open, by key — a tapped word was not known. */
	const lookedUp = new SvelteSet<string>();
	/** Set once Finished has written; the panel then shows the receipt. */
	let finished = $state(false);
	let summary = $state('');
	/**
	 * Whether Finished also marks the un-tapped `new` words known. Off by default
	 * and never remembered: a word becoming "known" because the learner did not
	 * happen to tap it is LingQ's most-resented mechanic, so here it is a box
	 * ticked on purpose, every time.
	 */
	let markFresh = $state(false);

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
	 * Where the pages break. Derived from the stored sentences, never from the
	 * annotation: a break must not move because the learner added a word.
	 */
	const pages = $derived(paginate(text?.sentences ?? []));
	/** One page even for a text with no sentences, so the reader always has a frame. */
	const pageCount = $derived(Math.max(1, pages.length));

	/**
	 * Which page, from `?p=` — 1-based in the URL because that is what the label
	 * says, and clamped rather than 404'd: a stale link to page 9 of a text that
	 * now has 3 lands on the last page, which is where "read to the end" means.
	 */
	const pageIndex = $derived.by(() => {
		const asked = Number(page.url.searchParams.get('p') ?? '1');
		if (!Number.isFinite(asked)) return 0;
		return Math.min(Math.max(Math.trunc(asked) - 1, 0), pageCount - 1);
	});
	const pageRange = $derived(pages[pageIndex] ?? { start: 0, end: 0 });
	const lastPage = $derived(pageIndex >= pageCount - 1);

	/** The slice of the annotated text this page shows — the only part rendered. */
	const pageLines = $derived(lines.slice(pageRange.start, pageRange.end));

	/**
	 * What sits between two sentences on the page: the script's own rule, decided
	 * from the whole text — a space for Spanish, nothing for Chinese. Whole text
	 * rather than page, so a page of dialogue does not space differently from the
	 * one before it.
	 */
	const gap = $derived(
		usesInterWordSpaces(lines.map((line) => line.sentence.text).join('')) ? ' ' : ''
	);

	/** True once the romanizer's tokenizer is in — every reading is then ruby. */
	const localReadings = $derived(tokenize !== tokenizeByTerms);

	/** The page's translation, not the text's: it sits under the page it explains. */
	const translation = $derived(
		joinTokens(pageLines.map((line) => line.sentence.translation ?? '').filter(Boolean))
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
					pageLines
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

	/**
	 * The grade each garden word last got *today*, by item id — the whole of this
	 * page's review state, derived rather than kept.
	 *
	 * `recentGrades` is oldest-first and the ledger is what everything else reads,
	 * so taking the last entry of the day here means a lapse in this morning's
	 * drill and a lookup in this text are the same fact: reading a word you
	 * already failed today is not a second failure, and a word that appears on
	 * five pages cannot collect five `Good`s. It also survives a reload, which the
	 * set it replaces did not. `now` moves on every `refresh()`, so a session held
	 * open across midnight rolls over on the next write.
	 */
	const gradedToday = $derived.by(() => {
		const today = localDay(now);
		const out = new Map<string, number>();
		for (const item of items) {
			const last = item.recentGrades?.at(-1);
			if (last && localDay(last.at) === today) out.set(item.id, last.grade);
		}
		return out;
	});

	/** True for a garden word already counted as forgotten today, wherever that happened. */
	function isLapsed(word: ReadingWord): boolean {
		return word.itemId !== undefined && gradedToday.get(word.itemId) === Grade.Again;
	}

	$effect(() => {
		if (!browser) return;

		const id = page.params.id ?? '';
		let cancelled = false;
		loading = true;
		loadError = '';
		missing = false;

		// `withRecentGrades`: the page's whole review state is folded out of the
		// last grade each word got today, so the entries have to come along.
		Promise.all([
			getProfile(),
			getText(id),
			getAllItems({ withRecentGrades: true }),
			getKnownTerms()
		])
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

	/**
	 * Turning a page resets everything scoped to one: what was tapped, the
	 * checkbox, the receipt, whatever the panel held. Keyed on `pageIndex` alone,
	 * so a typed or restored `?p=` resets exactly as the buttons do — the page is
	 * the state, and the URL is where it lives.
	 */
	$effect(() => {
		void pageIndex;
		tapped.clear();
		markFresh = false;
		finished = false;
		summary = '';
		selected = null;
		panel = null;
		playing = false;
		stopSpeaking();
	});

	/**
	 * Re-reads what a write changed; the roll map survives, so nothing re-rolls.
	 *
	 * This is also how a grade becomes visible: the underlines and the status line
	 * read `recentGrades`, so every `review()` is followed by one of these.
	 */
	async function refresh() {
		const [loadedItems, known] = await Promise.all([
			getAllItems({ withRecentGrades: true }),
			getKnownTerms()
		]);
		items = loadedItems;
		knownTerms = known;
		now = Date.now();
	}

	function statusLine(word: ReadingWord): string {
		if (word.status === 'tracked' && isLapsed(word)) {
			return `Counted as forgotten · ${BEDS[word.maturity ?? 'new']}, back sooner`;
		}
		if (word.status === 'tracked') return `In your garden · ${BEDS[word.maturity ?? 'new']}`;
		if (word.status === 'known') return 'Marked known';
		if (word.status === 'new') return 'New word';
		return 'Not in your garden';
	}

	function close() {
		selected = null;
		panel = null;
	}

	/** Opens a confirmation in the panel, in place of whatever word was open. */
	function confirm(kind: 'finish' | 'delete') {
		selected = null;
		panel = kind;
	}

	/**
	 * Turns to a page, 1-based, by rewriting `?p=`.
	 *
	 * `replaceState` because paging is not somewhere to go *back* to — Back
	 * belongs to the library, and a ten-page text should not need ten presses to
	 * leave. `noScroll` because SvelteKit's restoration would land wherever this
	 * page was left; the new page starts at its own first line instead.
	 */
	async function turnTo(number: number) {
		const url = new URL(page.url);
		if (number <= 1) url.searchParams.delete('p');
		else url.searchParams.set('p', String(number));

		await goto(url, { replaceState: true, noScroll: true });
		window.scrollTo({ top: 0 });
	}

	function open(line: number, index: number) {
		const target = lines[line]?.words[index];
		if (!target?.key || !text) return;

		selected = { line, word: index };
		panel = null;
		meaningDraft = '';
		cardError = '';

		// A tap is a *lookup* — "I don't understand this, explain" — and it is the
		// one thing about a reading session that cannot be recovered afterwards.
		// Once per open, never awaited: a card must not wait on a write.
		void recordLookup(target.text, text.id, target.itemId);
		lookedUp.add(target.key);
		// Before the add, so a second tap on the same page is not a second grade:
		// `gradedToday` only catches up once the write has been read back.
		const again = target.status === 'tracked' && target.itemId && !tapped.has(target.key);
		tapped.add(target.key);

		// On a garden word the lookup is also a lapse: recall failed in context,
		// with the reading often showing — the easiest conditions there are — so
		// it is graded `Again`, once per *day* rather than once per text open: a
		// word already lost in this morning's drill is not lost twice. `add_words`
		// and the drill grade through the same repository call, so this lands in
		// the ledger as an ordinary review, amendable like any other.
		if (again && target.itemId && !isLapsed(target)) {
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

	/**
	 * What confirming this page would do — counted live, so the confirm step can
	 * say it. Over `pageLines` only: a page is the unit of reading and therefore
	 * the unit of grading, and the receipt is never totalled across pages.
	 */
	const finishPlan = $derived.by(() => {
		const read = new Map<string, string>();
		const looked = new Set<string>();
		const fresh = new Map<string, string>();
		for (const line of pageLines) {
			for (const word of line.words) {
				if (!word.key) continue;
				if (word.status === 'tracked' && word.itemId) {
					// Two separate reasons not to grade a word `Good` here: the learner
					// looked it up on this page, or it already has a `Good` today from
					// an earlier page or from the drill. `looked` is only the receipt's
					// count, so it names the words this page actually lost — a word
					// tapped and *added* here was never graded and is nobody's failure.
					if (tapped.has(word.key)) {
						if (gradedToday.get(word.itemId) === Grade.Again) looked.add(word.itemId);
					} else if (gradedToday.get(word.itemId) !== Grade.Good) {
						read.set(word.itemId, word.text);
					}
				} else if (word.status === 'new' && !lookedUp.has(word.key)) {
					// A tapped new word is one the learner needed explained — the last
					// thing to call known — and that stays true across the whole text,
					// not just this page.
					fresh.set(word.key, word.gloss?.term ?? word.text);
				}
			}
		}
		return { read: [...read.keys()], looked: looked.size, fresh: [...fresh.values()] };
	});

	/**
	 * Confirming a page: the reading counted, then on to the next one.
	 *
	 * Not looking a garden word up is the implicit `Good` — recall in context —
	 * but only at this explicit moment, never by scrolling past. The `new` words
	 * read without a tap can be marked known too — LingQ's paging — but only
	 * with `markFresh` ticked for this press. `plain` words are left alone —
	 * unglossed, they are as likely to be a segmenter's slip as a word.
	 *
	 * On the last page this is "Finished reading" and the receipt takes the
	 * button's place; on any other it is "Next page" and the writing happens
	 * before the turn, so a page is graded exactly once, when it is left.
	 */
	async function finishPage() {
		if (!text || writing || finished) return;
		const { read, looked } = finishPlan;
		const fresh = markFresh ? finishPlan.fresh : [];
		const last = lastPage;

		writing = true;
		pageError = '';
		try {
			for (const itemId of read) await review(itemId, Grade.Good);
			for (const term of fresh) await markWord(term, true);
			await refresh();
			const parts = [
				`${read.length} garden word${read.length === 1 ? '' : 's'} read fine`,
				...(looked > 0 ? [`${looked} forgotten`] : []),
				...(fresh.length > 0 ? [`${fresh.length} new marked known`] : [])
			];
			summary = parts.join(' · ');
			if (last) finished = true;
			else await turnTo(pageIndex + 2);
		} catch (cause) {
			pageError = cause instanceof Error ? cause.message : 'Could not save this page.';
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
	 * Reads the current page aloud, sentence by sentence.
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
		const sentences = pageLines.map((line) => line.sentence.text);
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
			panel = null;
		}
	}

	/**
	 * The status and maturity classes the colours hang off. `w-new` means two
	 * things — a glossed stranger and a freshly planted word — so the CSS tells
	 * them apart by whether `w-tracked` is there too.
	 */
	function wordClass(word: ReadingWord): string {
		const lapse = isLapsed(word) ? ' w-lapsed' : '';
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
						title={ttsAvailable(lang) ? 'Read this page aloud' : 'Speech is off — see Settings'}
						onclick={() => void listen()}
					>
						{playing ? 'Stop' : 'Listen'}
					</button>
					<!-- Confirmation lives in the panel, never here: the header's shape
					     stays the same whatever the learner is deciding. -->
					<button
						type="button"
						class="btn btn-ghost tool"
						class:is-active={panel === 'delete'}
						onclick={() => confirm('delete')}
					>
						Delete
					</button>
				</div>
			</header>

			{#if pageError}
				<p class="error spread-full" role="alert">{pageError}</p>
			{/if}

			<!-- The text. Capped at the reading measure whatever the column allows:
			     width buys the word card its own page, never a longer line. -->
			<div class="text-col">
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
				     and the sentences are joined by `gap`, the script's own rule.
				     Only this page's slice is rendered, but the indices stay the whole
				     text's, so `selected` still points into `lines` and a card survives
				     a re-annotation. -->
				<p class="prose">
					{#each pageLines as line, l (pageRange.start + l)}{@const s =
							pageRange.start + l}{#if l > 0}{gap}{/if}<span class="sentence"
							>{#each line.words as word, w (w)}{#if word.key === undefined}{word.text}{:else}<button
										type="button"
										class={wordClass(word)}
										class:is-open={selected?.line === s && selected?.word === w}
										onclick={() => open(s, w)}
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

				<!-- At the end of the page, because that is where the learner is when
				     they have read it. The primary action carries the page forward and
				     confirms in the panel first, because it writes; going *back* writes
				     nothing, so it is a quiet link beside it. The receipt takes the
				     button's place on the last page. -->
				<div class="finish-row">
					<p class="page-count">Page {pageIndex + 1} of {pageCount}</p>
					<div class="finish-actions">
						{#if finished}
							<p class="summary" aria-live="polite">Finished · {summary}</p>
						{:else}
							<button
								type="button"
								class="btn btn-primary finish-btn"
								class:is-active={panel === 'finish'}
								onclick={() => confirm('finish')}
							>
								{lastPage ? 'Finished reading' : 'Next page'}
							</button>
						{/if}
						{#if pageIndex > 0}
							<button type="button" class="reveal" onclick={() => void turnTo(pageIndex)}>
								Previous page
							</button>
						{/if}
					</div>
				</div>
			</div>

			<!-- The panel: the word card, or a confirmation in its place. A facing
			     page at 48rem, a sheet at the foot of the phone below it. -->
			<aside class="card-col" class:is-open={card !== null || panel !== null}>
				{#if panel === 'finish'}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="panel-title">
									{finished ? 'Counted' : lastPage ? 'Finished reading?' : 'Done with this page?'}
								</p>
							</div>
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>

						{#if finished}
							<p class="panel-copy">{summary}</p>
							<hr class="stitch" />
							<button type="button" class="btn btn-ghost btn-block" onclick={close}>Close</button>
						{:else}
							<p class="panel-copy">
								{finishPlan.read.length} garden word{finishPlan.read.length === 1 ? '' : 's'} on this
								page that you read without looking up will be reviewed as remembered{finishPlan.looked >
								0
									? `; ${finishPlan.looked} you looked up ${finishPlan.looked === 1 ? 'is' : 'are'} already counted as forgotten`
									: ''}.
							</p>
							{#if finishPlan.fresh.length > 0}
								<label class="finish-opt">
									<input type="checkbox" bind:checked={markFresh} />
									Also mark the {finishPlan.fresh.length} new word{finishPlan.fresh.length === 1
										? ''
										: 's'} I didn't tap as known
								</label>
							{/if}
							<hr class="stitch" />
							<div class="word-actions">
								<button
									type="button"
									class="btn btn-primary"
									disabled={writing}
									onclick={() => void finishPage()}
								>
									{writing ? 'Saving…' : lastPage ? 'Yes, done' : 'Yes, next page'}
								</button>
								<button type="button" class="btn btn-ghost" disabled={writing} onclick={close}>
									Not yet
								</button>
							</div>
						{/if}
					</div>
				{:else if panel === 'delete'}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="panel-title">Delete this text?</p>
							</div>
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>
						<p class="panel-copy">
							It goes for good, here and on every paired device. Words you added or marked from it
							stay.
						</p>
						<hr class="stitch" />
						<div class="word-actions">
							<button
								type="button"
								class="btn btn-ghost danger"
								disabled={writing}
								onclick={() => void remove()}
							>
								Delete for good
							</button>
							<button type="button" class="btn btn-ghost" disabled={writing} onclick={close}>
								Keep
							</button>
						</div>
					</div>
				{:else if card}
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

	.tool.is-active {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.btn.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		color: var(--danger);
	}

	.btn.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	/* The text ------------------------------------------------------------ */

	.text-col {
		max-width: var(--measure);
	}

	/* Room under the last line for the sheet that covers the foot of the phone. */
	/*
	  Scroll room under the text, always, on a phone: the sheet is pinned to
	  the foot of the viewport and this is what keeps the last lines reachable
	  above it. Reserved permanently rather than added when a card opens —
	  padding that appears on tap makes the page scrollable in the same instant,
	  and the scrollbar popping in reads as the layout jumping. The wide layout
	  below gives the card its own column and takes the room back.
	*/
	.text-col {
		padding-bottom: 45dvh;
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
		/* Within the tail `.text-col` reserves, so the sheet never covers a
		   line the page cannot scroll clear of. */
		max-height: 45dvh;
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

	/* The end of the page: where it sits in the text, one primary action, then
	   its receipt in its place. Separated from the prose by the same stitch the
	   cards use. */
	.finish-row {
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px dashed var(--border);
	}

	/* Wears the word card's status voice, because it says the same kind of thing:
	   where you are, not what to do. */
	.page-count {
		margin: 0 0 0.75rem;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* Forward and back on one line, wrapping on a narrow phone. No breakpoint:
	   the row holds one button and a link at every width. */
	.finish-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem 1.1rem;
	}

	.finish-btn.is-active {
		box-shadow: var(--ring);
	}

	.summary {
		margin: 0;
		color: var(--primary-strong);
		font-weight: 700;
	}

	.panel-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-weight: 700;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}

	.panel-copy {
		margin: 0.6rem 0 0;
		font-size: 0.95rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.finish-opt {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-size: 0.92rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.finish-opt input {
		accent-color: var(--primary);
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

		.text-col {
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
