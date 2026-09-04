/**
 * Tests for `difficultyOf`.
 *
 * Three things have to hold at once, and they are tested separately: within one
 * type, difficulty moves the direction a human would expect as a structural
 * field grows or shrinks (monotonic in each knob); across types, a challenge
 * never escapes the span its own `demand` tier owns, however hard its fields
 * make it read; and *inside* a tier the types are ordered by how much the
 * format itself asks, at equal prompt length — which is the whole point of the
 * shared length scale and the per-type base offsets, since the planner compares
 * these numbers between types.
 */

import { describe, expect, it } from 'vitest';
import type { Challenge, ChallengeType } from '$lib/types';
import { difficultyOf } from './difficulty';
import { STORED_TYPE_ORDER } from './types';

/** One of the samples below as a challenge; `id`/`itemIds` are never read. */
function challenge(sample: object): Challenge {
	return { id: 'c1', itemIds: ['i1'], ...sample } as Challenge;
}

const SHORT_PROMPT = 'hola';
const LONG_PROMPT = 'perdona, ¿me podrías decir dónde está la estación de tren más cercana?';

describe('difficultyOf', () => {
	describe('multiple-choice', () => {
		const base = {
			type: 'multiple-choice',
			direction: 'toTarget',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		};

		it('grows with the prompt length', () => {
			const short = difficultyOf(challenge({ ...base, prompt: SHORT_PROMPT }));
			const long = difficultyOf(challenge({ ...base, prompt: LONG_PROMPT }));
			expect(short).toBeLessThan(long);
		});

		it('never leaves the recognition tier, demand 0: [0, 0.15]', () => {
			for (const prompt of [SHORT_PROMPT, LONG_PROMPT]) {
				const value = difficultyOf(challenge({ ...base, prompt }));
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(0.15);
			}
		});
	});

	describe('cloze', () => {
		const banked = (sentence: string, bankSize: number) => ({
			type: 'cloze',
			direction: 'toTarget',
			sentence,
			acceptedAnswers: ['a'],
			wordBank: Array.from({ length: bankSize }, (_, i) => `w${i}`),
			translationHint: 'x'
		});
		const bankless = (sentence: string) => ({
			type: 'cloze',
			direction: 'toTarget',
			sentence,
			acceptedAnswers: ['a'],
			translationHint: 'x'
		});

		it('grows with sentence length', () => {
			const short = difficultyOf(challenge(banked('Yo ___ un libro.', 4)));
			const long = difficultyOf(
				challenge(banked('Yo, después de comer, siempre ___ un libro antes de dormir.', 4))
			);
			expect(short).toBeLessThan(long);
		});

		it('does not count the blank as a word of the sentence', () => {
			// `segmentWords` reads a standalone `___` as a word of its own, so
			// "I want the ___ please." counted five where four are written.
			const blanked = difficultyOf(challenge(banked('I want the ___ please.', 4)));
			const written = difficultyOf(challenge(banked('I want the please.', 4)));
			expect(blanked).toBeCloseTo(written, 10);
		});

		it('does not glue a mid-word blank to the words around it', () => {
			// The other half of the same bug: `a___b` is one segment, so a blank
			// inside a word made the whole sentence read as one word long.
			const glued = difficultyOf(challenge(banked('ho___la que tal', 4)));
			const split = difficultyOf(challenge(banked('ho la que tal', 4)));
			expect(glued).toBeCloseTo(split, 10);
		});

		it('shrinks as the word bank grows: fewer distractors is harder', () => {
			const smallBank = difficultyOf(challenge(banked('Yo ___ un libro.', 3)));
			const bigBank = difficultyOf(challenge(banked('Yo ___ un libro.', 6)));
			expect(smallBank).toBeGreaterThan(bigBank);
		});

		it('stays in the constrained-production span [0.15, 0.45] when banked', () => {
			for (const bankSize of [3, 4, 5, 6]) {
				const value = difficultyOf(challenge(banked('Yo ___ un libro.', bankSize)));
				expect(value).toBeGreaterThanOrEqual(0.15);
				expect(value).toBeLessThanOrEqual(0.45);
			}
		});

		it('jumps to the free-production span [0.45, 1] once the bank is gone', () => {
			const value = difficultyOf(challenge(bankless('Yo ___ un libro.')));
			expect(value).toBeGreaterThanOrEqual(0.45);
			expect(value).toBeLessThanOrEqual(1);
		});
	});

	describe('word-order', () => {
		const wordOrder = (tileCount: number, distractors: number) => {
			const answerTokens = Array.from({ length: tileCount }, (_, i) => `w${i}`);
			const tiles = [...answerTokens, ...Array.from({ length: distractors }, (_, i) => `d${i}`)];
			return {
				type: 'word-order',
				direction: 'toTarget',
				prompt: 'x',
				tiles,
				answerTokens,
				answer: 'x'
			};
		};

		it('grows with tile count', () => {
			const short = difficultyOf(challenge(wordOrder(3, 0)));
			const long = difficultyOf(challenge(wordOrder(8, 0)));
			expect(short).toBeLessThan(long);
		});

		it('grows with distractor count, tile count held constant', () => {
			const none = difficultyOf(challenge(wordOrder(5, 0)));
			const some = difficultyOf(challenge(wordOrder(5, 3)));
			expect(none).toBeLessThan(some);
		});

		it('never leaves the constrained-production tier, demand 1: [0.15, 0.45]', () => {
			for (const [tiles, distractors] of [
				[3, 0],
				[8, 3]
			]) {
				const value = difficultyOf(challenge(wordOrder(tiles, distractors)));
				expect(value).toBeGreaterThanOrEqual(0.15);
				expect(value).toBeLessThanOrEqual(0.45 + 1e-9);
			}
		});
	});

	describe('typed-translation', () => {
		it('grows with prompt length toTarget, and stays in the free-production span', () => {
			const base = { type: 'typed-translation', direction: 'toTarget', acceptedAnswers: ['a'] };
			const short = difficultyOf(challenge({ ...base, prompt: SHORT_PROMPT }));
			const long = difficultyOf(challenge({ ...base, prompt: LONG_PROMPT }));
			expect(short).toBeLessThan(long);
			expect(short).toBeGreaterThanOrEqual(0.45);
			expect(long).toBeLessThanOrEqual(1);
		});

		it('stays in the recognition span toNative, whatever the prompt length', () => {
			const base = { type: 'typed-translation', direction: 'toNative', acceptedAnswers: ['a'] };
			const value = difficultyOf(challenge({ ...base, prompt: LONG_PROMPT }));
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(0.15);
		});
	});

	describe('spot-error', () => {
		const spotError = (tokenCount: number) => ({
			type: 'spot-error',
			direction: 'toNative',
			tokens: Array.from({ length: tokenCount }, (_, i) => `w${i}`),
			correctIndex: 0,
			intendedWord: 'w0',
			correctedSentence: 'x',
			meaning: 'x'
		});

		it('grows with sentence length, staying in the recognition span', () => {
			const short = difficultyOf(challenge(spotError(3)));
			const long = difficultyOf(challenge(spotError(14)));
			expect(short).toBeLessThan(long);
			expect(short).toBeGreaterThanOrEqual(0);
			expect(long).toBeLessThanOrEqual(0.15);
		});
	});

	describe('match-pairs', () => {
		const matchPairs = (pairCount: number) => ({
			type: 'match-pairs',
			direction: 'toNative',
			pairs: Array.from({ length: pairCount }, (_, i) => ({ a: `a${i}`, b: `b${i}` }))
		});

		it('grows with pair count, staying in the recognition span', () => {
			const few = difficultyOf(challenge(matchPairs(2)));
			const many = difficultyOf(challenge(matchPairs(6)));
			expect(few).toBeLessThan(many);
			expect(few).toBeGreaterThanOrEqual(0);
			expect(many).toBeLessThanOrEqual(0.15);
		});
	});

	describe('across types, at the same prompt length', () => {
		// The reason the length scale is shared and the base offsets exist. Each
		// type used to normalise its own length against its own ceiling — 8 words
		// for multiple-choice, 12 for typed translation, 14 for spot-error — so the
		// same five-word prompt made the four-option question read *harder* than
		// finding the wrong word in a whole sentence. The planner compares these
		// numbers between types, so that ordering was live.
		const FIVE_WORDS = 'quiero pedir la cuenta ahora';

		it('orders the recognition tier: multiple-choice < typed toNative < spot-error', () => {
			const mc = difficultyOf(
				challenge({
					type: 'multiple-choice',
					direction: 'toTarget',
					prompt: FIVE_WORDS,
					options: ['a', 'b', 'c', 'd'],
					correctIndex: 0
				})
			);
			const typed = difficultyOf(
				challenge({
					type: 'typed-translation',
					direction: 'toNative',
					prompt: FIVE_WORDS,
					acceptedAnswers: ['a']
				})
			);
			const spot = difficultyOf(
				challenge({
					type: 'spot-error',
					direction: 'toNative',
					tokens: FIVE_WORDS.split(' '),
					correctIndex: 0,
					intendedWord: 'w0',
					correctedSentence: 'x',
					meaning: 'x'
				})
			);

			expect(mc).toBeLessThan(typed);
			expect(typed).toBeLessThan(spot);
			// All three are still recognition, so none of them escapes tier 0.
			expect(spot).toBeLessThanOrEqual(0.15);
		});

		it('keeps banked cloze and word-order comparable in constrained production', () => {
			// Both put every word the learner needs on screen and withhold one
			// choice, so at the same sentence length with no extra support on either
			// side they should land close together rather than one type-wide apart.
			const cloze = difficultyOf(
				challenge({
					type: 'cloze',
					direction: 'toTarget',
					sentence: 'quiero pedir la cuenta ___',
					acceptedAnswers: ['ahora'],
					wordBank: ['ahora', 'luego', 'nunca', 'siempre'],
					translationHint: 'x'
				})
			);
			const tiles = FIVE_WORDS.split(' ');
			const wordOrder = difficultyOf(
				challenge({
					type: 'word-order',
					direction: 'toTarget',
					prompt: 'x',
					tiles: [...tiles, 'd0'],
					answerTokens: tiles,
					answer: FIVE_WORDS
				})
			);

			expect(Math.abs(cloze - wordOrder)).toBeLessThan(0.05);
		});
	});

	it('dispatches for every stored type', () => {
		const samples = {
			'multiple-choice': {
				type: 'multiple-choice',
				direction: 'toTarget',
				prompt: 'hola',
				options: ['a', 'b', 'c', 'd'],
				correctIndex: 0
			},
			cloze: {
				type: 'cloze',
				direction: 'toTarget',
				sentence: 'Yo ___ un libro.',
				acceptedAnswers: ['leo'],
				translationHint: 'I read a book.'
			},
			'typed-translation': {
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'hola',
				acceptedAnswers: ['hello']
			},
			'match-pairs': { type: 'match-pairs', direction: 'toNative', pairs: [{ a: 'a', b: 'b' }] },
			'word-order': {
				type: 'word-order',
				direction: 'toTarget',
				prompt: 'x',
				tiles: ['a', 'b'],
				answerTokens: ['a', 'b'],
				answer: 'a b'
			},
			'spot-error': {
				type: 'spot-error',
				direction: 'toNative',
				tokens: ['a', 'b', 'c'],
				correctIndex: 0,
				intendedWord: 'a',
				correctedSentence: 'a b c',
				meaning: 'x'
			}
		} satisfies { [T in ChallengeType]: object };

		for (const type of STORED_TYPE_ORDER) {
			const value = difficultyOf(challenge(samples[type]));
			expect(value, type).toBeGreaterThanOrEqual(0);
			expect(value, type).toBeLessThanOrEqual(1);
		}
	});
});
