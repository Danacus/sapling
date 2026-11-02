<!--
  Spike: a page viewer with the learner's words annotated on the page itself.
  A PDF or page images are drawn as they print; each page's text comes from
  the PDF's own text layer where it has one, else from on-device OCR
  (`$lib/ocr`, PP-OCRv5 in a worker). Either way a page is lines of text with
  every character's x, so a word is underlined in place by the reader's own
  annotation (by how well it is held) and opens the word card.
  Nothing is stored: the file stays on the device, the page is read on open.

  The book is open on the desk. At ≥48rem the page faces a panel — "On this
  page" (the legend, the words not held yet), the word card docked in its
  place when one is tapped, or the steps of reading a scanned page while OCR
  runs — and at ≥72rem a rail of nearby pages joins on the left. A phone shows
  one page at the width of the screen, a bar at its foot (turn, Page | Lines,
  Words) and the reader's sheet for the card and the word list. Settings are
  not on the screen: the script is the profile's, the backend and the source
  are automatic, and the model size is a quiet device preference.

  Two annotations of every line are kept, tokenized alike so their indices
  agree: one in the learner's own `RomanizationMode` for anything drawn as
  text (the Lines view, the larger line in the sheet), and one with every
  reading (`'on'`) for what a word *is* — its card, its row in the list and
  the reading it is filed with.
