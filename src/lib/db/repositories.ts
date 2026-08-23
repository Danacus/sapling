/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so callers never import Dexie. Keep the
 * functions thin — they are not unit-tested (IndexedDB is unavailable in the
 * node test environment), so all the logic worth testing lives elsewhere.
 */

import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Stats } from '$lib/types';
import { db, SINGLETON_KEY } from './database';
import type { ChallengeRow } from './database';
import { toPlain } from './plain';

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

/** Returns the stored profile, or `undefined` before onboarding completes. */
export async function getProfile(): Promise<Profile | undefined> {
	const row = await db.profile.get(SINGLETON_KEY);
	if (!row) return undefined;
	const { id: _id, ...profile } = row;
	return profile;
}

/** Creates or replaces the profile. */
export async function saveProfile(profile: Profile): Promise<void> {
	const plain = toPlain(profile);
	await db.profile.put({ ...plain, id: SINGLETON_KEY });
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                             */
/* -------------------------------------------------------------------------- */

/** Every knowledge item the learner has met so far. */
export async function getAllItems(): Promise<KnowledgeItem[]> {
	return db.items.toArray();
}

export async function getItem(id: string): Promise<KnowledgeItem | undefined> {
	return db.items.get(id);
}

/** Inserts or replaces items by `id`. */
export async function upsertItems(items: KnowledgeItem[]): Promise<void> {
	if (items.length === 0) return;
	await db.items.bulkPut(toPlain(items));
}

/**
 * Forgets one word entirely.
 *
 * Safe to call mid-session: pooled challenges keep pointing at the id, and
 * {@link updateItemAfterReview} — via `applyResult` — skips items that are no
 * longer there. The learner sees the challenge play out, it just grades nothing.
 */
export async function deleteItem(id: string): Promise<void> {
	await db.items.delete(id);
}

/**
 * Writes back the FSRS card produced by a review and appends one history entry.
 *
 * With `replaceLast`, the entry overwrites the newest one instead of being
 * appended — for a review that is being *recomputed* rather than added (the
 * learner re-graded the answer they just gave; see `amendResult`). Appending
 * there would double-count the review in `reps` and in `accuracyFromHistory`.
 * An empty history has nothing to replace, so it simply appends.
 *
 * Resolves to `false` when the item no longer exists.
 */
export async function updateItemAfterReview(
	id: string,
	fsrsCard: unknown,
	historyEntry: { at: number; grade: number },
	opts: { replaceLast?: boolean } = {}
): Promise<boolean> {
	const plainCard = toPlain(fsrsCard);
	const plainEntry = toPlain(historyEntry);
	return db.transaction('rw', db.items, async () => {
		const item = await db.items.get(id);
		if (!item) return false;
		const history =
			opts.replaceLast && item.history.length > 0
				? [...item.history.slice(0, -1), plainEntry]
				: [...item.history, plainEntry];
		await db.items.put({ ...item, fsrsCard: plainCard, history });
		return true;
	});
}

/* -------------------------------------------------------------------------- */
/* Challenge pool                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Adds a freshly generated batch to the pool.
 *
 * `generatedAt` is offset by the index so a batch keeps the order it was
 * written in even when every row lands in the same millisecond — the planner's
 * "newest first" freshness fill leans on that ordering being total.
 */
export async function addToPool(
	challenges: Challenge[],
	now: number = Date.now(),
	topic?: string
): Promise<void> {
	if (challenges.length === 0) return;
	const trimmed = topic?.trim();
	const rows: ChallengeRow[] = toPlain(challenges).map((challenge, index) => ({
		...challenge,
		generatedAt: now + index,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...(trimmed ? { topic: trimmed } : {})
	}));
	await db.challenges.bulkPut(rows);
}

/**
 * Every challenge the learner could still be shown, in no particular order.
 *
 * Reported rows are dropped here rather than at the planner, so "flagged" means
 * gone everywhere at once. Everything else — eligibility, recycling gaps,
 * ordering — is `planSession`'s business, working in memory over this array:
 * one learner's pool is a few hundred rows, which is not worth an index.
 */
export async function getPool(): Promise<ChallengeRow[]> {
	const rows = await db.challenges.toArray();
	return rows.filter((row) => !row.reported);
}

/**
 * Stamps a challenge as served: one more play, at `now`.
 *
 * Called when an answer is *committed*, not when a challenge is planned, which
 * is what makes an early quit self-cleaning — challenges the learner never
 * reached were never stamped, so they simply come back next session.
 *
 * A missing id is a no-op: locally built match-pairs rounds are never pooled,
 * so `applyResult` can call this unconditionally.
 */
export async function recordServe(id: string, now: number = Date.now()): Promise<void> {
	await db.transaction('rw', db.challenges, async () => {
		const row = await db.challenges.get(id);
		if (!row) return;
		await db.challenges.put({ ...row, timesServed: row.timesServed + 1, lastServedAt: now });
	});
}

/**
 * Flags a challenge the learner reported as broken. The row stays (results
 * point at it) but {@link getPool} never hands it out again.
 */
export async function reportChallenge(id: string): Promise<void> {
	await db.challenges.update(id, { reported: true });
}

/**
 * Looks challenges up by id, reported and already-answered ones included —
 * nothing here ever deletes. Used to turn a result log entry back into the
 * words it exercised. Ids that no longer exist are simply absent.
 */
export async function getChallengesByIds(ids: string[]): Promise<Challenge[]> {
	if (ids.length === 0) return [];
	const rows = await db.challenges.bulkGet(ids);
	return rows.filter((row): row is ChallengeRow => row !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export async function addResult(result: ChallengeResult): Promise<void> {
	await db.results.add(toPlain(result));
}

/** The most recent results, newest first. */
export async function recentResults(limit: number): Promise<ChallengeResult[]> {
	if (limit <= 0) return [];
	const rows = await db.results.orderBy('at').reverse().limit(limit).toArray();
	return rows.map(({ seq: _seq, ...result }) => result);
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                       */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` for an epoch-milliseconds timestamp, in the local time zone. */
export function localDay(at: number): string {
	const date = new Date(at);
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/** The local calendar day before `day` (DST-safe: built from local parts). */
function previousDay(day: string): string {
	const [year, month, date] = day.split('-').map(Number);
	return localDay(new Date(year, month - 1, date - 1).getTime());
}

function defaultStats(): Stats {
	return { xp: 0, streakDays: 0, lastActiveDay: '', history: [] };
}

/** Returns the stats row, creating the default one on first access. */
export async function getStats(): Promise<Stats> {
	return db.transaction('rw', db.stats, async () => {
		const row = await db.stats.get(SINGLETON_KEY);
		if (row) {
			const { id: _id, ...stats } = row;
			return stats;
		}
		const stats = defaultStats();
		await db.stats.put({ ...stats, id: SINGLETON_KEY });
		return stats;
	});
}

/**
 * Adds XP earned at `now`, updates today's history bucket and rolls the streak.
 *
 * The streak increments when the last active day was yesterday, is left alone
 * when it was today, and restarts at 1 after any longer gap.
 */
export async function addXp(amount: number, now: number): Promise<Stats> {
	const day = localDay(now);

	return db.transaction('rw', db.stats, async () => {
		const row = await db.stats.get(SINGLETON_KEY);
		const current = row ? { ...row } : { ...defaultStats(), id: SINGLETON_KEY };

		let streakDays: number;
		if (current.lastActiveDay === day) streakDays = Math.max(current.streakDays, 1);
		else if (current.lastActiveDay === previousDay(day)) streakDays = current.streakDays + 1;
		else streakDays = 1;

		const history = [...current.history];
		const today = history.find((entry) => entry.day === day);
		if (today) today.xp += amount;
		else history.push({ day, xp: amount });

		const next: Stats = {
			xp: current.xp + amount,
			streakDays,
			lastActiveDay: day,
			history
		};
		await db.stats.put({ ...next, id: SINGLETON_KEY });
		return next;
	});
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                             */
/* -------------------------------------------------------------------------- */

/** Envelope version written by {@link exportData}. */
export const EXPORT_VERSION = 1;

/** Shape of the JSON produced by {@link exportData}. */
export interface ExportEnvelope {
	version: number;
	exportedAt: number;
	profile: Profile | null;
	items: KnowledgeItem[];
	stats: Stats;
}

/**
 * Serializes profile, items and stats as JSON.
 *
 * Deliberately excludes the API key (it lives in `localStorage`) and the
 * challenge pool (regenerated content, not progress — and the pool's serve
 * bookkeeping means nothing on another device). Nothing in the envelope
 * mentions challenges, so the pool's row shape is free to change without
 * touching the export format.
 */
export async function exportData(): Promise<string> {
	const [profile, items, stats] = await Promise.all([getProfile(), getAllItems(), getStats()]);
	const envelope: ExportEnvelope = {
		version: EXPORT_VERSION,
		exportedAt: Date.now(),
		profile: profile ?? null,
		items,
		stats
	};
	return JSON.stringify(envelope, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Restores a dump produced by {@link exportData}, replacing existing data.
 *
 * Throws on malformed input or an unsupported envelope version; the API key and
 * the challenge pool are untouched.
 */
export async function importData(json: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('Import failed: the file is not valid JSON.');
	}

	if (!isRecord(parsed)) throw new Error('Import failed: unexpected file contents.');
	if (parsed.version !== EXPORT_VERSION) {
		throw new Error(`Import failed: unsupported export version ${String(parsed.version)}.`);
	}
	if (!Array.isArray(parsed.items)) throw new Error('Import failed: missing item list.');
	if (parsed.profile !== null && !isRecord(parsed.profile)) {
		throw new Error('Import failed: malformed profile.');
	}
	if (!isRecord(parsed.stats)) throw new Error('Import failed: malformed stats.');

	const envelope = toPlain(parsed as unknown as ExportEnvelope);

	await db.transaction('rw', db.profile, db.items, db.stats, async () => {
		await db.items.clear();
		if (envelope.items.length > 0) await db.items.bulkPut(envelope.items);

		if (envelope.profile) await db.profile.put({ ...envelope.profile, id: SINGLETON_KEY });
		else await db.profile.delete(SINGLETON_KEY);

		await db.stats.put({ ...envelope.stats, id: SINGLETON_KEY });
	});
}
