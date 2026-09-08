/**
 * The shape of the activity calendar, kept pure so the page is only markup.
 *
 * A calendar here is a run of whole weeks ending in the week that holds
 * today, Monday first — the journal reads left to right into the present, so
 * the newest column is the rightmost and the days after today in that column
 * are simply not yet. Everything is built from `YYYY-MM-DD` strings through
 * `$lib/db`'s local-day helpers, so a DST change never moves a cell.
 */
import { localDay, previousDay } from '$lib/db';
import type { DailyActivity } from '$lib/db';

/** Monday is 0. `Date.getDay` puts Sunday first, which is not how a week is read here. */
function weekdayOf(day: string): number {
	const [year, month, date] = day.split('-').map(Number);
	return (new Date(year, month - 1, date).getDay() + 6) % 7;
}

/** The local calendar day after `day` (DST-safe: built from local parts). */
export function nextDay(day: string): string {
	const [year, month, date] = day.split('-').map(Number);
	return localDay(new Date(year, month - 1, date + 1).getTime());
}

/**
 * `weeks` columns of seven days, oldest column first, Monday at the top,
 * the last column being the week that holds `today`. Days past `today` are
 * present so the column keeps its shape; the page draws them as not yet.
 */
export function calendarWeeks(today: string, weeks: number): string[][] {
	const columns: string[][] = [];
	let day = today;
	for (let back = weekdayOf(today); back > 0; back--) day = previousDay(day);
	for (let week = weeks - 1; week > 0; week--) for (let i = 0; i < 7; i++) day = previousDay(day);

	for (let week = 0; week < weeks; week++) {
		const column: string[] = [];
		for (let i = 0; i < 7; i++) {
			column.push(day);
			day = nextDay(day);
		}
		columns.push(column);
	}
	return columns;
}

/**
 * Where a month begins along the columns: the column whose top cell is the
 * first Monday on or after the first of a month carries that month's label.
 * The first column is labelled only when its week starts in a month of its
 * own — a strip that opens mid-March would otherwise say "Mar" over a
 * column that is mostly February.
 */
export function monthStarts(
	weeks: string[][],
	format: (day: string) => string
): { column: number; label: string }[] {
	const labels: { column: number; label: string }[] = [];
	let previous = '';
	for (const [column, week] of weeks.entries()) {
		const month = week[0].slice(0, 7);
		if (column === 0) {
			previous = month;
			// Only if the whole week already belongs to this month.
			if (week[0].slice(8) <= '07') labels.push({ column, label: format(week[0]) });
			continue;
		}
		if (month !== previous) labels.push({ column, label: format(week[0]) });
		previous = month;
	}
	return labels;
}

/**
 * How much happened that day, for the shade of a cell. Every row of work
 * counts once — an answer, a word reviewed, a word looked up, a word added —
 * and a drill therefore weighs about twice what its answers alone would, on
 * every day alike. The shade is relative to the busiest day on screen, so a
 * uniform weighting changes nothing about which days stand out.
 */
export function activityOf(day: DailyActivity | undefined): number {
	if (!day) return 0;
	return day.count + day.reviewed + day.lookups + day.added;
}

/** Five shades: 0 is nothing; 1..4 is the quarter of the busiest day a cell reaches. */
export function shadeOf(value: number, peak: number): 0 | 1 | 2 | 3 | 4 {
	if (value <= 0 || peak <= 0) return 0;
	return Math.min(4, Math.max(1, Math.ceil((4 * value) / peak))) as 1 | 2 | 3 | 4;
}

/** The longest run of consecutive days in `days`, in any order, duplicates allowed. */
export function longestStreak(days: string[]): number {
	const present = new Set(days);
	let longest = 0;
	for (const day of present) {
		// Only count a run from its first day, so each run is walked once.
		if (present.has(previousDay(day))) continue;
		let length = 0;
		for (let cursor = day; present.has(cursor); cursor = nextDay(cursor)) length++;
		longest = Math.max(longest, length);
	}
	return longest;
}
