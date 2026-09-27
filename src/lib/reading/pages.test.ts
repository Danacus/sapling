/**
 * The page packer. What matters is that the pages tile the text exactly — no
 * segment lost, none read twice, and the same cut every time — because the
 * grading is scoped to a page and the page number is only ever a URL parameter.
 * And that a long segment is cut only where it has to be, into pieces that
 * give it back character for character.
 */

import { describe, expect, it } from 'vitest';

import {
	PAGE_WORDS,
	countWords,
	paginate,
	pieceOffset,
	piecesOfSegment,
	sentenceAt
} from './pages';

/** `n` one-sentence segments of `words` words each. */
function segments(n: number, words: number): { text: string }[] {
	return Array.from({ length: n }, (_, i) => ({
		text: Array.from({ length: words }, (_, w) => `w${i}x${w}`).join(' ') + '.'
	}));
}

/** The pages, as the ranges alone. */
function pages(input: { text: string }[], budget?: number) {
	return paginate(input, budget).pages;
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
	it('keeps a short text on one page, one piece per segment', () => {
		const text = segments(4, 6);
		const { pieces, pages } = paginate(text);
		expect(pages).toEqual([{ start: 0, end: 4 }]);
		expect(pieces).toEqual(text.map((segment, i) => ({ segment: i, text: segment.text })));
	});

	it('packs greedily up to the budget', () => {
		// 10 words each: five fit in 50, the sixth would be 60.
		expect(pages(segments(13, 10), 50)).toEqual([
			{ start: 0, end: 5 },
			{ start: 5, end: 10 },
			{ start: 10, end: 13 }
		]);
	});

	it('finishes the segment: a break never falls inside one that fits a page', () => {
		// 8 words each against a budget of 30: three segments (24) fit, the
		// fourth would be 32 — so it starts the next page whole.
		expect(pages(segments(8, 8), 30)).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
			{ start: 6, end: 8 }
		]);
	});

	it('cuts a segment longer than a page at its sentences, and only that one', () => {
		const paragraph = 'Uno dos tres cuatro. Cinco seis siete ocho. Nueve diez once doce.';
		const { pieces, pages } = paginate([{ text: 'Hola.' }, { text: paragraph }], 8);

		expect(pieces.map((piece) => piece.segment)).toEqual([0, 1, 1, 1]);
		expect(pieces[0].text).toBe('Hola.');
		// The cut is a view: the pieces give the paragraph back exactly.
		expect(
			pieces
				.filter((piece) => piece.segment === 1)
				.map((piece) => piece.text)
				.join('')
		).toBe(paragraph);
		expect(pieces[1].text).toBe('Uno dos tres cuatro. ');
		// 1 + 4 fit in 8 and the next sentence would make 9; the last two make 8.
		expect(pages).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 }
		]);
	});

	it('gives an over-long sentence a page of its own', () => {
		const long = [...segments(1, 90), { text: 'short.' }, ...segments(1, 90)];
		expect(pages(long, 50)).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 }
		]);
	});

	it('never returns an empty page', () => {
		for (const budget of [1, 10, PAGE_WORDS]) {
			for (const range of pages(segments(20, 9), budget)) {
				expect(range.end).toBeGreaterThan(range.start);
			}
		}
	});

	it('tiles the text exactly, in order', () => {
		const text = segments(37, 7);
		const { pieces, pages } = paginate(text, 20);

		expect(pages[0].start).toBe(0);
		expect(pages.at(-1)?.end).toBe(pieces.length);
		for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end);

		const rejoined = pages.flatMap((range) => pieces.slice(range.start, range.end));
		expect(rejoined.map((piece) => piece.text)).toEqual(text.map((segment) => segment.text));
	});

	it('cuts page 1 the same way however the text ends', () => {
		const short = segments(6, 12);
		const long = [...short, ...segments(40, 12)];
		expect(pages(long)[0]).toEqual(pages(short)[0]);
	});

	it('has no pages for an empty text', () => {
		expect(paginate([])).toEqual({ pieces: [], pages: [] });
	});

	it('pages Chinese by words, so a page is a paragraph and not a wall', () => {
		// Twelve characters, about six words, per segment: 30 words is five
		// segments (60 characters), where a character budget would have packed
		// ten times as many.
		const text = Array.from({ length: 20 }, () => ({ text: '我每天骑自行车去学校。' }));
		const { pieces, pages } = paginate(text);

		expect(pages.length).toBeGreaterThanOrEqual(3);
		for (const range of pages) {
			const words = pieces
				.slice(range.start, range.end)
				.reduce((sum, piece) => sum + countWords(piece.text), 0);
			expect(words).toBeLessThanOrEqual(PAGE_WORDS);
		}
	});
});

describe('piecesOfSegment', () => {
	const pieces = [
		{ segment: 0, text: 'a' },
		{ segment: 1, text: 'b. ' },
		{ segment: 1, text: 'c.' },
		{ segment: 2, text: 'd' }
	];

	it('is the run of pieces one segment became', () => {
		expect(piecesOfSegment(pieces, 0)).toEqual({ start: 0, end: 1 });
		expect(piecesOfSegment(pieces, 1)).toEqual({ start: 1, end: 3 });
		expect(piecesOfSegment(pieces, 2)).toEqual({ start: 3, end: 4 });
	});

	it('is empty for no segment at all', () => {
		expect(piecesOfSegment(pieces, -1)).toEqual({ start: 0, end: 0 });
		expect(piecesOfSegment(pieces, 9)).toEqual({ start: 0, end: 0 });
	});
});

describe('pieceOffset', () => {
	const pieces = [
		{ segment: 0, text: 'a' },
		{ segment: 1, text: 'b. ' },
		{ segment: 1, text: 'cc. ' },
		{ segment: 1, text: 'd.' },
		{ segment: 2, text: 'e' }
	];

	it('is where a piece starts inside its own segment', () => {
		expect(pieceOffset(pieces, 1)).toBe(0);
		expect(pieceOffset(pieces, 2)).toBe(3);
		expect(pieceOffset(pieces, 3)).toBe(7);
	});

	it('is zero for a whole-segment piece and for nothing at all', () => {
		expect(pieceOffset(pieces, 0)).toBe(0);
		expect(pieceOffset(pieces, 4)).toBe(0);
		expect(pieceOffset(pieces, 9)).toBe(0);
	});
});

describe('sentenceAt', () => {
	const text = 'La cuenta no era cara. Dejamos una propina. Volveremos.';

	it('is the sentence that holds the offset, trimmed', () => {
		expect(sentenceAt(text, 3)).toBe('La cuenta no era cara.');
		expect(sentenceAt(text, text.indexOf('propina'))).toBe('Dejamos una propina.');
		expect(sentenceAt(text, text.indexOf('Volveremos'))).toBe('Volveremos.');
	});

	it('clamps an offset outside the text to its first or last sentence', () => {
		expect(sentenceAt(text, -4)).toBe('La cuenta no era cara.');
		expect(sentenceAt(text, 999)).toBe('Volveremos.');
	});

	it('cuts a script written without spaces at its own full stops', () => {
		const zh = '我点了汤。她点了鱼和米饭。';
		expect(sentenceAt(zh, zh.indexOf('鱼'))).toBe('她点了鱼和米饭。');
	});

	it('is the whole text when there is one sentence', () => {
		expect(sentenceAt('Hola', 2)).toBe('Hola');
	});
});
