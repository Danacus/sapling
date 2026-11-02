import { describe, expect, it } from 'vitest';

import type { OcrLine } from '$lib/ocr';
import { annotateSentence, type AnnotateContext, type ReadingWord } from '$lib/reading/annotate';
import { tokenizeByTerms } from '$lib/reading/tokenize';
import type { KnowledgeItem } from '$lib/types';
import {
	accumulateZoom,
	boxOf,
	clampPage,
	clampScale,
	DEFAULT_ZOOM,
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
	parsePosition,
	parseZoom,
	placeWords,
	positionKey,
	serializePosition,
	textLinesOf,
	unsureLines,
	wheelFactor,
	wordAt,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_PRESETS,
	zoomChoice,
	zoomLabel,
	zoomOf,
	zoomOrigin,
	zoomStep
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
		expect(fileTitle({ name: 'HSK 1 Textbook.pdf' })).toBe('HSK 1 Textbook');
		expect(fileTitle({ name: 'scan.page.01.pdf' })).toBe('scan.page.01');
	});

	it('keeps a name with no extension or only a leading dot', () => {
		expect(fileTitle({ name: 'README' })).toBe('README');
		expect(fileTitle({ name: '.hidden' })).toBe('.hidden');
	});
});

describe('placing words', () => {
	const size = { width: 200, height: 100 };

	it('boxes a line in percentages of the page', () => {
		expect(boxOf(line('你好'), size)).toEqual({ left: 0, top: 0, width: 50, height: 10 });
	});

	it('cuts each keyed word out of its line at its edges', () => {
		const read: OcrLine = {
			text: '我 好',
			box: { x: 20, y: 10, w: 60, h: 20 },
			edges: [20, 40, 60, 80],
			score: 1
		};
		const words: ReadingWord[] = [
			{ text: '我', reading: null, key: '我', status: 'plain' },
			{ text: ' ', reading: null, status: 'plain' },
			{ text: '好', reading: null, key: '好', status: 'plain' }
		];
		const placed = placeWords([read], [words], size);
		expect(placed.map((at) => [at.word.text, at.offset, at.left, at.width])).toEqual([
			['我', 0, 10, 10],
			['好', 2, 30, 10]
		]);
		expect(placed[0]).toMatchObject({ line: 0, top: 10, height: 20 });
	});

	it("falls back to the line's ends where edges are missing", () => {
		const read: OcrLine = { text: '好', box: { x: 20, y: 0, w: 60, h: 10 }, edges: [], score: 1 };
		const [at] = placeWords(
			[read],
			[[{ text: '好', reading: null, key: '好', status: 'plain' }]],
			size
		);
		expect(at).toMatchObject({ left: 10, width: 30 });
	});
});

