import { describe, expect, it } from 'vitest';

import {
	EXCERPT_CHARS,
	SOURCE_NAMES,
	TITLE_CHARS,
	baseName,
	clock,
	duration,
	excerpt,
	extent,
	firstLine,
	isVideo,
	libraryHref,
	showFrom,
	shown,
	sourceOf,
	tabFrom
} from './compose';

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
	it('names the three drawers', () => {
		expect(tabFrom('video')).toBe('video');
		expect(tabFrom('text')).toBe('text');
		expect(tabFrom('write')).toBe('write');
	});

	it('is closed with no tab or an unknown one', () => {
		expect(tabFrom(null)).toBeUndefined();
		expect(tabFrom('')).toBeUndefined();
		expect(tabFrom('nonsense')).toBeUndefined();
	});
});

describe('showFrom', () => {
	it('names the two filters and shows everything otherwise', () => {
		expect(showFrom('videos')).toBe('videos');
		expect(showFrom('texts')).toBe('texts');
		expect(showFrom(null)).toBe('all');
		expect(showFrom('all')).toBe('all');
		expect(showFrom('nonsense')).toBe('all');
	});
});

describe('libraryHref', () => {
	it('leaves the defaults out', () => {
		expect(libraryHref(undefined, 'all')).toBe('/read');
	});

	it('carries the drawer and the filter independently', () => {
		expect(libraryHref('text', 'all')).toBe('/read?tab=text');
		expect(libraryHref(undefined, 'videos')).toBe('/read?show=videos');
		expect(libraryHref('write', 'texts')).toBe('/read?tab=write&show=texts');
	});

	it('round-trips through the parsers', () => {
		const url = new URL(libraryHref('video', 'texts'), 'https://sapling.test');
		expect(tabFrom(url.searchParams.get('tab'))).toBe('video');
		expect(showFrom(url.searchParams.get('show'))).toBe('texts');
	});
});

describe('the filter', () => {
	const youtube = { id: 'a', media: { kind: 'youtube', videoId: 'dQw4w9WgXcQ' } } as const;
	const prose = { id: 'b', media: undefined };
	const file = { id: 'c', media: { kind: 'file', name: 'ep1.mp4' } } as const;
	const texts = [youtube, prose, file];

	it('counts a YouTube link and a file alike as a video', () => {
		expect(isVideo(youtube)).toBe(true);
		expect(isVideo(file)).toBe(true);
		expect(isVideo(prose)).toBe(false);
	});

	it('keeps the order it was given', () => {
		expect(shown(texts, 'all').map((text) => text.id)).toEqual(['a', 'b', 'c']);
		expect(shown(texts, 'videos').map((text) => text.id)).toEqual(['a', 'c']);
		expect(shown(texts, 'texts').map((text) => text.id)).toEqual(['b']);
	});

	it('is empty when nothing matches', () => {
		expect(shown([prose], 'videos')).toEqual([]);
	});
});

describe('sourceOf', () => {
	it('names the recording first, else where the text came from', () => {
		expect(sourceOf({ source: 'imported', media: { kind: 'youtube', videoId: 'x' } })).toBe(
			'youtube'
		);
		expect(sourceOf({ source: 'imported', media: { kind: 'file', name: 'a.mp4' } })).toBe('file');
		expect(sourceOf({ source: 'imported' })).toBe('imported');
		expect(sourceOf({ source: 'generated' })).toBe('generated');
	});

	it('has a badge for every kind', () => {
		expect(SOURCE_NAMES).toEqual({
			youtube: 'YouTube',
			file: 'Video file',
			imported: 'Imported',
			generated: 'Written'
		});
	});
});

describe('excerpt', () => {
	it('runs the segments together with whitespace collapsed', () => {
		expect(excerpt([{ text: '  First\n\nline. ' }, { text: '' }, { text: 'Second.' }])).toBe(
			'First line. Second.'
		);
	});

	it('cuts at the limit without an ellipsis', () => {
		const cut = excerpt([{ text: 'ab cd' }, { text: 'efgh' }], 7);
		expect(cut).toBe('ab cd e');
	});

	it('counts code points, so a long CJK text is cut at a character', () => {
		const cut = excerpt([{ text: '𠀀'.repeat(EXCERPT_CHARS + 10) }]);
		expect([...cut]).toHaveLength(EXCERPT_CHARS);
	});

	it('does not end on the space between two segments', () => {
		expect(excerpt([{ text: 'abc' }, { text: 'def' }], 4)).toBe('abc');
	});

	it('is empty for no text', () => {
		expect(excerpt([])).toBe('');
	});
});

describe('duration', () => {
	it('is the last timed end on the clock', () => {
		expect(
			duration([
				{ text: 'a', start: 0, end: 1_000 },
				{ text: 'b', start: 60_000, end: 65_000 }
			])
		).toBe('1:05');
	});

	it('skips an untimed segment at the end', () => {
		expect(duration([{ text: 'a', start: 0, end: 3_723_000 }, { text: 'b' }])).toBe('1:02:03');
	});

	it('is undefined for prose', () => {
		expect(duration([{ text: 'a' }, { text: 'b' }])).toBeUndefined();
		expect(duration([])).toBeUndefined();
	});
});
