/**
 * Splicing a dictated chunk into whatever is already in the composer.
 *
 * This is the whole reason dictation is safe to add to conversation mode: the
 * transcript lands in the *input*, not in the send. An engine that mishears is
 * then a typo the learner fixes before pressing Send, never a mistake the
 * teacher attributes to them — and `diff.ts` keeps aligning corrections against
 * a message the learner endorsed, exactly as it does for a typed one.
 */

import { spanGap } from '$lib/conversation/diff';

/**
 * `existing` with `transcript` appended, joined the way the script joins words.
 *
 * The separator is `spanGap`'s, not a space: a dictated 我想要 must sit flush
 * against what is already there and a dictated `please` must not — the same rule
 * the correction spans are rebuilt with, borrowed rather than re-derived.
 *
 * Empty transcripts return `existing` untouched, which is what makes this safe
 * to call on every interim result: the caller keeps the pre-dictation text and
 * re-splices, so a revised guess replaces the last one instead of stacking.
 */
export function appendDictation(existing: string, transcript: string): string {
	const heard = transcript.trim();
	if (!heard) return existing;

	// Trailing whitespace is the learner's, but the gap is the script's call.
	const base = existing.trimEnd();
	if (!base) return heard;

	return base + spanGap(base, heard) + heard;
}
