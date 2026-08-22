/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so callers never import Dexie. Keep the
 * functions thin — they are not unit-tested (IndexedDB is unavailable in the
 * node test environment), so all the logic worth testing lives elsewhere.
 */

import Dexie from 'dexie';

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
 * Writes back the FSRS card produced by a review and appends one history entry.
 *
 * Resolves to `false` when the item no longer exists.
 */
export async function updateItemAfterReview(
	id: string,
	fsrsCard: unknown,
	historyEntry: { at: number; grade: number }
): Promise<boolean> {
	const plainCard = toPlain(fsrsCard);
	const plainEntry = toPlain(historyEntry);
	return db.transaction('rw', db.items, async () => {
		const item = await db.items.get(id);
		if (!item) return false;
		await db.items.put({
			...item,
			fsrsCard: plainCard,
			history: [...item.history, plainEntry]
		});
		return true;
	});
}

/* -------------------------------------------------------------------------- */
/* Challenge queue                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Appends generated challenges to the queue.
 *
 * `enqueuedAt` is offset by the index so a batch keeps the order it was
 * generated in even when the whole batch is written in the same millisecond.
 */
export async function enqueueChallenges(challenges: Challenge[]): Promise<void> {
	if (challenges.length === 0) return;
	const now = Date.now();
	const rows: ChallengeRow[] = toPlain(challenges).map((challenge, index) => ({
		...challenge,
		status: 'queued',
		enqueuedAt: now + index
	}));
	await db.challenges.bulkPut(rows);
}

/**
 * The oldest queued challenge, or `undefined` when the queue is empty.
 *
 * Peeking only: the challenge stays queued until {@link markChallengeDone}.
 */
export async function takeNextChallenge(): Promise<Challenge | undefined> {
	return db.challenges
		.where('[status+enqueuedAt]')
		.between(['queued', Dexie.minKey], ['queued', Dexie.maxKey])
		.first();
}

/** Marks a challenge as answered so it leaves the queue. */
export async function markChallengeDone(id: string): Promise<void> {
	await db.challenges.update(id, { status: 'done' });
}

/** How many challenges are still waiting to be answered. */
export async function queuedCount(): Promise<number> {
	return db.challenges.where('status').equals('queued').count();
}

/** Drops every still-queued challenge (answered ones are kept). */
export async function clearQueue(): Promise<void> {
	await db.challenges.where('status').equals('queued').delete();
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
 * challenge queue (regenerated content, not progress).
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
 * the challenge queue are untouched.
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
