/**
 * Unit tests for the per-type presentation rules.
 *
 * One fixture per stored type, deliberately minimal — only the fields these
 * four functions actually read — and every function is asked about every type,
 * because the bugs this module exists to prevent are the ones where five types
 * were updated and the sixth was not.
 *
 * The `spokenAnswerFor` cases here overlap with the ones in
 * `session/engine.test.ts` on purpose: those pin the *re-export* (the session
 * screen still imports it from the engine), these pin the implementation.
 */

import { describe, expect, it } from 'vitest';

import type {
	Challenge,
	ChallengeType,
	ClozeChallenge,
	MatchPairsChallenge,
	MultipleChoiceChallenge,
	SpotErrorChallenge,
	TypedTranslationChallenge,
	WordOrderChallenge
} from '$lib/types';

import {
	answerIsTargetLanguage,
	answerReading,
	correctAnswerText,
	spokenAnswerFor,
	unhandledChallenge
} from './display';

/* Fixtures ------------------------------------------------------------------ */

function mc(overrides: Partial<MultipleChoiceChallenge> = {}): MultipleChoiceChallenge {
	return {
		id: 'mc1',
		type: 'multiple-choice',
		direction: 'toTarget',
		prompt: 'the menu',
		options: ['筷子', '菜单', '茶', '水'],
		correctIndex: 1,
		itemIds: ['i1'],
		...overrides
	};
}

function cloze(overrides: Partial<ClozeChallenge> = {}): ClozeChallenge {
	return {
		id: 'cz1',
		type: 'cloze',
		direction: 'toTarget',
		sentence: '请给我一份___。',
		acceptedAnswers: ['菜单', 'càidān'],
		translationHint: 'A menu, please.',
		itemIds: ['i1'],
		...overrides
	};
}

function typed(overrides: Partial<TypedTranslationChallenge> = {}): TypedTranslationChallenge {
	return {
		id: 'tt1',
		type: 'typed-translation',
		direction: 'toTarget',
		prompt: 'the bill, please',
		acceptedAnswers: ['买单', 'mǎidān', 'maidan'],
		itemIds: ['i1'],
		...overrides
	};
}

function wordOrder(overrides: Partial<WordOrderChallenge> = {}): WordOrderChallenge {
	return {
		id: 'wo1',
		type: 'word-order',
		direction: 'toTarget',
		prompt: 'We would like to pay the bill.',
		tiles: ['买单', '我们', '菜单', '想'],
		answerTokens: ['我们', '想', '买单'],
		answer: '我们想买单',
		itemIds: ['i1'],
		...overrides
	};
}

function spotError(overrides: Partial<SpotErrorChallenge> = {}): SpotErrorChallenge {
	return {
		id: 'se1',
		type: 'spot-error',
		// `toNative` on purpose: spot-error is the type whose answer is
		// target-language *despite* its direction.
		direction: 'toNative',
		tokens: ['我们', '想', '菜单'],
		correctIndex: 2,
		intendedWord: '买单',
		correctedSentence: '我们想买单',
		meaning: 'We would like to pay the bill.',
		itemIds: ['i1'],
		...overrides
	};
}

function matchPairs(overrides: Partial<MatchPairsChallenge> = {}): MatchPairsChallenge {
	return {
		id: 'mp1',
		type: 'match-pairs',
		direction: 'toNative',
		pairs: [
			{ a: '菜单', b: 'the menu' },
			{ a: '买单', b: 'to pay the bill' }
		],
		itemIds: ['i1', 'i2'],
		...overrides
	};
}

/**
 * One fixture per member of the stored union, keyed by tag.
 *
 * Typed as a total record so a new `Challenge` member fails to compile here —
 * which is what forces every test below to cover it too.
 */
const everyType: { [T in ChallengeType]: Challenge } = {
	'multiple-choice': mc(),
	cloze: cloze(),
	'typed-translation': typed(),
	'match-pairs': matchPairs(),
	'word-order': wordOrder(),
	'spot-error': spotError()
};

const allChallenges = Object.values(everyType);

/* -------------------------------------------------------------------------- */

describe('correctAnswerText', () => {
	it('returns the option at correctIndex for multiple choice', () => {
		expect(correctAnswerText(mc())).toBe('菜单');
	});

	it('returns the canonical accepted answer for cloze and typed translation', () => {
		expect(correctAnswerText(cloze())).toBe('菜单');
		expect(correctAnswerText(typed())).toBe('买单');
	});

	it('returns the assembled sentence for word order, not the token list', () => {
		expect(correctAnswerText(wordOrder())).toBe('我们想买单');
	});

	it('returns the word that belonged there for spot-error, not the wrong one', () => {
		const challenge = spotError();
		expect(correctAnswerText(challenge)).toBe('买单');
		expect(correctAnswerText(challenge)).not.toBe(challenge.tokens[challenge.correctIndex]);
	});

	it('returns nothing for match-pairs, which has no single answer', () => {
		expect(correctAnswerText(matchPairs())).toBe('');
	});

	it('falls back to an empty string on an empty accepted-answer list', () => {
		expect(correctAnswerText(cloze({ acceptedAnswers: [] }))).toBe('');
		expect(correctAnswerText(typed({ acceptedAnswers: [] }))).toBe('');
	});

	it('answers for every stored type', () => {
		for (const challenge of allChallenges) {
			expect(typeof correctAnswerText(challenge)).toBe('string');
		}
	});
});

