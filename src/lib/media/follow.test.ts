/**
 * Following the clock. Every case here is one the shape of a real subtitle file
 * produces: silence between cues, a title card before the first one, credits
 * after the last, overlapping cues, and a transcript that was never timed at
 * all.
 */

import { describe, expect, it } from 'vitest';

import { crossedEnd, firstTimed, nextTimed, prevTimed, segmentAt, startOf } from './follow';
import type { Timed } from './follow';

/** Three cues with real gaps between them, the way subtitles actually sit. */
const cues: Timed[] = [
	{ start: 1000, end: 2000 },
	{ start: 3000, end: 4500 },
	{ start: 6000, end: 7000 }
];

/** Two cues on screen at once: the second starts before the first has ended. */
const overlapping: Timed[] = [
	{ start: 1000, end: 5000 },
	{ start: 2000, end: 3000 },
	{ start: 6000, end: 7000 }
];

/** An untimed segment spliced between two timed ones — the mixed text. */
const mixed: Timed[] = [{ start: 1000, end: 2000 }, {}, { start: 5000, end: 6000 }];

describe('segmentAt', () => {
	it('has no current line before the first cue starts', () => {
		expect(segmentAt(cues, 0)).toBe(-1);
		expect(segmentAt(cues, 999)).toBe(-1);
	});

	it('takes a start inclusively', () => {
		expect(segmentAt(cues, 1000)).toBe(0);
		expect(segmentAt(cues, 3000)).toBe(1);
		expect(segmentAt(cues, 6000)).toBe(2);
	});

	it('stays on the last line that started, through the gap after it', () => {
		expect(segmentAt(cues, 1500)).toBe(0);
		// Past cue 0's end, before cue 1 starts: the highlight does not blink off.
		expect(segmentAt(cues, 2001)).toBe(0);
		expect(segmentAt(cues, 2999)).toBe(0);
	});

	it('stays on the last line after the recording has run past it', () => {
		expect(segmentAt(cues, 7000)).toBe(2);
		expect(segmentAt(cues, 999_999)).toBe(2);
	});

	it('skips a segment nobody timed, and never lands on one', () => {
		expect(segmentAt(mixed, 2500)).toBe(0);
		expect(segmentAt(mixed, 4999)).toBe(0);
		expect(segmentAt(mixed, 5000)).toBe(2);
	});

	it('has no current line in a text with no timings at all', () => {
		const prose: Timed[] = [{}, {}, {}];
		expect(segmentAt(prose, 0)).toBe(-1);
		expect(segmentAt(prose, 10_000)).toBe(-1);
		expect(segmentAt([], 1000)).toBe(-1);
	});

	it('ignores a half-timed segment, since both offsets or neither is the rule', () => {
		const half: Timed[] = [{ start: 1000 }, { start: 2000, end: 3000 }];
		expect(segmentAt(half, 1500)).toBe(-1);
		expect(segmentAt(half, 2500)).toBe(1);
	});

	it('follows one segment at a time, even where two share a start', () => {
		const shared: Timed[] = [
			{ start: 1000, end: 2000 },
			{ start: 1000, end: 3000 }
		];
		// Both are running: the later one wins, alone.
		expect(segmentAt(shared, 1500)).toBe(1);
		// The first has ended; the second is still running.
		expect(segmentAt(shared, 2500)).toBe(1);
	});

	it('lets a cue still running win over a later one that has already ended', () => {
		expect(segmentAt(overlapping, 1500)).toBe(0);
		expect(segmentAt(overlapping, 2500)).toBe(1);
		// Back to the long cue once the short one inside it is over.
		expect(segmentAt(overlapping, 3500)).toBe(0);
		// In the silence after both, the last to have started holds.
		expect(segmentAt(overlapping, 5500)).toBe(1);
		expect(segmentAt(overlapping, 6500)).toBe(2);
	});
});

describe('crossedEnd', () => {
	it('is true exactly on the sample that passes the end', () => {
		expect(crossedEnd(cues, 0, 1800, 2000)).toBe(true);
		expect(crossedEnd(cues, 0, 1800, 2200)).toBe(true);
	});

	it('is false on every later sample, so auto-pause fires once', () => {
		expect(crossedEnd(cues, 0, 2000, 2200)).toBe(false);
		expect(crossedEnd(cues, 0, 2200, 2400)).toBe(false);
	});

	it('is false while the line is still running', () => {
		expect(crossedEnd(cues, 0, 1200, 1400)).toBe(false);
	});

	it('is false for a seek backwards over the end', () => {
		expect(crossedEnd(cues, 0, 2500, 1200)).toBe(false);
	});

	it('is false for a segment with no timings, and for an index off the end', () => {
		expect(crossedEnd(mixed, 1, 0, 999_999)).toBe(false);
		expect(crossedEnd(cues, 9, 0, 999_999)).toBe(false);
		expect(crossedEnd(cues, -1, 0, 999_999)).toBe(false);
	});
});

describe('nextTimed and prevTimed', () => {
	it('steps to the neighbouring line', () => {
		expect(nextTimed(cues, 0)).toBe(1);
		expect(prevTimed(cues, 2)).toBe(1);
	});

	it('skips over an untimed segment in both directions', () => {
		expect(nextTimed(mixed, 0)).toBe(2);
		expect(prevTimed(mixed, 2)).toBe(0);
	});

	it('returns -1 at either end', () => {
		expect(nextTimed(cues, 2)).toBe(-1);
		expect(prevTimed(cues, 0)).toBe(-1);
		expect(nextTimed([], 0)).toBe(-1);
		expect(prevTimed([], 0)).toBe(-1);
	});

	it('finds the first line from the no-current-line state', () => {
		expect(nextTimed(cues, -1)).toBe(0);
		expect(nextTimed(mixed, -1)).toBe(0);
		expect(firstTimed(mixed)).toBe(0);
		expect(firstTimed([{}, { start: 4, end: 5 }])).toBe(1);
		expect(firstTimed([{}])).toBe(-1);
	});
});

describe('startOf', () => {
	it('gives a timed segment its start and everything else nothing', () => {
		expect(startOf(cues, 1)).toBe(3000);
		expect(startOf(mixed, 1)).toBeUndefined();
		expect(startOf(cues, -1)).toBeUndefined();
		expect(startOf(cues, 99)).toBeUndefined();
	});
});
