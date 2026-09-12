/**
 * Listening mode: whether a challenge is played before it is read.
 *
 * Pure and serve-time, like the rest of `serve/` — it reads only the challenge
 * and the learner's preference. Speech availability (`ttsAvailable`) is a
 * browser question and stays with the component that plays the clip; nothing
 * here touches it.
 */

import type { Challenge } from '$lib/types';

/**
 * Share of eligible challenges presented audio-first. Half: a session that was
 * *all* listening stops being reading practice, and one that never listens
 * never trains the ear.
 */
export const LISTENING_SHARE = 0.5;

/** FNV-1a over the id, mapped to `[0,1)`. Stable across devices and reloads. */
function idFraction(id: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash / 0x100000000;
}

/**
 * Whether a challenge should be played before it is read.
 *
 * Listening mode is **presentation only** — the stored challenge is untouched,
 * nothing about it is generated differently, and grading is identical. That is
 * the point: every recognize-MC row already in the pool, however long ago it was
 * generated, can be served as a listening exercise.
 *
 * Eligible: `multiple-choice` in the `toNative` direction, i.e. target text
 * shown and a native meaning picked — the only stored shape whose prompt is a
 * target-language string the learner is expected to understand rather than
 * produce.
 *
 * Which of them get it is decided by a hash of the challenge id rather than a
 * coin flip, so a challenge that comes back round in a later session is
 * presented the same way it was the first time. `enabled` is the learner's
 * preference (`ll.listeningMode`); the caller also has to check that speech is
 * actually available, which is a browser question this module knows nothing
 * about.
 */
export function isListeningChallenge(challenge: Challenge, enabled: boolean): boolean {
	if (!enabled) return false;
	if (challenge.type !== 'multiple-choice' || challenge.direction !== 'toNative') return false;
	if (!challenge.prompt.trim()) return false;
	return idFraction(challenge.id) < LISTENING_SHARE;
}
