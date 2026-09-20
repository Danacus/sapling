/**
 * The shape of the activity calendar, kept pure so the page is only markup.
 *
 * The journal uses one Monday-first month at a time. Everything is built from
 * `YYYY-MM-DD` strings through `$lib/db`'s local-day helpers, so a DST change
 * never moves a cell.
 */
import { localDay, previousDay } from '$lib/db';
import type { DailyActivity } from '$lib/db';

/** The local calendar day after `day` (DST-safe: built from local parts). */
export function nextDay(day: string): string {
	const [year, month, date] = day.split('-').map(Number);
	return localDay(new Date(year, month - 1, date + 1).getTime());
}

/** A stable `YYYY-MM` key for moving through the activity journal month by month. */
export function monthKey(day: string): string {
	return day.slice(0, 7);
}

/** Move a `YYYY-MM` key by whole calendar months, including across year boundaries. */
export function shiftMonth(month: string, offset: number): string {
	const [year, index] = month.split('-').map(Number);
	const date = new Date(year, index - 1 + offset, 1);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * A complete Monday-first calendar page for `month`. Days outside the month
 * are `null`, keeping the familiar weekday columns without making adjacent
 * months look selectable.
 */
export function monthCalendar(month: string): (string | null)[] {
	const [year, index] = month.split('-').map(Number);
	const daysInMonth = new Date(year, index, 0).getDate();
	const leading = (new Date(year, index - 1, 1).getDay() + 6) % 7;
	const cells: (string | null)[] = Array.from({ length: leading }, () => null);

	for (let date = 1; date <= daysInMonth; date++) {
		cells.push(`${month}-${String(date).padStart(2, '0')}`);
	}
	while (cells.length % 7 !== 0) cells.push(null);
	return cells;
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
