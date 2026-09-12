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

/** Four answers and a nine-word bank are the intentional top end of this format. */
const MIN_GAPS = 2;
const MAX_GAPS = 4;
const MIN_BANK = 5;
const MAX_BANK = 9;
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

	// Passage length, number of decisions and bank size all climb together. A
	// larger *shared* bank is a larger search task here, unlike a one-gap cloze
	// where a bank mostly supplies support.
	difficulty(challenge) {
		const gaps = clamp01((challenge.gaps.length - MIN_GAPS) / (MAX_GAPS - MIN_GAPS));
		const words = wordCount(challenge.passage.replace(/___\d+___/g, ' '));
		const passage = clamp01((words - MIN_PASSAGE_WORDS) / (MAX_PASSAGE_WORDS - MIN_PASSAGE_WORDS));
		const bank = clamp01((challenge.wordBank.length - MIN_BANK) / (MAX_BANK - MIN_BANK));
		return withBase(0.45, gaps * 0.4 + passage * 0.35 + bank * 0.25);
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