describe('zoom', () => {
	it('lists the fits first, then the scales, labelled', () => {
		expect(ZOOM_PRESETS.map((preset) => preset.label)).toEqual([
			'Fit page',
			'Fit width',
			'50%',
			'75%',
			'100%',
			'125%',
			'150%',
			'200%',
			'300%',
			'400%'
		]);
		expect(zoomLabel(0.874)).toBe('87%');
	});

	it('reads a zoom leniently and clamps a scale', () => {
		expect(parseZoom('page-fit')).toBe('page-fit');
		expect(parseZoom('page-width')).toBe('page-width');
		expect(parseZoom('1.25')).toBe(1.25);
		expect(parseZoom(1.5)).toBe(1.5);
		expect(parseZoom(40)).toBe(ZOOM_MAX);
		expect(parseZoom(0.01)).toBe(ZOOM_MIN);
		expect(parseZoom('auto')).toBeUndefined();
		expect(parseZoom('')).toBeUndefined();
		expect(parseZoom(-1)).toBeUndefined();
		expect(parseZoom(null)).toBeUndefined();
		expect(clampScale(3)).toBe(3);
	});

	it('keeps a fit as a fit, and rounds a scale as pdf.js does', () => {
		expect(zoomOf(0.8734, 'page-fit')).toBe('page-fit');
		expect(zoomOf(1.3, 'page-width')).toBe('page-width');
		expect(zoomOf(0.8734)).toBe(0.87);
		expect(zoomOf(1.25, '1.25')).toBe(1.25);
	});

	it('names the menu entry, or custom for a pinched scale', () => {
		expect(zoomChoice('page-fit')).toBe('page-fit');
		expect(zoomChoice(1.25)).toBe('1.25');
		expect(zoomChoice(1.37)).toBe('custom');
	});

	it('steps to the next preset scale either way, within the limits', () => {
		expect(zoomStep(1, 1)).toBe(1.25);
		expect(zoomStep(1, -1)).toBe(0.75);
		expect(zoomStep(1.1, 1)).toBe(1.25);
		expect(zoomStep(1.1, -1)).toBe(1);
		expect(zoomStep(0.874, 1)).toBe(1);
		expect(zoomStep(4, 1)).toBe(ZOOM_MAX);
		expect(zoomStep(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
		expect(zoomStep(0.5, -1)).toBe(ZOOM_MIN);
	});

	it('makes a wheel delta a factor: down is out, one notch about 10%', () => {
		expect(wheelFactor(0, 0)).toBe(1);
		expect(wheelFactor(100, 0)).toBeCloseTo(Math.exp(-0.1));
		expect(wheelFactor(-100, 0)).toBeCloseTo(Math.exp(0.1));
		expect(wheelFactor(3, 1)).toBeCloseTo(Math.exp(-0.1));
		expect(wheelFactor(2, 0)).toBeCloseTo(Math.exp(-0.02));
		expect(wheelFactor(-1, 2)).toBeCloseTo(Math.exp(0.1));
	});

	it('accumulates factors until the rounded scale moves', () => {
		let step = accumulateZoom(0.5, 1, 1.004);
		expect(step.scale).toBeUndefined();
		step = accumulateZoom(0.5, step.pending, 1.004);
		expect(step.scale).toBeUndefined();
		step = accumulateZoom(0.5, step.pending, 1.01);
		expect(step).toEqual({ scale: 0.51, pending: 1 });
		expect(accumulateZoom(1, 1, 1.2)).toEqual({ scale: 1.2, pending: 1 });
	});

	it('clears the account at a limit', () => {
		expect(accumulateZoom(ZOOM_MAX, 1, 1.5)).toEqual({ scale: undefined, pending: 1 });
		expect(accumulateZoom(ZOOM_MIN, 1, 0.5)).toEqual({ scale: undefined, pending: 1 });
		expect(accumulateZoom(4.9, 1, 1.5)).toEqual({ scale: ZOOM_MAX, pending: 1 });
	});

	it('makes a client point the origin pdf.js expects', () => {
		expect(zoomOrigin({ x: 500, y: 300 }, { left: 200, top: 100 }, { left: 0, top: 0 })).toEqual([
			300, 200
		]);
		expect(zoomOrigin({ x: 500, y: 300 }, { left: 200, top: 100 }, { left: 8, top: 4 })).toEqual([
			308, 204
		]);
	});
});

describe('the remembered position', () => {
	it('keys a file by its size and name', () => {
		expect(positionKey({ name: 'HSK 1.pdf', size: 1234 })).toBe('ll.pdfPosition.1234:HSK 1.pdf');
		expect(positionKey({ name: 'HSK 1.pdf', size: 1235 })).not.toBe(
			positionKey({ name: 'HSK 1.pdf', size: 1234 })
		);
	});

	it('round-trips a page and a zoom', () => {
		for (const zoom of ['page-fit', 'page-width', 1.5] as const) {
			expect(parsePosition(serializePosition({ page: 12, zoom }))).toEqual({ page: 12, zoom });
		}
	});

	it('reads anything broken as nothing, and a bad zoom as the default', () => {
		expect(parsePosition(null)).toBeUndefined();
		expect(parsePosition('')).toBeUndefined();
		expect(parsePosition('{')).toBeUndefined();
		expect(parsePosition('7')).toBeUndefined();
		expect(parsePosition('{"page":0,"zoom":1}')).toBeUndefined();
		expect(parsePosition('{"page":2.5,"zoom":1}')).toBeUndefined();
		expect(parsePosition('{"page":3,"zoom":"auto"}')).toEqual({ page: 3, zoom: DEFAULT_ZOOM });
		expect(parsePosition('{"page":3}')).toEqual({ page: 3, zoom: DEFAULT_ZOOM });
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
