/**
 * The page viewer's bookkeeping, pure so it is tested in node: what the panel
 * counts on a page (the legend, the words not held yet), where each word sits
 * on the page, how the OCR worker's progress messages fold into the steps the
 * "Reading this page" card draws, the zoom the toolbar, the wheel and a pinch
 * ask for, the position remembered per file, and the few strings built from
 * numbers.
 *
 * Nothing here draws, stores or calls anything. A page's words are the
 * reader's own `annotateSentence` tokens, one array per line, handed in.
 */
import type { OcrLine, OcrProgress } from '$lib/ocr';
import type { ReadingWord } from '$lib/reading/annotate';
// The module, not `$lib/reading`'s index, which pulls the model calls in.
import { harvestWords, type WordCandidate } from '$lib/reading/harvest';
import { inTargetScript } from '$lib/text';

export { inTargetScript };

type Maturity = NonNullable<ReadingWord['maturity']>;

/** A line whose recognizer score is under this may be misread, and is outlined. */
export const UNSURE_SCORE = 0.8;

/**
 * Under this the recognizer was reading a picture, not text: stroke diagrams,
 * character art and photos come back as a few glyphs at 0.05–0.5 (measured on
 * HSK 1 p.32), while printed lines score 0.9 and up. Such a line is dropped.
 */
export const PICTURE_SCORE = 0.5;

/** The lines of a page that are text, not pictures read as text. */
export function textLinesOf(lines: readonly OcrLine[]): OcrLine[] {
	return lines.filter((line) => line.score >= PICTURE_SCORE);
}

/**
 * A line's words with every one outside the target script made plain text: no
 * key, so it is neither drawn as a button, counted, listed nor looked up.
 */
export function forTarget(words: readonly ReadingWord[], tag: string | undefined): ReadingWord[] {
	return words.map((word) =>
		!word.key || inTargetScript(word.text, tag)
			? word
			: { text: word.text, reading: word.reading, status: 'plain' }
	);
}

