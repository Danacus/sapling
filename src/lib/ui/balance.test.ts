import { describe, expect, it } from 'vitest';

import { splitColumns } from './balance';

/** Greedy column fill at `height`, as a column flex-wrap lays it out. */
function wrapAt(heights: number[], gap: number, height: number): number {
	let used = 0;
	for (let i = 0; i < heights.length; i++) {
		const next = used === 0 ? heights[i] : used + gap + heights[i];
		if (i > 0 && next > height) return i;
		used = next;
	}
	return heights.length;
}

describe('splitColumns', () => {
	it('keeps an empty or single list in one column', () => {
		expect(splitColumns([], 20)).toEqual({ split: 0, height: 1 });
		expect(splitColumns([300], 20).split).toBe(1);
	});

	it('picks the contiguous split with the shortest taller column', () => {
		// The settings page as Firefox measured it at 1300px.
		const heights = [193, 384, 484, 532, 378, 287, 319, 299, 167];
		const { split, height } = splitColumns(heights, 24);
		expect(split).toBe(4);
		// The first column, plus the full pixel of slack: the next card is far off.
		expect(height).toBe(193 + 384 + 484 + 532 + 3 * 24 + 1);
	});

	it('wraps exactly after the split at the height it returns', () => {
		const cases: [number[], number][] = [
			[[100, 100, 100, 100], 10],
			[[50, 400, 60, 70, 80], 16],
			[[120.4, 80.3, 200.6, 99.9, 10.1], 24],
			[[10, 10, 10, 500], 20],
			[[500, 10, 10, 10], 20]
		];
		for (const [heights, gap] of cases) {
			const { split, height } = splitColumns(heights, gap);
			expect(wrapAt(heights, gap, height)).toBe(split);
		}
	});

	it('breaks a tie towards the longer first column', () => {
		// [100 | 100 100] and [100 100 | 100] tie at 210 — the first column takes two.
		expect(splitColumns([100, 100, 100], 10).split).toBe(2);
	});

	it('leaves the next item no room even when the second column is taller', () => {
		// [200 | 50 199.6]: the second column (249.6) is the taller, and pulling
		// the 50 across would make 250 — a 0.4px overflow, so the slack is 0.2.
		const heights = [200, 50, 199.6];
		const { split, height } = splitColumns(heights, 0);
		expect(split).toBe(1);
		expect(height).toBeCloseTo(249.8);
		expect(wrapAt(heights, 0, height)).toBe(1);
	});
});
