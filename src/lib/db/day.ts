/**
 * Calendar-day arithmetic over the answer log.
 *
 * Pure: no Dexie, no clock, nothing but the timestamps it is handed. The streak
 * is *derived* rather than bookkept — every answered challenge is already
 * persisted as a `ChallengeResult` with an `at`, and results sync between
 * devices as a set-union, so a streak folded out of them is automatically
 * consistent everywhere without a counter to merge.
 */

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
 * How many answers landed on each local calendar day, oldest day first.
 *
 * Input order does not matter; days with no answers are simply absent.
 */
export function activityByDay(results: { at: number }[]): { day: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const result of results) {
		const day = localDay(result.at);
		counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([day, count]) => ({ day, count }))
		.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The run of consecutive calendar days ending at the most recent active one.
 *
 * A skipped day breaks the run; today does **not** have to be active for the
 * streak to stand — a learner who played yesterday and has not played yet today
 * still has their streak, and loses it only once a whole day passes unplayed.
 */
export function streakFrom(days: string[]): number {
	if (days.length === 0) return 0;

	const present = new Set(days);
	const lastActiveDay = [...present].sort((a, b) => a.localeCompare(b)).pop() as string;

	let streak = 0;
	for (let day = lastActiveDay; present.has(day); day = previousDay(day)) streak++;
	return streak;
}
