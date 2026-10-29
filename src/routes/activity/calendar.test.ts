import { describe, expect, it } from 'vitest';

import {
	activityOf,
	longestStreak,
	monthCalendar,
	monthKey,
	nextDay,
	shiftMonth,
	shadeOf,
	studyAmount,
	studyMinutes,
	studyOn
} from './calendar';
import type { StudySession } from '$lib/db';

describe('study log', () => {
	const at = (day: number, hour: number, minute = 0) =>
		new Date(2024, 2, day, hour, minute).getTime();
	const session = (
		mode: StudySession['mode'],
		when: number,
		minutes: number,
		answers = 0
	): StudySession => ({ id: `${mode}-${when}`, at: when, mode, minutes, answers });

	it("keeps one local day's sessions, oldest first", () => {
		const late = session('input', at(13, 21, 10), 12.5);
		const early = session('practice', at(13, 9, 5), 0, 14);
		const other = session('output', at(14, 0, 30), 3);
		expect(studyOn([late, other, early], '2024-03-13')).toEqual([early, late]);
	});

	it('reads practice as answers and the rest as minutes', () => {
		expect(studyAmount(session('practice', at(13, 9), 0, 1))).toBe('1 answer');
		expect(studyAmount(session('practice', at(13, 9), 0, 14))).toBe('14 answers');
		expect(studyAmount(session('input', at(13, 9), 12.5))).toBe('12.5 min');
	});

	it('totals the minutes to a tenth', () => {
		const sessions = [session('input', at(13, 9), 0.1), session('output', at(13, 10), 0.2)];
		expect(studyMinutes(sessions)).toBe(0.3);
	});
});

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
