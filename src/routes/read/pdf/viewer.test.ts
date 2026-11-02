import { describe, expect, it } from 'vitest';

import type { OcrLine } from '$lib/ocr';
import { annotateSentence, type AnnotateContext, type ReadingWord } from '$lib/reading/annotate';
import { tokenizeByTerms } from '$lib/reading/tokenize';
import type { KnowledgeItem } from '$lib/types';
import {
	clampPage,
	downloadOf,
	fileTitle,
	foldProgress,
	forTarget,
	inTargetScript,
	legendOf,
	megabytes,
	notYetWords,
	NO_STEPS,
	offsetOf,
	textLinesOf,
	unsureLines,
	wordAt
} from './viewer';

function line(text: string, score = 0.95): OcrLine {
	return { text, box: { x: 0, y: 0, w: 100, h: 10 }, edges: [], score };
}

function item(term: string): KnowledgeItem {
	return {
		id: `id-${term}`,
		kind: 'vocab',
		term,
		meaning: `meaning of ${term}`,
		fsrsCard: null,
		introducedAt: 0,
		history: []
	};
}

function ctx(overrides: Partial<AnnotateContext> = {}): AnnotateContext {
	return { items: [], knownTerms: [], mode: 'on', rolls: new Map(), ...overrides };
}

function tracked(text: string, itemId: string, maturity: ReadingWord['maturity']): ReadingWord {
	return { text, reading: null, key: text, status: 'tracked', itemId, maturity };
}

describe('fileTitle', () => {
	it('is the name without its extension', () => {
		expect(fileTitle([{ name: 'HSK 1 Textbook.pdf' }])).toBe('HSK 1 Textbook');
		expect(fileTitle([{ name: 'scan.page.01.jpg' }])).toBe('scan.page.01');
	});

	it('keeps a name with no extension or only a leading dot', () => {
		expect(fileTitle([{ name: 'README' }])).toBe('README');
		expect(fileTitle([{ name: '.hidden' }])).toBe('.hidden');
	});

	it('counts several images, and is empty for none', () => {
		expect(fileTitle([{ name: 'a.jpg' }, { name: 'b.jpg' }])).toBe('2 page images');
		expect(fileTitle([])).toBe('');
	});
});

describe('clampPage', () => {
	it('keeps a page in the book, rounding a fraction', () => {
		expect(clampPage(0, 150)).toBe(1);
		expect(clampPage(400, 150)).toBe(150);
		expect(clampPage(20.6, 150)).toBe(21);
	});

	it('keeps the current page for something unreadable', () => {
		expect(clampPage(Number(''), 150, 21)).toBe(1);
		expect(clampPage(Number('abc'), 150, 21)).toBe(21);
	});
});

describe('legendOf', () => {
	it('counts distinct garden words per maturity, not occurrences', () => {
		const counts = legendOf([
			[tracked('你', 'a', 'solid'), { text: '，', reading: null, status: 'plain' }],
			[tracked('你', 'a', 'solid'), tracked('叫', 'b', 'young'), tracked('名字', 'c', 'new')],
			[
				tracked('叫', 'b', 'young'),
				{ text: '什么', reading: 'shénme', key: '什么', status: 'plain' }
			]
		]);
		expect(counts).toEqual({ solid: 1, young: 1, new: 1 });
	});

	it('is all zeroes for a page with nothing held', () => {
		expect(legendOf([])).toEqual({ solid: 0, young: 0, new: 0 });
	});
});

describe('notYetWords', () => {
	it('lists the words not held, once each, with the line and offset they first stand at', () => {
		const lines = [line('Dag Els, dag!'), line('Els is een collega. 3 x 4')];
		const context = ctx({ items: [item('dag')] });
		const words = lines.map((l) => annotateSentence(l.text, tokenizeByTerms, context));
		const found = notYetWords(lines, words);
		expect(found.map((w) => [w.term, w.count, w.segment, w.offset])).toEqual([
			['Els', 2, 0, 4],
			['is', 1, 1, 4],
			['een', 1, 1, 7],
			['collega', 1, 1, 11],
			['x', 1, 1, 22]
		]);
		// The offset lands on that very word.
		const first = found[3];
		expect(wordAt(words[first.segment], first.offset)?.word.text).toBe('collega');
	});
});

