/**
 * `multi-cloze` — several target-language gaps in one short passage, filled
 * from a shared bank. Each gap is graded against its own item (`../check`'s
 * `gradeMultiClozeAnswers`) so one missed word does not turn a partly
 * successful passage into an SRS failure for every word it contains.
 */

import type { MultiClozeChallenge } from '$lib/types';
import type { StoredTypeDef } from './def';

/** The numbered marker in a stored passage for one zero-based gap index. */
export function multiClozeMarker(index: number): string {
	return `___${index + 1}___`;
}

/** Replaces every numbered gap with its canonical answer. */
export function completedMultiClozePassage(challenge: MultiClozeChallenge): string {
	return challenge.gaps.reduce(
		(passage, gap, index) =>
			passage.split(multiClozeMarker(index)).join(gap.acceptedAnswers[0] ?? ''),
		challenge.passage
	);
}

/**
 * The answers as one logged string, `"1: Yo · 2: bebo"` — compact enough for
 * the answer log and the banner. Rust's `checkChallenge` reads this form back,
 * so the separator and the numbering are a contract with `grade.rs`.
 */
export function serializeMultiClozeAnswers(answers: readonly string[]): string {
	return answers.map((answer, index) => `${index + 1}: ${answer.trim() || '—'}`).join(' · ');
}

export const multiClozeStoredDef = {
	type: 'multi-cloze',
	reviewsSrs: true,
	pooled: true,

	correctAnswerText(challenge) {
		return serializeMultiClozeAnswers(challenge.gaps.map((gap) => gap.acceptedAnswers[0] ?? ''));
	},

	answerIsTargetLanguage() {
		return true;
	},

	// A single reading would be a confusing run-on annotation for several words.
	answerReading() {
		return undefined;
	},

	spokenAnswerFor(challenge) {
		return completedMultiClozePassage(challenge).trim();
	},

	audioTexts(challenge) {
		const asked = challenge.passage.replace(/___\d+___/g, '…').trim();
		const answered = completedMultiClozePassage(challenge).trim();
		return [...new Set([asked, answered])].filter((text) => text !== '');
	}
} satisfies StoredTypeDef<MultiClozeChallenge>;
