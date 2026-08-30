/**
 * Cutting a text into pages.
 *
 * A page is a window of consecutive sentences, and the window is measured in
 * words rather than sentences because the two kinds of text this feature
 * carries have nothing in common in that dimension: a generated piece is six to
 * twelve sentences that may each be five words long, while an import is up to
 * `MAX_IMPORT_CHARS` of somebody else's prose, where one sentence can run three
 * lines. Counting sentences would give the first a page a swipe long and the
 * second a wall; counting words gives both about the same amount of reading,
 * which is what a page is for.
 *
 * Words, not characters, because a character is not the same amount of reading
 * in every script: 700 characters of Spanish is about 120 words, 700 characters
 * of Chinese is about 700. The count is ICU's base segmentation (`segmentWords`),
 * deliberately *not* the annotated tokens: vocabulary and known terms override
 * the segmentation by longest match, so the annotated count of a sentence can
 * change by one when the learner adds a word — and a page break that moves
 * under the learner mid-read is a bug. ICU's cut depends on the text alone.
 *
 * Otherwise pure, like `./sentences`: the caller hands over the sentences and
 * gets back index ranges. Nothing here knows about the DB, the URL or the roll
 * map — pagination is a view of an immutable text, and the page the learner is
 * on is a query parameter, never a stored fact.
 */
import { segmentWords } from '$lib/text';

/**
 * How much text a page may hold, in words.
 *
 * About a paragraph: long enough that paging is not a tic, short enough that
 * every page is a single confirmable thought and the finish row is reachable
 * without a long scroll. A generated text of six to twelve short sentences is
 * two or three pages; a full import is a dozen or more.
 */
export const PAGE_WORDS = 30;

/** A page: sentence indices `[start, end)` into the text's own array. */
export interface PageRange {
	start: number;
	end: number;
}

/** How many words ICU finds in `text` — punctuation and spaces do not count. */
export function countWords(text: string, locale?: string): number {
	let n = 0;
	for (const segment of segmentWords(text, locale)) if (segment.isWord) n += 1;
	return n;
}

/**
 * Packs `sentences` greedily into pages of at most `budget` words.
 *
 * Greedy rather than balanced: a page break has to fall between the same two
 * sentences every time the text is opened, because the page number lives in the
 * URL and nothing else remembers where the learner was. Greedy from the front
 * is the only packing that keeps page 1 identical no matter how the text ends.
 *
 * A break falls *before* a sentence, never inside one: the annotation, the
 * readings and the translation are all keyed on whole sentences, so the last
 * sentence of a page is always finished. A sentence longer than the whole
 * budget gets a page to itself — a page never comes back empty, so the reader
 * always has something to render and the grading always has something to
 * grade. An empty text has no pages at all; that is the caller's one special
 * case.
 */
export function paginate(
	sentences: readonly { text: string }[],
	budget: number = PAGE_WORDS,
	locale?: string
): PageRange[] {
	const out: PageRange[] = [];
	let start = 0;
	let words = 0;

	for (let i = 0; i < sentences.length; i++) {
		const length = countWords(sentences[i].text, locale);
		if (i > start && words + length > budget) {
			out.push({ start, end: i });
			start = i;
			words = 0;
		}
		words += length;
	}

	if (start < sentences.length) out.push({ start, end: sentences.length });
	return out;
}
