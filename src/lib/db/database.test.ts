/**
 * `challengeOf` is what turns a pool row into the challenge a screen is
 * handed, so nothing the pool keeps for itself may survive it. The compiler
 * holds its strip list to `PoolRow`; this holds the runtime to the list.
 */
import { describe, expect, it } from 'vitest';

import { challengeOf, type ChallengeRow } from './database';

describe('challengeOf', () => {
	it('sheds every bookkeeping field', () => {
		const row: ChallengeRow = {
			id: 'c1',
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Yo ___ café.',
			acceptedAnswers: ['bebo'],
			itemIds: ['i1'],
			generatedAt: 1,
			timesServed: 2,
			lastServedAt: 3,
			reported: false,
			topic: 'breakfast'
		};

		expect(challengeOf(row)).toEqual({
			id: 'c1',
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Yo ___ café.',
			acceptedAnswers: ['bebo'],
			itemIds: ['i1']
		});
		// The row itself is left as it was.
		expect(row.topic).toBe('breakfast');
	});
});
