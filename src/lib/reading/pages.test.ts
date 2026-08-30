/**
 * The page packer. What matters is that the pages tile the text exactly — no
 * sentence lost, none read twice, and the same cut every time — because the
 * grading is scoped to a page and the page number is only ever a URL parameter.
 */

import { describe, expect, it } from 'vitest';

import { PAGE_CHARS, paginate } from './pages';

/** `n` sentences of `length` characters each. */
function sentences(n: number, length: number): { text: string }[] {
	return Array.from({ length: n }, (_, i) => ({ text: `${i}`.padEnd(length, 'x') }));
}

describe('paginate', () => {
	it('keeps a short text on one page', () => {
		expect(paginate(sentences(8, 40))).toEqual([{ start: 0, end: 8 }]);
	});

	it('packs greedily up to the budget', () => {
		// 100 chars each: five fit in 500, the sixth would be 600.
		expect(paginate(sentences(13, 100), 500)).toEqual([
			{ start: 0, end: 5 },
			{ start: 5, end: 10 },
			{ start: 10, end: 13 }
		]);
	});

	it('gives an over-long sentence a page of its own', () => {
		const long = [{ text: 'a'.repeat(900) }, { text: 'short.' }, { text: 'b'.repeat(900) }];
		expect(paginate(long, 500)).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 }
		]);
	});

	it('never returns an empty page', () => {
		for (const budget of [1, 10, 700]) {
			for (const range of paginate(sentences(20, 90), budget)) {
				expect(range.end).toBeGreaterThan(range.start);
			}
		}
	});

	it('tiles the text exactly, in order', () => {
		const text = sentences(37, 63);
		const pages = paginate(text, 200);

		expect(pages[0].start).toBe(0);
		expect(pages.at(-1)?.end).toBe(text.length);
		for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);

		const rejoined = pages.flatMap((range) => text.slice(range.start, range.end));
		expect(rejoined).toEqual(text);
	});

	it('cuts page 1 the same way however the text ends', () => {
		const short = sentences(6, 200);
		const long = [...short, ...sentences(40, 200)];
		expect(paginate(long, 700)[0]).toEqual(paginate(short, 700)[0]);
	});

	it('has no pages for an empty text', () => {
		expect(paginate([])).toEqual([]);
	});

	it('cuts a full-length import into a handful of pages at the default budget', () => {
		// `MAX_IMPORT_CHARS` (4000) of prose in 80-character sentences: eight to a
		// page, so seven pages — a handful, not a scroll and not a flipbook.
		const text = sentences(50, 80);
		const pages = paginate(text);

		expect(pages.length).toBe(7);
		for (const range of pages) {
			const chars = text.slice(range.start, range.end).reduce((sum, s) => sum + s.text.length, 0);
			expect(chars).toBeLessThanOrEqual(PAGE_CHARS);
		}
	});
});
