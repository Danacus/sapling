import { describe, expect, it } from 'vitest';

import { MAX_GLOSS_WORDS } from '$lib/llm';
import { glossBatches, pageRange, startsPicked, toNewWord, withGlosses } from './index';

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

describe('the word review', () => {
	it('ticks the book’s words, but not names or words already held', () => {
		const known = new Set(['老师']);
		expect(startsPicked({ term: '学生', proper: false }, known)).toBe(true);
		expect(startsPicked({ term: '李月', proper: true }, known)).toBe(false);
		expect(startsPicked({ term: ' 老师 ', proper: false }, known)).toBe(false);
	});

	it('files the meaning the row shows, the reading as romanization, and the notes', () => {
		expect(
			toNewWord(
				{ term: '叫', reading: 'jiào', notes: 'v.', meaning: 'to call', proper: false },
				' to be called '
			)
		).toEqual({ term: '叫', meaning: 'to be called', romanization: 'jiào', notes: 'v.' });
		expect(toNewWord({ term: 'collega', notes: 'de', proper: false }, 'colleague')).toEqual({
			term: 'collega',
			meaning: 'colleague',
			notes: 'de'
		});
		expect(toNewWord({ term: 'goed', proper: false }, '  ')).toBeUndefined();
	});

	it('fills only the meanings and readings a word lacked', () => {
		const words = withGlosses(
			[
				{ term: 'Leche', proper: false },
				{ term: '叫', meaning: 'to call', proper: false },
				{ term: '名字', reading: 'míngzi', proper: false }
			],
			[
				{ term: 'leche', meaning: 'milk' },
				{ term: '叫', meaning: 'to shout' },
				{ term: '名字', meaning: 'name', reading: 'mingzi' }
			]
		);
		expect(words).toEqual([
			{ term: 'Leche', meaning: 'milk', proper: false },
			{ term: '叫', meaning: 'to call', proper: false },
			{ term: '名字', meaning: 'name', reading: 'míngzi', proper: false }
		]);
	});

	it('cuts a long list into calls the gloss takes', () => {
		const batches = glossBatches(Array.from({ length: MAX_GLOSS_WORDS * 2 + 1 }, (_, i) => i));
		expect(batches.map((b) => b.length)).toEqual([MAX_GLOSS_WORDS, MAX_GLOSS_WORDS, 1]);
	});
});
