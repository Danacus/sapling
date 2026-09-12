/**
 * `multi-cloze` — several target-language gaps in one short passage, filled
 * from a shared bank. Each gap is graded against its own item so one missed
 * word does not turn a partly successful passage into an SRS failure for every
 * word it contains.
 */

import { z } from 'zod';
import type { MultiClozeChallenge, Verdict } from '$lib/types';
import { checkAnswer } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { clamp01, nonEmpty, storedBase, withBase } from './primitives';
import { wordCount } from './word-count';

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

/** One answer's result, retained by the session for item-level SRS grading. */
export interface MultiClozeGapVerdict {
	itemId: string;
	verdict: Verdict;
}

/**
 * Worst answer wins: the banner and summary should call a passage wrong when
 * any gap was wrong, while FSRS still receives the individual results below.
 */
export function overallMultiClozeVerdict(verdicts: readonly Verdict[]): Verdict {
	if (verdicts.includes('wrong')) return 'wrong';
	if (verdicts.includes('almost')) return 'almost';
	return 'correct';
}

/** Grades each supplied gap answer and returns both the per-item and overall results. */
export function gradeMultiClozeAnswers(
	challenge: MultiClozeChallenge,
	answers: readonly string[]
): { verdict: Verdict; itemVerdicts: MultiClozeGapVerdict[] } {
	const itemVerdicts = challenge.gaps.map((gap, index) => ({
		itemId: gap.itemId,
		verdict: checkAnswer(answers[index] ?? '', gap.acceptedAnswers)
	}));
	return {
		verdict: overallMultiClozeVerdict(itemVerdicts.map((result) => result.verdict)),
		itemVerdicts
	};
}

/** Compact enough for the answer log and feedback banner, while retaining each gap. */
export function serializeMultiClozeAnswers(answers: readonly string[]): string {
	return answers.map((answer, index) => `${index + 1}: ${answer.trim() || '—'}`).join(' · ');
}

function answersFromSerialized(answerGiven: string): string[] {
	return answerGiven.split(' · ').map((entry) => entry.replace(/^\d+:\s*/, '').trim());
}

/** Four answers is the intentional top end of this format; nine is the bank's. */
const MIN_GAPS = 2;
const MAX_GAPS = 4;
const MIN_BANK = 5;
const MIN_PASSAGE_WORDS = 8;
const MAX_PASSAGE_WORDS = 24;

const gapSchema = z.object({
	itemId: nonEmpty,
	acceptedAnswers: z.array(nonEmpty).min(1),
	answerRomanization: z.string().optional()
});

export const multiClozeChallengeSchema = z
	.object({
		type: z.literal('multi-cloze'),
		passage: nonEmpty,
		passageRomanization: z.string().optional(),
		gaps: z.array(gapSchema).min(MIN_GAPS).max(MAX_GAPS),
		wordBank: z.array(nonEmpty).min(MIN_BANK),
		wordBankRomanization: z.array(z.string()).optional(),
		...storedBase,
		direction: z.literal('toTarget')
	})
	.superRefine((challenge, ctx) => {
		const gapIds = challenge.gaps.map((gap) => gap.itemId);
		if (new Set(gapIds).size !== gapIds.length) {
			ctx.addIssue({ code: 'custom', message: 'Every gap needs its own item.' });
		}
		if (
			gapIds.some((itemId) => !challenge.itemIds.includes(itemId)) ||
			challenge.itemIds.length !== gapIds.length
		) {
			ctx.addIssue({ code: 'custom', message: 'itemIds must contain exactly the gap items.' });
		}
		for (let index = 0; index < challenge.gaps.length; index++) {
			const marker = multiClozeMarker(index);
			const occurrences = challenge.passage.split(marker).length - 1;
			if (occurrences !== 1) {
				ctx.addIssue({
					code: 'custom',
					message: `Passage must contain ${marker} exactly once.`
				});
			}
		}
	});

export const multiClozeStoredDef = {
	type: 'multi-cloze',
	schema: multiClozeChallengeSchema,

	check(challenge, answerGiven) {
		return gradeMultiClozeAnswers(challenge, answersFromSerialized(answerGiven)).verdict;
	},

	// The answers are all visible, but contextual placement across a passage is
	// real constrained production rather than a simple recognition tap.
	demand() {
		return 1;
	},

	// Passage length and number of decisions climb together; the bank is no
	// longer one of them. Every generated passage now carries the fullest
	// shared bank the model can supply regardless of rung, so bank size stopped
	// being a difficulty knob — how much of it a served challenge shows is a
	// serve-time decision (`$lib/session/support`), not a fact about the row.
	difficulty(challenge) {
		const gaps = clamp01((challenge.gaps.length - MIN_GAPS) / (MAX_GAPS - MIN_GAPS));
		const words = wordCount(challenge.passage.replace(/___\d+___/g, ' '));
		const passage = clamp01((words - MIN_PASSAGE_WORDS) / (MAX_PASSAGE_WORDS - MIN_PASSAGE_WORDS));
		return withBase(0.45, gaps * 0.55 + passage * 0.45);
	},

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
