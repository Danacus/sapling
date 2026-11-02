/**
 * Transcribing a local recording, the pure half: which stretch of audio to
 * listen to next, which moments to read the subtitles at and where on the
 * picture they are. The task that drives it is `$lib/tasks/kinds/transcribe`;
 * the merge of the two witnesses is the Rust core's (`mergeTranscript`).
 */

/** Audio is listened to this much at a time: progress, cancel, bounded memory. */
export const AUDIO_WINDOW_MS = 300_000;

/**
 * A span ending this close to a window's end may have been cut by it, so it is
 * heard again at the start of the next window.
 */
export const WINDOW_TAIL_MS = 1000;

/** Spans read before deciding whether the recording has subtitles at all. */
export const PROBE_SPANS = 20;

/** A span shorter than this is read once, in its middle; longer, twice. */
const TWO_FRAMES_MS = 2000;

/** The subtitle band: the bottom quarter of the picture, full width. */
const BAND_TOP = 0.75;

/** Under this the recognizer was reading a picture, not text (the page viewer's cut). */
export const MIN_LINE_SCORE = 0.5;

export interface Span {
	start: number;
	end: number;
	text: string;
}

/**
 * The spans of one window to keep, and where the next window starts: a span
 * the window's end may have cut is dropped and heard again, whole, next time.
 */
export function keepSpans(
	spans: readonly Span[],
	windowStart: number,
	windowEnd: number,
	durationMs: number
): { keep: Span[]; next: number } {
	const last = spans.at(-1);
	if (
		windowEnd < durationMs &&
		last &&
		last.end > windowEnd - WINDOW_TAIL_MS &&
		last.start > windowStart
	) {
		return { keep: spans.slice(0, -1), next: last.start };
	}
	return { keep: [...spans], next: windowEnd };
}

/** The moments a span's subtitles are read at: its middle, or its thirds. */
export function framesFor(span: Pick<Span, 'start' | 'end'>): number[] {
	const length = span.end - span.start;
	if (length < TWO_FRAMES_MS) return [span.start + length / 2];
	return [span.start + length / 3, span.start + (2 * length) / 3];
}

/** The subtitle band of a `width × height` picture, in its pixels. */
export function subtitleRect(
	width: number,
	height: number
): { x: number; y: number; width: number; height: number } {
	const y = Math.round(height * BAND_TOP);
	return { x: 0, y, width, height: height - y };
}
