import { describe, expect, it } from 'vitest';

import type { Chapter } from '$lib/db/generated/index';
import { chapterName, chapterSummary, chapterTerms, pageRange, pagesOf, toNewWord } from './index';

const chapter: Chapter = {
	label: '3',
	title: '你叫什么名字',
	firstPage: '14',
	lastPage: '21',
	sections: [
		{
			kind: 'dialogue',
			lines: [
				{ speaker: 'A', text: '你叫什么名字？' },
				{ speaker: 'B', text: '我叫李月。' }
			],
			words: []
		},
		{
			kind: 'sentences',
			lines: [{ text: '李月是我的老师。' }, { text: '这是我的书。' }],
			words: []
		},
		{
			kind: 'words',
			lines: [],
			words: [
				{ term: '叫', notes: 'v.', meaning: 'to be called', proper: false },
				{ term: '名字', proper: false }
			]
		},
		{ kind: 'words', lines: [], words: [{ term: '叫', proper: false }] }
	]
};

describe('pageRange', () => {
	it('clamps to the document and never runs backwards', () => {
		expect(pageRange(1, 120, 120)).toEqual({ from: 1, to: 120 });
		expect(pageRange(0, 3, 120)).toEqual({ from: 1, to: 3 });
		expect(pageRange(118, 130, 120)).toEqual({ from: 118, to: 120 });
		expect(pageRange(10, 4, 120)).toEqual({ from: 10, to: 10 });
		expect(pageRange(NaN, 3, 5)).toBeUndefined();
		expect(pageRange(1, 1, 0)).toBeUndefined();
	});
});

describe('a chapter on screen', () => {
	it('is named by its label and title, and an unlabelled one is the introduction', () => {
		expect(chapterName(chapter)).toBe('3 · 你叫什么名字');
		expect(chapterName({ label: 'LES 4' })).toBe('LES 4');
		expect(chapterName({ label: '4', title: 'Les 4: Ik kom uit Italië' })).toBe(
			'Les 4: Ik kom uit Italië'
		);
		expect(chapterName({})).toBe('Introduction');
	});

	it('spans its printed pages', () => {
		expect(pagesOf(chapter)).toBe('pp. 14–21');
		expect(pagesOf({ firstPage: '14', lastPage: '14' })).toBe('p. 14');
		expect(pagesOf({})).toBe('');
	});

	it('says what it holds in a line', () => {
		expect(chapterSummary(chapter)).toBe('1 dialogue · 2 sentences · 3 words');
		expect(chapterSummary({ sections: [] })).toBe('');
	});

	it('lists its vocabulary once each', () => {
		expect(chapterTerms(chapter)).toEqual(['叫', '名字']);
	});
});

describe('toNewWord', () => {
	it('files the meaning shown, the frontend’s reading and the book’s notes', () => {
		expect(toNewWord({ term: '叫', notes: 'v.' }, ' to be called ', 'jiào')).toEqual({
			term: '叫',
			meaning: 'to be called',
			romanization: 'jiào',
			notes: 'v.'
		});
		expect(toNewWord({ term: 'collega', notes: 'de' }, 'colleague', null)).toEqual({
			term: 'collega',
			meaning: 'colleague',
			notes: 'de'
		});
		expect(toNewWord({ term: 'goed' }, '  ')).toBeUndefined();
	});
});
