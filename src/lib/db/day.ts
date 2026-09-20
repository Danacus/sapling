/**
 * Calendar-day arithmetic over the answer log.
 *
 * Pure: no database access, no clock, nothing but the timestamps it is handed. The streak
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
 * The run of active days ending at the most recent one, with a little grace.
 *
 * Up to two inactive days may sit between active days without breaking the
 * chain. Grace days do not increase the count: the streak remains a count of
 * days on which the learner showed up. Today does **not** have to be active;
 * this pure fold has no clock and ends at the newest activity it is given.
 */
export function streakFrom(days: string[]): number {
	if (days.length === 0) return 0;

	const present = new Set(days);
	const lastActiveDay = [...present].sort((a, b) => a.localeCompare(b)).pop() as string;

	let streak = 1;
	let missed = 0;
	for (let day = previousDay(lastActiveDay); missed <= 2; day = previousDay(day)) {
		if (present.has(day)) {
			streak++;
			missed = 0;
		} else {
			missed++;
		}
	}
	return streak;
}
