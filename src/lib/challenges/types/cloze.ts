/**
 * `cloze` — fill the `___` blank in a target-language sentence.
 *
 * The answer is always a target-language word, whichever way the challenge is
 * exercised, so the romanization line is never suppressed here. What the learner
 * hears afterwards is the *whole sentence with the blank filled*, not the word on
 * its own: how a word sounds in place is the thing they were missing.
 */

import { z } from 'zod';
import type { ClozeChallenge } from '$lib/types';
import { checkAnswer } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { clamp01, nonEmpty, storedBase } from './primitives';
import { wordCount } from './word-count';

/** Sentence length, in words, spanning the full 0..1 range. */
const SHORTEST_SENTENCE = 3;
const LONGEST_SENTENCE = 16;

/**
 * Word-bank size spanning the full 0..1 range, smaller-is-harder: a bank with
 * only the correct answer and a couple of distractors gives the learner far
 * less to lean on than one with five or six candidates on it.
 */
const SMALLEST_BANK = 3;
const LARGEST_BANK = 6;

export const clozeChallengeSchema = z.object({
	type: z.literal('cloze'),
	sentence: nonEmpty,
	sentenceRomanization: z.string().optional(),
	acceptedAnswers: z.array(z.string()).min(1),
	/** Reading of `acceptedAnswers[0]`; see the domain type. */
	answerRomanization: z.string().optional(),
	wordBank: z.array(z.string()).optional(),
	/** Index-aligned with `wordBank`; all-or-nothing, see the resolver. */
	wordBankRomanization: z.array(z.string()).optional(),
	translationHint: z.string(),
	...storedBase
});

/** The blank, as the resolver joined the sentence around it. */
const GAP = '___';

/**
 * The sentence with the blank filled by the canonical accepted answer — `''`
 * when the row carries no answer to fill it with, because a bare gap read aloud
 * teaches nothing.
 */
function completedSentence(challenge: ClozeChallenge): string {
	const canonical = challenge.acceptedAnswers[0]?.trim() ?? '';
	if (!canonical) return '';
	return challenge.sentence.split(GAP).join(canonical);
}

export const clozeStoredDef = {
	type: 'cloze',
	schema: clozeChallengeSchema,

	check(challenge, answerGiven) {
		return checkAnswer(answerGiven, challenge.acceptedAnswers);
	},

	// The one type whose demand is decided by the row rather than the type. With a
	// `wordBank` the answer is on screen and the learner picks the word that fits
	// the gap — constrained production. Without one they have to retrieve and
	// spell it from the sentence alone, which is free production of a single word
	// and the same act a typed translation asks for, sentence-length aside.
	demand(challenge) {
		return challenge.wordBank && challenge.wordBank.length > 0 ? 1 : 2;
	},

	// Two knobs, weighted so the sentence carries most of the read: how long the
	// sentence is, and — only when there is a bank at all — how much support it
	// gives. A bankless cloze (free recall) reads on sentence length alone.
	difficulty(challenge) {
		const lengthFit = clamp01(
			(wordCount(challenge.sentence) - SHORTEST_SENTENCE) / (LONGEST_SENTENCE - SHORTEST_SENTENCE)
		);
		const bank = challenge.wordBank;
		if (!bank || bank.length === 0) return lengthFit;
		const bankFit = clamp01((LARGEST_BANK - bank.length) / (LARGEST_BANK - SMALLEST_BANK));
		return clamp01(lengthFit * 0.6 + bankFit * 0.4);
	},

	correctAnswerText(challenge) {
		return challenge.acceptedAnswers[0] ?? '';
	},

	answerIsTargetLanguage() {
		return true;
	},

	answerReading(challenge) {
		return challenge.answerRomanization;
	},

	spokenAnswerFor(challenge) {
		if (challenge.direction !== 'toTarget') return '';
		// The sentence, spoken whole — the blank filled with the canonical script
		// form the resolver pinned, never a romanized variant.
		return completedSentence(challenge);
	},

	// Two clips, in the order the round asks for them. The speaker button sits in
	// the sentence line from the first frame and reads the blank as an ellipsis
	// (every engine renders that as the "…and then?" pause the learner needs);
	// once the answer is in, both that button and the banner read the sentence
	// complete. Neither is gated on `direction` the way `spokenAnswerFor` is —
	// the sentence is target-language whichever way the row is exercised, and
	// warming a clip nobody plays costs only a cache entry.
	audioTexts(challenge) {
		const asked = challenge.sentence.split(GAP).join('…');
		const answered = completedSentence(challenge);
		// A sentence with no blank left to fill makes the two identical.
		return [...new Set([asked, answered])].filter((text) => text !== '');
	}
} satisfies StoredTypeDef<ClozeChallenge>;
