/**
 * Unit tests for the per-type grading rules.
 *
 * One fixture per stored type — only the fields the grader actually reads — and
 * every type is asked, because the bug this dispatcher exists to prevent is the
 * one where a new type falls through to somebody else's rule. Moved here
 * verbatim from `$lib/validate/fuzzy.test.ts` when the dispatch moved out of the
 * string matchers and into the challenge layer; the matchers underneath are
 * still tested over there.
 */

import { describe, expect, it } from 'vitest';
import type {
	ClozeChallenge,
	MatchPairsChallenge,
	MultipleChoiceChallenge,
	SpotErrorChallenge,
	TypedTranslationChallenge,
	WordOrderChallenge
} from '$lib/types';
import { checkChallenge } from './check';

describe('checkChallenge', () => {
	const cloze: ClozeChallenge = {
		id: 'c1',
		type: 'cloze',
		direction: 'toTarget',
		sentence: 'Ich ___ nach Hause.',
		acceptedAnswers: ['gehe'],
		translationHint: 'I am going home.',
		itemIds: ['item1']
	};

	const typedTranslation: TypedTranslationChallenge = {
		id: 't1',
		type: 'typed-translation',
		direction: 'toTarget',
		prompt: 'good morning',
		acceptedAnswers: ['buenos días', 'buenos dias'],
		itemIds: ['item1']
	};

	const multipleChoice: MultipleChoiceChallenge = {
		id: 'm1',
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: 'casa',
		options: ['house', 'car', 'tree', 'dog'],
		correctIndex: 0,
		itemIds: ['item1']
	};

	const matchPairs: MatchPairsChallenge = {
		id: 'p1',
		type: 'match-pairs',
		direction: 'toTarget',
		pairs: [
			{ a: 'hola', b: 'hello' },
			{ a: 'adiós', b: 'goodbye' }
		],
		itemIds: ['item1']
	};

	it('grades a cloze challenge against its accepted answers', () => {
		expect(checkChallenge(cloze, 'gehe')).toBe('correct');
		expect(checkChallenge(cloze, 'gehee')).toBe('almost');
		expect(checkChallenge(cloze, 'komme')).toBe('wrong');
	});

	it('grades a typed-translation challenge, taking the best of several accepted answers', () => {
		expect(checkChallenge(typedTranslation, 'Buenos Días')).toBe('correct');
		expect(checkChallenge(typedTranslation, 'buenos dias')).toBe('correct');
		expect(checkChallenge(typedTranslation, 'buenos dia')).toBe('almost');
	});

	it('grades a multiple-choice challenge against the correct option text', () => {
		expect(checkChallenge(multipleChoice, 'house')).toBe('correct');
		expect(checkChallenge(multipleChoice, 'House')).toBe('correct');
		expect(checkChallenge(multipleChoice, 'car')).toBe('wrong');
	});

	it('grades a match-pairs "a::b" answer against the declared pairs', () => {
		expect(checkChallenge(matchPairs, 'hola::hello')).toBe('correct');
		expect(checkChallenge(matchPairs, 'hola::goodbye')).toBe('wrong');
		expect(checkChallenge(matchPairs, 'not a pair')).toBe('wrong');
	});

	const wordOrder: WordOrderChallenge = {
		id: 'w1',
		type: 'word-order',
		direction: 'toTarget',
		prompt: 'I am going home.',
		tiles: ['Hause.', 'Ich', 'nach', 'gehe', 'komme'],
		answerTokens: ['Ich', 'gehe', 'nach', 'Hause.'],
		answer: 'Ich gehe nach Hause.',
		itemIds: ['item1']
	};

	const spotError: SpotErrorChallenge = {
		id: 's1',
		type: 'spot-error',
		direction: 'toNative',
		tokens: ['Ich', 'komme', 'nach', 'Hause.'],
		correctIndex: 1,
		intendedWord: 'gehe',
		correctedSentence: 'Ich gehe nach Hause.',
		meaning: 'I am going home.',
		itemIds: ['item1']
	};

	it('grades word-order exactly: the learner picked tiles, they did not spell', () => {
		expect(checkChallenge(wordOrder, 'Ich gehe nach Hause.')).toBe('correct');
		expect(checkChallenge(wordOrder, 'Ich nach gehe Hause.')).toBe('wrong');
		// One tile out is a wrong arrangement, never a near miss.
		expect(checkChallenge(wordOrder, 'Ich gehe nach Hausee.')).toBe('wrong');
	});

	it('grades spot-error against the word the learner had to tap — the wrong one', () => {
		expect(checkChallenge(spotError, 'komme')).toBe('correct');
		// Tapping the word that is actually fine is not the answer.
		expect(checkChallenge(spotError, 'gehe')).toBe('wrong');
		expect(checkChallenge(spotError, 'Hause.')).toBe('wrong');
	});
});
