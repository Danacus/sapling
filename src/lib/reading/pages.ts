/**
 * Cutting a text into pages.
 *
 * A page is a window of consecutive sentences, and the window is measured in
 * characters rather than sentences because the two kinds of text this feature
 * carries have nothing in common in that dimension: a generated piece is six to
 * twelve sentences that may each be five words long, while an import is up to
 * `MAX_IMPORT_CHARS` of somebody else's prose, where one sentence can run three
 * lines. Counting sentences would give the first a page a swipe long and the
 * second a wall; counting characters gives both about the same amount of
 * reading, which is what a page is for.
 *
 * Pure and dependency-free, like `./sentences`: the caller hands over the
 * sentences and gets back index ranges. Nothing here knows about the DB, the
 * URL or the roll map — pagination is a view of an immutable text, and the page
 * the learner is on is a query parameter, never a stored fact.
 */

/**
 * How much text a page may hold, in characters.
 *
 * One number for every script, deliberately. A per-script budget was the
 * obvious refinement — a Han character carries far more meaning than a Latin
 * one, so 700 hanzi is a much longer read than 700 letters — but the two errors
 * cancel where it matters: the reader sets the target script larger than body
 * text and at a 1.9 line height for ruby, so a Chinese page occupies about as
 * much *screen* as a Spanish one of the same character count. 700 is roughly a
 * phone screen and a half of prose at the reading measure: long enough that
 * paging is not a tic, short enough that the finish row is reachable without a
 * long scroll, and it cuts a full 4000-character import into six or so pages
 * while leaving most generated texts on one.
 */
export const PAGE_CHARS = 700;

/** A page: sentence indices `[start, end)` into the text's own array. */
export interface PageRange {
	start: number;
	end: number;
}

/**
 * Packs `sentences` greedily into pages of at most `budget` characters.
 *
 * Greedy rather than balanced: a page break has to fall between the same two
 * sentences every time the text is opened, because the page number lives in the
 * URL and nothing else remembers where the learner was. Greedy from the front
 * is the only packing that keeps page 1 identical no matter how the text ends.
 *
 * A sentence longer than the whole budget gets a page to itself — a page never
 * comes back empty, so the reader always has something to render and the
 * grading always has something to grade. An empty text has no pages at all;
 * that is the caller's one special case.
 */
export function paginate(
	sentences: readonly { text: string }[],
	budget: number = PAGE_CHARS
): PageRange[] {
	const out: PageRange[] = [];
	let start = 0;
	let chars = 0;

	for (let i = 0; i < sentences.length; i++) {
		const length = sentences[i].text.length;
		// Break *before* this sentence, never mid-sentence: the annotation, the
		// readings and the translation are all keyed on whole sentences.
		if (i > start && chars + length > budget) {
			out.push({ start, end: i });
			start = i;
			chars = 0;
		}
		chars += length;
	}

	if (start < sentences.length) out.push({ start, end: sentences.length });
	return out;
}
