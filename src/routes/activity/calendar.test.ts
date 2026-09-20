import { describe, expect, it } from 'vitest';

import {
	activityOf,
	longestStreak,
	monthCalendar,
	monthKey,
	nextDay,
	shiftMonth,
	shadeOf
} from './calendar';

describe('month calendar', () => {
	it('builds a Monday-first page with empty cells around the month', () => {
		const days = monthCalendar('2024-03');
		expect(days).toHaveLength(35);
		expect(days.slice(0, 4)).toEqual([null, null, null, null]);
		expect(days[4]).toBe('2024-03-01');
		expect(days.at(-1)).toBe('2024-03-31');
	});

	it('moves cleanly across years and derives month keys from days', () => {
		expect(monthKey('2024-03-13')).toBe('2024-03');
		expect(shiftMonth('2024-01', -1)).toBe('2023-12');
		expect(shiftMonth('2024-12', 1)).toBe('2025-01');
		expect(nextDay('2024-02-29')).toBe('2024-03-01');
	});
});

describe('shades', () => {
	it('is nothing for nothing and otherwise a quarter of the peak, floored at one', () => {
		expect(shadeOf(0, 10)).toBe(0);
		expect(shadeOf(1, 10)).toBe(1);
		expect(shadeOf(3, 10)).toBe(2);
		expect(shadeOf(5, 10)).toBe(2);
		expect(shadeOf(6, 10)).toBe(3);
		expect(shadeOf(10, 10)).toBe(4);
		expect(shadeOf(12, 10)).toBe(4);
		expect(shadeOf(3, 0)).toBe(0);
	});

	it('weighs every row of work once', () => {
		expect(activityOf(undefined)).toBe(0);
		expect(
			activityOf({
				day: 'd',
				count: 3,
				correct: 1,
				almost: 1,
				wrong: 1,
				reviewed: 2,
				lookups: 4,
				added: 1
			})
		).toBe(10);
	});
});

describe('longestStreak', () => {
	it('finds the longest run however the days arrive, with two grace days', () => {
		expect(longestStreak([])).toBe(0);
		expect(longestStreak(['2024-03-10'])).toBe(1);
		expect(
			longestStreak([
				'2024-03-14',
				'2024-03-10',
				'2024-03-11',
				'2024-03-20',
				'2024-03-21',
				'2024-03-11'
			])
		).toBe(3);
	});

	it('breaks after three inactive days', () => {
		expect(longestStreak(['2024-03-10', '2024-03-14'])).toBe(1);
	});

	it('runs across a month end', () => {
		expect(longestStreak(['2024-02-28', '2024-02-29', '2024-03-01'])).toBe(3);
	});
});