describe('wordAt and offsetOf', () => {
	const words: ReadingWord[] = [
		{ text: '你', reading: 'nǐ', key: '你', status: 'plain' },
		{ text: '叫', reading: 'jiào', key: '叫', status: 'plain' },
		{ text: '什么', reading: 'shénme', key: '什么', status: 'plain' },
		{ text: '？', reading: null, status: 'plain' }
	];

	it('finds the word covering an offset, and the offset a word starts at', () => {
		expect(wordAt(words, 2)?.index).toBe(2);
		expect(wordAt(words, 3)?.index).toBe(2);
		expect(wordAt(words, 4)?.index).toBe(3);
		expect(wordAt(words, 5)).toBeUndefined();
		expect(offsetOf(words, 2)).toBe(2);
		expect(offsetOf(words, 0)).toBe(0);
	});
});

describe('unsure lines', () => {
	it('are the lines scored under 0.8', () => {
		expect(unsureLines([line('a', 0.99), line('b', 0.79), line('c', 0.8), line('d', 0.2)])).toEqual(
			[1, 3]
		);
	});

	it('leave out pictures read as text, which score under 0.5', () => {
		const kept = textLinesOf([
			line('a', 0.99),
			line('→口', 0.49),
			line('c', 0.5),
			line('雨', 0.17)
		]);
		expect(kept.map((l) => l.text)).toEqual(['a', 'c']);
	});
});

describe('the target script', () => {
	it('keeps CJK for a spaceless target and Latin for a spaced one', () => {
		expect(inTargetScript('什么', 'zh-CN')).toBe(true);
		expect(inTargetScript('Open your book.', 'zh-CN')).toBe(false);
		expect(inTargetScript('Dǎkāi shū.', 'zh')).toBe(false);
		expect(inTargetScript('meisje', 'nl')).toBe(true);
		expect(inTargetScript('什么', 'nl')).toBe(false);
		expect(inTargetScript('학생', 'ko')).toBe(true);
		expect(inTargetScript('anything', undefined)).toBe(true);
	});

	it('makes a word outside it plain text, and leaves the rest as they are', () => {
		const words: ReadingWord[] = [
			{ text: 'HSK', reading: null, key: 'hsk', status: 'plain' },
			{ text: '标准', reading: 'biāo zhǔn', key: '标准', status: 'plain' },
			{ text: ' ', reading: null, status: 'plain' }
		];
		const kept = forTarget(words, 'zh-CN');
		expect(kept[0]).toEqual({ text: 'HSK', reading: null, status: 'plain' });
		expect(kept[1]).toBe(words[1]);
		expect(kept[2]).toBe(words[2]);
	});
});

describe('reading steps', () => {
	it('folds each file’s download, then the start, then the lines', () => {
		let steps = foldProgress(NO_STEPS, {
			stage: 'Downloading detector',
			done: 2e6,
			total: 5e6
		});
		steps = foldProgress(steps, { stage: 'Downloading recognizer', done: 1e6, total: 16e6 });
		expect(downloadOf(steps)).toEqual({ done: 3e6, total: 21e6, finished: false });
		steps = foldProgress(steps, { stage: 'Starting the models', done: 0, total: 0 });
		expect(downloadOf(steps)?.finished).toBe(true);
		expect(steps.lines).toBeUndefined();
		steps = foldProgress(steps, { stage: 'Reading lines', done: 6, total: 23 });
		expect(steps.lines).toEqual({ done: 6, total: 23 });
		expect(steps.starting).toBe(true);
	});

	it('has no download row when the models were cached', () => {
		const steps = foldProgress(NO_STEPS, { stage: 'Reading lines', done: 0, total: 9 });
		expect(downloadOf(steps)).toBeUndefined();
	});

	it('leaves the total unknown while a file has not said its size', () => {
		const steps = foldProgress(NO_STEPS, { stage: 'Downloading dictionary', done: 5e4, total: 0 });
		expect(downloadOf(steps)).toEqual({ done: 5e4, total: 0, finished: false });
	});

	it('ignores a stage it does not know', () => {
		expect(foldProgress(NO_STEPS, { stage: 'Thinking', done: 1, total: 2 })).toBe(NO_STEPS);
	});
});

describe('numbers as words', () => {
	it('writes megabytes', () => {
		expect(megabytes(21_400_000)).toBe('21 MB');
		expect(megabytes(40_000)).toBe('1 MB');
		expect(megabytes(0)).toBe('0 MB');
	});
});
