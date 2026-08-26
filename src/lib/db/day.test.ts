/**
 * The streak is derived from the answer log rather than bookkept, so these two
 * folds are the whole of it: `activityByDay` buckets results into local days,
 * `streakFrom` counts the run ending at the most recent one.
 */

import { describe, expect, it } from 'vitest';

import { activityByDay, localDay, previousDay, streakFrom } from './day';

const at = (year: number, month: number, day: number, hour = 12): number =>
	new Date(year, month - 1, day, hour).getTime();

describe('localDay', () => {
	it('names the local calendar day', () => {
		expect(localDay(at(2026, 8, 23))).toBe('2026-08-23');
	});

	it('steps back one calendar day', () => {
		expect(previousDay('2026-03-01')).toBe('2026-02-28');
		expect(previousDay('2026-01-01')).toBe('2025-12-31');
	});
});

describe('activityByDay', () => {
	it('is empty for a learner who has never answered anything', () => {
		expect(activityByDay([])).toEqual([]);
	});

	it('counts answers per local day, oldest first, whatever the input order', () => {
		expect(
			activityByDay([
				{ at: at(2026, 8, 23, 9) },
				{ at: at(2026, 8, 21, 20) },
				{ at: at(2026, 8, 23, 21) },
				{ at: at(2026, 8, 22, 8) }
			])
		).toEqual([
			{ day: '2026-08-21', count: 1 },
			{ day: '2026-08-22', count: 1 },
			{ day: '2026-08-23', count: 2 }
		]);
	});
});

describe('streakFrom', () => {
	it('is zero with no active days', () => {
		expect(streakFrom([])).toBe(0);
	});

	it('counts the run ending at the most recent active day', () => {
		expect(streakFrom(['2026-08-23', '2026-08-21', '2026-08-22'])).toBe(3);
	});

	it('breaks the streak on a missing day, counting only the trailing run', () => {
		expect(streakFrom(['2026-08-01', '2026-08-02', '2026-08-22', '2026-08-23'])).toBe(2);
	});

	it('does not require today to be active', () => {
		// Nothing here says "today"; the run simply ends at the newest day it has.
		expect(streakFrom(['2026-08-22', '2026-08-23'])).toBe(2);
	});
});
