import { describe, expect, it } from 'vitest';

import { crossedStop, paddedSpan, SPAN_PAD_MS } from './span';

describe('paddedSpan', () => {
	it('pads both sides', () => {
		expect(paddedSpan(3000, 4500)).toEqual({ from: 3000 - SPAN_PAD_MS, to: 4500 + SPAN_PAD_MS });
	});

	it('never starts before the recording', () => {
		expect(paddedSpan(100, 900).from).toBe(0);
		expect(paddedSpan(0, 900).from).toBe(0);
	});
});

describe('crossedStop', () => {
	it('is true on the sample that reaches or passes the stop', () => {
		expect(crossedStop(2000, 1800, 2000)).toBe(true);
		expect(crossedStop(2000, 1800, 2300)).toBe(true);
	});

	it('is false on every later sample, so it pauses once', () => {
		expect(crossedStop(2000, 2000, 2200)).toBe(false);
		expect(crossedStop(2000, 2200, 2400)).toBe(false);
	});

	it('is false while the span is still playing', () => {
		expect(crossedStop(2000, 1200, 1400)).toBe(false);
	});

	it('is false for a seek backwards over the stop', () => {
		expect(crossedStop(2000, 2500, 1200)).toBe(false);
	});
});
