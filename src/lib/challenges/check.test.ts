/**
 * Grading through the wasm seam. The rules and their cases are Rust's
 * (`crates/sapling-challenges`' `grade.rs` and `matcher.rs`); this pins that
 * a challenge and an answer cross and a verdict comes back.
 */

import { describe, expect, it } from 'vitest';
import type { ClozeChallenge, WordOrderChallenge } from '$lib/types';
import { checkChallenge, validateAnswer } from './check';

describe('checkChallenge', () => {
	it('grades a typed answer fuzzily and a tapped one exactly', () => {
		const cloze: ClozeChallenge = {
			id: 'c1',
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Ich ___ nach Hause.',
			acceptedAnswers: ['gehe'],
			itemIds: ['item1']
		};
		expect(checkChallenge(cloze, 'gehe')).toBe('correct');
		expect(checkChallenge(cloze, 'gehee')).toBe('almost');

		const wordOrder: WordOrderChallenge = {
			id: 'w1',
			type: 'word-order',
			direction: 'toTarget',
			tiles: ['Hause.', 'Ich', 'nach', 'gehe'],
			answerTokens: ['Ich', 'gehe', 'nach', 'Hause.'],
			answer: 'Ich gehe nach Hause.',
			itemIds: ['item1']
		};
		expect(checkChallenge(wordOrder, 'Ich gehe nach Hause.')).toBe('correct');
		expect(checkChallenge(wordOrder, 'Ich gehe nach Hausee.')).toBe('wrong');
	});
});

describe('validateAnswer', () => {
	it('answers the verdict and the nearest accepted answer', () => {
		expect(validateAnswer('cafe', ['café'])).toEqual({
			verdict: 'almost',
			closestAccepted: 'café',
			distance: 0
		});
		expect(validateAnswer('helo', ['hello'], { fuzzy: false }).verdict).toBe('wrong');
		expect(validateAnswer('anything', [])).toEqual({ verdict: 'wrong', closestAccepted: '' });
	});
});
