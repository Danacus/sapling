/**
 * The page packer. What matters is that the pages tile the text exactly — no
 * sentence lost, none read twice, and the same cut every time — because the
 * grading is scoped to a page and the page number is only ever a URL parameter.
 */

import { describe, expect, it } from 'vitest';

import { PAGE_WORDS, countWords, paginate } from './pages';

/** `n` sentences of `words` words each. */
function sentences(n: number, words: number): { text: string }[] {
	return Array.from({ length: n }, (_, i) => ({
		text: Array.from({ length: words }, (_, w) => `w${i}x${w}`).join(' ') + '.'
	}));
}

describe('countWords', () => {
	it('counts words, not punctuation or spaces', () => {
		expect(countWords('Hello, world! How are you?')).toBe(5);
		expect(countWords('')).toBe(0);
	});

	it('counts a script written without spaces by its words, not its characters', () => {
		// 我 / 每天 / 骑 / 自行车 / 去 / 学校 — six words, twelve characters.
		const n = countWords('我每天骑自行车去学校。');
		expect(n).toBeGreaterThanOrEqual(5);
		expect(n).toBeLessThanOrEqual(7);
	});
});

describe('paginate', () => {
	it('keeps a short text on one page', () => {
		expect(paginate(sentences(4, 6))).toEqual([{ start: 0, end: 4 }]);
	});

	it('packs greedily up to the budget', () => {
		// 10 words each: five fit in 50, the sixth would be 60.
		expect(paginate(sentences(13, 10), 50)).toEqual([
			{ start: 0, end: 5 },
			{ start: 5, end: 10 },
			{ start: 10, end: 13 }
		]);
	});

	it('finishes the sentence: a break never falls inside one', () => {
		// 8 words each against a budget of 30: three sentences (24) fit, the
		// fourth would be 32 — so it starts the next page whole.
		expect(paginate(sentences(8, 8), 30)).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
			{ start: 6, end: 8 }
		]);
	});

	it('gives an over-long sentence a page of its own', () => {
		const long = [...sentences(1, 90), { text: 'short.' }, ...sentences(1, 90)];
		expect(paginate(long, 50)).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 }
		]);
	});

	it('never returns an empty page', () => {
		for (const budget of [1, 10, PAGE_WORDS]) {
			for (const range of paginate(sentences(20, 9), budget)) {
				expect(range.end).toBeGreaterThan(range.start);
			}
		}
	});

	it('tiles the text exactly, in order', () => {
		const text = sentences(37, 7);
		const pages = paginate(text, 20);

		expect(pages[0].start).toBe(0);
		expect(pages.at(-1)?.end).toBe(text.length);
		for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);

		const rejoined = pages.flatMap((range) => text.slice(range.start, range.end));
		expect(rejoined).toEqual(text);
	});

	it('cuts page 1 the same way however the text ends', () => {
		const short = sentences(6, 12);
		const long = [...short, ...sentences(40, 12)];
		expect(paginate(long)[0]).toEqual(paginate(short)[0]);
	});

	it('has no pages for an empty text', () => {
		expect(paginate([])).toEqual([]);
	});

	it('pages Chinese by words, so a page is a paragraph and not a wall', () => {
		// Twelve characters, about six words, per sentence: 30 words is five
		// sentences (60 characters), where a character budget would have packed
		// ten times as many.
		const text = Array.from({ length: 20 }, () => ({ text: '我每天骑自行车去学校。' }));
		const pages = paginate(text);

		expect(pages.length).toBeGreaterThanOrEqual(3);
		for (const range of pages) {
			const words = text
				.slice(range.start, range.end)
				.reduce((sum, s) => sum + countWords(s.text), 0);
			expect(words).toBeLessThanOrEqual(PAGE_WORDS);
		}
	});
});
