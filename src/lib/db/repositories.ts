/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so the 28 modules that import `$lib/db`
 * did not change when the storage underneath did, which is the whole reason
 * this seam exists.
 *
 * ## Every write is an event
 *
 * There is no "write the row, then also append the event" pair to keep in
 * agreement — the event *is* the write, and the read tables are what
 * `materialize.ts` makes of the log. Reads never touch `events`.
 *
 * ## Bulk reads are aggregates; the history is per-item
 *
 * `fsrsCard`, `reviewCount`, `correctCount` and `recentGrades` are columns,
 * folded forward one review at a time by the materializer, so {@link getAllItems}
 * costs a single `SELECT` and never scans `reviews`. The rows are still there —
 * they are what lets one item be refolded exactly when a review arrives out of
 * order, and {@link getItem} attaches them for the one word being looked at.
 */

import { getDeviceId } from '$lib/device';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Verdict } from '$lib/types';
import { challengeOf } from './database';
import type { ChallengeRow } from './database';
import { parseEvent, type SyncEvent } from './events';
import { LOG_ORDER } from './materialize';
import { toPlain } from './plain';
import { DERIVED_TABLES, PROFILE_ID } from './schema';
import { ready, type Fact } from './store';

export { activityByDay, localDay, previousDay, streakFrom } from './day';

/* -------------------------------------------------------------------------- */
/* Row assembly                                                                */
/* -------------------------------------------------------------------------- */

interface ReviewRow {
	itemId: string;
	at: number;
	grade: number;
	device: string;
}

interface ItemRow {
	id: string;
	kind: string;
	term: string;
	meaning: string;
	romanization: string | null;
	notes: string | null;
	introducedAt: number;
	fsrsCard: string;
	reviewCount: number;
	correctCount: number;
	recentGrades: string;
}

interface ChallengeSqlRow {
	id: string;
	content: string;
	generatedAt: number;
	topic: string | null;
	reported: number;
	timesServed: number;
	lastServedAt: number | null;
}

interface ResultSqlRow {
	challengeId: string;
	verdict: string;
	answerGiven: string;
	at: number;
}

/**
 * Reassembles the `KnowledgeItem` the rest of the app expects.
 *
 * SQLite has no "absent", so a nullable column comes back as `null` where the
 * domain type means "not set at all". Converting back here keeps `romanization`
 * genuinely optional for the Latin-script languages that never have one.
 *
 * The aggregates always come; `history` only when the caller asked for one item.
 */
function itemFrom(row: ItemRow, history: readonly ReviewRow[]): KnowledgeItem {
	return {
		id: row.id,
		kind: row.kind as KnowledgeItem['kind'],
		term: row.term,
		meaning: row.meaning,
		...(row.romanization === null ? {} : { romanization: row.romanization }),
		...(row.notes === null ? {} : { notes: row.notes }),
		introducedAt: row.introducedAt,
		fsrsCard: JSON.parse(row.fsrsCard) as unknown,
		reviewCount: row.reviewCount,
		correctCount: row.correctCount,
		recentGrades: JSON.parse(row.recentGrades) as { at: number; grade: number }[],
		history: history.map(({ at, grade, device }) => ({ at, grade, device }))
	};
}

function challengeRowFrom(row: ChallengeSqlRow): ChallengeRow {
	return {
		...(JSON.parse(row.content) as Challenge),
		generatedAt: row.generatedAt,
		timesServed: row.timesServed,
		lastServedAt: row.lastServedAt,
		reported: row.reported === 1,
		...(row.topic === null ? {} : { topic: row.topic })
	};
}

