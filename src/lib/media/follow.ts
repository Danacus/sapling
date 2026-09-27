/**
 * Which line of a text is being spoken right now.
 *
 * Pure, like `$lib/reading/pages`: it is handed the segments and a position in
 * milliseconds and gives back an index. No element, no clock of its own, no
 * DOM — the reader owns the player and the state, and everything that could be
 * subtly wrong about following a subtitle track is decided here, where a test
 * can hold the clock still.
 *
 * A line is one segment — one cue, stored as the file had it with its own span
 * — so the unit of following is the single segment and never a group.
 *
 * The rules the shape of a subtitle file forces:
 *
 * - **The current line is the one whose `[start, end)` holds the clock, or else
 *   the last one to have started.** Cues do not tile a recording; there is
 *   silence between them, and a highlight that blinked off between every pair
 *   of lines would flicker through a whole conversation. Where two cues overlap
 *   (a speaker change shown as two lines at once), the one still running wins
 *   over a later one that has already ended, and between two running ones the
 *   later start does.
 * - **`start` is inclusive.** A player asked to seek to a line's start reports
 *   exactly that number back, and landing one line *before* the one you asked
 *   for is the bug the learner would notice first.
 * - **A segment with no timings is skipped, never landed on.** The importer
 *   gives both offsets or neither, and a text mixing the two must not swallow
 *   the lines around it.
 * - **Before the first timed segment there is no current line** (`-1`), which
 *   is also the answer for a text with no timings at all. A recording that
 *   opens on a title card is reading nothing, and saying "line 0" there would
 *   highlight a line nobody has spoken yet.
 */

/** All this module needs of a segment: when it is spoken, if anyone knows. */
export interface Timed {
	start?: number;
	end?: number;
}

/** Whether a segment carries a usable span. Both or neither, per the importer. */
function timed(segment: Timed | undefined): segment is { start: number; end: number } {
	return (
		segment !== undefined && typeof segment.start === 'number' && typeof segment.end === 'number'
	);
}

/**
 * The index of the segment being spoken at `ms`, or `-1`.
 *
 * The last segment whose `[start, end)` contains `ms`; failing that, the last
 * one whose `start` has passed. A linear scan rather than a binary search: the
 * segments are in order, but a text is at most a few hundred of them and this
 * runs on `timeupdate` — four times a second, not per frame.
 */
export function segmentAt(segments: readonly Timed[], ms: number): number {
	let started = -1;
	let running = -1;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!timed(segment)) continue;
		// Ordered, so the first start beyond `ms` ends the walk — and every later
		// one is beyond it too.
		if (segment.start > ms) break;
		started = i;
		if (ms < segment.end) running = i;
	}
	return running >= 0 ? running : started;
}

/**
 * Whether playback has just run off the end of segment `i`.
 *
 * The auto-pause question, and it is asked between two samples rather than
 * against the present alone: `timeupdate` fires every 200-odd milliseconds, so
 * "is `ms` past the end" would be true for every sample until the next line
 * starts and would pause again the moment the learner pressed play. Asking
 * whether the boundary fell *between* the last position and this one makes it
 * true exactly once per crossing.
 *
 * A seek backwards over the end is not a crossing (the interval is empty
 * backwards), and neither is a jump that lands before the segment began.
 */
export function crossedEnd(
	segments: readonly Timed[],
	i: number,
	prevMs: number,
	ms: number
): boolean {
	const segment = segments[i];
	if (!timed(segment)) return false;
	return prevMs < segment.end && ms >= segment.end;
}

/** The next segment after `i` that has timings, or `-1` — the "next line" button. */
export function nextTimed(segments: readonly Timed[], i: number): number {
	for (let n = Math.max(i, -1) + 1; n < segments.length; n += 1) {
		if (timed(segments[n])) return n;
	}
	return -1;
}

/**
 * The previous timed segment before `i`, or `-1`.
 *
 * Not the replay button — replaying a line seeks to the line it is already on.
 * This is the step *back*, and it is here because "which line is before this
 * one" is the same skipping walk as `nextTimed` and deserves the same test.
 */
export function prevTimed(segments: readonly Timed[], i: number): number {
	for (let p = Math.min(i, segments.length) - 1; p >= 0; p -= 1) {
		if (timed(segments[p])) return p;
	}
	return -1;
}

/** The first timed segment, or `-1` — where a text with no current line starts. */
export function firstTimed(segments: readonly Timed[]): number {
	return nextTimed(segments, -1);
}

/** When segment `i` is spoken, or `undefined` if nobody timed it. */
export function startOf(segments: readonly Timed[], i: number): number | undefined {
	const segment = segments[i];
	return timed(segment) ? segment.start : undefined;
}
