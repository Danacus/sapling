/**
 * Cutting a text into pages.
 *
 * A text is stored as its source cut it — a subtitle cue, or a paragraph — and
 * a page is a window of consecutive segments, measured in words rather than
 * segments because the two kinds of text have nothing in common in that
 * dimension: a cue is a line of dialogue, a paragraph of somebody's article can
 * run half a screen. Counting segments would give the first a page a swipe long
 * and the second a wall; counting words gives both about the same amount of
 * reading, which is what a page is for.
 *
 * A segment longer than a whole page is the one case where packing whole
 * segments cannot work, so that segment — and only that one — is cut at the
 * sentence boundaries ICU finds (`Intl.Segmenter`, sentence granularity). Those
 * cuts are a view: they place page breaks and are never stored, so no rule
 * about abbreviations or decimals ever reaches the data. What the reader
 * renders is therefore a list of **pieces**, each a whole segment or one
 * sentence of a long one, and each knowing which segment it came from; the
 * pieces of a segment concatenate back to it exactly.
 *
 * Words, not characters, because a character is not the same amount of reading
 * in every script: 700 characters of Spanish is about 120 words, 700 characters
 * of Chinese is about 700. The count is ICU's base segmentation (`segmentWords`),
 * deliberately *not* the annotated tokens: vocabulary and known terms override
 * the segmentation by longest match, so the annotated count of a piece can
 * change by one when the learner adds a word — and a page break that moves
 * under the learner mid-read is a bug. ICU's cut depends on the text alone.
 *
 * No locale anywhere, exactly as `tokenize.ts` calls ICU: the boundaries come
 * from the characters themselves, and the profile's language is a display name
 * ("Mandarin Chinese"), not a BCP-47 tag `Intl.Segmenter` would accept.
 *
 * Otherwise pure: the caller hands over the segments and gets back pieces and
 * index ranges. Nothing here knows about the DB, the URL or the roll map —
 * pagination is a view of an immutable text, and the page the learner is on is
 * a query parameter, never a stored fact.
 */
import { segmentWords } from '$lib/text';

/**
 * How much text a page may hold, in words.
 *
 * About a paragraph: long enough that paging is not a tic, short enough that
 * every page is a single confirmable thought and the finish row is reachable
 * without a long scroll. A generated text is two or three pages; a long import
 * is a dozen or more.
 */
export const PAGE_WORDS = 30;

/** A run of pieces `[start, end)` — a page, or the pieces of one segment. */
export interface PageRange {
	start: number;
	end: number;
}

/**
 * One unit the reader renders: a whole segment, or one sentence of a segment
 * too long for a page. `text` is verbatim — the pieces of a segment concatenate
 * back to it, trailing spaces included.
 */
export interface Piece {
	/** Index of the stored segment this piece is (part of). */
	segment: number;
	text: string;
}

/** What {@link paginate} hands back: the pieces, and the pages as ranges over them. */
export interface Pagination {
	pieces: Piece[];
	pages: PageRange[];
}

/**
 * How many words ICU finds in `text` — punctuation and spaces do not count.
 */
export function countWords(text: string): number {
	let n = 0;
	for (const segment of segmentWords(text)) if (segment.isWord) n += 1;
	return n;
}

/** Constructed once: a reader cuts every long segment of every text it opens. */
let sentenceSegmenter: Intl.Segmenter | null | undefined;

/**
 * `text` cut at ICU's sentence boundaries, verbatim — each sentence keeps its
 * trailing space, so the parts concatenate back to `text`. A host without
 * `Intl.Segmenter` gets the whole text back as one sentence: a page too long,
 * never a wrong render.
 */
function sentencesOf(text: string): string[] {
	if (sentenceSegmenter === undefined) {
		sentenceSegmenter =
			typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
				? new Intl.Segmenter(undefined, { granularity: 'sentence' })
				: null;
	}
	if (!sentenceSegmenter) return [text];
	const out: string[] = [];
	for (const part of sentenceSegmenter.segment(text)) out.push(part.segment);
	return out.length > 0 ? out : [text];
}

/**
 * The sentence of `text` that holds character `offset` — what a looked-up word
 * travels with, so a polysemous word comes back in the sense it is used in and
 * not in the sense of the whole cue or paragraph around it.
 *
 * The same ICU cut {@link paginate} places page breaks with, and the same
 * fallback: a host without `Intl.Segmenter` gets the whole `text` back. An
 * offset past the end is the last sentence, a negative one the first. Trimmed,
 * because a sentence keeps its trailing space for concatenation and a prompt
 * does not want it.
 */
export function sentenceAt(text: string, offset: number): string {
	const sentences = sentencesOf(text);
	let end = 0;
	for (const sentence of sentences) {
		end += sentence.length;
		if (offset < end) return sentence.trim() || text.trim();
	}
	return (sentences.at(-1) ?? text).trim() || text.trim();
}

/**
 * Cuts `segments` into pieces and packs the pieces greedily into pages of at
 * most `budget` words.
 *
 * A segment that fits a page is one piece; a longer one is one piece per
 * sentence. Greedy rather than balanced: a page break has to fall between the
 * same two pieces every time the text is opened, because the page number lives
 * in the URL and nothing else remembers where the learner was. Greedy from the
 * front is the only packing that keeps page 1 identical no matter how the text
 * ends.
 *
 * A break falls *before* a piece, never inside one. A piece longer than the
 * whole budget — one enormous sentence, an unpunctuated paragraph — gets a page
 * to itself: a page never comes back empty, so the reader always has something
 * to render and the grading always has something to grade. An empty text has
 * no pages at all; that is the caller's one special case.
 */
export function paginate(
	segments: readonly { text: string }[],
	budget: number = PAGE_WORDS
): Pagination {
	const pieces: Piece[] = [];
	const lengths: number[] = [];
	segments.forEach((segment, index) => {
		const words = countWords(segment.text);
		if (words <= budget) {
			pieces.push({ segment: index, text: segment.text });
			lengths.push(words);
			return;
		}
		for (const sentence of sentencesOf(segment.text)) {
			pieces.push({ segment: index, text: sentence });
			lengths.push(countWords(sentence));
		}
	});

	const pages: PageRange[] = [];
	let start = 0;
	let words = 0;
	for (let i = 0; i < pieces.length; i++) {
		if (i > start && words + lengths[i] > budget) {
			pages.push({ start, end: i });
			start = i;
			words = 0;
		}
		words += lengths[i];
	}
	if (start < pieces.length) pages.push({ start, end: pieces.length });

	return { pieces, pages };
}

/**
 * Where piece `index` starts inside its own segment, in characters — the sum of
 * the pieces of that segment before it, which is exact because the pieces of a
 * segment concatenate back to it. `0` for a whole-segment piece or an index out
 * of range.
 */
export function pieceOffset(pieces: readonly Piece[], index: number): number {
	const piece = pieces[index];
	if (!piece) return 0;
	let offset = 0;
	for (let i = index - 1; i >= 0 && pieces[i].segment === piece.segment; i--) {
		offset += pieces[i].text.length;
	}
	return offset;
}

/**
 * The pieces segment `segment` became, as a range — the follow view's page,
 * which is one cue however it was cut. Empty (`{0, 0}`) for `-1` or a segment
 * with no pieces.
 */
export function piecesOfSegment(pieces: readonly Piece[], segment: number): PageRange {
	const start = pieces.findIndex((piece) => piece.segment === segment);
	if (segment < 0 || start < 0) return { start: 0, end: 0 };
	let end = start + 1;
	while (end < pieces.length && pieces[end].segment === segment) end++;
	return { start, end };
}
