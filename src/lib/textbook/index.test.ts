import { describe, expect, it } from 'vitest';

import { pageRange } from './index';

describe('pageRange', () => {
	it('clamps to the document and never runs backwards', () => {
		expect(pageRange(14, 21, 120)).toEqual({ from: 14, to: 21 });
		expect(pageRange(0, 3, 120)).toEqual({ from: 1, to: 3 });
		expect(pageRange(118, 130, 120)).toEqual({ from: 118, to: 120 });
		expect(pageRange(10, 4, 120)).toEqual({ from: 10, to: 10 });
		expect(pageRange(2.7, 3.2, 5)).toEqual({ from: 2, to: 3 });
		expect(pageRange(NaN, 3, 5)).toBeUndefined();
		expect(pageRange(1, 1, 0)).toBeUndefined();
	});
});
