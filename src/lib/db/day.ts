/**
 * Calendar-day arithmetic and the XP/streak fold.
 *
 * Split out of `repositories.ts` so it can be imported by pure code — this
 * module touches neither Dexie nor the clock. The sync apply engine
 * (`$lib/sync/apply`) recomputes stats from merged per-day XP totals and must
 * land on exactly the same streak the local incremental path produces, so both
 * sides share this one implementation rather than agreeing by coincidence.
 */

import type { Stats } from '$lib/types';

/** `YYYY-MM-DD` for an epoch-milliseconds timestamp, in the local time zone. */
export function localDay(at: number): string {
	const date = new Date(at);
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/** The local calendar day before `day` (DST-safe: built from local parts). */
export function previousDay(day: string): string {
	const [year, month, date] = day.split('-').map(Number);
	return localDay(new Date(year, month - 1, date - 1).getTime());
}

/**
 * Midday, local time, on `day` — a timestamp that is unambiguously inside the
 * day it names whatever the DST situation. Used by genesis to give a synthetic
 * `xp-banked` event an ordering key, since `Stats.history` records only the day.
 */
export function middayOf(day: string): number {
	const [year, month, date] = day.split('-').map(Number);
	return new Date(year, month - 1, date, 12).getTime();
}

/** Empty stats, as written on first access. */
export function defaultStats(): Stats {
	return { xp: 0, streakDays: 0, lastActiveDay: '', history: [] };
}

/**
 * Rebuilds whole `Stats` from per-day XP totals.
 *
 * `streakDays` is the run of consecutive active days ending at the most recent
 * one — the same rule `addXp` applies incrementally, stated as a fold instead
 * of a step. Days with no entry break the run; a zero-XP entry does not, since
 * banking zero XP still means the learner played.
 *
 * Input order does not matter; the returned `history` is sorted oldest-first.
 */
export function statsFromDays(days: { day: string; xp: number }[]): Stats {
	if (days.length === 0) return defaultStats();

	const history = [...days].sort((a, b) => a.day.localeCompare(b.day));
	const present = new Set(history.map((entry) => entry.day));
	const lastActiveDay = history[history.length - 1].day;

	let streakDays = 0;
	for (let day = lastActiveDay; present.has(day); day = previousDay(day)) streakDays++;

	return {
		xp: history.reduce((total, entry) => total + entry.xp, 0),
		streakDays,
		lastActiveDay,
		history
	};
}
