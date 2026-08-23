/**
 * `statsFromDays` is the one piece of stats logic that exists twice over: the
 * local path rolls the streak forward a day at a time in `addXp`, and the sync
 * path (docs/sync.md §4 — "streak and `lastActiveDay` are derived from the day
 * totals, not synced") has to rebuild the same number from merged totals. These
 * tests pin the fold; `addXp` is the incremental statement of the same rule.
 */

import { describe, expect, it } from 'vitest';

import { localDay, middayOf, previousDay, statsFromDays } from './day';

describe('localDay', () => {
	it('round-trips through middayOf', () => {
		const day = localDay(Date.UTC(2026, 7, 23, 12));
		expect(localDay(middayOf(day))).toBe(day);
	});

	it('steps back one calendar day', () => {
		expect(previousDay('2026-03-01')).toBe('2026-02-28');
		expect(previousDay('2026-01-01')).toBe('2025-12-31');
	});
});

describe('statsFromDays', () => {
	it('is empty for a learner who has never played', () => {
		expect(statsFromDays([])).toEqual({ xp: 0, streakDays: 0, lastActiveDay: '', history: [] });
	});

	it('sums XP, sorts history and counts the run ending at the last active day', () => {
		const stats = statsFromDays([
			{ day: '2026-08-23', xp: 65 },
			{ day: '2026-08-21', xp: 40 },
			{ day: '2026-08-22', xp: 10 }
		]);

		expect(stats).toEqual({
			xp: 115,
			streakDays: 3,
			lastActiveDay: '2026-08-23',
			history: [
				{ day: '2026-08-21', xp: 40 },
				{ day: '2026-08-22', xp: 10 },
				{ day: '2026-08-23', xp: 65 }
			]
		});
	});

	it('breaks the streak on a missing day, counting only the trailing run', () => {
		const stats = statsFromDays([
			{ day: '2026-08-01', xp: 10 },
			{ day: '2026-08-02', xp: 10 },
			{ day: '2026-08-22', xp: 10 },
			{ day: '2026-08-23', xp: 10 }
		]);

		expect(stats.streakDays).toBe(2);
		expect(stats.lastActiveDay).toBe('2026-08-23');
	});

	it('counts a day the learner played for zero XP as active', () => {
		expect(
			statsFromDays([
				{ day: '2026-08-22', xp: 0 },
				{ day: '2026-08-23', xp: 20 }
			]).streakDays
		).toBe(2);
	});
});
