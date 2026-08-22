import { describe, expect, it } from 'vitest';

import type { Challenge } from './types';

describe('test wiring', () => {
	it('runs in a node environment', () => {
		expect(typeof window).toBe('undefined');
	});

	it('can narrow the Challenge union on `type`', () => {
		const challenge: Challenge = {
			id: 'c1',
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'the cat',
			acceptedAnswers: ['de kat'],
			itemIds: ['i1']
		};

		expect(challenge.type === 'typed-translation' && challenge.acceptedAnswers).toEqual(['de kat']);
	});
});
