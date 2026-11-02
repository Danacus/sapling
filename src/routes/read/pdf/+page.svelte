<!--
  A PDF reader with the learner's words annotated on the page itself. The
  book is pdf.js's own viewer (`PDFViewer`, `pdf_viewer.mjs`): every page in
  one continuous scroll, virtualised and drawn by pdf.js's rendering queue,
  zoomed from the toolbar, the keys, Ctrl/⌘+wheel, a trackpad or a two-finger
  pinch, and panned by dragging with the mouse. Its text layer, annotation
  layer, find and scripting are all off: what sits on a page is ours.

  Each page's text comes from the PDF's own text layer where it has one, else
  from on-device OCR (`$lib/ocr`, PP-OCRv5 in a worker), over a fixed raster
  of the same `PDFDocumentProxy` (`$lib/ocr/pdf.ts`) whatever the zoom. Either
  way a page is lines of text with every character's x, so a word is
  underlined in place by the reader's own annotation (by how well it is held)
  and opens the word card. The current page (`pagechanging`) and the one after
  it are read; their overlays (`PageOverlay.svelte`) are mounted into
  pdf.js's `div.page` in percentages, so a zoom moves nothing, and put back
  whenever pdf.js resets the page. Nothing is stored but, per device, the
  page and zoom last read in a file (`localStorage`, by name and size); the
  file stays on the device and is read on open.

  The book is open on a desk. At ≥48rem one slim toolbar runs over the desk,
  the page faces a panel — "On this page" (the legend, the words not held
  yet), the word card docked in its place when one is tapped, or the steps of
  reading a scanned page while OCR runs — and a rail of thumbnails can join on
  the left (open by default at ≥72rem); both toggle, and with both closed the
  page takes the width. A phone shows the desk under a compact header, a bar
  at its foot (turn, Page | Lines, Words) and the reader's sheet for the card
  and the word list. Settings are not on the screen: the script is the
  profile's, the backend and the source are automatic, and the model size is
  a quiet device preference.

  Two annotations of every line are kept, tokenized alike so their indices
  agree: one in the learner's own `RomanizationMode` for anything drawn as
  text (the Lines view, the larger line in the sheet), and one with every
  reading (`'on'`) for what a word *is* — its card, its row in the list and
  the reading it is filed with.
