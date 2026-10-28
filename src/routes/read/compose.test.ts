import { describe, expect, it } from 'vitest';

import { TITLE_CHARS, baseName, clock, extent, firstLine, tabFrom } from './compose';

describe('firstLine', () => {
	it('takes the first non-blank line of the first segment', () => {
		expect(firstLine([{ text: '\n  Hello there \nmore' }, { text: 'later' }])).toBe('Hello there');
	});

	it('is empty for no segments', () => {
		expect(firstLine([])).toBe('');
	});

	it('cuts a long line to a label', () => {
		const label = firstLine([{ text: '字'.repeat(TITLE_CHARS + 5) }]);
		expect([...label]).toHaveLength(TITLE_CHARS + 1);
		expect(label.endsWith('…')).toBe(true);
	});
});

describe('extent', () => {
	it('counts cues as lines and prose as paragraphs', () => {
		expect(extent([{ text: 'a', start: 0, end: 1 }])).toBe('1 line');
		expect(extent([{ text: 'a' }, { text: 'b' }])).toBe('2 paragraphs');
	});
});

describe('clock', () => {
	it('writes minutes, and hours only when needed', () => {
		expect(clock(65_000)).toBe('1:05');
		expect(clock(3_723_000)).toBe('1:02:03');
	});
});

describe('baseName', () => {
	it('drops only the extension', () => {
		expect(baseName('ep.01.srt')).toBe('ep.01');
		expect(baseName('notes')).toBe('notes');
	});
});

describe('tabFrom', () => {
	it('defaults to video', () => {
		expect(tabFrom(null)).toBe('video');
		expect(tabFrom('nonsense')).toBe('video');
		expect(tabFrom('text')).toBe('text');
		expect(tabFrom('write')).toBe('write');
	});
});
