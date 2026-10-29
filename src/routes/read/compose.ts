/**
 * Presentation helpers shared by the library and its import forms: how a text
 * on the way in, or on the shelf, is described to the learner — and the two
 * URL facts the library page is, its open drawer and its filter.
 */

import type { ReadingText, Segment, SubtitleFormat } from '$lib/types';

/** A default title is a shelf label, and a first line can be a whole paragraph. */
export const TITLE_CHARS = 60;

export const FORMAT_NAMES: Record<SubtitleFormat, string> = {
	srt: 'SRT subtitles',
	vtt: 'WebVTT subtitles',
	'youtube-transcript': 'YouTube transcript',
	json3: 'YouTube captions'
};

/** The first non-blank line of the first segment, shortened to a label. */
export function firstLine(segments: readonly Segment[]): string {
	const line = (segments[0]?.text ?? '')
		.split('\n')
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return '';
	const chars = [...line];
	return chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('').trimEnd()}…` : line;
}

/** A file's name without its extension. */
export function baseName(name: string): string {
	return name.replace(/\.[^./\\]+$/, '');
}

export function isTimed(segments: readonly Segment[]): boolean {
	return segments.some((segment) => segment.start !== undefined);
}

/** "12 lines" for subtitles, "3 paragraphs" for prose. */
export function extent(segments: readonly Segment[]): string {
	const n = segments.length;
	return `${n} ${isTimed(segments) ? 'line' : 'paragraph'}${n === 1 ? '' : 's'}`;
}

/** `m:ss`, or `h:mm:ss` once it runs past an hour. */
export function clock(ms: number): string {
	const total = Math.round(ms / 1000);
	const seconds = `${total % 60}`.padStart(2, '0');
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	return hours > 0
		? `${hours}:${`${minutes}`.padStart(2, '0')}:${seconds}`
		: `${minutes}:${seconds}`;
}

export type Tab = 'video' | 'text' | 'write';

/**
 * The drawer a `?tab=` opens. No `tab`, or one nothing answers to, is a closed
 * drawer: the library is the page, and adding to it is something asked for.
 */
export function tabFrom(value: string | null): Tab | undefined {
	return value === 'video' || value === 'text' || value === 'write' ? value : undefined;
}

export type Show = 'all' | 'videos' | 'texts';

/** The library filter a `?show=` names; absent or unknown shows everything. */
export function showFrom(value: string | null): Show {
	return value === 'videos' || value === 'texts' ? value : 'all';
}

/**
 * The library's URL with this drawer and this filter. The two are independent
 * facts, so every link that changes one carries the other through unchanged,
 * and a default is left out rather than spelled.
 */
export function libraryHref(tab: Tab | undefined, show: Show): string {
	const params = new URLSearchParams();
	if (tab) params.set('tab', tab);
	if (show !== 'all') params.set('show', show);
	const query = params.toString();
	return query ? `/read?${query}` : '/read';
}

/** A video is a text with a recording behind it, a YouTube one or a file. */
export function isVideo(text: Pick<ReadingText, 'media'>): boolean {
	return text.media !== undefined;
}

/** The texts a filter shows, in the order they came. */
export function shown<T extends Pick<ReadingText, 'media'>>(texts: readonly T[], show: Show): T[] {
	if (show === 'all') return [...texts];
	return texts.filter((text) => isVideo(text) === (show === 'videos'));
}

export type SourceKind = 'youtube' | 'file' | 'imported' | 'generated';

/** Where a text came from, as the card's corner badge says it. */
export function sourceOf(text: Pick<ReadingText, 'media' | 'source'>): SourceKind {
	if (text.media) return text.media.kind;
	return text.source === 'generated' ? 'generated' : 'imported';
}

export const SOURCE_NAMES: Record<SourceKind, string> = {
	youtube: 'YouTube',
	file: 'Video file',
	imported: 'Imported',
	generated: 'Written'
};

/** How much of a text a card shows: a few lines in a small tile, faded out. */
export const EXCERPT_CHARS = 200;

/**
 * The opening of a text as one run, whitespace collapsed — a card shows a
 * glimpse of the page, not its paragraphs — cut at `limit` characters (code
 * points, so a CJK text is not cut mid-surrogate). No ellipsis: the tile
 * fades the end out.
 */
export function excerpt(segments: readonly Segment[], limit = EXCERPT_CHARS): string {
	const chars: string[] = [];
	for (const segment of segments) {
		const text = segment.text.replace(/\s+/g, ' ').trim();
		if (!text) continue;
		if (chars.length > 0) chars.push(' ');
		chars.push(...text);
		if (chars.length >= limit) break;
	}
	return chars.slice(0, limit).join('').trimEnd();
}

/**
 * How long a recording runs, read off its subtitles: the `end` of the last
 * timed segment, as `clock` writes it. Undefined for a text with no timings.
 */
export function duration(segments: readonly Segment[]): string | undefined {
	for (let i = segments.length - 1; i >= 0; i--) {
		const end = segments[i].end;
		if (end !== undefined) return clock(end);
	}
	return undefined;
}
