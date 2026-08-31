/**
 * Which line of a text is being spoken right now.
 *
 * Pure, like `$lib/reading/pages`: it is handed the sentences and a position in
 * milliseconds and gives back an index. No element, no clock of its own, no
 * DOM — the reader owns the player and the state, and everything that could be
 * subtly wrong about following a subtitle track is decided here, where a test
 * can hold the clock still.
 *
 * The rules the shape of a subtitle file forces:
 *
 * - **A gap stays on the last line that started.** Cues do not tile a
 *   recording; there is silence between them, and a highlight that blinked off
 *   between every pair of lines would flicker through a whole conversation. So
 *   `end` is ignored for the purpose of "which line" — it only ever means "the
 *   line is over", which is a different question (`crossedEnd`).
 * - **`start` is inclusive.** A player asked to seek to a line's start reports
 *   exactly that number back, and landing one line *before* the one you asked
 *   for is the bug the learner would notice first.
 * - **A sentence with no timings is skipped, never landed on.** The importer
 *   gives both offsets or neither, and a text mixing the two — a prose sentence
 *   spliced into a transcript — must not swallow the lines around it.
 * - **Before the first timed sentence there is no current line** (`-1`), which
 *   is also the answer for a text with no timings at all. A recording that
 *   opens on a title card is reading nothing, and saying "line 0" there would
 *   highlight a sentence nobody has spoken yet.
 */

/** All this module needs of a sentence: when it is spoken, if anyone knows. */
export interface Timed {
	start?: number;
	end?: number;
}

/** Whether a sentence carries a usable span. Both or neither, per the importer. */
function timed(sentence: Timed | undefined): sentence is { start: number; end: number } {
	return (
		sentence !== undefined && typeof sentence.start === 'number' && typeof sentence.end === 'number'
	);
}

/**
 * The index of the sentence whose `start` most recently passed `ms`, or `-1`.
 *
 * A linear scan rather than a binary search: the sentences are in order, but a
 * text is at most a few hundred of them and this runs on `timeupdate` — four
 * times a second, not per frame. A search would be the same code with an
 * off-by-one to get wrong.
 */
export function sentenceAt(sentences: readonly Timed[], ms: number): number {
	let found = -1;
	for (let i = 0; i < sentences.length; i += 1) {
		const sentence = sentences[i];
		if (!timed(sentence)) continue;
		// Ordered, so the first start beyond `ms` ends the walk — and every later
		// one is beyond it too.
		if (sentence.start > ms) break;
		found = i;
	}
	return found;
}

/**
 * The contiguous run of sentences sharing the clock's current `start`, as a
 * half-open range.  Sentences cut from one cue legitimately share its span,
 * and `sentenceAt` always picks the last — so the unit of following is the
 * group, not the individual sentence.
 */
export function sentenceRangeAt(
	sentences: readonly Timed[],
	ms: number
): { start: number; end: number } {
	const at = sentenceAt(sentences, ms);
	if (at < 0) return { start: 0, end: 0 };

	const anchor = sentences[at];
	if (!timed(anchor)) return { start: 0, end: 0 };
	const t = anchor.start;

	let start = at;
	while (start > 0) {
		const prev = sentences[start - 1];
		if (!timed(prev) || prev.start !== t) break;
		start--;
	}

	let end = at + 1;
	while (end < sentences.length) {
		const next = sentences[end];
		if (!timed(next) || next.start !== t) break;
		end++;
	}

	return { start, end };
}

/**
 * Whether playback has just run off the end of sentence `i`.
 *
 * The auto-pause question, and it is asked between two samples rather than
 * against the present alone: `timeupdate` fires every 200-odd milliseconds, so
 * "is `ms` past the end" would be true for every sample until the next line
 * starts and would pause again the moment the learner pressed play. Asking
 * whether the boundary fell *between* the last position and this one makes it
 * true exactly once per crossing.
 *
 * A seek backwards over the end is not a crossing (the interval is empty
 * backwards), and neither is a jump that lands before the sentence began.
 */
export function crossedEnd(
	sentences: readonly Timed[],
	i: number,
	prevMs: number,
	ms: number
): boolean {
	const sentence = sentences[i];
	if (!timed(sentence)) return false;
	return prevMs < sentence.end && ms >= sentence.end;
}

/** The next sentence after `i` that has timings, or `-1` — the "next line" button. */
export function nextTimed(sentences: readonly Timed[], i: number): number {
	for (let n = Math.max(i, -1) + 1; n < sentences.length; n += 1) {
		if (timed(sentences[n])) return n;
	}
	return -1;
}

/**
 * The previous timed sentence before `i`, or `-1`.
 *
 * Not the replay button — replaying a line seeks to the line it is already on.
 * This is the step *back*, and it is here because "which line is before this
 * one" is the same skipping walk as `nextTimed` and deserves the same test.
 */
export function prevTimed(sentences: readonly Timed[], i: number): number {
	for (let p = Math.min(i, sentences.length) - 1; p >= 0; p -= 1) {
		if (timed(sentences[p])) return p;
	}
	return -1;
}

/** The first timed sentence, or `-1` — where a text with no current line starts. */
export function firstTimed(sentences: readonly Timed[]): number {
	return nextTimed(sentences, -1);
}

/** When sentence `i` is spoken, or `undefined` if nobody timed it. */
export function startOf(sentences: readonly Timed[], i: number): number | undefined {
	const sentence = sentences[i];
	return timed(sentence) ? sentence.start : undefined;
}
