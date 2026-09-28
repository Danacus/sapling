/**
 * The logged form of a passage's answers is a contract across the seam: the
 * component writes it here and Rust grades it back.
 */

import { describe, expect, it } from 'vitest';

import type { MultiClozeChallenge } from '$lib/types';
import { checkChallenge, gradeMultiClozeAnswers } from '../check';
import { serializeMultiClozeAnswers } from './multi-cloze';

const challenge: MultiClozeChallenge = {
	id: 'mc1',
	type: 'multi-cloze',
	direction: 'toTarget',
	passage: '___1___ leo un libro. Luego ___2___ café.',
	gaps: [
		{ itemId: 'i1', acceptedAnswers: ['Yo'] },
		{ itemId: 'i2', acceptedAnswers: ['bebo'] }
	],
	wordBank: ['Yo', 'bebo', 'como', 'libro', 'café'],
	itemIds: ['i1', 'i2']
};

describe('multi-cloze answers', () => {
	it('grade gap by gap, and read back from the form they are logged in', () => {
		expect(gradeMultiClozeAnswers(challenge, ['Yo', 'como'])).toEqual({
			verdict: 'wrong',
			itemVerdicts: [
				{ itemId: 'i1', verdict: 'correct' },
				{ itemId: 'i2', verdict: 'wrong' }
			]
		});
		expect(serializeMultiClozeAnswers(['Yo', 'como'])).toBe('1: Yo · 2: como');
		expect(checkChallenge(challenge, serializeMultiClozeAnswers(['Yo', 'bebo']))).toBe('correct');
		expect(checkChallenge(challenge, serializeMultiClozeAnswers(['Yo', '']))).toBe('wrong');
	});
});