-->
<script lang="ts">
	import { page as route } from '$app/state';
	import { untrack } from 'svelte';

	import { addWords } from '$lib/assistant';
	import { getAllItems, getKnownTerms, getProfile, recordTextbookStudy } from '$lib/db';
	import { modelSet, ocrPage, scriptFor, type OcrLine } from '$lib/ocr';
	import { isPdf, openDocument, type ViewerDocument, type ViewerPage } from '$lib/ocr/pdf';
	import { getOcrModelSize, getRomanizationMode } from '$lib/prefs';
	import {
		annotateSentence,
		glossWords,
		lookUpWord,
		studyTracker,
		tokenizeByTerms,
		type AnnotateContext,
		type ReadingWord,
		type TokenizeFn
	} from '$lib/reading';
	import { syncRemotes } from '$lib/remotes';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import { targetTagOf, termKey } from '$lib/text';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import FileSlot from '../FileSlot.svelte';
	import {
		clampPage,
		downloadOf,
		fileTitle,
		foldProgress,
		forTarget,
		legendOf,
		megabytes,
		NO_STEPS,
		notYetWords,
		offsetOf,
		textLinesOf,
		unsureLines,
		wordAt,
		type ReadingSteps
	} from './viewer';

	/* ---- The learner --------------------------------------------------------- */

	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);
	const mode = getRomanizationMode();
	/** The adaptive roll, memoised per open file (`reading.md`). */
	let rolls = $state.raw(new Map<string, boolean>());
	const ctx = $derived<AnnotateContext>({ items, knownTerms, mode, rolls });
	const fullCtx = $derived<AnnotateContext>({ items, knownTerms, mode: 'on', rolls: new Map() });
	const lang = $derived(profile ? targetTagOf(profile) : undefined);
	const script = $derived(scriptFor(lang));

	$effect(() => {
		let cancelled = false;
		void Promise.all([getProfile(), getAllItems(), getKnownTerms()]).then(
			([loadedProfile, loadedItems, known]) => {
				if (cancelled || !loadedProfile) return;
				profile = loadedProfile;
				items = loadedItems;
				knownTerms = known;
				if (!hasLocalRomanizer(targetTagOf(loadedProfile))) return;
				void loadRomanizer(targetTagOf(loadedProfile)).then((loaded) => {
					if (!cancelled && loaded) tokenize = (source, terms) => loaded.tokenize(source, terms);
				});
			}
		);
		return () => {
			cancelled = true;
		};
	});

	/** `?debug` outlines every line the page was read as. */
	const debug = $derived(route.url.searchParams.has('debug'));

	/* ---- The viewport ---------------------------------------------------------- */

	/**
	 * Asked of the viewport rather than left to CSS, as the reader does: the
	 * panel, the rail's thumbnails and the phone's sheet are each built only
	 * where they are shown. The numbers are the stylesheet's two breakpoints.
	 */
	let wide = $state(false);
	let broad = $state(false);
	$effect(() => {
		const wideQuery = window.matchMedia('(min-width: 48rem)');
		const broadQuery = window.matchMedia('(min-width: 72rem)');
		const sync = () => {
			wide = wideQuery.matches;
			broad = broadQuery.matches;
		};
		sync();
		wideQuery.addEventListener('change', sync);
		broadQuery.addEventListener('change', sync);
		return () => {
			wideQuery.removeEventListener('change', sync);
			broadQuery.removeEventListener('change', sync);
		};
	});

	let zoom = $state<'whole' | 'width'>('whole');
	/** Page or Lines: a phone's choice; the spread always shows the page. */
	let view = $state<'page' | 'lines'>('page');
	const shownView = $derived(wide ? 'page' : view);

	/* ---- The document and the page ------------------------------------------ */

	// Raw: a document is a handle, and the raster goes to a worker — a proxy cannot be cloned.
	let doc = $state.raw<ViewerDocument | undefined>(undefined);
	let title = $state('');
	let kind = $state('');
	let pageNo = $state(1);
	let shown = $state.raw<{ n: number; page: ViewerPage } | undefined>(undefined);
	let drawing = $state(false);
	let error = $state('');

	async function pickFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		if (files.length === 0) return;
		error = '';
		try {
			const opened = await openDocument(files);
			doc?.close();
			ocrCache.clear();
			clearThumbs();
			rolls = new Map();
			doc = opened;
			title = fileTitle(files);
			kind =
				files.length === 1 && isPdf(files[0])
					? `PDF · ${opened.count} ${opened.count === 1 ? 'page' : 'pages'}`
					: 'Page images';
			turnTo(1);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that file.';
		}
	}

	/** Every page change goes through here: the card and the meanings belong to a page. */
	function turnTo(n: number) {
		if (!doc) return;
		pageNo = clampPage(n, doc.count, pageNo);
		picked = undefined;
		sheet = false;
		found = {};
		glossError = '';
	}

	function commitPageInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (!doc) return;
		turnTo(clampPage(Number(input.value), doc.count, pageNo));
		input.value = String(pageNo);
	}

	// Draw the page whenever the document or the page number changes.
	$effect(() => {
		const current = doc;
		const n = pageNo;
		if (!current) return;
		let cancelled = false;
		drawing = true;
		void current
			.page(n)
			.then((loaded) => {
				if (cancelled) return URL.revokeObjectURL(loaded.url);
				if (shown) URL.revokeObjectURL(shown.page.url);
				shown = { n, page: loaded };
			})
			.catch((cause) => {
				if (!cancelled) error = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				if (!cancelled) drawing = false;
			});
		return () => {
			cancelled = true;
		};
	});

	/* ---- Reading the page ------------------------------------------------------ */

	// The text reader's size is a setting (Settings → Reading printed pages).
	const set = $derived(modelSet(script, getOcrModelSize()));

	let lines = $state.raw<OcrLine[]>([]);
	let reading = $state(false);
	let steps = $state.raw<ReadingSteps>(NO_STEPS);
	/** Model sets that have read a page this session: the worker holds them warm. */
	const warm = new Set<string>();
	let readerWarm = $state(false);

	/** OCR answers by page and model, for this open only. */
	const ocrCache = new Map<string, OcrLine[]>();

	/** A text layer worth trusting: some letters, not just page numbers. */
	function hasText(page: ViewerPage): boolean {
		return page.textLines.reduce((n, line) => n + line.text.trim().length, 0) >= 20;
	}

	// Read the page: its own text where it has some, else OCR.
	$effect(() => {
		const current = shown;
		const models = set;
		if (!current) return;
		let cancelled = false;
		error = '';
		if (hasText(current.page)) {
			lines = current.page.textLines;
			reading = false;
			return;
		}
		const key = `${current.n}:${models.id}`;
		const cached = ocrCache.get(key);
		if (cached) {
			lines = cached;
			reading = false;
			return;
		}
		lines = [];
		reading = true;
		steps = NO_STEPS;
		readerWarm = warm.has(models.id);
		void ocrPage(current.page.raster, models, 'auto', (progress) => {
			if (!cancelled) steps = foldProgress(steps, progress);
		})
			.then((result) => {
				const text = textLinesOf(result.lines);
				ocrCache.set(key, text);
				warm.add(models.id);
				if (cancelled) return;
				lines = text;
			})
			.catch((cause) => {
				if (!cancelled) error = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				if (!cancelled) reading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const download = $derived(downloadOf(steps));
	const unsure = $derived(unsureLines(lines));

	/* ---- Words on the page ----------------------------------------------------- */

	/** Every line with every reading: what a word is. */
	// Only words in the target's script are words here: a textbook's English
	// glosses and pinyin are text on the page, not things to look up or count.
	const fullWords = $derived(
		lines.map((line) => forTarget(annotateSentence(line.text, tokenize, fullCtx), lang))
	);
	/** Every line as the learner reads it: what is drawn as text. */
	const shownWords = $derived(
		mode === 'on'
			? fullWords
			: lines.map((line) => forTarget(annotateSentence(line.text, tokenize, ctx), lang))
	);
	/**
	 * The lines the Lines view shows: those with a word in the target script.
	 * The book's glosses, pinyin and page furniture stay on the page itself.
	 */
	const targetLines = $derived(
		fullWords.flatMap((words, l) => (words.some((word) => word.key) ? [l] : []))
	);
	const hasReadings = $derived(shownWords.some((words) => words.some((word) => word.reading)));

	interface Placed {
		word: ReadingWord;
		line: number;
		offset: number;
		/** Percentages of the page. */
		left: number;
		top: number;
		width: number;
		height: number;
	}

	const placed = $derived.by(() => {
		const page = shown?.page;
		if (!page) return [];
		const { width: W, height: H } = page.raster;
		const out: Placed[] = [];
		lines.forEach((line, l) => {
			let at = 0;
			for (const word of fullWords[l] ?? []) {
				const start = at;
				at += word.text.length;
				if (!word.key) continue;
				const x0 = line.edges[start] ?? line.box.x;
				const x1 = line.edges[at] ?? line.box.x + line.box.w;
				out.push({
					word,
					line: l,
					offset: start,
					left: (x0 / W) * 100,
					top: (line.box.y / H) * 100,
					width: (Math.max(1, x1 - x0) / W) * 100,
					height: (line.box.h / H) * 100
				});
			}
		});
		return out;
	});

	const legend = $derived(legendOf(fullWords));
	const notYet = $derived(notYetWords(lines, fullWords));

	function boxStyle(line: OcrLine, raster: { width: number; height: number }) {
		return {
			left: (line.box.x / raster.width) * 100,
			top: (line.box.y / raster.height) * 100,
			width: (line.box.w / raster.width) * 100,
			height: (line.box.h / raster.height) * 100
		};
	}

	function wordClass(word: ReadingWord): string {
		return `w-${word.status}${word.maturity ? ` w-${word.maturity}` : ''}`;
	}

	/* ---- Meanings for the whole page ------------------------------------------ */

	/** Found meanings by `termKey`, for this page and this open only — never stored. */
	let found = $state<Record<string, string>>({});
	let finding = $state(false);
	let glossError = $state('');
	const unglossed = $derived(notYet.filter((word) => !found[termKey(word.term)]));

	async function findMeanings() {
		if (!profile || finding || unglossed.length === 0) return;
		const asked = unglossed;
		const askedOn = pageNo;
		finding = true;
		glossError = '';
		try {
			const glossed = await glossWords({
				profile: { nativeLanguage: profile.nativeLanguage, targetLanguage: profile.targetLanguage },
				words: asked.map((word) => ({ term: word.term, sentence: word.sentence }))
			});
			if (pageNo !== askedOn) return;
			const next = { ...found };
			for (const gloss of glossed) {
				const key = termKey(gloss.term);
				if (gloss.meaning.trim() && !next[key]) next[key] = gloss.meaning.trim();
			}
			found = next;
		} catch (cause) {
			glossError = cause instanceof Error ? cause.message : 'Could not find those meanings.';
		} finally {
			finding = false;
		}
	}

	/* ---- The word card ------------------------------------------------------- */

	/**
	 * The open word as a position — a line and a character offset into it —
	 * never the word itself: adding re-annotates the page (and may re-cut a
	 * line around the new term), and the card should show the word's new
	 * status rather than the one it was tapped with.
	 */
	let picked = $state<{ line: number; offset: number } | undefined>(undefined);
	/** A phone's sheet holds the word list (when no card is open over it). */
	let sheet = $state(false);
	let meaning = $state('');
	let explanation = $state('');
	let looking = $state(false);
	let adding = $state(false);
	let cardError = $state('');
	let addedNote = $state('');

	const open = $derived.by(() => {
		if (!picked) return undefined;
		const words = fullWords[picked.line];
		const hit = words ? wordAt(words, picked.offset) : undefined;
		if (!hit || !hit.word.key) return undefined;
		return {
			line: picked.line,
			index: hit.index,
			offset: offsetOf(words, hit.index),
			word: hit.word,
			sentence: lines[picked.line]?.text ?? hit.word.text
		};
	});

	function pick(line: number, offset: number) {
		picked = { line, offset };
		const word = fullWords[line] ? wordAt(fullWords[line], offset)?.word : undefined;
		meaning = word ? (found[termKey(word.text)] ?? '') : '';
		explanation = '';
		cardError = '';
		addedNote = '';
	}

	function closeCard() {
		picked = undefined;
	}

	function isOpen(line: number, index: number): boolean {
		return open?.line === line && open.index === index;
	}

	async function lookUp() {
		if (!open || !profile || looking) return;
		const asked = picked;
		const word = open.word;
		looking = true;
		cardError = '';
		try {
			const gloss = await lookUpWord({
				profile: { nativeLanguage: profile.nativeLanguage, targetLanguage: profile.targetLanguage },
				wordCount: items.length,
				term: word.text,
				sentence: open.sentence
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

	async function addOpen() {
		if (!open || adding || !meaning.trim()) return;
		const word = open.word;
		adding = true;
		cardError = '';
		try {
			const outcome = await addWords([
				{
					term: word.text.trim(),
					meaning: meaning.trim(),
					...(word.reading?.trim() ? { romanization: word.reading.trim() } : {})
				}
			]);
			addedNote = outcome.summary;
			// The page recolours under the open card, which now shows the word held.
			items = await getAllItems();
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not add that word.';
		} finally {
			adding = false;
		}
	}

	/* ---- The rail ---------------------------------------------------------------- */

	/** Every page of the book: the rail scrolls through them all. */
	const pages = $derived(doc ? Array.from({ length: doc.count }, (_, i) => i + 1) : []);
	let thumbs = $state<Record<number, string>>({});
	const thumbsAsked = new Set<number>();
	let railEl = $state<HTMLElement | undefined>(undefined);

	function clearThumbs() {
		for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
		thumbs = {};
		thumbsAsked.clear();
	}

	function askThumb(n: number) {
		const current = doc;
		if (!current || thumbsAsked.has(n)) return;
		thumbsAsked.add(n);
		void current
			.thumbnail(n)
			.then((url) => {
				if (doc !== current) return URL.revokeObjectURL(url);
				thumbs[n] = url;
			})
			.catch(() => undefined);
	}

	/**
	 * A thumbnail is drawn once its slot scrolls near the rail's view, so a
	 * 150-page book draws the dozen the learner can see, not all 150.
	 */
	function lazyThumb(node: HTMLElement, n: number) {
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				askThumb(n);
				observer.disconnect();
			},
			{ root: node.closest('.rail'), rootMargin: '300px 0px' }
		);
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}

	// The current page stays in the rail's view as the learner turns pages,
	// scrolled inside the rail only — never the window.
	$effect(() => {
		const rail = railEl;
		const n = pageNo;
		const slot = rail?.querySelector<HTMLElement>(`[data-page="${n}"]`);
		if (!rail || !slot) return;
		const top = slot.offsetTop;
		const bottom = top + slot.offsetHeight;
		if (top >= rail.scrollTop && bottom <= rail.scrollTop + rail.clientHeight) return;
		const target = top - (rail.clientHeight - slot.offsetHeight) / 2;
		// A long jump lands at once: gliding past eighty slots would draw all eighty.
		const far = Math.abs(target - rail.scrollTop) > rail.clientHeight * 2;
		rail.scrollTo({ top: target, behavior: far ? 'instant' : 'smooth' });
	});

	$effect(() => () => {
		doc?.close();
		clearThumbs();
	});

	/**
	 * Study time, wired as the reader wires it (`$lib/reading/study`): one
	 * tracker per open document, its spans `studied` events that name no
	 * document, since the viewer stores nothing. Nothing plays here.
	 */
	$effect(() => {
		if (!doc) return;
		const tracker = untrack(() =>
			studyTracker({
				now: Date.now,
				visible: document.visibilityState === 'visible',
				write: (span) => void recordTextbookStudy(span.at, span.ms).catch(() => {})
			})
		);
		const input = () => tracker.signal({ kind: 'input' });
		const visibility = () =>
			tracker.signal({ kind: 'visible', visible: document.visibilityState === 'visible' });
		const leave = () => tracker.signal({ kind: 'leave' });
		const inputs = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
		for (const kind of inputs) {
			window.addEventListener(kind, input, { capture: true, passive: true });
		}
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('pagehide', leave);
		const tick = setInterval(() => tracker.signal({ kind: 'tick' }), 15_000);
		return () => {
			clearInterval(tick);
			for (const kind of inputs) window.removeEventListener(kind, input, { capture: true });
			document.removeEventListener('visibilitychange', visibility);
			window.removeEventListener('pagehide', leave);
			tracker.signal({ kind: 'leave' });
			// As leaving a text does: the span's write was posted first, so the pass reads it.
			void syncRemotes();
		};
	});

	function onKey(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		if (picked) closeCard();
		else sheet = false;
	}
</script>

<svelte:window onkeydown={onKey} />

<svelte:head>
	<title>Sapling · {title || 'Page viewer'}</title>
</svelte:head>

{#snippet icon(name: 'prev' | 'next' | 'close' | 'check' | 'lock' | 'plus' | 'open')}
	<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
		{#if name === 'prev'}<path d="m15 18-6-6 6-6" />
		{:else if name === 'open'}<path
				d="M4 7.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-6.5L9.5 5H6a2 2 0 0 0-2 2.5Z"
			/>
		{:else if name === 'next'}<path d="m9 18 6-6-6-6" />
		{:else if name === 'close'}<path d="m7 7 10 10M17 7 7 17" />
		{:else if name === 'check'}<path d="m5 12.5 4.5 4.5L19 7.5" />
		{:else if name === 'lock'}<rect x="5" y="11" width="14" height="9" rx="2" /><path
				d="M8 11V8a4 4 0 0 1 8 0v3"
			/>
		{:else}<path d="M12 5v14M5 12h14" />{/if}
	</svg>
{/snippet}

<!-- A line as text: tokens as buttons wearing no chrome, readings as ruby, the
     garden's underline. No whitespace between tokens: they reproduce the line. -->
{#snippet tokens(l: number)}{#each shownWords[l] ?? [] as word, w (w)}{#if word.key}<button
				type="button"
				class="tok {wordClass(word)}"
				class:open={isOpen(l, w)}
				onclick={() => pick(l, offsetOf(shownWords[l], w))}
				>{#if word.reading}<ruby>{word.text}<rt>{word.reading}</rt></ruby
					>{:else}{word.text}{/if}</button
			>{:else}{word.text}{/if}{/each}{/snippet}

{#snippet steps_()}
	<section class="reading-card" aria-live="polite">
		<h2 class="panel-title">Reading this page</h2>
		<ol class="steps">
			{#if download && !download.finished}
				<li class="step">
					<span class="step-row">
						<Spinner />
						<span class="step-name">Downloading the text reader</span>
						<span class="step-meta"
							>{megabytes(download.done)}{#if download.total}
								of {megabytes(download.total)}{/if}</span
						>
					</span>
					<span
						class="bar"
						class:indeterminate={!download.total}
						role="progressbar"
						aria-label="Text reader downloaded"
						aria-valuemin="0"
						aria-valuemax={download.total || undefined}
						aria-valuenow={download.total ? download.done : undefined}
						><span
							style:width={download.total
								? `${(download.done / download.total) * 100}%`
								: undefined}
						></span></span
					>
				</li>
			{:else if download || readerWarm || steps.starting}
				<li class="step done">
					<span class="step-row">
						<span class="tick">{@render icon('check')}</span>
						<span class="step-name"
							>{download ? 'Text reader downloaded' : 'Text reader ready'}</span
						>
						<span class="step-meta"
							>{download
								? `${megabytes(download.total || download.done)}, once`
								: 'on this device'}</span
						>
					</span>
				</li>
			{:else}
				<li class="step">
					<span class="step-row">
						<Spinner />
						<span class="step-name">Getting the text reader</span>
					</span>
				</li>
			{/if}
			<li
				class="step"
				class:waiting={download ? !download.finished : !(readerWarm || steps.starting)}
			>
				<span class="step-row">
					<span class="step-name">Finding the words</span>
					{#if steps.lines}<span class="step-meta"
							>{steps.lines.done} of {steps.lines.total} lines</span
						>{/if}
				</span>
				<span
					class="bar"
					class:indeterminate={!steps.lines}
					role="progressbar"
					aria-label="Lines read"
					aria-valuemin="0"
					aria-valuemax={steps.lines?.total}
					aria-valuenow={steps.lines?.done}
					><span
						style:width={steps.lines
							? `${(steps.lines.done / Math.max(1, steps.lines.total)) * 100}%`
							: undefined}
					></span></span
				>
			</li>
		</ol>
		<p class="note">{@render icon('lock')} Read on your device. The page never leaves it.</p>
	</section>
{/snippet}

{#snippet onThisPage()}
	<div class="on-page">
		<h2 class="panel-title">On this page</h2>
		<p class="panel-copy">
			Tap any word on the page to look it up. Underlined words are already in your garden.
		</p>
		<ul class="legend">
			<li><span class="swatch solid"></span>Well known<span class="n">{legend.solid}</span></li>
			<li><span class="swatch young"></span>Still learning<span class="n">{legend.young}</span></li>
			<li><span class="swatch new"></span>Just added<span class="n">{legend.new}</span></li>
			{#if unsure.length}
				<li>
					<span class="swatch unsure"></span>May be misread<span class="n">{unsure.length}</span>
				</li>
			{/if}
		</ul>
		<hr class="rule" />
		{#if lines.length === 0}
			<p class="panel-copy">No text was found on this page.</p>
		{:else if notYet.length === 0}
			<p class="panel-copy">Every word on this page is in your garden.</p>
		{:else}
			<h3 class="list-title">Not in your words yet · {notYet.length}</h3>
			<ul class="not-yet">
				{#each notYet as word (word.id)}
					{@const gloss = found[termKey(word.term)]}
					<li class="row">
						<span class="row-term" {lang}>{word.term}</span>
						<span class="row-about">
							{#if word.reading}<span class="row-reading">{word.reading}</span>{/if}
							{#if gloss}<span class="row-meaning">{gloss}</span>{/if}
						</span>
						<button
							type="button"
							class="icon-btn add"
							aria-label={`Add ${word.term}`}
							title="Open the word card"
							onclick={() => pick(word.segment, word.offset)}>{@render icon('plus')}</button
						>
					</li>
				{/each}
			</ul>
			{#if unglossed.length > 0}
				<button
					type="button"
					class="btn btn-ghost hairline"
					disabled={finding}
					onclick={() => void findMeanings()}
				>
					{finding ? 'Finding meanings…' : `Find meanings for all ${unglossed.length}`}
				</button>
			{/if}
			{#if glossError}<p class="error" role="alert">{glossError}</p>{/if}
		{/if}
	</div>
{/snippet}

{#snippet card(docked: boolean)}
	{#if open}
		{@const word = open.word}
		<div class="word-card" class:docked role="dialog" aria-label={`The word ${word.text}`}>
			{#if !docked}
				<!-- On a phone the printed line is small: it comes first, reflowed big. -->
				<span class="handle" aria-hidden="true"></span>
				<div class="context">
					<span class="context-label">The line, larger</span>
					<span class="larger" {lang}>{@render tokens(open.line)}</span>
				</div>
			{/if}
			<div class="card-head">
				<div class="card-title">
					{#if word.reading}<span class="card-reading">{word.reading}</span>{/if}
					<span class="card-term" {lang}>{word.text}</span>
				</div>
				<SpeakButton text={word.text} {lang} />
				<button type="button" class="icon-btn close" aria-label="Close" onclick={closeCard}
					>{@render icon('close')}</button
				>
			</div>
			{#if docked}
				<div class="context">
					<span class="context-label">On the page</span>
					<span class="context-line" {lang}
						>{open.sentence.slice(0, open.offset)}<b>{word.text}</b>{open.sentence.slice(
							open.offset + word.text.length
						)}</span
					>
				</div>
			{/if}
			{#if word.status === 'tracked' && word.gloss}
				<p class="card-meaning">{word.gloss.meaning}</p>
				<p class="card-status">{@render icon('check')} In your words</p>
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
							onclick={() => void addOpen()}
						>
							{adding ? 'Adding…' : 'Add to my words'}
						</button>
						{#if !explanation}
							<button
								type="button"
								class="btn btn-ghost hairline"
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
			{#if addedNote}<p class="added" aria-live="polite">{addedNote}</p>{/if}
		</div>
	{/if}
{/snippet}

<main class="shell shell-full">
	<header class="topbar">
		<BackLink href="/read" label="Back to your media" />
		<div class="identity">
			<p class="eyebrow">{doc ? kind : 'Page viewer'}</p>
			<h1>{doc ? title : 'Open a book'}</h1>
			{#if doc}<p class="where">Page {pageNo} of {doc.count}</p>{/if}
		</div>
		{#if doc}
			<label class="icon-btn open-file" title="Open another file">
				<input
					type="file"
					accept="application/pdf,image/*"
					multiple
					aria-label="Open another file"
					onchange={pickFiles}
				/>
				{@render icon('open')}
			</label>
		{/if}
		{#if doc && wide}
			<nav class="stepper" aria-label="Pages">
				<button
					type="button"
					class="icon-btn"
					aria-label="Previous page"
					disabled={pageNo <= 1}
					onclick={() => turnTo(pageNo - 1)}>{@render icon('prev')}</button
				>
				<label class="page-field">
					<span>Page</span>
					<input
						class="page-input"
						type="text"
						inputmode="numeric"
						aria-label="Page number"
						value={pageNo}
						onchange={commitPageInput}
						onkeydown={(event) => {
							if (event.key === 'Enter') commitPageInput(event);
						}}
					/>
					<span>of {doc.count}</span>
				</label>
				<button
					type="button"
					class="icon-btn"
					aria-label="Next page"
					disabled={pageNo >= doc.count}
					onclick={() => turnTo(pageNo + 1)}>{@render icon('next')}</button
				>
			</nav>
			<div class="segmented" role="group" aria-label="Zoom">
				<button type="button" aria-pressed={zoom === 'whole'} onclick={() => (zoom = 'whole')}
					>Whole page</button
				>
				<button type="button" aria-pressed={zoom === 'width'} onclick={() => (zoom = 'width')}
					>Fit width</button
				>
			</div>
		{/if}
	</header>

	{#if error}<p class="error banner" role="alert">{error}</p>{/if}

	{#if !doc}
		<section class="empty">
			<p>
				Open a textbook PDF, or photos of its pages. A page with real text uses it; a scan, or a
				page whose text is only drawn, is read on this device and never leaves it.
			</p>
			<FileSlot
				label="Open a PDF or page images"
				accept="application/pdf,image/*"
				icon="upload"
				multiple
				onchange={pickFiles}
			/>
		</section>
	{:else}
		<div class="viewer" class:has-rail={broad}>
			{#if broad}
				<aside class="rail" aria-label="Pages" bind:this={railEl}>
					<span class="rail-label">Pages</span>
					{#each pages as n (n)}
						<button
							type="button"
							class="thumb"
							aria-current={n === pageNo ? 'page' : undefined}
							aria-label={`Page ${n}`}
							data-page={n}
							use:lazyThumb={n}
							onclick={() => turnTo(n)}
						>
							<span class="thumb-page">
								{#if thumbs[n]}<img src={thumbs[n]} alt="" />{/if}
							</span>
							{n}
						</button>
					{/each}
				</aside>
			{/if}

			<div class="stage" class:whole={zoom === 'whole'}>
				{#if shownView === 'lines'}
					<div class="lines" class:has-ruby={hasReadings} {lang}>
						{#each targetLines as l (l)}
							<p class="line" class:unsure={unsure.includes(l)}>{@render tokens(l)}</p>
						{:else}
							{#if !reading}<p class="panel-copy">No text was found on this page.</p>{/if}
						{/each}
					</div>
				{:else if shown}
					{@const raster = shown.page.raster}
					<figure
						class="page"
						class:stale={drawing}
						style:aspect-ratio="{raster.width} / {raster.height}"
						style:--ratio={raster.width / raster.height}
					>
						<img src={shown.page.url} alt={`Page ${shown.n}`} />
						{#each unsure as l (l)}
							{@const box = boxStyle(lines[l], raster)}
							<span
								class="unsure-box"
								style:left="{box.left}%"
								style:top="{box.top}%"
								style:width="{box.width}%"
								style:height="{box.height}%"
							></span>
						{/each}
						{#if debug}
							{#each lines as line, l (l)}
								{@const box = boxStyle(line, raster)}
								<span
									class="line-box"
									style:left="{box.left}%"
									style:top="{box.top}%"
									style:width="{box.width}%"
									style:height="{box.height}%"
								></span>
							{/each}
						{/if}
						{#each placed as at, i (i)}
							<button
								type="button"
								class="w {wordClass(at.word)}"
								class:open={open?.line === at.line && open.offset === at.offset}
								style:left="{at.left}%"
								style:top="{at.top}%"
								style:width="{at.width}%"
								style:height="{at.height}%"
								aria-label={at.word.text}
								onclick={() => pick(at.line, at.offset)}
							></button>
						{/each}
					</figure>
				{:else}
					<div class="loading"><Spinner /></div>
				{/if}
			</div>

			{#if wide}
				<aside class="panel" aria-label="Words on this page">
					{#if reading}
						<div class="panel-card">{@render steps_()}</div>
					{:else if open}
						<div class="panel-card flush">
							{@render card(true)}
							<details class="more">
								<summary>On this page · {notYet.length} not in your garden</summary>
								{@render onThisPage()}
							</details>
						</div>
					{:else}
						<div class="panel-card">{@render onThisPage()}</div>
					{/if}
				</aside>
			{/if}
		</div>

		{#if !wide}
			{#if reading}
				<div class="phone-reading">{@render steps_()}</div>
			{/if}
			{#if open}
				<div class="sheet">{@render card(false)}</div>
			{:else if sheet}
				<div class="sheet" role="dialog" aria-label="On this page">
					<div class="sheet-head">
						<span class="handle" aria-hidden="true"></span>
						<button
							type="button"
							class="icon-btn close"
							aria-label="Close"
							onclick={() => (sheet = false)}>{@render icon('close')}</button
						>
					</div>
					{@render onThisPage()}
				</div>
			{/if}
			<nav class="bottom-bar" aria-label="Page controls">
				<button
					type="button"
					class="icon-btn"
					aria-label="Previous page"
					disabled={pageNo <= 1}
					onclick={() => turnTo(pageNo - 1)}>{@render icon('prev')}</button
				>
				<div class="segmented" role="group" aria-label="View">
					<button type="button" aria-pressed={view === 'page'} onclick={() => (view = 'page')}
						>Page</button
					>
					<button type="button" aria-pressed={view === 'lines'} onclick={() => (view = 'lines')}
						>Lines</button
					>
				</div>
				<button
					type="button"
					class="btn btn-primary words-btn"
					aria-expanded={sheet && !open}
					onclick={() => {
						picked = undefined;
						sheet = !sheet;
					}}>Words · {notYet.length}</button
				>
				<button
					type="button"
					class="icon-btn"
					aria-label="Next page"
					disabled={pageNo >= doc.count}
					onclick={() => turnTo(pageNo + 1)}>{@render icon('next')}</button
				>
			</nav>
		{/if}
	{/if}
</main>

<style>
	/* The garden's three underlines, as the reader colours them. */
	main {
		--u-solid: var(--primary);
		--u-young: color-mix(in srgb, var(--primary) 55%, var(--amber));
		--u-new: var(--accent);
		--paper-shadow: 0 10px 30px rgb(60 50 20 / 14%), 0 1px 3px rgb(60 50 20 / 12%);
	}

	/* Scroll room for the bar fixed at the phone's foot. */
	.shell {
		padding-block: var(--gutter) 7rem;
	}

	.ico {
		width: 1.15rem;
		height: 1.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		flex: none;
	}

	/* The header ------------------------------------------------------------ */

	.topbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1.25rem;
		margin-bottom: 1rem;
	}

	.identity {
		flex: 1 1 12rem;
		min-width: 0;
	}

	/* The phone's header is the title and where you are; the eyebrow is the
	   spread's. */
	.eyebrow {
		display: none;
		margin: 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.25rem;
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.where {
		margin: 0.1rem 0 0;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.stepper {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.page-field {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-size: 0.95rem;
	}

	.page-input {
		width: 3.4rem;
		height: 2.6rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-weight: 700;
		text-align: center;
	}

	.page-input:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* Square icon controls, 44px: the turn, the close, the add. */
	.icon-btn {
		display: grid;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		flex: none;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}

	.icon-btn:hover:not(:disabled) {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.icon-btn:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.icon-btn:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.icon-btn.close {
		border-color: transparent;
		background: none;
		color: var(--text-muted);
	}

	.icon-btn.add {
		border-color: var(--border-strong);
		background: transparent;
		color: var(--primary);
	}

	/* A segmented control: ink fill for the pressed option. */
	.segmented {
		display: flex;
		flex: none;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.segmented button {
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 700;
		cursor: pointer;
	}

	.segmented button[aria-pressed='true'] {
		background: var(--text);
		color: var(--surface);
	}

	.segmented button:focus-visible {
		outline: none;
		box-shadow: inset var(--ring);
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

	.error.banner {
		margin: 0 0 1rem;
		max-width: var(--measure);
	}

	.empty {
		display: grid;
		gap: 1rem;
		max-width: var(--measure);
		color: var(--text-muted);
	}

	.empty p {
		margin: 0;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	/* The page ------------------------------------------------------------------ */

	.viewer {
		display: grid;
		gap: var(--gap);
	}

	.stage {
		display: flex;
		justify-content: center;
		min-width: 0;
	}

	.page {
		position: relative;
		width: 100%;
		margin: 0;
		border-radius: 2px;
		background: #fff;
		box-shadow: var(--paper-shadow);
		transition: opacity 0.15s ease;
	}

	/* The next page is being drawn: the old one stays, quieter. */
	.page.stale {
		opacity: 0.6;
	}

	.page img {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: inherit;
	}

	.line-box {
		position: absolute;
		border: 1px solid rgb(0 120 255 / 50%);
		pointer-events: none;
	}

	/* A line the recognizer was unsure of: outlined, not interactive. */
	.unsure-box {
		position: absolute;
		border-radius: 3px;
		outline: 1.5px dashed var(--accent);
		outline-offset: 2px;
		pointer-events: none;
	}

	/* A word is a transparent button over the printed glyphs; the underline is
	   its bottom edge, which descenders cross as they would a ruled line.
	   Stronger than the reader's softened underlines: these sit on a printed
	   page, not on our own type. */
	.w {
		position: absolute;
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: transparent;
		cursor: pointer;
	}

	.w:hover,
	.w.open {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
	}

	.w:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.w.w-tracked {
		border-bottom: 3px solid var(--u-solid);
	}

	.w.w-young {
		border-bottom-color: var(--u-young);
	}

	.w.w-new {
		border-bottom-color: var(--u-new);
	}

	/* Lines: the page reflowed as text, in the reader's voice ------------------- */

	.lines {
		display: grid;
		gap: 0.5rem;
		width: 100%;
		max-width: var(--measure);
	}

	.line {
		margin: 0;
		font-size: 1.35rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	/* Room over each line for its readings, only where there are any. */
	.has-ruby .line {
		line-height: 2.2;
	}

	.line.unsure {
		padding-inline: 0.35rem;
		border-radius: var(--radius-sm);
		outline: 1.5px dashed var(--accent);
	}

	.tok {
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

	.tok:hover,
	.tok.open {
		background: var(--primary-soft);
	}

	.tok.open {
		box-shadow: 0 0 0 2px var(--primary);
	}

	.tok.w-tracked {
		border-bottom: 2.5px solid var(--u-solid);
		border-radius: 3px 3px 0 0;
	}

	.tok.w-young {
		border-bottom-color: var(--u-young);
	}

	.tok.w-new {
		border-bottom-color: var(--u-new);
	}

	ruby {
		ruby-position: over;
		ruby-align: center;
	}

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

	/* The panel's content: one set of rules, a facing page or a sheet --------- */

	.panel-title {
		margin: 0;
		font-size: 1.35rem;
	}

	.panel-copy {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.95rem;
		line-height: 1.5;
	}

	.on-page {
		display: grid;
		gap: 1rem;
	}

	.legend {
		display: grid;
		gap: 0.6rem;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.95rem;
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}

	.legend .n {
		margin-left: auto;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.swatch {
		display: inline-block;
		flex: none;
		width: 1.75rem;
		border-bottom: 3px solid var(--u-solid);
	}

	.swatch.young {
		border-bottom-color: var(--u-young);
	}

	.swatch.new {
		border-bottom-color: var(--u-new);
	}

	.swatch.unsure {
		width: 1.1rem;
		height: 0.8rem;
		border: 1.5px dashed var(--accent);
		border-radius: 3px;
	}

	.rule {
		width: 100%;
		margin: 0;
		border: 0;
		border-top: 1px solid var(--border);
	}

	.list-title {
		margin: 0;
		font-family: var(--font);
		font-size: 0.95rem;
	}

	.not-yet {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 3rem;
		border-bottom: 1px solid var(--surface-alt);
	}

	.row:last-child {
		border-bottom: 0;
	}

	/* One line, never broken between CJK characters; a long term is cut with
	   an ellipsis rather than widening the card past its column. */
	.row-term {
		flex: 0 1 auto;
		min-width: 3.25rem;
		overflow: hidden;
		font-size: 1.25rem;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.row-about {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: 0 0.5rem;
		align-items: baseline;
		min-width: 0;
	}

	.row-reading {
		color: var(--text-muted);
		font-size: 0.88rem;
	}

	.row-meaning {
		font-size: 0.9rem;
		font-style: italic;
		overflow-wrap: anywhere;
	}

	.btn.hairline {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.on-page > .btn {
		min-height: 2.75rem;
	}

	/* Reading this page --------------------------------------------------------- */

	.reading-card {
		display: grid;
		gap: 1rem;
	}

	.steps {
		display: grid;
		gap: 1rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.step {
		display: grid;
		gap: 0.45rem;
	}

	.step-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.95rem;
	}

	.step-row :global(.spinner) {
		width: 1.1rem;
		height: 1.1rem;
	}

	.step-name {
		font-weight: 700;
	}

	.step-meta {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.88rem;
		font-variant-numeric: tabular-nums;
	}

	.step.waiting {
		opacity: 0.5;
	}

	.tick {
		display: inline-grid;
		place-items: center;
		color: var(--primary);
	}

	.bar {
		display: block;
		height: 0.4rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--surface-alt);
	}

	.bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--primary);
		transition: width 0.2s ease;
	}

	.bar.indeterminate > span {
		width: 35%;
		animation: slide 1.2s ease-in-out infinite;
	}

	.step.waiting .bar.indeterminate > span {
		animation: none;
		width: 0;
	}

	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar.indeterminate > span {
			animation: none;
			width: 100%;
			opacity: 0.4;
		}
	}

	.note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--text-muted);
		font-size: 0.88rem;
	}

	/* Another file: an icon button in the header whose input is the real control. */

	.open-file {
		position: relative;
		cursor: pointer;
	}

	.open-file input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}

	.open-file:focus-within {
		box-shadow: var(--ring);
	}

	/* The word card --------------------------------------------------------------- */

	.word-card {
		display: grid;
		gap: 0.85rem;
	}

	.handle {
		justify-self: center;
		width: 2.5rem;
		height: 0.3rem;
		border-radius: 3px;
		background: var(--border-strong);
	}

	.context {
		display: grid;
		gap: 0.35rem;
		padding: 0.75rem 0.9rem;
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.context-label {
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.context-line {
		font-size: 1.1rem;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}

	.context-line b {
		color: var(--primary-strong);
	}

	.larger {
		font-size: 1.5rem;
		line-height: 2.3;
		overflow-wrap: anywhere;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.card-title {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}

	.card-reading {
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	.card-term {
		font-size: 2rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.card-meaning {
		margin: 0;
		font-size: 1.1rem;
	}

	.card-status {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0;
		color: var(--primary-strong);
		font-size: 0.85rem;
		font-weight: 700;
	}

	.card-explanation {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.95rem;
		line-height: 1.5;
	}

	.word-card .field {
		margin: 0;
	}

	.card-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	/* Full-width on a phone, where the thumb is; side by side on the spread. */
	.card-actions .btn {
		flex: 1 1 100%;
		min-height: 2.75rem;
	}

	.added {
		margin: 0;
		color: var(--primary-strong);
		font-size: 0.88rem;
		font-weight: 700;
	}

	/* The phone: a bar at the foot, a sheet over it ---------------------------- */

	.bottom-bar {
		position: fixed;
		z-index: 20;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem var(--gutter) calc(0.5rem + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--surface);
	}

	.words-btn {
		flex: 1;
		min-height: 2.75rem;
		padding-inline: 0.75rem;
		white-space: nowrap;
	}

	.sheet {
		position: fixed;
		z-index: 30;
		left: 0;
		right: 0;
		bottom: 0;
		display: grid;
		gap: 1rem;
		max-height: 80dvh;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.6rem var(--gutter) calc(1.5rem + env(safe-area-inset-bottom));
		border-radius: 18px 18px 0 0;
		background: var(--surface);
		box-shadow: 0 -8px 30px color-mix(in srgb, var(--text) 18%, transparent);
	}

	.sheet-head {
		display: grid;
		grid-template-columns: 2.75rem 1fr 2.75rem;
		align-items: center;
	}

	.sheet-head .handle {
		grid-column: 2;
	}

	.phone-reading {
		position: fixed;
		z-index: 15;
		left: var(--gutter);
		right: var(--gutter);
		bottom: calc(4.5rem + env(safe-area-inset-bottom));
		padding: 1.1rem 1.15rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	.phone-reading .panel-title {
		font-size: 1.1rem;
	}

	/* The spread ---------------------------------------------------------------- */

	/* At ≥48rem the viewer is a frame, not a scroll: <main> is the viewport's
	   height, the viewer row takes what the header leaves (minmax(0, 1fr), or a
	   tall panel would push the row past the frame), and the rail, the page and
	   the panel each scroll inside themselves. The window never scrolls, so there
	   is never a scroll inside a scroll. */
	@media (min-width: 48rem) {
		.shell {
			display: flex;
			flex-direction: column;
			height: 100dvh;
			box-sizing: border-box;
			padding-block: var(--gutter);
		}

		.topbar {
			margin-bottom: 1.5rem;
		}

		.eyebrow {
			display: block;
		}

		.topbar h1 {
			font-size: 1.75rem;
		}

		.where {
			display: none;
		}

		.viewer {
			flex: 1 1 auto;
			min-height: 0;
			grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
			grid-template-rows: minmax(0, 1fr);
		}

		/* The page's own scroll: Fit width can be taller than the frame. A size
		   container, so Whole page can size the page from this height. */
		.stage {
			min-height: 0;
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			container-type: size;
			align-items: flex-start;
			padding-bottom: 0.75rem;
		}

		/* Whole page: the page's height is the stage's. */
		.stage.whole .page {
			width: min(100%, calc(100cqh * var(--ratio, 0.7)));
		}

		/* The card scrolls inside itself, so a page of many words never pushes
		   the panel past the frame. */
		.panel {
			display: flex;
			flex-direction: column;
			gap: 1rem;
			min-height: 0;
		}

		.panel-card {
			flex: 0 1 auto;
			min-height: 0;
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			padding: 1.25rem;
			border: 1px solid var(--border);
			border-radius: var(--radius-lg);
			background: var(--surface);
		}

		.panel-card.flush {
			display: grid;
			gap: 1rem;
		}

		.card-actions .btn {
			flex: 1 1 auto;
		}

		.more {
			border-top: 1px solid var(--border);
			padding-top: 0.85rem;
		}

		.more summary {
			padding-block: 0.7rem;
			color: var(--text-muted);
			font-size: 0.9rem;
			font-weight: 700;
			cursor: pointer;
		}

		.more[open] summary {
			margin-bottom: 0.75rem;
		}
	}

	@media (min-width: 72rem) {
		.viewer.has-rail {
			grid-template-columns: 6.5rem minmax(0, 1fr) minmax(18rem, 22rem);
		}

		/* The whole book, scrolling inside itself beside the page. Positioned, so
		   a slot's offsetTop is measured from the rail's own top. */
		.rail {
			position: relative;
			display: grid;
			justify-items: center;
			align-content: start;
			gap: 0.85rem;
			min-height: 0;
			padding: 0 0.4rem 0.6rem;
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
			scrollbar-color: var(--border) transparent;
		}

		.rail-label {
			position: sticky;
			top: 0;
			z-index: 1;
			justify-self: stretch;
			padding-block: 0 0.4rem;
			background: var(--bg);
			color: var(--text-muted);
			font-size: 0.75rem;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}

		.thumb {
			display: grid;
			justify-items: center;
			gap: 0.25rem;
			padding: 0;
			border: 0;
			background: none;
			color: var(--text-muted);
			font: inherit;
			font-size: 0.82rem;
			cursor: pointer;
		}

		.thumb-page {
			display: block;
			width: 5.25rem;
			aspect-ratio: 1 / 1.41;
			overflow: hidden;
			border: 1px solid var(--border);
			border-radius: 3px;
			background: #fffefa;
			box-shadow: 0 1px 2px rgb(60 50 20 / 8%);
		}

		.thumb-page img {
			display: block;
			width: 100%;
			height: 100%;
			object-fit: contain;
			background: #fff;
		}

		.thumb:hover .thumb-page {
			border-color: var(--border-strong);
		}

		.thumb[aria-current='page'] {
			color: var(--text);
			font-weight: 700;
		}

		.thumb[aria-current='page'] .thumb-page {
			border: 2px solid var(--primary);
			box-shadow: 0 0 0 4px var(--primary-soft);
		}

		.thumb:focus-visible {
			outline: none;
		}

		.thumb:focus-visible .thumb-page {
			box-shadow: var(--ring);
		}
	}
</style>
