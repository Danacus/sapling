import { describe, expect, it } from 'vitest';

import { revealDelta, stepWord } from './word-nav';

const w = (key?: string) => (key === undefined ? {} : { key });

// Line 0: a , b   Line 1: (space) c   Line 2: d
const lines = [[w('a'), w(), w('b')], [w(), w('c')], [w('d')]];

describe('stepWord', () => {
	it('moves to the next tappable token on the same line, skipping plain text', () => {
		expect(stepWord(lines, { line: 0, word: 0 }, 1)).toEqual({ line: 0, word: 2 });
	});

	it('crosses into the next line', () => {
		expect(stepWord(lines, { line: 0, word: 2 }, 1)).toEqual({ line: 1, word: 1 });
	});

	it('moves back across a line', () => {
		expect(stepWord(lines, { line: 1, word: 1 }, -1)).toEqual({ line: 0, word: 2 });
		expect(stepWord(lines, { line: 2, word: 0 }, -1)).toEqual({ line: 1, word: 1 });
	});

	it('stops at either end', () => {
		expect(stepWord(lines, { line: 0, word: 0 }, -1)).toBeUndefined();
		expect(stepWord(lines, { line: 2, word: 0 }, 1)).toBeUndefined();
	});

	it('stays inside the range it is given', () => {
		const page = { start: 1, end: 2 };
		expect(stepWord(lines, { line: 1, word: 1 }, 1, page)).toBeUndefined();
		expect(stepWord(lines, { line: 1, word: 1 }, -1, page)).toBeUndefined();
	});

	it('skips a line with nothing tappable', () => {
		const sparse = [[w('a')], [w(), w()], [w('b')]];
		expect(stepWord(sparse, { line: 0, word: 0 }, 1)).toEqual({ line: 2, word: 0 });
		expect(stepWord(sparse, { line: 2, word: 0 }, -1)).toEqual({ line: 0, word: 0 });
	});
});

describe('revealDelta', () => {
	const view = { left: 0, top: 0, width: 400, height: 600 };

	it('leaves a target already inside alone', () => {
		expect(revealDelta(view, { left: 100, top: 100, width: 40, height: 20 }, 16)).toEqual({
			x: 0,
			y: 0
		});
	});

	it('centres a target below the view', () => {
		// Centre at 1010, the view's at 300.
		expect(revealDelta(view, { left: 100, top: 1000, width: 40, height: 20 }, 16)).toEqual({
			x: 0,
			y: 710
		});
	});

	it('centres a target above, and to the side', () => {
		expect(revealDelta(view, { left: -200, top: -100, width: 40, height: 20 }, 16)).toEqual({
			x: -380,
			y: -390
		});
	});

	it('counts the margin as outside', () => {
		expect(revealDelta(view, { left: 100, top: 590, width: 40, height: 20 }, 16).y).toBe(300);
	});
});
