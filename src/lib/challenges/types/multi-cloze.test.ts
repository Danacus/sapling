import { describe, expect, it } from 'vitest';

import type { MultiClozeChallenge } from '$lib/types';
import {
	gradeMultiClozeAnswers,
	multiClozeChallengeSchema,
	serializeMultiClozeAnswers
} from './multi-cloze';

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

describe('multi-cloze stored shape', () => {
	it('requires every numbered marker and one distinct item per gap', () => {
		expect(multiClozeChallengeSchema.safeParse(challenge).success).toBe(true);
		expect(
			multiClozeChallengeSchema.safeParse({ ...challenge, passage: '___1___ leo un libro.' })
				.success
		).toBe(false);
		expect(
			multiClozeChallengeSchema.safeParse({
				...challenge,
				gaps: [challenge.gaps[0], { ...challenge.gaps[1], itemId: 'i1' }]
			}).success
		).toBe(false);
	});

	it('keeps overall feedback intuitive while exposing the gap verdicts SRS needs', () => {
		const graded = gradeMultiClozeAnswers(challenge, ['Yo', 'como']);
		expect(graded.verdict).toBe('wrong');
		expect(graded.itemVerdicts).toEqual([
			{ itemId: 'i1', verdict: 'correct' },
			{ itemId: 'i2', verdict: 'wrong' }
		]);
		expect(serializeMultiClozeAnswers(['Yo', 'como'])).toBe('1: Yo · 2: como');
	});
});
