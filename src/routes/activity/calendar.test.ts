import { describe, expect, it } from 'vitest';

import {
	activityOf,
	calendarWeeks,
	longestStreak,
	monthStarts,
	nextDay,
	shadeOf
} from './calendar';

describe('calendarWeeks', () => {
	it('ends in the week holding today, Monday first, oldest column first', () => {
		// 2024-03-13 is a Wednesday.
		const weeks = calendarWeeks('2024-03-13', 2);
		expect(weeks).toEqual([
			[
				'2024-03-04',
				'2024-03-05',
				'2024-03-06',
				'2024-03-07',
				'2024-03-08',
				'2024-03-09',
				'2024-03-10'
			],
			[
				'2024-03-11',
				'2024-03-12',
				'2024-03-13',
				'2024-03-14',
				'2024-03-15',
				'2024-03-16',
				'2024-03-17'
			]
		]);
	});

	it('keeps a Monday and a Sunday in the same shape', () => {
		expect(calendarWeeks('2024-03-11', 1)[0][0]).toBe('2024-03-11');
		expect(calendarWeeks('2024-03-17', 1)[0][6]).toBe('2024-03-17');
	});

	it('crosses a month and a year boundary by local parts', () => {
		const [week] = calendarWeeks('2024-01-03', 1);
		expect(week[0]).toBe('2024-01-01');
		expect(nextDay('2023-12-31')).toBe('2024-01-01');
		expect(nextDay('2024-02-29')).toBe('2024-03-01');
	});
});

describe('monthStarts', () => {
	const label = (day: string) => day.slice(0, 7);

	it('labels the column where a month begins, and the first only when it owns its week', () => {
		const weeks = calendarWeeks('2024-03-13', 6);
		// Columns start 2024-02-05, 02-12, 02-19, 02-26, 03-04, 03-11.
		expect(monthStarts(weeks, label)).toEqual([
			{ column: 0, label: '2024-02' },
			{ column: 4, label: '2024-03' }
		]);
	});

	it('leaves the first column unlabelled when it opens mid-month', () => {
		const weeks = calendarWeeks('2024-03-27', 3);
		// Columns start 03-11, 03-18, 03-25: March began before the strip.
		expect(monthStarts(weeks, label)).toEqual([]);
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
	it('finds the longest run however the days arrive', () => {
		expect(longestStreak([])).toBe(0);
		expect(longestStreak(['2024-03-10'])).toBe(1);
		expect(
			longestStreak([
				'2024-03-12',
				'2024-03-10',
				'2024-03-11',
				'2024-03-20',
				'2024-03-21',
				'2024-03-11'
			])
		).toBe(3);
	});

	it('runs across a month end', () => {
		expect(longestStreak(['2024-02-28', '2024-02-29', '2024-03-01'])).toBe(3);
	});
});
