/**
 * Playing one span of a recording — a subtitle cue heard on its own.
 *
 * Pure like `follow.ts`: a caller owns the player, and when to stop is decided
 * here between two clock samples, so a test can hold the clock still.
 */

/** Padding either side of a cue: its timings are a subtitler's, not the speech's. */
export const SPAN_PAD_MS = 250;

/** Where a padded span starts and stops playing, never before the recording. */
export function paddedSpan(start: number, end: number): { from: number; to: number } {
	return { from: Math.max(0, start - SPAN_PAD_MS), to: end + SPAN_PAD_MS };
}

/**
 * Whether playback has just run past `to`. Asked between the last sample and
 * this one, as `crossedPause` is, so it is true once per crossing and a seek back
 * over the stop is not one.
 */
export function crossedStop(to: number, prevMs: number, ms: number): boolean {
	return prevMs < to && ms >= to;
}