describe('answerIsTargetLanguage', () => {
	it('is always true for cloze, word-order and spot-error', () => {
		expect(answerIsTargetLanguage(cloze())).toBe(true);
		expect(answerIsTargetLanguage(wordOrder())).toBe(true);
		// `toNative`, and still target-language: the word it names is a
		// target-language word whichever way the round is exercised.
		expect(answerIsTargetLanguage(spotError())).toBe(true);
		expect(answerIsTargetLanguage(spotError({ direction: 'toTarget' }))).toBe(true);
	});

	it('follows the direction for multiple choice and typed translation', () => {
		expect(answerIsTargetLanguage(mc({ direction: 'toTarget' }))).toBe(true);
		expect(answerIsTargetLanguage(mc({ direction: 'toNative' }))).toBe(false);
		expect(answerIsTargetLanguage(typed({ direction: 'toTarget' }))).toBe(true);
		expect(answerIsTargetLanguage(typed({ direction: 'toNative' }))).toBe(false);
	});

	it('is false for match-pairs, whatever its direction says', () => {
		expect(answerIsTargetLanguage(matchPairs())).toBe(false);
		expect(answerIsTargetLanguage(matchPairs({ direction: 'toTarget' }))).toBe(false);
	});

	it('answers for every stored type', () => {
		for (const challenge of allChallenges) {
			expect(typeof answerIsTargetLanguage(challenge)).toBe('boolean');
		}
	});
});

describe('answerReading', () => {
	it('reads the correct option for multiple choice', () => {
		expect(
			answerReading(mc({ optionsRomanization: ['kuàizi', 'càidān', 'chá', 'shuǐ'] }))
		).toBe('càidān');
	});

	it('reads the stored answer romanization for cloze, typed translation and word order', () => {
		expect(answerReading(cloze({ answerRomanization: 'càidān' }))).toBe('càidān');
		expect(answerReading(typed({ answerRomanization: 'mǎidān' }))).toBe('mǎidān');
		expect(answerReading(wordOrder({ answerRomanization: 'wǒmen xiǎng mǎidān' }))).toBe(
			'wǒmen xiǎng mǎidān'
		);
	});

	it('reads the intended word for spot-error, matching what the banner prints', () => {
		expect(answerReading(spotError({ intendedWordRomanization: 'mǎidān' }))).toBe('mǎidān');
	});

	it('is undefined when the answer is in the learner’s own language', () => {
		expect(
			answerReading(mc({ direction: 'toNative', optionsRomanization: ['a', 'b', 'c', 'd'] }))
		).toBeUndefined();
		expect(
			answerReading(typed({ direction: 'toNative', answerRomanization: 'mǎidān' }))
		).toBeUndefined();
	});

	it('is undefined for match-pairs and for Latin-script rows carrying no reading', () => {
		expect(answerReading(matchPairs())).toBeUndefined();
		expect(answerReading(cloze())).toBeUndefined();
		expect(answerReading(mc())).toBeUndefined();
		expect(answerReading(spotError())).toBeUndefined();
	});

	it('answers for every stored type', () => {
		for (const challenge of allChallenges) {
			const reading = answerReading(challenge);
			expect(reading === undefined || typeof reading === 'string').toBe(true);
		}
	});
});

describe('spokenAnswerFor', () => {
	it('speaks the corrected sentence for spot-error, ahead of the direction gate', () => {
		// The `toNative` fixture: were the gate checked first this would be silent.
		expect(spokenAnswerFor(spotError())).toBe('我们想买单');
		expect(spokenAnswerFor(spotError({ correctedSentence: '  我们想买单  ' }))).toBe('我们想买单');
	});

	it('splices the canonical answer into the cloze sentence, blank and all', () => {
		expect(spokenAnswerFor(cloze())).toBe('请给我一份菜单。');
	});

	it('speaks a word-order answer as the assembled sentence, not tile by tile', () => {
		expect(spokenAnswerFor(wordOrder())).toBe('我们想买单');
	});

	it('speaks the correct option of a toTarget multiple choice', () => {
		expect(spokenAnswerFor(mc())).toBe('菜单');
	});

	it('speaks the canonical accepted answer of a toTarget typed translation', () => {
		expect(spokenAnswerFor(typed())).toBe('买单');
	});

	it('is silent for match-pairs, which has no single answer', () => {
		expect(spokenAnswerFor(matchPairs())).toBe('');
		// Even were it ever built `toTarget`.
		expect(spokenAnswerFor(matchPairs({ direction: 'toTarget' }))).toBe('');
	});

	it('is silent when the answer is in the learner’s own language', () => {
		expect(spokenAnswerFor(mc({ direction: 'toNative' }))).toBe('');
		expect(spokenAnswerFor(typed({ direction: 'toNative' }))).toBe('');
		expect(spokenAnswerFor(cloze({ direction: 'toNative' }))).toBe('');
		expect(spokenAnswerFor(wordOrder({ direction: 'toNative' }))).toBe('');
	});

	it('is silent on an empty accepted-answer list rather than speaking a bare gap', () => {
		expect(spokenAnswerFor(cloze({ acceptedAnswers: [] }))).toBe('');
		expect(spokenAnswerFor(typed({ acceptedAnswers: [] }))).toBe('');
	});

	it('answers for every stored type', () => {
		for (const challenge of allChallenges) {
			expect(typeof spokenAnswerFor(challenge)).toBe('string');
		}
	});
});

describe('unhandledChallenge', () => {
	it('names the offending type, for a row from a build that knew more types', () => {
		const alien = { id: 'x', type: 'dictation', direction: 'toTarget', itemIds: [] };
		expect(() => unhandledChallenge(alien as never)).toThrow(/dictation/);
	});
});
