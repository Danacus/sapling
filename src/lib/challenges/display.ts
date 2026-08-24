/**
 * Per-type presentation facts, dispatched by challenge type.
 *
 * Every challenge type answers the same four questions once it has been graded:
 * *what was the right answer*, *is that answer in the target language*, *what
 * is its Latin reading*, and *what should the learner hear*. Those are
 * presentation knowledge — nothing about them touches the SRS, the database or
 * the model — and each type's answers live with that type, in
 * `./types/<type>.ts`, next to its schema and its grading rule.
 *
 * What is left here is the door: four functions with the signatures the banner,
 * the session screen and the engine already import, each one lookup deep. The
 * exhaustiveness guarantee moved with the knowledge — the registry in
 * `./types/index.ts` is a mapped type over `ChallengeType`, so a seventh member
 * of the `Challenge` union fails `pnpm check` at the registry, once, instead of
 * rendering blank.
 *
 * Still pure: zod, `$lib/types` and the string matchers, nothing else. No
 * Svelte, no DB, no preferences — the learner's romanization toggle is the
 * *caller's* question, so {@link answerReading} reports what exists and the
 * banner decides whether to show it.
 */

import type { Challenge } from '$lib/types';
import { storedDefFor, unhandledChallenge } from './types';

/**
 * Exhaustiveness guard for a dispatch over `Challenge['type']`.
 *
 * Defined in `./types/def.ts` and re-exported here, because the `{:else}` branch
 * of `ChallengeHost.svelte` is its other caller and this module is the one that
 * screen imports from.
 */
export { unhandledChallenge };

/**
 * What the feedback banner tells the learner they should have answered.
 *
 * The canonical form in every case — `acceptedAnswers[0]`, the option at
 * `correctIndex`, the assembled word-order sentence — never a romanized
 * variant and never the learner's own near-miss (the banner shows
 * `closestAccepted` separately, and knows to prefer it).
 *
 * Match-pairs returns `''`: a matching round has no single answer, and the
 * banner reads an empty string as "print no answer line at all".
 */
export function correctAnswerText(challenge: Challenge): string {
	return storedDefFor(challenge).correctAnswerText(challenge);
}

/**
 * Whether {@link correctAnswerText} is a target-language string.
 *
 * Drives both the romanization line and (via the banner) whether reading the
 * answer back is worth anything: hearing your own native language read aloud
 * teaches nothing.
 *
 * Cloze, word-order and spot-error answers are always target-language — the
 * last of those *despite* its direction, because the word it names is a
 * target-language word whichever way the challenge is exercised. Multiple
 * choice and typed translation depend on `direction`. Match rounds have no
 * single answer, so they are neither.
 */
export function answerIsTargetLanguage(challenge: Challenge): boolean {
	return storedDefFor(challenge).answerIsTargetLanguage(challenge);
}

/**
 * The Latin reading of {@link correctAnswerText}, when the challenge carries
 * one — the moment a learner is told a word they could not produce is exactly
 * when they need to know how to say it.
 *
 * `undefined` for Latin-script targets, for native-language answers (the
 * {@link answerIsTargetLanguage} gate, applied here rather than in each def
 * because it is the one rule none of them differ on), and for rows generated
 * before the reading fields existed. Callers render nothing at all in that case,
 * and also own the learner's "show romanization" preference — this module only
 * reports what the challenge actually has.
 */
export function answerReading(challenge: Challenge): string | undefined {
	if (!answerIsTargetLanguage(challenge)) return undefined;
	return storedDefFor(challenge).answerReading(challenge);
}

/**
 * The canonical target-language audio for a challenge's answer, or `''` when
 * there is nothing worth hearing (the answer is in the learner's own language,
 * or the round has no single answer).
 *
 * One function, two consumers, on purpose: the feedback banner speaks this the
 * moment an answer is graded, and the session screen *pre-synthesizes* it the
 * moment the challenge is shown — the learner takes seconds to answer while
 * Kokoro takes one or two to render, so warming here is what makes the
 * auto-play land instantly instead of arriving late. If the two computed the
 * string independently, a drift between them would silently turn every warm
 * into a miss.
 *
 * Always the canonical script form — `acceptedAnswers[0]`, which the resolver
 * pins (see `answerVariants` in `$lib/llm/generate`) — never a romanized
 * variant: TTS reads Latin letters as Latin letters. A cloze speaks the whole
 * sentence with the blank filled, because how the word sounds *in place* is
 * the thing the learner is missing.
 *
 * Re-exported from `$lib/session/engine`, where it used to live.
 */
export function spokenAnswerFor(challenge: Challenge): string {
	return storedDefFor(challenge).spokenAnswerFor(challenge);
}
