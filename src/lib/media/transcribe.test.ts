import { describe, expect, it } from 'vitest';

import { framesFor, keepSpans, subtitleRect, WINDOW_TAIL_MS } from './transcribe';

const span = (start: number, end: number) => ({ start, end, text: 'x' });

describe('keepSpans', () => {
	it('hears a span the window may have cut again in the next window', () => {
		const spans = [span(1000, 3000), span(298_500, 300_000)];
		expect(keepSpans(spans, 0, 300_000, 600_000)).toEqual({
			keep: [span(1000, 3000)],
			next: 298_500
		});
	});

	it('keeps everything when the last span ends clear of the window’s end', () => {
		const spans = [span(1000, 3000), span(200_000, 300_000 - WINDOW_TAIL_MS - 1)];
		expect(keepSpans(spans, 0, 300_000, 600_000)).toEqual({ keep: spans, next: 300_000 });
	});

	it('keeps the last span of the recording, which nothing cut', () => {
		const spans = [span(598_000, 600_000)];
		expect(keepSpans(spans, 300_000, 600_000, 600_000).keep).toEqual(spans);
	});

	it('never starts a window where it started, so it always moves on', () => {
		const spans = [span(300_000, 600_000)];
		expect(keepSpans(spans, 300_000, 600_000, 900_000).next).toBe(600_000);
	});
});

describe('framesFor', () => {
	it('reads a short span once, in its middle', () => {
		expect(framesFor({ start: 1000, end: 2500 })).toEqual([1750]);
	});

	it('reads a longer one at its thirds', () => {
		expect(framesFor({ start: 0, end: 3000 })).toEqual([1000, 2000]);
	});
});

describe('subtitleRect', () => {
	it('is the bottom quarter, full width', () => {
		expect(subtitleRect(1920, 1080)).toEqual({ x: 0, y: 810, width: 1920, height: 270 });
	});
});