-->
<script lang="ts">
	import { page as route } from '$app/state';
	import { mount, unmount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	// Injected only while this page is mounted, in a layer of its own: its
	// `:root` and `.spread` rules would otherwise reach every screen after it.
	import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?inline';
	import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';

	import { addWords } from '$lib/assistant';
	import { getAllItems, getKnownTerms, getProfile, recordTextbookStudy } from '$lib/db';
	import { modelSet, ocrPage, scriptFor, type ModelSet, type OcrLine } from '$lib/ocr';
	import { isPdf, openPdf, viewerModule, type ViewerDocument, type ViewerPage } from '$lib/ocr/pdf';
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
	import Spinner from '$lib/ui/Spinner.svelte';
	import WordCard, { BEDS } from '$lib/ui/WordCard.svelte';
	import WordPopover from '$lib/ui/WordPopover.svelte';
	import { revealDelta, stepWord } from '$lib/ui/word-nav';
	import FileSlot from '../FileSlot.svelte';
	import PageOverlay from './PageOverlay.svelte';
	import {
		accumulateZoom,
		boxOf,
		clampPage,
		DEFAULT_ZOOM,
		downloadOf,
		fileTitle,
		foldProgress,
		forTarget,
		legendOf,
		megabytes,
		NO_STEPS,
		notYetWords,
		offsetOf,
		parsePosition,
		parseZoom,
		placeWords,
		positionKey,
		serializePosition,
		textLinesOf,
		unsureLines,
		wheelFactor,
		wordAt,
		ZOOM_PRESETS,
		zoomChoice,
		zoomLabel,
		zoomOf,
		zoomOrigin,
		zoomStep,
		type PageBox,
		type PlacedWord,
		type ReadingSteps,
		type Zoom
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

	// pdf.js's stylesheet, for as long as the viewer is on screen.
	$effect(() => {
		const style = document.createElement('style');
		style.textContent = `@layer pdfjs {\n${viewerCss}\n}`;
		document.head.append(style);
		return () => style.remove();
	});

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

	/** Page or Lines: a phone's choice; the spread always shows the page. */
	let view = $state<'page' | 'lines'>('page');
	const shownView = $derived(wide ? 'page' : view);

	/** The rail follows the width until the learner says otherwise. */
	let railChoice = $state<boolean | undefined>(undefined);
	let panelOpen = $state(true);
	const showRail = $derived(wide && (railChoice ?? broad));
	const showPanel = $derived(wide && panelOpen);

	/* ---- The document and the page ------------------------------------------ */

	// Raw: a document is a handle, and the raster goes to a worker — a proxy cannot be cloned.
	let doc = $state.raw<ViewerDocument | undefined>(undefined);
	let file = $state.raw<File | undefined>(undefined);
	let title = $state('');
	let pageNo = $state(1);
	let error = $state('');

	/** The zoom in effect (a fit or a scale) and the scale it came to. */
	let zoom = $state<Zoom>(DEFAULT_ZOOM);
	let scale = $state(1);

	function rememberedPosition(of: File) {
		try {
			return parsePosition(localStorage.getItem(positionKey(of)));
		} catch {
			return undefined;
		}
	}

	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	/** The page and zoom, a beat after they settle: a pinch reports dozens a second. */
	function savePosition() {
		const of = file;
		if (!of) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(positionKey(of), serializePosition({ page: pageNo, zoom }));
			} catch {
				// A convenience; the book still opens at its first page.
			}
		}, 300);
	}

	async function pickFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const picked = input.files?.[0];
		input.value = '';
		if (!picked) return;
		error = '';
		if (!isPdf(picked)) {
			error = 'That is not a PDF.';
			return;
		}
		try {
			const opened = await openPdf(picked);
			pageTexts.clear();
			readErrors.clear();
			clearThumbs();
			rolls = new Map();
			const position = rememberedPosition(picked);
			file = picked;
			title = fileTitle(picked);
			pageNo = clampPage(position?.page ?? 1, opened.count);
			zoom = position?.zoom ?? DEFAULT_ZOOM;
			resetPageState();
			doc = opened;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that file.';
		}
	}

	// A document is closed when another replaces it, or when the page goes.
	$effect(() => {
		const current = doc;
		return () => current?.close();
	});

	/** The card and the meanings belong to a page: a new page starts without them. */
	function resetPageState() {
		picked = undefined;
		sheet = false;
		found = {};
		glossError = '';
	}

	/** pdf.js says the current page changed — by a scroll, a jump or a pick. */
	function arrive(n: number) {
		if (n === pageNo) return;
		pageNo = n;
		resetPageState();
		savePosition();
	}

	/** Every page change the learner asks for: pdf.js scrolls there and says so. */
	function goTo(n: number) {
		if (!doc || !pdfViewer) return;
		pdfViewer.currentPageNumber = clampPage(n, doc.count, pageNo);
	}

	function commitPageInput(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		if (!doc) return;
		goTo(clampPage(Number(input.value), doc.count, pageNo));
		input.value = String(pageNo);
	}

	/* ---- pdf.js's viewer ------------------------------------------------------ */

	let containerEl = $state<HTMLDivElement | undefined>(undefined);
	let viewerEl = $state<HTMLDivElement | undefined>(undefined);
	// Raw: pdf.js owns the object; a proxy around it would break its private fields.
	let pdfViewer = $state.raw<PDFViewer | undefined>(undefined);
	let dragging = $state(false);

	function setZoom(next: Zoom) {
		if (pdfViewer) pdfViewer.currentScaleValue = String(next);
	}

	/**
	 * One step of a continuous zoom (a wheel, a pinch), anchored at a point on
	 * screen, through the factor account `accumulateZoom` keeps per gesture.
	 */
	function zoomAt(
		viewer: PDFViewer,
		container: HTMLElement,
		pending: number,
		factor: number,
		client: { x: number; y: number },
		pan?: [number, number]
	): number {
		const step = accumulateZoom(viewer.currentScale, pending, factor);
		if (step.scale === undefined) {
			if (pan) viewer.panBy(pan[0], pan[1]);
			return step.pending;
		}
		viewer.updateScale({
			scaleFactor: step.scale / viewer.currentScale,
			origin: zoomOrigin(client, container.getBoundingClientRect(), {
				left: container.offsetLeft,
				top: container.offsetTop
			}),
			...(pan ? { pan } : {}),
			drawingDelay: 400
		});
		return step.pending;
	}

	// The viewer, one per open document: built once the container is on screen,
	// opened where this file was last left, and every gesture wired to it.
	$effect(() => {
		const current = doc;
		const container = containerEl;
		const inner = viewerEl;
		if (!current || !container || !inner) return;
		const start = untrack(() => ({ page: pageNo, zoom }));
		const abort = new AbortController();
		const { signal } = abort;
		let viewer: PDFViewer | undefined;
		let touch: { destroy(): void } | undefined;
		let observer: MutationObserver | undefined;
		let resized: ResizeObserver | undefined;
		let ready = false;

		void viewerModule()
			.then((kit) => {
				if (signal.aborted) return;
				const eventBus = new kit.EventBus();
				// `abortSignal` is read by the constructor (its scroll and resize
				// watchers) but missing from the typings.
				const options: ConstructorParameters<typeof kit.PDFViewer>[0] & {
					abortSignal: AbortSignal;
				} = {
					container,
					viewer: inner,
					eventBus,
					abortSignal: signal,
					textLayerMode: 0,
					annotationMode: kit.AnnotationMode.DISABLE,
					annotationEditorMode: kit.AnnotationEditorType.DISABLE,
					enableAutoLinking: false
				};
				const built = new kit.PDFViewer(options);
				viewer = built;
				eventBus.on(
					'pagesinit',
					() => {
						ready = true;
						built.currentScaleValue = String(start.zoom);
						built.currentPageNumber = clampPage(start.page, current.count);
						attachOverlays();
					},
					{ signal }
				);
				eventBus.on(
					'pagechanging',
					({ pageNumber }: { pageNumber: number }) => {
						if (ready) arrive(pageNumber);
					},
					{ signal }
				);
				eventBus.on(
					'scalechanging',
					({ scale: next, presetValue }: { scale: number; presetValue?: string }) => {
						// pdf.js re-creates a page's contents on a zoom: the popover's
						// word goes with them, so the card closes rather than drift.
						if (next !== scale && wide) picked = undefined;
						scale = next;
						zoom = zoomOf(next, presetValue);
						if (ready) savePosition();
					},
					{ signal }
				);
				built.setDocument(current.proxy);
				pdfViewer = built;

				// pdf.js resets a page (a zoom, a redraw, leaving its buffer) by
				// emptying its div, our overlay with it: put it back each time.
				observer = new MutationObserver(attachOverlays);
				observer.observe(inner, { childList: true, subtree: true });

				// A fit is a fit of the frame: refit when the frame changes (a panel
				// toggled, the window resized).
				let frame = 0;
				resized = new ResizeObserver(() => {
					cancelAnimationFrame(frame);
					frame = requestAnimationFrame(() => {
						if (ready && typeof zoom === 'string') built.currentScaleValue = zoom;
					});
				});
				// The border box: a scrollbar appearing after a fit is not a resize.
				resized.observe(container, { box: 'border-box' });

				let pinchPending = 1;
				touch = new kit.TouchManager({
					container,
					signal,
					onPinchStart: () => {
						pinchPending = 1;
					},
					onPinching: (
						origin: [number, number],
						previous: number,
						distance: number,
						dx: number,
						dy: number
					) => {
						pinchPending = zoomAt(
							built,
							container,
							pinchPending,
							distance / previous,
							{ x: origin[0], y: origin[1] },
							[dx, dy]
						);
					},
					onPanning: (dx: number, dy: number) => built.panBy(dx, dy)
				});
			})
			.catch((cause) => {
				if (!signal.aborted) error = cause instanceof Error ? cause.message : String(cause);
			});

		// Ctrl/⌘+wheel and a trackpad pinch (a wheel with ctrlKey) zoom the page,
		// never the app; a plain wheel scrolls as it always does.
		let wheelPending = 1;
		const onWheel = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey) || !viewer) return;
			event.preventDefault();
			wheelPending = zoomAt(
				viewer,
				container,
				wheelPending,
				wheelFactor(event.deltaY, event.deltaMode),
				{ x: event.clientX, y: event.clientY }
			);
		};
		container.addEventListener('wheel', onWheel, { passive: false, signal });

		// Drag to pan with the mouse. A press on a word is a click, and a press
		// becomes a drag only once it has moved a few pixels.
		let press: { id: number; x: number; y: number; left: number; top: number } | undefined;
		container.addEventListener(
			'pointerdown',
			(event) => {
				if (event.pointerType !== 'mouse' || event.button !== 0) return;
				if ((event.target as Element | null)?.closest('button, a, input, select, textarea')) return;
				press = {
					id: event.pointerId,
					x: event.clientX,
					y: event.clientY,
					left: container.scrollLeft,
					top: container.scrollTop
				};
			},
			{ signal }
		);
		container.addEventListener(
			'pointermove',
			(event) => {
				if (!press || event.pointerId !== press.id) return;
				const dx = event.clientX - press.x;
				const dy = event.clientY - press.y;
				if (!dragging) {
					if (Math.hypot(dx, dy) < 4) return;
					dragging = true;
					container.setPointerCapture(press.id);
				}
				container.scrollLeft = press.left - dx;
				container.scrollTop = press.top - dy;
			},
			{ signal }
		);
		const release = (event: PointerEvent) => {
			if (!press || event.pointerId !== press.id) return;
			if (container.hasPointerCapture(press.id)) container.releasePointerCapture(press.id);
			press = undefined;
			dragging = false;
		};
		container.addEventListener('pointerup', release, { signal });
		container.addEventListener('pointercancel', release, { signal });

		return () => {
			abort.abort();
			touch?.destroy();
			observer?.disconnect();
			resized?.disconnect();
			unmountOverlays();
			viewer?.setDocument(null);
			pdfViewer = undefined;
			dragging = false;
		};
	});

	/* ---- Reading the page ------------------------------------------------------ */

	// The text reader's size is a setting (Settings → Reading printed pages).
	const set = $derived(modelSet(script, getOcrModelSize()));

	/** A page's text, and the size of the raster its boxes were measured on. */
	interface PageText {
		lines: OcrLine[];
		size: { width: number; height: number };
	}

	/** Pages read, by page and model, for this open only. */
	const pageTexts = new SvelteMap<string, PageText>();
	const readErrors = new SvelteMap<string, string>();
	const textKey = (n: number, models: ModelSet) => `${n}:${models.id}`;

	const currentKey = $derived(textKey(pageNo, set));
	const pageText = $derived(pageTexts.get(currentKey));
	const known = $derived(pageText !== undefined);
	const lines = $derived(pageText?.lines ?? []);
	const pageError = $derived(readErrors.get(currentKey));

	/** The page OCR is reading now, if any: its steps are the card's. */
	let readingPage = $state<number | undefined>(undefined);
	let steps = $state.raw<ReadingSteps>(NO_STEPS);
	const reading = $derived(readingPage === pageNo && !known);
	/** Model sets that have read a page this session: the worker holds them warm. */
	const warm = new Set<string>();
	let readerWarm = $state(false);

	/** A text layer worth trusting: some letters, not just page numbers. */
	function hasText(page: ViewerPage): boolean {
		return page.textLines.reduce((n, line) => n + line.text.trim().length, 0) >= 20;
	}

	/**
	 * Reads go one at a time, in the order asked — the current page, then the
	 * one after it — and a queued read whose page is no longer wanted when its
	 * turn comes is skipped, so flicking through a book reads the page it stops
	 * on, not every page it passed.
	 */
	let chain: Promise<void> = Promise.resolve();
	const queued = new Set<string>();
	let wanted: { doc?: ViewerDocument; pages: number[]; models: string } = {
		pages: [],
		models: ''
	};

	function stillWanted(current: ViewerDocument, n: number, models: ModelSet): boolean {
		return wanted.doc === current && wanted.models === models.id && wanted.pages.includes(n);
	}

	function enqueue(current: ViewerDocument, n: number, models: ModelSet) {
		const key = textKey(n, models);
		if (pageTexts.has(key) || queued.has(key)) return;
		queued.add(key);
		chain = chain.then(async () => {
			try {
				if (stillWanted(current, n, models) && !pageTexts.has(key)) {
					await readPage(current, n, models, key);
				}
			} catch (cause) {
				if (doc === current) {
					readErrors.set(key, cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				queued.delete(key);
			}
		});
	}

	async function readPage(current: ViewerDocument, n: number, models: ModelSet, key: string) {
		const page = await current.page(n);
		const size = { width: page.raster.width, height: page.raster.height };
		if (hasText(page)) {
			if (doc === current) pageTexts.set(key, { lines: page.textLines, size });
			return;
		}
		if (!stillWanted(current, n, models)) return;
		readingPage = n;
		steps = NO_STEPS;
		readerWarm = warm.has(models.id);
		try {
			const result = await ocrPage(page.raster, models, 'auto', (progress) => {
				if (readingPage === n) steps = foldProgress(steps, progress);
			});
			warm.add(models.id);
			if (doc === current) pageTexts.set(key, { lines: textLinesOf(result.lines), size });
		} finally {
			if (readingPage === n) readingPage = undefined;
		}
	}

	// Read the current page, then read ahead to the next.
	$effect(() => {
		const current = doc;
		const n = pageNo;
		const models = set;
		if (!current) return;
		const pages = [n, n + 1].filter((p) => p <= current.count);
		wanted = { doc: current, pages, models: models.id };
		untrack(() => {
			for (const p of pages) enqueue(current, p, models);
		});
	});

	const download = $derived(downloadOf(steps));
	const unsure = $derived(unsureLines(lines));

	/* ---- Words on the page ----------------------------------------------------- */

	// Only words in the target's script are words here: a textbook's English
	// glosses and pinyin are text on the page, not things to look up or count.
	function annotateLines(of: readonly OcrLine[], context: AnnotateContext) {
		return of.map((line) => forTarget(annotateSentence(line.text, tokenize, context), lang));
	}

	/** Every line with every reading: what a word is. */
	const fullWords = $derived(annotateLines(lines, fullCtx));
	/** Every line as the learner reads it: what is drawn as text. */
	const shownWords = $derived(mode === 'on' ? fullWords : annotateLines(lines, ctx));
	/**
	 * The lines the Lines view shows: those with a word in the target script.
	 * The book's glosses, pinyin and page furniture stay on the page itself.
	 */
	const targetLines = $derived(
		fullWords.flatMap((words, l) => (words.some((word) => word.key) ? [l] : []))
	);
	const hasReadings = $derived(shownWords.some((words) => words.some((word) => word.reading)));

	const legend = $derived(legendOf(fullWords));
	const notYet = $derived(notYetWords(lines, fullWords));

	/** The page read ahead, drawn on as soon as its text is in. */
	const nextText = $derived(
		doc && pageNo < doc.count ? pageTexts.get(textKey(pageNo + 1, set)) : undefined
	);
	const nextWords = $derived(nextText ? annotateLines(nextText.lines, fullCtx) : []);

	interface OverlayData {
		marks: PlacedWord[];
		unsure: PageBox[];
		debugLines: PageBox[];
	}

	function overlayOf(text: PageText, words: ReturnType<typeof annotateLines>): OverlayData {
		return {
			marks: placeWords(text.lines, words, text.size),
			unsure: unsureLines(text.lines).map((l) => boxOf(text.lines[l], text.size)),
			debugLines: debug ? text.lines.map((line) => boxOf(line, text.size)) : []
		};
	}

	/** What each page with a known text wears, by page number. */
	const overlays = $derived.by(() => {
		const out = new Map<number, OverlayData>();
		if (pageText) out.set(pageNo, overlayOf(pageText, fullWords));
		if (nextText) out.set(pageNo + 1, overlayOf(nextText, nextWords));
		return out;
	});

	/** Mounted overlays, by page: each in a host div of ours that pdf.js's page holds. */
	const mounted = new Map<number, { host: HTMLDivElement; instance: Record<string, unknown> }>();

	function attachOverlays() {
		const viewer = pdfViewer;
		if (!viewer) return;
		for (const [n, { host }] of mounted) {
			const div = viewer.getPageView(n - 1)?.div as HTMLElement | undefined;
			if (div && host.parentElement !== div) div.append(host);
		}
	}

	function unmountOverlays() {
		for (const { host, instance } of mounted.values()) {
			void unmount(instance);
			host.remove();
		}
		mounted.clear();
	}

	$effect(() => {
		const viewer = pdfViewer;
		const pages = [...overlays.keys()];
		if (!viewer) return;
		untrack(() => {
			for (const [n, { host, instance }] of mounted) {
				if (pages.includes(n)) continue;
				void unmount(instance);
				host.remove();
				mounted.delete(n);
			}
			for (const n of pages) {
				if (mounted.has(n)) continue;
				const host = document.createElement('div');
				host.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none';
				const instance = mount(PageOverlay, {
					target: host,
					props: {
						get marks() {
							return overlays.get(n)?.marks ?? [];
						},
						get unsure() {
							return overlays.get(n)?.unsure ?? [];
						},
						get debugLines() {
							return overlays.get(n)?.debugLines ?? [];
						},
						get open() {
							return n === pageNo && open ? { line: open.line, offset: open.offset } : undefined;
						},
						onpick: (line: number, offset: number) => pickOn(n, line, offset)
					}
				});
				mounted.set(n, { host, instance });
			}
			attachOverlays();
		});
	});

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
	let readingDraft = $state('');
	let explanation = $state('');
	/** The open word has a looked-up answer: the card asks nothing more. */
	let answered = $state(false);
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
		readingDraft = word?.reading ?? '';
		explanation = '';
		answered = false;
		cardError = '';
		addedNote = '';
	}

	/** Whether the card offers a Reading field: a word not in Latin script, as the reader decides. */
	const offersReading = $derived(
		open !== undefined && /\p{L}/u.test(open.word.text) && !/\p{Script=Latin}/u.test(open.word.text)
	);

	function statusLine(word: ReadingWord): string {
		if (word.status === 'tracked') return `In your garden · ${BEDS[word.maturity ?? 'new']}`;
		if (word.status === 'known') return 'Marked known';
		return 'Not in your garden';
	}

	/**
	 * The open word's button on the page, for the popover to point at — found
	 * after every render that could have replaced it. A word whose button is
	 * gone closes its card.
	 */
	let anchorEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const at = open;
		const n = pageNo;
		void overlays;
		if (!at || !wide || !containerEl) {
			anchorEl = null;
			return;
		}
		const el = containerEl.querySelector<HTMLElement>(
			`.page[data-page-number="${n}"] [data-word="${at.line}:${at.offset}"]`
		);
		anchorEl = el;
		if (!el) picked = undefined;
	});

	/** ← and →, with a card open: the card moves to the page's previous or next word. */
	function stepCard(dir: 1 | -1) {
		if (!open) return;
		const next = stepWord(fullWords, { line: open.line, word: open.index }, dir);
		if (next) pick(next.line, offsetOf(fullWords[next.line], next.word));
	}

	/**
	 * A row of *Not in your words yet*: its first occurrence on the page,
	 * scrolled into view inside pdf.js's container — never the window — and
	 * opened there. On a phone the sheet needs no anchor.
	 */
	function reveal(line: number, offset: number) {
		const container = containerEl;
		const el = container?.querySelector<HTMLElement>(
			`.page[data-page-number="${pageNo}"] [data-word="${line}:${offset}"]`
		);
		if (wide && container && el) {
			const delta = revealDelta(container.getBoundingClientRect(), el.getBoundingClientRect(), 48);
			if (delta.x || delta.y)
				container.scrollBy({ left: delta.x, top: delta.y, behavior: 'smooth' });
		}
		pick(line, offset);
	}

	/**
	 * A word tapped on the page read ahead makes that page the current one —
	 * in pdf.js too, without scrolling (its own `_setCurrentPageNumber`, which
	 * says so through `pagechanging`) — so the card and the panel follow it.
	 */
	function pickOn(n: number, line: number, offset: number) {
		if (n !== pageNo) {
			(
				pdfViewer as unknown as { _setCurrentPageNumber(n: number): boolean } | undefined
			)?._setCurrentPageNumber(n);
			arrive(n);
		}
		pick(line, offset);
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
			// Only into fields still empty: the learner's own typing stands.
			if (!meaning.trim()) meaning = gloss.meaning;
			if (!readingDraft.trim() && gloss.reading) readingDraft = gloss.reading;
			explanation = gloss.explanation ?? '';
			answered = true;
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
			// The Reading field as the learner left it — prefilled from the token.
			const reading = readingDraft.trim();
			const outcome = await addWords([
				{
					term: word.text.trim(),
					meaning: meaning.trim(),
					...(reading ? { romanization: reading } : {})
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

	// The current page stays in the rail's view as the learner reads on,
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
		clearThumbs();
		clearTimeout(saveTimer);
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

	/**
	 * The reader's keys. None while typing; ← → and PageUp/PageDown turn a
	 * page (the book scrolls continuously, so a "page" key means the next
	 * page, not the next screenful), Home/End the first and last, + − 0 the
	 * zoom, [ and ] the rail and the panel, Esc the card, then the sheet. While
	 * a card is open ← and → move it to the previous or next word instead.
	 */
	function onKey(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (picked) closeCard();
			else sheet = false;
			return;
		}
		if (!doc || !pdfViewer || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target instanceof Element ? event.target : undefined;
		if (
			target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		)
			return;
		// With a card open, ← and → walk the page's words instead of turning it.
		if (open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			event.preventDefault();
			stepCard(event.key === 'ArrowLeft' ? -1 : 1);
			return;
		}
		switch (event.key) {
			case 'ArrowLeft':
			case 'PageUp':
				goTo(pageNo - 1);
				break;
			case 'ArrowRight':
			case 'PageDown':
				goTo(pageNo + 1);
				break;
			case 'Home':
				goTo(1);
				break;
			case 'End':
				goTo(doc.count);
				break;
			case '+':
			case '=':
				setZoom(zoomStep(scale, 1));
				break;
			case '-':
				setZoom(zoomStep(scale, -1));
				break;
			case '0':
				setZoom('page-fit');
				break;
			case '[':
				if (!wide) return;
				railChoice = !showRail;
				break;
			case ']':
				if (!wide) return;
				panelOpen = !panelOpen;
				break;
			default:
				return;
		}
		event.preventDefault();
	}
</script>

<svelte:window onkeydown={onKey} />

<svelte:head>
	<title>Sapling · {title || 'Page viewer'}</title>
</svelte:head>

{#snippet icon(
	name: 'prev' | 'next' | 'close' | 'check' | 'lock' | 'plus' | 'minus' | 'open' | 'rail'
)}
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
		{:else if name === 'minus'}<path d="M5 12h14" />
		{:else if name === 'rail'}<rect x="4" y="5" width="16" height="14" rx="2" /><path
				d="M9.5 5v14"
			/>
		{:else}<path d="M12 5v14M5 12h14" />{/if}
	</svg>
{/snippet}

<!-- A line as text: tokens as buttons wearing no chrome, readings as ruby, the
     garden's underline. No whitespace between tokens: they reproduce the line. -->
{#snippet tokens(l: number)}{#each shownWords[l] ?? [] as word, w (w)}{#if word.key}<button
				type="button"
				class="tok w-{word.status}{word.maturity ? ` w-${word.maturity}` : ''}"
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
		{#if !known}
			{#if pageError}
				<p class="panel-copy">This page could not be read.</p>
			{:else}
				<div class="waiting-text"><Spinner /></div>
			{/if}
		{:else if lines.length === 0}
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
							onclick={() => reveal(word.segment, word.offset)}>{@render icon('plus')}</button
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

<!-- On a phone the printed line is small: the sheet leads with it, reflowed big. -->
{#snippet larger()}
	{#if open}
		<span class="handle" aria-hidden="true"></span>
		<div class="context">
			<span class="context-label">The line, larger</span>
			<span class="larger" {lang}>{@render tokens(open.line)}</span>
		</div>
	{/if}
{/snippet}

<!-- The reader's card, with what the viewer has: no legacy unmark, no lapse. -->
{#snippet card(compact: boolean)}
	{#if open}
		{@const word = open.word}
		<WordCard
			term={word.text}
			reading={word.reading ?? undefined}
			{lang}
			status={word.status}
			statusLine={statusLine(word)}
			meaning={word.gloss?.meaning}
			explanation={explanation || undefined}
			{answered}
			{offersReading}
			bind:meaningDraft={meaning}
			bind:readingDraft
			nativeLanguage={profile?.nativeLanguage}
			lookingUp={looking}
			writing={adding}
			error={cardError || undefined}
			note={addedNote || undefined}
			{compact}
			context={compact ? undefined : larger}
			onlookup={() => void lookUp()}
			onadd={() => void addOpen()}
			onclose={closeCard}
		/>
	{/if}
{/snippet}

{#snippet pageField()}
	{#if doc}
		<label class="page-field">
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
			<span class="of">/ {doc.count}</span>
		</label>
	{/if}
{/snippet}

{#snippet openFile()}
	<label class="icon-btn open-file" title="Open another PDF">
		<input type="file" accept="application/pdf" aria-label="Open another PDF" onchange={pickFile} />
		{@render icon('open')}
	</label>
{/snippet}

<main class="shell shell-full" class:shell-desk={!!doc} class:has-doc={!!doc}>
	<header class="topbar">
		<div class="tb-start">
			<BackLink href="/read" label="Back to your media" />
			{#if doc && wide}
				<button
					type="button"
					class="icon-btn tool"
					aria-label="Pages"
					aria-pressed={showRail}
					title="Pages ([)"
					onclick={() => (railChoice = !showRail)}>{@render icon('rail')}</button
				>
			{/if}
			<h1 class="title">{doc ? title : 'Open a book'}</h1>
		</div>
		{#if doc && wide}
			<div class="tb-centre">
				<nav class="pager" aria-label="Pages">
					<button
						type="button"
						class="icon-btn tool"
						aria-label="Previous page"
						disabled={pageNo <= 1}
						onclick={() => goTo(pageNo - 1)}>{@render icon('prev')}</button
					>
					{@render pageField()}
					<button
						type="button"
						class="icon-btn tool"
						aria-label="Next page"
						disabled={pageNo >= doc.count}
						onclick={() => goTo(pageNo + 1)}>{@render icon('next')}</button
					>
				</nav>
				<div class="zoom" role="group" aria-label="Zoom">
					<button
						type="button"
						class="icon-btn tool"
						aria-label="Zoom out"
						title="Zoom out (−)"
						onclick={() => setZoom(zoomStep(scale, -1))}>{@render icon('minus')}</button
					>
					<select
						class="zoom-select"
						aria-label="Zoom"
						value={zoomChoice(zoom)}
						onchange={(event) => {
							const chosen = parseZoom(event.currentTarget.value);
							if (chosen !== undefined) setZoom(chosen);
						}}
					>
						{#each ZOOM_PRESETS as preset (preset.zoom)}
							<option value={String(preset.zoom)}>{preset.label}</option>
						{/each}
						{#if zoomChoice(zoom) === 'custom'}
							<option value="custom" disabled>{zoomLabel(scale)}</option>
						{/if}
					</select>
					<button
						type="button"
						class="icon-btn tool"
						aria-label="Zoom in"
						title="Zoom in (+)"
						onclick={() => setZoom(zoomStep(scale, 1))}>{@render icon('plus')}</button
					>
				</div>
			</div>
		{/if}
		<div class="tb-end">
			{#if doc && wide}
				<button
					type="button"
					class="words-toggle"
					aria-pressed={showPanel}
					title="Words on this page (])"
					onclick={() => (panelOpen = !panelOpen)}
					>Words <span class="badge">{known ? notYet.length : '…'}</span></button
				>
			{/if}
			{#if doc}{@render openFile()}{/if}
		</div>
	</header>

	{#if error || pageError}<p class="error banner" role="alert">{error || pageError}</p>{/if}

	{#if !doc}
		<section class="empty">
			<p>
				Open a textbook PDF. A page with real text uses it; a scan, or a page whose text is only
				drawn, is read on this device and never leaves it.
			</p>
			<FileSlot label="Open a PDF" accept="application/pdf" icon="upload" onchange={pickFile} />
		</section>
	{:else}
		<div class="viewer" class:has-rail={showRail} class:has-panel={showPanel}>
			{#if showRail}
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
							onclick={() => goTo(n)}
						>
							<span class="thumb-page">
								{#if thumbs[n]}<img src={thumbs[n]} alt="" />{/if}
							</span>
							{n}
						</button>
					{/each}
				</aside>
			{/if}

			<div class="stage">
				<div class="viewport" class:dragging bind:this={containerEl}>
					<div class="pdfViewer" bind:this={viewerEl}></div>
				</div>
				{#if shownView === 'lines'}
					<div class="lines-layer">
						<div class="lines" class:has-ruby={hasReadings} {lang}>
							{#each targetLines as l (l)}
								<p class="line" class:unsure={unsure.includes(l)}>{@render tokens(l)}</p>
							{:else}
								{#if known}<p class="panel-copy">No text was found on this page.</p>
								{:else if !reading}<div class="waiting-text"><Spinner /></div>{/if}
							{/each}
						</div>
					</div>
				{/if}
			</div>

			{#if showPanel}
				<aside class="panel" aria-label="Words on this page">
					{#if reading}
						<div class="panel-card">{@render steps_()}</div>
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
				<div class="sheet sheet-card" role="dialog" aria-label={`The word ${open.word.text}`}>
					{@render card(false)}
				</div>
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
				<div class="pager">
					<button
						type="button"
						class="icon-btn"
						aria-label="Previous page"
						disabled={pageNo <= 1}
						onclick={() => goTo(pageNo - 1)}>{@render icon('prev')}</button
					>
					{@render pageField()}
					<button
						type="button"
						class="icon-btn"
						aria-label="Next page"
						disabled={pageNo >= doc.count}
						onclick={() => goTo(pageNo + 1)}>{@render icon('next')}</button
					>
				</div>
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
					}}>Words · {known ? notYet.length : '…'}</button
				>
			</nav>
		{/if}

		<!-- At 48rem the card is a popover at the word on the page, so the panel
		     keeps *On this page*. Keyed on the position: another word is a fresh
		     popover that takes focus again. -->
		{#if wide && open && anchorEl}
			{#key `${pageNo}:${open.line}:${open.offset}`}
				<WordPopover anchor={anchorEl} label={`The word ${open.word.text}`} onclose={closeCard}
					>{@render card(true)}</WordPopover
				>
			{/key}
		{/if}
	{/if}
</main>

<style>
	/* The garden's three underlines, as the reader colours them, and the desk
	   the book lies on: a shade under the chrome, so the page is the brightest
	   thing on screen in either theme. */
	main {
		--u-solid: var(--primary);
		--u-young: color-mix(in srgb, var(--primary) 55%, var(--amber));
		--u-new: var(--accent);
		--paper-shadow: 0 10px 30px rgb(60 50 20 / 14%), 0 1px 3px rgb(60 50 20 / 12%);
		--desk: color-mix(in srgb, var(--surface-alt) 82%, var(--text-muted));
	}

	:global(:root[data-theme='dark']) main {
		--desk: color-mix(in srgb, var(--bg) 70%, black);
		--paper-shadow: 0 10px 30px rgb(0 0 0 / 45%), 0 1px 3px rgb(0 0 0 / 40%);
	}

	/* The viewer is a frame at every width: the header, the desk taking what
	   is left (pdf.js wants a container of definite size), and on a phone the
	   bar at the foot. The window never scrolls; the desk, the rail and the
	   panel scroll inside themselves, so nothing scrolls inside a scroll. */
	.shell {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		box-sizing: border-box;
		padding-block: 0.5rem 0;
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
		flex: none;
		align-items: center;
		gap: 0.5rem;
		min-height: 3rem;
		margin-bottom: 0.5rem;
	}

	.tb-start {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.tb-end {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.title {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		font-size: 1.05rem;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.page-field {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--text-muted);
		font-size: 0.9rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.page-input {
		width: 3rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
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
		padding: 0 0.75rem;
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
		flex: none;
		margin: 0 0 0.5rem;
		max-width: var(--measure);
	}

	.empty {
		display: grid;
		gap: 1rem;
		max-width: var(--measure);
		padding-top: 0.5rem;
		color: var(--text-muted);
	}

	.empty p {
		margin: 0;
	}

	.waiting-text {
		display: grid;
		place-items: center;
		min-height: 6rem;
	}

	/* The desk ------------------------------------------------------------------ */

	.viewer {
		display: grid;
		flex: 1 1 auto;
		min-height: 0;
		grid-template-rows: minmax(0, 1fr);
		gap: var(--gap);
	}

	/* Full-bleed on a phone: every pixel of the width is the page's. */
	.stage {
		position: relative;
		min-width: 0;
		min-height: 0;
		margin-inline: calc(-1 * var(--gutter));
		overflow: hidden;
		background: var(--desk);
	}

	/* pdf.js's scroll container, which must be absolutely positioned. A
	   stacking context (z-index 0), so a page's shadow can sit under it.
	   Pinch is ours (pan-x pan-y leaves the browser one-finger scrolling
	   only); a mouse drag pans. */
	.viewport {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		touch-action: pan-x pan-y;
		user-select: none;
		cursor: grab;
		/* pdf.js's own page geometry, with a wider gap between pages. */
		--page-margin: 1px auto 6px;
	}

	.viewport.dragging {
		cursor: grabbing;
	}

	.pdfViewer {
		padding-block: 0.5rem;
	}

	/* The page's paper shadow, on the content box: pdf.js's page border is
	   9px of transparency its fit maths counts on, and a box-shadow on the
	   page itself would float that far off the paper. */
	.viewport :global(.page)::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: -1;
		box-shadow: var(--paper-shadow);
		pointer-events: none;
	}

	/* Lines: the page reflowed as text, in the reader's voice, over the desk
	   (pdf.js keeps its layout underneath, so the page is where it was). */
	.lines-layer {
		position: absolute;
		inset: 0;
		z-index: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 1rem var(--gutter) 2rem;
		background: var(--bg);
	}

	.lines {
		display: grid;
		gap: 0.5rem;
		width: 100%;
		max-width: var(--measure);
		margin-inline: auto;
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

	/* The word card's sheet on a phone: the larger line, then the card ------- */

	.handle {
		display: block;
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

	.larger {
		font-size: 1.5rem;
		line-height: 2.3;
		overflow-wrap: anywhere;
	}

	/* The card is a run of blocks with its own spacing, not grid items. */
	.sheet.sheet-card {
		display: block;
	}

	.sheet-card .handle {
		margin: 0 auto 0.75rem;
	}

	.sheet-card .context {
		margin-bottom: 1rem;
	}

	/* The phone: a bar at the foot, a sheet over it ---------------------------- */

	.bottom-bar {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.5rem;
		margin-inline: calc(-1 * var(--gutter));
		padding: 0.5rem var(--gutter) calc(0.5rem + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
		background: var(--surface);
	}

	.pager {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.35rem;
	}

	.words-btn {
		flex: 1;
		min-height: 2.75rem;
		padding-inline: 0.75rem;
		white-space: nowrap;
	}

	/* The bar is a phone's: three groups in 375px, so the turn buttons narrow. */
	.bottom-bar .icon-btn {
		width: 2.5rem;
	}

	.bottom-bar .page-input {
		width: 2.6rem;
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

	/* At ≥48rem one slim toolbar over the desk — the title at its start, the
	   page and the zoom centred, the panel's toggle and another file at its
	   end — and the desk framed between a rail and a panel, either of which
	   can be closed to give the page the width. */
	@media (min-width: 48rem) {
		.shell {
			padding-block: 0.5rem var(--gutter);
		}

		.topbar {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
			gap: 1rem;
			min-height: 3rem;
			margin-bottom: 0.75rem;
		}

		.title {
			color: var(--text-muted);
			font-family: var(--font);
			font-size: 0.92rem;
			font-weight: 700;
		}

		.tb-centre {
			display: flex;
			align-items: center;
			gap: 1rem;
		}

		/* The toolbar's own controls: 2.25rem, quieter than a page's buttons. */
		.icon-btn.tool {
			width: 2.25rem;
			height: 2.25rem;
			border-color: transparent;
			background: transparent;
			color: var(--text-muted);
		}

		.icon-btn.tool:hover:not(:disabled) {
			border-color: var(--border);
			background: var(--surface);
			color: var(--text);
		}

		.icon-btn.tool[aria-pressed='true'] {
			border-color: var(--border);
			background: var(--surface-alt);
			color: var(--text);
		}

		.zoom {
			display: flex;
			align-items: center;
			gap: 0.15rem;
		}

		.zoom-select {
			height: 2.25rem;
			min-width: 6.5rem;
			padding: 0 0.5rem;
			border: 1px solid var(--border);
			border-radius: var(--radius-sm);
			background: var(--surface);
			color: var(--text);
			font: inherit;
			font-size: 0.88rem;
			font-variant-numeric: tabular-nums;
			cursor: pointer;
		}

		.zoom-select:focus-visible {
			outline: none;
			box-shadow: var(--ring);
		}

		.words-toggle {
			display: inline-flex;
			align-items: center;
			gap: 0.45rem;
			height: 2.25rem;
			padding: 0 0.7rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: transparent;
			color: var(--text-muted);
			font: inherit;
			font-size: 0.88rem;
			font-weight: 700;
			cursor: pointer;
		}

		.words-toggle:hover {
			border-color: var(--border-strong);
			color: var(--text);
		}

		.words-toggle[aria-pressed='true'] {
			background: var(--surface-alt);
			color: var(--text);
		}

		.words-toggle:focus-visible {
			outline: none;
			box-shadow: var(--ring);
		}

		.badge {
			min-width: 1.4rem;
			padding: 0.05rem 0.4rem;
			border-radius: 999px;
			background: var(--primary);
			color: var(--text-inverse);
			font-size: 0.78rem;
			font-variant-numeric: tabular-nums;
			text-align: center;
		}

		.tb-end .open-file {
			width: 2.25rem;
			height: 2.25rem;
		}

		.viewer {
			grid-template-columns: minmax(0, 1fr);
		}

		.viewer.has-panel {
			grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
		}

		.viewer.has-rail {
			grid-template-columns: 6.5rem minmax(0, 1fr);
		}

		.viewer.has-rail.has-panel {
			grid-template-columns: 6.5rem minmax(0, 1fr) minmax(16rem, 22rem);
		}

		.stage {
			margin-inline: 0;
			border: 1px solid var(--border);
			border-radius: var(--radius-lg);
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

	@media (min-width: 72rem) {
		/* A page is a picture: an open book takes the whole desk, as a recording
		   does (`layout.md`). The panel and rail stay bounded columns. */
		.shell-desk {
			max-width: none;
		}

		.viewer.has-panel {
			grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
		}

		.viewer.has-rail.has-panel {
			grid-template-columns: 6.5rem minmax(0, 1fr) minmax(18rem, 22rem);
		}
	}
</style>
