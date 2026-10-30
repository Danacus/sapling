import { describe, expect, it } from 'vitest';
import type { ChallengeType } from '$lib/types';
import { CHALLENGE_COMPONENTS, componentFor } from './index';

/** Not derived: a derived list could drift the same way the defs do. */
const TYPES: ChallengeType[] = [
	'multiple-choice',
	'cloze',
	'typed-translation',
	'match-pairs',
	'multi-cloze',
	'word-order',
	'spot-error',
	'cue-cloze'
];

describe('CHALLENGE_COMPONENTS', () => {
	it('has one component per stored type and looks it up by tag', () => {
		expect(Object.keys(CHALLENGE_COMPONENTS)).toEqual(TYPES);
		for (const type of TYPES) expect(componentFor(type)).toBe(CHALLENGE_COMPONENTS[type]);
	});
});
