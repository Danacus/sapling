/**
 * The page viewer's bookkeeping, pure so it is tested in node: what the panel
 * counts on a page (the legend, the words not held yet), which pages the rail
 * shows, how the OCR worker's progress messages fold into the steps the
 * "Reading this page" card draws, and the few strings built from numbers.
 *
 * Nothing here draws, stores or calls anything. A page's words are the
 * reader's own `annotateSentence` tokens, one array per line, handed in.
 */
import type { OcrLine, OcrProgress } from '$lib/ocr';
import type { ReadingWord } from '$lib/reading/annotate';
// The module, not `$lib/reading`'s index, which pulls the model calls in.
import { harvestWords, type WordCandidate } from '$lib/reading/harvest';
import { usesInterWordSpaces } from '$lib/text';

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

/** Languages written without spaces between words, by primary subtag. */
const SPACELESS = new Set(['zh', 'cmn', 'yue', 'wuu', 'nan', 'ja', 'th', 'lo', 'km', 'my']);

/**
 * Whether `text` is in the target language's kind of script: for a language
 * written without spaces (Chinese, Japanese, Thai…) it must contain such a
 * script; for any other it must not. A textbook prints the learner's own
 * language beside the target — English glosses, pinyin — and under a Chinese
 * tokenizer each of those runs is one token, a whole sentence long.
 */
export function inTargetScript(text: string, tag: string | undefined): boolean {
	if (!tag) return true;
	const spaceless = SPACELESS.has(tag.toLowerCase().split('-')[0]);
	return spaceless !== usesInterWordSpaces(text);
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
export function fileTitle(files: readonly { name: string }[]): string {
	if (files.length === 0) return '';
	if (files.length > 1) return `${files.length} page images`;
	const name = files[0].name.trim();
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