/** The title a file gives the page: its name without the extension. */
export function fileTitle(file: { name: string }): string {
	const name = file.name.trim();
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** A typed page number made into one that exists; anything unreadable keeps `current`. */
export function clampPage(value: number, count: number, current = 1): number {
	if (!Number.isFinite(value)) return current;
	return Math.min(Math.max(1, Math.round(value)), Math.max(1, count));
}

/** How many distinct garden words on the page are at each maturity. */
export function legendOf(lines: readonly (readonly ReadingWord[])[]): Record<Maturity, number> {
	const seen = new Map<string, Maturity>();
	for (const words of lines) {
		for (const word of words) {
			if (word.status !== 'tracked' || !word.maturity) continue;
			seen.set(word.itemId ?? word.key ?? word.text, word.maturity);
		}
	}
	const counts: Record<Maturity, number> = { solid: 0, young: 0, new: 0 };
	for (const maturity of seen.values()) counts[maturity] += 1;
	return counts;
}

/**
 * The words on the page not in the garden: `harvestWords` over the page's
 * lines — once per spelling and reading, in order of first use, letters only —
 * each carrying the line and offset it first stands at, so its row can open
 * that occurrence's card.
 */
export function notYetWords(
	lines: readonly OcrLine[],
	words: readonly (readonly ReadingWord[])[]
): WordCandidate[] {
	return harvestWords(lines.map((line, l) => ({ text: line.text, words: [...(words[l] ?? [])] })));
}

/** The word of a line that covers character `offset`, with its index. */
export function wordAt(
	words: readonly ReadingWord[],
	offset: number
): { index: number; word: ReadingWord } | undefined {
	let at = 0;
	for (const [index, word] of words.entries()) {
		const end = at + word.text.length;
		if (offset >= at && offset < end) return { index, word };
		at = end;
	}
	return undefined;
}

/** The character offset at which word `index` of a line starts. */
export function offsetOf(words: readonly ReadingWord[], index: number): number {
	let at = 0;
	for (let i = 0; i < index && i < words.length; i++) at += words[i].text.length;
	return at;
}

/** The lines the recognizer was unsure of, by index (pictures are already gone). */
export function unsureLines(lines: readonly OcrLine[]): number[] {
	return lines.flatMap((line, l) => (line.score < UNSURE_SCORE ? [l] : []));
}

/* ---- Words on the page ------------------------------------------------------ */

/** A rectangle as percentages of the page, so a zoom moves nothing. */
export interface PageBox {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** A line's box as percentages of the page it was read at (`size`, the raster's). */
export function boxOf(line: OcrLine, size: { width: number; height: number }): PageBox {
	return {
		left: (line.box.x / size.width) * 100,
		top: (line.box.y / size.height) * 100,
		width: (line.box.w / size.width) * 100,
		height: (line.box.h / size.height) * 100
	};
}

export interface PlacedWord extends PageBox {
	word: ReadingWord;
	line: number;
	/** The character offset into its line the word starts at. */
	offset: number;
}

/**
 * Every word with a key, placed over its glyphs: its line's box, cut at the
 * x of its first and past its last character. A word with no edges recorded
 * (an edge list shorter than the line) falls back to the line's own ends.
 */
export function placeWords(
	lines: readonly OcrLine[],
	words: readonly (readonly ReadingWord[])[],
	size: { width: number; height: number }
): PlacedWord[] {
	const { width: W, height: H } = size;
	const out: PlacedWord[] = [];
	lines.forEach((line, l) => {
		let at = 0;
		for (const word of words[l] ?? []) {
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
}

/* ---- Zoom ---------------------------------------------------------------------- */

/** A fit pdf.js recomputes from the frame, or a scale (1 is 100%). */
export type Zoom = 'page-fit' | 'page-width' | number;

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
export const DEFAULT_ZOOM: Zoom = 'page-fit';

/** The toolbar's choices, in the order the menu lists them. */
export const ZOOM_PRESETS: readonly { zoom: Zoom; label: string }[] = [
	{ zoom: 'page-fit', label: 'Fit page' },
	{ zoom: 'page-width', label: 'Fit width' },
	...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((zoom) => ({ zoom, label: zoomLabel(zoom) }))
];

const SCALES = ZOOM_PRESETS.flatMap((preset) =>
	typeof preset.zoom === 'number' ? [preset.zoom] : []
);

export function clampScale(scale: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** A scale as the toolbar prints it. */
export function zoomLabel(scale: number): string {
	return `${Math.round(scale * 100)}%`;
}

/** A stored or chosen zoom made into one the viewer takes; anything else is none. */
export function parseZoom(value: unknown): Zoom | undefined {
	if (value === 'page-fit' || value === 'page-width') return value;
	const scale = typeof value === 'string' && value.trim() ? Number(value) : value;
	if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return undefined;
	return clampScale(scale);
}

/**
 * What pdf.js reports (`scalechanging`: the scale, and the preset when one
 * set it) as the zoom in effect: the fit, which a resize should refit, else
 * the scale to two places, as pdf.js itself rounds it.
 */
export function zoomOf(scale: number, preset?: string): Zoom {
	if (preset === 'page-fit' || preset === 'page-width') return preset;
	return Math.round(scale * 100) / 100;
}

/** The menu's value for a zoom: a preset's own, or `custom` for a pinched scale. */
export function zoomChoice(zoom: Zoom): string {
	if (typeof zoom === 'string') return zoom;
	return SCALES.includes(zoom) ? String(zoom) : 'custom';
}

/** One press of + or −: the next preset scale past this one, within the limits. */
export function zoomStep(scale: number, direction: 1 | -1): number {
	const next =
		direction > 0
			? SCALES.find((preset) => preset > scale * 1.01)
			: [...SCALES].reverse().find((preset) => preset < scale / 1.01);
	return clampScale(next ?? (direction > 0 ? ZOOM_MAX : ZOOM_MIN));
}

/**
 * A Ctrl/⌘ wheel event (and a trackpad pinch, which browsers report as one)
 * as a scale factor. Lines and pages are made pixels; each event is capped at
 * 10px so a mouse notch (100px) is one ~10% step, while a pinch's few pixels
 * stay as smooth as the fingers.
 */
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
	return Math.exp(-Math.min(10, Math.max(-10, px)) / 100);
}

/**
 * A stream of small factors folded into scales the viewer will actually take:
 * pdf.js rounds a scale to 0.01, so a single pinch event at 50% would round
 * back to where it started. The factor accumulates until it moves the rounded,
 * clamped scale, which is then applied and the account cleared; pushing past a
 * limit clears it too, so turning back is felt at once.
 */
export function accumulateZoom(
	scale: number,
	pending: number,
	factor: number
): { scale: number | undefined; pending: number } {
	const wanted = scale * pending * factor;
	const target = clampScale(Math.round(wanted * 100) / 100);
	if (target !== Math.round(scale * 100) / 100) return { scale: target, pending: 1 };
	if (wanted < ZOOM_MIN || wanted > ZOOM_MAX) return { scale: undefined, pending: 1 };
	return { scale: undefined, pending: pending * factor };
}

/**
 * A point on screen as the origin `PDFViewer.updateScale` takes. pdf.js
 * subtracts the container's `offsetTop`/`offsetLeft` from the origin, which is
 * the client position only when the container sits at the top left of the
 * window; this one sits in a frame, so the point is made container-relative
 * and the offsets pdf.js will subtract are added back.
 */
export function zoomOrigin(
	client: { x: number; y: number },
	rect: { left: number; top: number },
	offset: { left: number; top: number }
): [number, number] {
	return [client.x - rect.left + offset.left, client.y - rect.top + offset.top];
}

/* ---- Where the learner was, per file and device -------------------------------- */

export interface Position {
	page: number;
	zoom: Zoom;
}

const POSITION_KEY = 'll.pdfPosition.';

/** A file's key: its name and size, since the book itself is never stored. */
export function positionKey(file: { name: string; size: number }): string {
	return `${POSITION_KEY}${file.size}:${file.name}`;
}

export function serializePosition(position: Position): string {
	return JSON.stringify({ page: position.page, zoom: position.zoom });
}

/** A stored position read leniently: a bad zoom is the default, a bad page none at all. */
export function parsePosition(raw: string | null | undefined): Position | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object') return undefined;
	const { page, zoom } = value as { page?: unknown; zoom?: unknown };
	if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return undefined;
	return { page, zoom: parseZoom(zoom) ?? DEFAULT_ZOOM };
}

/* ---- Reading a page: the worker's progress, as steps ------------------------ */

export interface ReadingSteps {
	/** Bytes per model file fetched this time; empty when every one was cached. */
	downloads: Record<string, { done: number; total: number }>;
	/** The models are loaded and the sessions are being made. */
	starting: boolean;
	/** Lines found and how many are read; absent until the detector has run. */
	lines?: { done: number; total: number };
}

export const NO_STEPS: ReadingSteps = { downloads: {}, starting: false };

/** One progress message folded in. Unknown stages change nothing. */
export function foldProgress(steps: ReadingSteps, progress: OcrProgress): ReadingSteps {
	const download = /^Downloading (.+)$/.exec(progress.stage);
	if (download) {
		return {
			...steps,
			downloads: {
				...steps.downloads,
				[download[1]]: { done: progress.done, total: progress.total }
			}
		};
	}
	if (progress.stage === 'Starting the models') return { ...steps, starting: true };
	if (progress.stage === 'Reading lines') {
		return { ...steps, starting: true, lines: { done: progress.done, total: progress.total } };
	}
	return steps;
}

/**
 * The download as one row: bytes so far over every file, the total where
 * every file has said its size (0 otherwise), and whether it is over —
 * which it is once the models are starting.
 */
export function downloadOf(
	steps: ReadingSteps
): { done: number; total: number; finished: boolean } | undefined {
	const files = Object.values(steps.downloads);
	if (files.length === 0) return undefined;
	const done = files.reduce((sum, file) => sum + file.done, 0);
	const total = files.every((file) => file.total > 0)
		? files.reduce((sum, file) => sum + file.total, 0)
		: 0;
	return { done, total, finished: steps.starting };
}

/** Bytes as whole megabytes, never "0 MB" for something that is there. */
export function megabytes(bytes: number): string {
	return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1e6)) : 0} MB`;
}
