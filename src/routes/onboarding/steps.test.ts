import { describe, expect, it } from 'vitest';

import { FINISH_HREF, onboardingSteps, startHref } from './steps';

describe('onboardingSteps', () => {
	it('ends on the model step when no key was entered', () => {
		expect(onboardingSteps({ adding: false, keyed: false, mockForced: false })).toEqual([
			'languages',
			'model'
		]);
	});

	it('asks how much the learner knows once a key is entered', () => {
		expect(onboardingSteps({ adding: false, keyed: true, mockForced: false })).toEqual([
			'languages',
			'model',
			'level'
		]);
	});

	it('asks it keyless when the mock is forced on', () => {
		expect(onboardingSteps({ adding: false, keyed: false, mockForced: true })).toEqual([
			'languages',
			'model',
			'level'
		]);
	});

	it('skips the key step when adding a language', () => {
		expect(onboardingSteps({ adding: true, keyed: true, mockForced: false })).toEqual([
			'languages',
			'level'
		]);
	});

	it('adds a language in one step without a stored key', () => {
		expect(onboardingSteps({ adding: true, keyed: false, mockForced: false })).toEqual([
			'languages'
		]);
	});
});

describe('where onboarding ends', () => {
	it('sends a beginner to a starter topic', () => {
		expect(startHref('scratch')).toBe('/explore/check?mode=starter');
	});

	it('sends a learner who knows some to the check grid', () => {
		expect(startHref('some')).toBe('/explore/check');
	});

	it('ends a run without the level step on the dashboard', () => {
		expect(FINISH_HREF).toBe('/');
	});
});
