<!--
  Spike: a page viewer with the learner's words annotated on the page itself.
  A PDF or page images are drawn as they print; each page's text comes from
  the PDF's own text layer where it has one, else from on-device OCR
  (`$lib/ocr`, PP-OCRv5 in a worker). Either way a page is lines of text with
  every character's x, so a word is underlined in place by the reader's own
  annotation (green/amber by how well it is held) and opens the word card.
  Nothing is stored: the file stays on the device, the page is read on open.
-->
<script lang="ts">
	import { addWords } from '$lib/assistant';
	import { getAllItems, getKnownTerms, getProfile } from '$lib/db';
	import {
		modelSet,
		ocrPage,
		scriptFor,
		sizesFor,
		type OcrBackend,
		type OcrLine,
		type OcrScript,
		type OcrSize
	} from '$lib/ocr';
	import { openDocument, type ViewerDocument, type ViewerPage } from '$lib/ocr/pdf';
	import { getRomanizationMode } from '$lib/prefs';
	import {
		annotateSentence,
		lookUpWord,
		tokenizeByTerms,
		type AnnotateContext,
		type ReadingWord,
		type TokenizeFn
	} from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import { targetTagOf } from '$lib/text';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);
	const mode = getRomanizationMode();
	const rolls = new Map<string, boolean>();
	const ctx = $derived<AnnotateContext>({ items, knownTerms, mode, rolls });
	const lang = $derived(profile ? targetTagOf(profile) : undefined);

	$effect(() => {
		let cancelled = false;
		void Promise.all([getProfile(), getAllItems(), getKnownTerms()]).then(
			([loadedProfile, loadedItems, known]) => {
				if (cancelled || !loadedProfile) return;
				profile = loadedProfile;
				items = loadedItems;
				knownTerms = known;
				script = scriptFor(targetTagOf(loadedProfile));
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

	/* ---- The document and the page ------------------------------------------ */

	type Source = 'auto' | 'text' | 'ocr';

	let doc = $state<ViewerDocument | undefined>(undefined);
	let fileName = $state('');
	let pageNo = $state(1);
	// Raw: the raster goes to a worker, and a proxy cannot be cloned.
	let shown = $state.raw<ViewerPage | undefined>(undefined);
	let source = $state<Source>('auto');
	let script = $state<OcrScript>('chinese');
	let size = $state<OcrSize>('mobile');
	let backend = $state<OcrBackend>('auto');
	let showBoxes = $state(false);

	let lines = $state.raw<OcrLine[]>([]);
	let usedSource = $state<'text' | 'ocr' | undefined>(undefined);
	let busy = $state('');
	let progress = $state<{ done: number; total: number } | undefined>(undefined);
	let error = $state('');
	let stats = $state('');

	/** OCR answers by page and model, for this open only. */
	const ocrCache = new Map<string, { lines: OcrLine[]; stats: string }>();

	async function pickFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		if (files.length === 0) return;
		doc?.close();
		ocrCache.clear();
		error = '';
		try {
			doc = await openDocument(files);
			fileName = files.length === 1 ? files[0].name : `${files.length} images`;
			pageNo = 1;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that file.';
		}
	}

	// Draw the page whenever the document or the page number changes.
	$effect(() => {
		const current = doc;
		const n = pageNo;
		if (!current) return;
		let cancelled = false;
		busy = 'Drawing the page';
		void current
			.page(n)
			.then((loaded) => {
				if (cancelled) return URL.revokeObjectURL(loaded.url);
				if (shown) URL.revokeObjectURL(shown.url);
				shown = loaded;
			})
			.catch((cause) => {
				if (!cancelled) error = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				if (!cancelled) busy = '';
			});
		return () => {
			cancelled = true;
		};
	});

	/** A text layer worth trusting: some letters, not just page numbers. */
	function hasText(page: ViewerPage): boolean {
		return page.textLines.reduce((n, line) => n + line.text.trim().length, 0) >= 20;
	}

	// Read the page: its own text, or OCR.
	$effect(() => {
		const page = shown;
		const wanted = source;
		const set = modelSet(script, size);
		const run = backend;
		if (!page) return;
		let cancelled = false;
		error = '';
		if (wanted === 'text' || (wanted === 'auto' && hasText(page))) {
			lines = page.textLines;
			usedSource = 'text';
			stats = `${page.textLines.length} lines from the PDF's text layer`;
			return;
		}
		const key = `${pageNo}:${set.id}:${run}`;
		const cached = ocrCache.get(key);
		if (cached) {
			lines = cached.lines;
			usedSource = 'ocr';
			stats = cached.stats;
			return;
		}
		lines = [];
		usedSource = 'ocr';
		busy = 'Reading the page';
		progress = undefined;
		void ocrPage(page.raster, set, run, (p) => {
			if (cancelled) return;
			busy = p.stage;
			progress = p.total ? { done: p.done, total: p.total } : undefined;
		})
			.then((result) => {
				const line = `${result.lines.length} lines · ${(result.timings.pageMs / 1000).toFixed(1)} s on ${result.backend}${
					result.timings.loadMs > 500
						? ` · models ${(result.timings.loadMs / 1000).toFixed(1)} s`
						: ''
				} · ${set.label}`;
				ocrCache.set(key, { lines: result.lines, stats: line });
				if (cancelled) return;
				lines = result.lines;
				stats = line;
			})
			.catch((cause) => {
				if (!cancelled) error = cause instanceof Error ? cause.message : String(cause);
			})
			.finally(() => {
				if (!cancelled) {
					busy = '';
					progress = undefined;
				}
			});
		return () => {
			cancelled = true;
		};
	});

	/* ---- Words on the page --------------------------------------------------- */

	interface Placed {
		word: ReadingWord;
		line: number;
		/** Percentages of the page. */
		left: number;
		top: number;
		width: number;
		height: number;
	}

	const placed = $derived.by(() => {
		const page = shown;
		if (!page) return [];
		const { width: W, height: H } = page.raster;
		const out: Placed[] = [];
		lines.forEach((line, l) => {
			let at = 0;
			for (const word of annotateSentence(line.text, tokenize, ctx)) {
				const start = at;
				at += word.text.length;
				if (!word.key) continue;
				const x0 = line.edges[start] ?? line.box.x;
				const x1 = line.edges[at] ?? line.box.x + line.box.w;
				out.push({
					word,
					line: l,
					left: (x0 / W) * 100,
					top: (line.box.y / H) * 100,
					width: (Math.max(1, x1 - x0) / W) * 100,
					height: (line.box.h / H) * 100
				});
			}
		});
		return out;
	});

	function wordClass(word: ReadingWord): string {
		return `w w-${word.status}${word.maturity ? ` w-${word.maturity}` : ''}`;
	}

	/* ---- The word card ------------------------------------------------------- */

	interface Picked {
		index: number;
		term: string;
		reading: string | null;
		sentence: string;
		tracked?: string;
	}

	let picked = $state<Picked | undefined>(undefined);
	let meaning = $state('');
	let explanation = $state('');
	let looking = $state(false);
	let adding = $state(false);
	let cardError = $state('');
	let addedNote = $state('');

	function pick(index: number) {
		const at = placed[index];
		picked = {
			index,
			term: at.word.text,
			reading: at.word.reading,
			sentence: lines[at.line]?.text ?? at.word.text,
			...(at.word.gloss ? { tracked: at.word.gloss.meaning } : {})
		};
		meaning = '';
		explanation = '';
		cardError = '';
		addedNote = '';
	}

	async function lookUp() {
		if (!picked || !profile || looking) return;
		const asked = picked;
		looking = true;
		cardError = '';
		try {
			const gloss = await lookUpWord({
				profile: { nativeLanguage: profile.nativeLanguage, targetLanguage: profile.targetLanguage },
				wordCount: items.length,
				term: asked.term,
				sentence: asked.sentence
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

	async function addPicked() {
		if (!picked || adding || !meaning.trim()) return;
		adding = true;
		cardError = '';
		try {
			const outcome = await addWords([
				{
					term: picked.term.trim(),
					meaning: meaning.trim(),
					...(picked.reading?.trim() ? { romanization: picked.reading.trim() } : {})
				}
			]);
			addedNote = outcome.summary;
			items = await getAllItems();
			picked = undefined;
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not add that word.';
		} finally {
			adding = false;
		}
	}
</script>

<svelte:head>
	<title>Sapling · Page viewer</title>
</svelte:head>

<main class="shell shell-broad">
	<header class="topbar">
		<BackLink href="/read" label="Back to your media" />
		<div>
			<p class="eyebrow">Spike</p>
			<h1>Page viewer</h1>
		</div>
	</header>

	<div class="controls">
		<label class="file">
			<span class="btn btn-ghost">{doc ? 'Another file' : 'Open a PDF or page images'}</span>
			<input type="file" accept="application/pdf,image/*" multiple onchange={pickFiles} />
		</label>
		{#if doc}
			<span class="name">{fileName}</span>
			<div class="pager">
				<button
					type="button"
					class="btn btn-ghost"
					disabled={pageNo <= 1}
					onclick={() => (pageNo -= 1)}>‹</button
				>
				<input
					class="input page-no"
					type="number"
					min="1"
					max={doc.count}
					value={pageNo}
					onchange={(e) => {
						const n = Number((e.currentTarget as HTMLInputElement).value);
						if (doc && n >= 1 && n <= doc.count) pageNo = n;
					}}
				/>
				<span>/ {doc.count}</span>
				<button
					type="button"
					class="btn btn-ghost"
					disabled={pageNo >= doc.count}
					onclick={() => (pageNo += 1)}>›</button
				>
			</div>
		{/if}
	</div>

	<div class="controls small">
		<label
			>Text <select class="input" bind:value={source}>
				<option value="auto">Auto</option>
				<option value="text">PDF text layer</option>
				<option value="ocr">OCR</option>
			</select></label
		>
		<label
			>Script <select class="input" bind:value={script}>
				<option value="chinese">Chinese / Japanese</option>
				<option value="latin">Latin</option>
				<option value="korean">Korean</option>
			</select></label
		>
		<label
			>Model <select class="input" bind:value={size}>
				{#each sizesFor(script) as option (option)}<option value={option}>{option}</option>{/each}
			</select></label
		>
		<label
			>Run on <select class="input" bind:value={backend}>
				<option value="auto">WebGPU if available</option>
				<option value="wasm">CPU (wasm)</option>
			</select></label
		>
		<label class="check"><input type="checkbox" bind:checked={showBoxes} /> Line boxes</label>
	</div>

	<p class="status" aria-live="polite">
		{#if busy}
			<Spinner />
			{busy}{#if progress}
				· {progress.total > 1e5
					? `${(progress.done / 1e6).toFixed(0)} / ${(progress.total / 1e6).toFixed(0)} MB`
					: `${progress.done} / ${progress.total}`}{/if}
		{:else if stats}{usedSource === 'ocr' ? 'OCR: ' : ''}{stats}{/if}
	</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if addedNote}<p class="added" aria-live="polite">{addedNote}</p>{/if}

	{#if shown}
		<div class="spread">
			<figure class="page" style:aspect-ratio="{shown.raster.width} / {shown.raster.height}">
				<img src={shown.url} alt={`Page ${pageNo}`} />
				{#if showBoxes}
					{#each lines as line, l (l)}
						<span
							class="line-box"
							style:left="{(line.box.x / shown.raster.width) * 100}%"
							style:top="{(line.box.y / shown.raster.height) * 100}%"
							style:width="{(line.box.w / shown.raster.width) * 100}%"
							style:height="{(line.box.h / shown.raster.height) * 100}%"
						></span>
					{/each}
				{/if}
				{#each placed as at, i (i)}
					<button
						type="button"
						class={wordClass(at.word)}
						class:is-open={picked?.index === i}
						style:left="{at.left}%"
						style:top="{at.top}%"
						style:width="{at.width}%"
						style:height="{at.height}%"
						aria-label={at.word.text}
						onclick={() => pick(i)}
					></button>
				{/each}
			</figure>

			<aside class="panel">
				{#if picked}
					<div class="card word-card" role="dialog" aria-label={`The word ${picked.term}`}>
						<div class="card-head">
							<div>
								{#if picked.reading}<span class="card-reading">{picked.reading}</span>{/if}
								<span class="card-term" {lang}>{picked.term}</span>
							</div>
							<button
								type="button"
								class="close"
								aria-label="Close"
								onclick={() => (picked = undefined)}>×</button
							>
						</div>
						<p class="card-line" {lang}>{picked.sentence}</p>
						{#if picked.tracked}
							<p class="card-meaning">{picked.tracked}</p>
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
								{/if}
							</div>
							{#if cardError}<p class="error" role="alert">{cardError}</p>{/if}
						{/if}
					</div>
				{/if}
				{#if lines.length}
					<details class="card text-dump">
						<summary>What was read ({lines.length} lines)</summary>
						<ol>
							{#each lines as line, l (l)}
								<li {lang} class:low={line.score < 0.8}>
									<span class="score">{line.score.toFixed(2)}</span>
									{line.text}
								</li>
							{/each}
						</ol>
					</details>
				{/if}
			</aside>
		</div>
	{:else if !doc}
		<p class="empty">
			Open a textbook PDF, or photos of its pages. A page with real text uses it; a scan or a page
			whose text is only drawn is read on this device.
		</p>
	{/if}
</main>

<style>
	.shell {
		padding-block: 1.5rem 4rem;
	}

	.topbar {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		margin-bottom: 1rem;
	}

	.eyebrow {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	h1 {
		margin: 0;
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.controls.small {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.controls.small label {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
	}

	.controls.small .input {
		padding: 0.25rem 0.4rem;
		font-size: 0.85rem;
	}

	.file input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}

	.file {
		cursor: pointer;
	}

	.name {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.pager {
		display: inline-flex;
		gap: 0.4rem;
		align-items: center;
	}

	.page-no {
		width: 4.5rem;
	}

	.status {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		min-height: 1.5rem;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.page {
		position: relative;
		width: 100%;
		margin: 0;
		background: #fff;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.15);
	}

	.page img {
		display: block;
		width: 100%;
		height: 100%;
	}

	.line-box {
		position: absolute;
		border: 1px solid rgb(0 120 255 / 0.5);
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
	.w.is-open {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
	}

	.w-tracked {
		border-bottom: 3px solid var(--primary);
	}

	.w-tracked.w-new {
		border-bottom-color: var(--accent);
	}

	.w-tracked.w-young {
		border-bottom-color: color-mix(in srgb, var(--primary) 55%, var(--amber));
	}

	.w-tracked.w-solid {
		border-bottom-color: var(--primary);
	}

	.panel {
		display: grid;
		gap: var(--gap);
		align-content: start;
	}

	/* The card is a sheet at the foot of a phone, a docked panel beside the page
	   on a wider screen. */
	.word-card {
		position: fixed;
		inset: auto 0 0;
		z-index: 10;
		padding: 1rem var(--gutter) 1.5rem;
		border-radius: 1rem 1rem 0 0;
		box-shadow: 0 -4px 16px rgb(0 0 0 / 0.15);
	}

	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: start;
	}

	.card-reading {
		display: block;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.card-term {
		font-size: 1.6rem;
	}

	.close {
		border: 0;
		background: none;
		font-size: 1.5rem;
		line-height: 1;
		cursor: pointer;
		color: var(--text-muted);
	}

	.card-line {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.card-explanation {
		font-size: 0.9rem;
	}

	.card-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.text-dump {
		font-size: 0.8rem;
	}

	.text-dump ol {
		padding-left: 1.2rem;
	}

	.text-dump .score {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		margin-right: 0.4rem;
	}

	.text-dump .low {
		color: var(--terracotta, #b4532a);
	}

	.added {
		color: var(--primary);
	}

	@media (min-width: 48rem) {
		.spread {
			grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
		}

		.panel {
			position: sticky;
			top: 1rem;
			max-height: calc(100dvh - 2rem);
			overflow: auto;
		}

		.word-card {
			position: static;
			padding: 1rem;
			border-radius: var(--radius, 0.75rem);
			box-shadow: none;
		}
	}
</style>