function resultFrom(row: ResultSqlRow): ChallengeResult {
	return {
		challengeId: row.challengeId,
		verdict: row.verdict as Verdict,
		answerGiven: row.answerGiven,
		at: row.at
	};
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

interface ProfileSqlRow {
	nativeLanguage: string;
	targetLanguage: string;
	level: string;
	interests: string;
	about: string | null;
	model: string;
	createdAt: number;
}

/** Returns the stored profile, or `undefined` before onboarding completes. */
export async function getProfile(): Promise<Profile | undefined> {
	const store = await ready();
	const row = (
		await store.query<ProfileSqlRow>('SELECT * FROM profile WHERE id = ?', [PROFILE_ID])
	)[0];
	if (!row) return undefined;
	return {
		nativeLanguage: row.nativeLanguage,
		targetLanguage: row.targetLanguage,
		level: row.level as Profile['level'],
		interests: JSON.parse(row.interests) as string[],
		...(row.about === null ? {} : { about: row.about }),
		model: row.model,
		createdAt: row.createdAt
	};
}

/** Creates or replaces the profile. */
export async function saveProfile(profile: Profile, _now: number = Date.now()): Promise<void> {
	const store = await ready();
	const plain = toPlain(profile);
	await store.commit('profileUpdated', {
		nativeLanguage: plain.nativeLanguage,
		targetLanguage: plain.targetLanguage,
		level: plain.level,
		interests: plain.interests,
		...(plain.about === undefined ? {} : { about: plain.about }),
		model: plain.model,
		createdAt: plain.createdAt
	});
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every knowledge item the learner has met so far, with an **empty** `history`.
 *
 * This is the hot read — 29 call sites, session start included — so it costs one
 * `SELECT` over `items` and never touches `reviews`. Everything a bulk reader
 * wants from the history is already a column: `reviewCount`, `correctCount` and
 * `recentGrades`. A caller that genuinely needs the entries reads {@link getItem}.
 */
export async function getAllItems(): Promise<KnowledgeItem[]> {
	const store = await ready();
	const rows = await store.query<ItemRow>('SELECT * FROM items');
	return rows.map((row) => itemFrom(row, []));
}

/** One item, with its whole review history attached. */
export async function getItem(id: string): Promise<KnowledgeItem | undefined> {
	const store = await ready();
	const row = (await store.query<ItemRow>('SELECT * FROM items WHERE id = ?', [id]))[0];
	if (!row) return undefined;
	const history = await store.query<ReviewRow>(
		'SELECT itemId, at, grade, device FROM reviews WHERE itemId = ? ORDER BY at, device',
		[id]
	);
	return itemFrom(row, history);
}

/**
 * Inserts or replaces items by `id`.
 *
 * An id the table has never seen emits `itemAdded` (full content); a known one
 * emits `itemUpdated` (the mutable fields only). That distinction is what lets
 * another device tell "the learner met a new word" from "the learner edited a
 * note".
 *
 * Card and history on the passed items are deliberately ignored: reviews arrive
 * through {@link updateItemAfterReview} and the card follows from them.
 */
export async function upsertItems(
	items: KnowledgeItem[],
	_now: number = Date.now()
): Promise<void> {
	if (items.length === 0) return;
	const store = await ready();
	const plain = toPlain(items);
	const known = new Set(
		(await store.query<{ id: string }>('SELECT id FROM items')).map((r) => r.id)
	);

	await store.commitAll(
		plain.map((item): Fact =>
			known.has(item.id)
				? {
						type: 'itemUpdated',
						payload: {
							itemId: item.id,
							fields: {
								term: item.term,
								meaning: item.meaning,
								...(item.romanization === undefined ? {} : { romanization: item.romanization }),
								...(item.notes === undefined ? {} : { notes: item.notes })
							}
						}
					}
				: {
						type: 'itemAdded',
						payload: {
							id: item.id,
							kind: item.kind,
							term: item.term,
							meaning: item.meaning,
							...(item.romanization === undefined ? {} : { romanization: item.romanization }),
							...(item.notes === undefined ? {} : { notes: item.notes }),
							introducedAt: item.introducedAt
						}
					}
		)
	);
}

/**
 * Forgets one word entirely — the item and its whole review history.
 *
 * Safe to call mid-session: pooled challenges keep pointing at the id, and
 * {@link updateItemAfterReview} skips items that are no longer there. The
 * learner sees the challenge play out, it just grades nothing.
 */
export async function deleteItem(id: string, _now: number = Date.now()): Promise<void> {
	const store = await ready();
	await store.commit('itemDeleted', { itemId: id });
}

/**
 * Folds a review into an item: appends one history entry.
 *
 * `nextCard` is **not consulted**. It survives in the signature because every
 * caller is written around it and because it documents, at the call site, what
 * the review is supposed to do to the card — but the card the materializer
 * folds is the one source of truth. `prior` is the card as it stood before this
 * review, read straight off the row, and is what `amendResult` rewinds to.
 *
 * With `replaceLast`, the entry supersedes the newest one instead of being
 * appended — for a review being *recomputed* rather than added (the learner
 * re-graded the answer they just gave). Appending there would double-count the
 * review. An empty history has nothing to replace, so it simply appends.
 *
 * `existed` is `false` when the item no longer exists.
 */
export async function updateItemAfterReview(
	id: string,
	_nextCard: (prior: unknown) => unknown,
	historyEntry: { at: number; grade: number },
	opts: { replaceLast?: boolean } = {}
): Promise<{ existed: boolean; prior: unknown }> {
	const store = await ready();
	const row = (
		await store.query<{ fsrsCard: string }>('SELECT fsrsCard FROM items WHERE id = ?', [id])
	)[0];
	if (!row) return { existed: false, prior: null };

	const prior = JSON.parse(row.fsrsCard) as unknown;
	const device = getDeviceId();
	const { at, grade } = toPlain(historyEntry);

	const replaced = opts.replaceLast
		? (
				await store.query<{ at: number }>(
					'SELECT at FROM reviews WHERE itemId = ? ORDER BY at DESC, device DESC LIMIT 1',
					[id]
				)
			)[0]
		: undefined;

	if (replaced) {
		await store.commit('reviewAmended', {
			device,
			at,
			itemId: id,
			grade,
			replaces: replaced.at
		});
	} else {
		await store.commit('itemReviewed', { device, at, itemId: id, grade });
	}

	return { existed: true, prior };
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
	const store = await ready();
	const trimmed = topic?.trim();

	await store.commitAll(
		toPlain(challenges).map((challenge, index): Fact => ({
			type: 'challengeAdded',
			payload: {
				challenge,
				generatedAt: now + index,
				...(trimmed ? { topic: trimmed } : {})
			}
		}))
	);
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
	const store = await ready();
	const rows = await store.query<ChallengeSqlRow>('SELECT * FROM challenges WHERE reported = 0');
	return rows.map(challengeRowFrom);
}

/** The whole pool, reported rows included — what sync merges over. */
export async function getAllChallenges(): Promise<ChallengeRow[]> {
	const store = await ready();
	return (await store.query<ChallengeSqlRow>('SELECT * FROM challenges')).map(challengeRowFrom);
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
	const store = await ready();
	const known = await store.query('SELECT 1 FROM challenges WHERE id = ?', [id]);
	if (known.length === 0) return;
	await store.commit('challengeServed', { challengeId: id, at: now });
}

/**
 * Flags a challenge the learner reported as broken. The row stays (results
 * point at it) but {@link getPool} never hands it out again.
 */
export async function reportChallenge(id: string, _now: number = Date.now()): Promise<void> {
	const store = await ready();
	await store.commit('challengeReported', { challengeId: id });
}

/**
 * Looks challenges up by id, reported and already-answered ones included —
 * nothing here ever deletes. Used to turn a result log entry back into the
 * words it exercised. Ids that no longer exist are simply absent.
 */
export async function getChallengesByIds(ids: string[]): Promise<Challenge[]> {
	if (ids.length === 0) return [];
	const store = await ready();
	const placeholders = ids.map(() => '?').join(', ');
	const rows = await store.query<{ content: string }>(
		`SELECT content FROM challenges WHERE id IN (${placeholders})`,
		ids
	);
	return rows.map((row) => JSON.parse(row.content) as Challenge);
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export async function addResult(result: ChallengeResult): Promise<void> {
	const store = await ready();
	const plain = toPlain(result);
	await store.commit('resultLogged', {
		challengeId: plain.challengeId,
		verdict: plain.verdict,
		answerGiven: plain.answerGiven,
		at: plain.at
	});
}

/** The whole answer log, oldest first. Used by genesis; the UI wants {@link recentResults}. */
export async function getAllResults(): Promise<ChallengeResult[]> {
	const store = await ready();
	return (await store.query<ResultSqlRow>('SELECT * FROM results ORDER BY at ASC')).map(resultFrom);
}

/** The most recent results, newest first. */
export async function recentResults(limit: number): Promise<ChallengeResult[]> {
	if (limit <= 0) return [];
	const store = await ready();
	return (
		await store.query<ResultSqlRow>('SELECT * FROM results ORDER BY at DESC LIMIT ?', [limit])
	).map(resultFrom);
}

/**
 * How many answers landed on each local calendar day, oldest day first.
 *
 * The materializer counts them as results arrive, so the streak and the
 * activity graph cost one small table read instead of the whole answer log.
 */
export async function getDailyActivity(): Promise<{ day: string; count: number }[]> {
	const store = await ready();
	return store.query<{ day: string; count: number }>(
		'SELECT day, count FROM daily ORDER BY day ASC'
	);
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                             */
/* -------------------------------------------------------------------------- */

/** Empties the whole database, log included — Settings' "reset my progress". */
export async function resetData(): Promise<void> {
	const store = await ready();
	await store.batch(
		[...DERIVED_TABLES, 'events', 'meta'].map((table) => ({ sql: `DELETE FROM ${table}` }))
	);
}

/** Envelope version written by {@link exportData}. */
export const EXPORT_VERSION = 3;

/** Envelope versions {@link importData} still restores from. */
const LEGACY_IMPORT_VERSIONS = [1, 2];

/** Shape of the JSON produced by {@link exportData}. */
export interface ExportEnvelope {
	version: number;
	exportedAt: number;
	events: SyncEvent[];
}

interface EventSqlRow {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: string;
}

/**
 * Serializes the whole log as JSON. The log *is* the data, so the file is
 * complete — pool, serves and results included. Excludes only the API key,
 * which lives in `localStorage`.
 *
 * Written in `LOG_ORDER`, so the file carries the causal order that produced it
 * and an importing device replays it the same way.
 */
export async function exportData(): Promise<string> {
	const store = await ready();
	const rows = await store.query<EventSqlRow>(
		`SELECT id, type, at, device, payload FROM events ORDER BY ${LOG_ORDER}`
	);
	const envelope: ExportEnvelope = {
		version: EXPORT_VERSION,
		exportedAt: Date.now(),
		events: rows.map((row) => ({
			id: row.id,
			type: row.type as SyncEvent['type'],
			at: row.at,
			device: row.device,
			payload: JSON.parse(row.payload) as unknown
		}))
	};
	return JSON.stringify(envelope, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Shape of the v1/v2 envelopes {@link importData} still restores from. */
interface LegacyExportEnvelope {
	version: number;
	exportedAt: number;
	profile: Profile | null;
	items: KnowledgeItem[];
}

/** v1/v2: replaces the item list wholesale, as those envelopes meant. */
async function importLegacy(parsed: Record<string, unknown>): Promise<void> {
	if (!Array.isArray(parsed.items)) throw new Error('Import failed: missing item list.');
	if (parsed.profile !== null && !isRecord(parsed.profile)) {
		throw new Error('Import failed: malformed profile.');
	}

	const envelope = toPlain(parsed as unknown as LegacyExportEnvelope);
	const store = await ready();
	const device = getDeviceId();
	const facts: Fact[] = [];

	for (const row of await store.query<{ id: string }>('SELECT id FROM items')) {
		facts.push({ type: 'itemDeleted', payload: { itemId: row.id } });
	}

	for (const item of envelope.items) {
		facts.push({
			type: 'itemAdded',
			payload: {
				id: item.id,
				kind: item.kind,
				term: item.term,
				meaning: item.meaning,
				...(item.romanization === undefined ? {} : { romanization: item.romanization }),
				...(item.notes === undefined ? {} : { notes: item.notes }),
				introducedAt: item.introducedAt
			}
		});
		for (const entry of item.history ?? []) {
			facts.push({
				type: 'itemReviewed',
				payload: {
					device: entry.device ?? device,
					at: entry.at,
					itemId: item.id,
					grade: entry.grade
				}
			});
		}
	}

	await store.commitAll(facts);
	if (envelope.profile) await saveProfile(envelope.profile);
}

/**
 * Restores a dump.
 *
 * A v3 file is the log itself: its events are unioned in by id — anything
 * already present is skipped — and the read model is rebuilt from the result.
 * That makes an import idempotent and order-free, so re-importing an old file
 * cannot resurrect a word deleted since or revert a profile edited since; the
 * tombstone and the newer `at` both outrank it.
 *
 * A v1/v2 file predates the log and replaces the item list wholesale, which is
 * what those envelopes meant.
 */
export async function importData(json: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('Import failed: the file is not valid JSON.');
	}

	if (!isRecord(parsed)) throw new Error('Import failed: unexpected file contents.');

	if (parsed.version === EXPORT_VERSION) {
		if (!Array.isArray(parsed.events)) throw new Error('Import failed: missing event list.');
		const events = parsed.events
			.map((raw) => parseEvent(raw))
			.filter((event): event is SyncEvent => event !== undefined);
		const store = await ready();
		await store.importEvents(events);
		return;
	}

	// A v1 envelope still restores: it carries a `stats` field that no longer
	// means anything, and everything else is unchanged, so it is simply ignored.
	if (typeof parsed.version !== 'number' || !LEGACY_IMPORT_VERSIONS.includes(parsed.version)) {
		throw new Error(`Import failed: unsupported export version ${String(parsed.version)}.`);
	}
	await importLegacy(parsed);
}

export { challengeOf };
