/**
 * Presentation helpers shared by the library and its import forms: how a text
 * on the way in, or on the shelf, is described to the learner.
 */

import type { Segment, SubtitleFormat } from '$lib/types';

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

/** The composer tab a `?tab=` names; anything else is the default, video. */
export function tabFrom(value: string | null): Tab {
	return value === 'text' || value === 'write' ? value : 'video';
}
