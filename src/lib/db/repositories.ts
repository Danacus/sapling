/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so callers never import LiveStore. The
 * 28 modules that import `$lib/db` did not change when the storage underneath
 * did, which is the whole reason this seam exists.
 *
 * ## Every write is an event
 *
 * There is no longer a "write the row, then also append the event" pair to
 * keep in agreement — the event *is* the write, and the tables are a
 * projection LiveStore maintains by replaying it (`$lib/livestore`). The
 * `capture()` helper this module used to carry, the `syncEnabled()` gate on
 * it, and the whole class of bug where a new write path forgot its event, are
 * gone with it.
 *
 * ## Nothing here stores a card
 *
 * `KnowledgeItem.fsrsCard` and `.history` are assembled on read: history is
 * the `reviews` table, and the card is `deriveCard` folding it through
 * `$lib/srs`. Callers still receive whole `KnowledgeItem`s and cannot tell.
 * What they get for free is that a card can no longer disagree with the
 * history it was supposed to be derived from, because it is never stored.
 *
 * ## Reads are synchronous underneath
 *
 * `store.query` is a synchronous SQLite read. These functions stay `async`
 * anyway: their callers are written around promises, and `await storeReady()`
 * is what makes "the store is up" someone else's problem. After boot it is an
 * already-resolved promise.
 */

import { deriveCard, serveStats, sortHistory } from '$lib/livestore/derive';
import { events, PROFILE_ID, tables } from '$lib/livestore/schema';
import { storeReady } from '$lib/livestore/store';
import { getDeviceId, newUuid, syncEnabled } from '$lib/sync/config';
import {
	EVENT_TYPES,
	type SyncEvent,
	type SyncEventType,
	type SyncPayloads
} from '$lib/sync/events';
import {
	emptyBookkeeping,
	type GenesisState,
	type SyncBookkeeping,
	type SyncSnapshot
} from '$lib/sync/snapshot';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Verdict } from '$lib/types';
import { challengeOf, db, SINGLETON_KEY } from './database';
import type { ChallengeRow, OutboxRow } from './database';
import { toPlain } from './plain';

export { activityByDay, localDay, previousDay, streakFrom } from './day';

/* -------------------------------------------------------------------------- */
/* Row assembly                                                                */
/* -------------------------------------------------------------------------- */

/** One `reviews` row, as much of it as the folds read. */
interface ReviewRow {
	itemId: string;
	at: number;
	grade: number;
	device: string;
}

/** One `items` row, before its history is attached. */
interface ItemRow {
	id: string;
	kind: string;
	term: string;
	meaning: string;
	romanization: string | null;
	notes: string | null;
	introducedAt: number;
}

/** Groups review rows by the item they belong to, each already in fold order. */
function historyByItem(reviews: readonly ReviewRow[]): Map<string, ReviewRow[]> {
	const byItem = new Map<string, ReviewRow[]>();
	for (const review of reviews) {
		const list = byItem.get(review.itemId);
		if (list) list.push(review);
		else byItem.set(review.itemId, [review]);
	}
	for (const [id, list] of byItem) byItem.set(id, sortHistory(list));
	return byItem;
}

/**
 * Reassembles the `KnowledgeItem` the rest of the app expects.
 *
 * SQLite has no "absent", so a nullable column comes back as `null` where the
 * domain type means "not set at all". Converting back here keeps `romanization`
 * genuinely optional for the Latin-script languages that never have one.
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
		fsrsCard: deriveCard(row.introducedAt, history),
		history: history.map(({ at, grade, device }) => ({ at, grade, device }))
	};
}

/** Reassembles a `ChallengeRow` — immutable content plus its serve bookkeeping. */
function challengeRowFrom(
	row: {
		id: string;
		content: unknown;
		generatedAt: number;
		topic: string | null;
		reported: boolean;
	},
	serves: readonly { at: number }[]
): ChallengeRow {
	const { timesServed, lastServedAt } = serveStats(serves);
	return {
		...(row.content as Challenge),
		generatedAt: row.generatedAt,
		timesServed,
		lastServedAt,
		reported: row.reported,
		...(row.topic === null ? {} : { topic: row.topic })
	};
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

/** Returns the stored profile, or `undefined` before onboarding completes. */
export async function getProfile(): Promise<Profile | undefined> {
	const store = await storeReady();
	const row = store.query(
		tables.profile.where({ id: PROFILE_ID }).first({ behaviour: 'fallback', fallback: () => null })
	);
	if (!row) return undefined;
	return {
		nativeLanguage: row.nativeLanguage,
		targetLanguage: row.targetLanguage,
		level: row.level as Profile['level'],
		interests: [...row.interests],
		...(row.about === null ? {} : { about: row.about }),
		model: row.model,
		createdAt: row.createdAt
	};
}

/** Creates or replaces the profile. */
export async function saveProfile(profile: Profile, _now: number = Date.now()): Promise<void> {
	const store = await storeReady();
	const plain = toPlain(profile);
	store.commit(
		events.profileUpdated({
			nativeLanguage: plain.nativeLanguage,
			targetLanguage: plain.targetLanguage,
			level: plain.level,
			interests: plain.interests,
			...(plain.about === undefined ? {} : { about: plain.about }),
			model: plain.model,
			createdAt: plain.createdAt
		})
	);
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                             */
/* -------------------------------------------------------------------------- */

/** Every knowledge item the learner has met so far. */
export async function getAllItems(): Promise<KnowledgeItem[]> {
	const store = await storeReady();
	const history = historyByItem(store.query(tables.reviews));
	return store.query(tables.items).map((row) => itemFrom(row, history.get(row.id) ?? []));
}

export async function getItem(id: string): Promise<KnowledgeItem | undefined> {
	const store = await storeReady();
	const row = store.query(
		tables.items.where({ id }).first({ behaviour: 'fallback', fallback: () => null })
	);
	if (!row) return undefined;
	return itemFrom(row, sortHistory(store.query(tables.reviews.where({ itemId: id }))));
}

/**
 * Inserts or replaces items by `id`.
 *
 * An id the table has never seen emits `item-added` (full content); a known one
 * emits `item-updated` (the mutable fields only). That distinction is what lets
 * another device tell "the learner met a new word" from "the learner edited a
 * note" — and it is now the *only* write, rather than a second write shadowing
 * a row put.
 *
 * Card and history on the passed items are deliberately ignored: both are
 * derived from the `reviews` table, so there is nothing here that could write
 * them. Reviews arrive through {@link updateItemAfterReview}.
 */
export async function upsertItems(
	items: KnowledgeItem[],
	_now: number = Date.now()
): Promise<void> {
	if (items.length === 0) return;
	const store = await storeReady();
	const plain = toPlain(items);
	const known = new Set(store.query(tables.items).map((row) => row.id));

	for (const item of plain) {
		if (known.has(item.id)) {
			store.commit(
				events.itemUpdated({
					itemId: item.id,
					fields: {
						term: item.term,
						meaning: item.meaning,
						...(item.romanization === undefined ? {} : { romanization: item.romanization }),
						...(item.notes === undefined ? {} : { notes: item.notes })
					}
				})
			);
		} else {
			store.commit(
				events.itemAdded({
					id: item.id,
					kind: item.kind,
					term: item.term,
					meaning: item.meaning,
					...(item.romanization === undefined ? {} : { romanization: item.romanization }),
					...(item.notes === undefined ? {} : { notes: item.notes }),
					introducedAt: item.introducedAt
				})
			);
		}
	}
}

/**
 * Forgets one word entirely — the item and its whole review history.
 *
 * Safe to call mid-session: pooled challenges keep pointing at the id, and
 * {@link updateItemAfterReview} skips items that are no longer there. The
 * learner sees the challenge play out, it just grades nothing.
 */
export async function deleteItem(id: string, _now: number = Date.now()): Promise<void> {
	const store = await storeReady();
	store.commit(events.itemDeleted({ itemId: id }));
}

/**
 * Folds a review into an item: appends one history entry.
 *
 * `nextCard` is **no longer consulted**. It survives in the signature because
 * every caller is written around it and because it still documents, at the call
 * site, what the review is supposed to do to the card — but the card is now
 * derived from the history this event appends, so computing one here and
 * storing it would be inventing a second source of truth for the thing the
 * migration set out to stop storing twice. `prior` is still returned, still
 * means "the card as it stood before this review", and is still what
 * `amendResult` rewinds to; it is derived rather than read.
 *
 * With `replaceLast`, the entry supersedes the newest one instead of being
 * appended — for a review being *recomputed* rather than added (the learner
 * re-graded the answer they just gave). Appending there would double-count the
 * review in `reps` and in `accuracyFromHistory`. An empty history has nothing
 * to replace, so it simply appends.
 *
 * `existed` is `false` when the item no longer exists.
 */
export async function updateItemAfterReview(
	id: string,
	_nextCard: (prior: unknown) => unknown,
	historyEntry: { at: number; grade: number },
	opts: { replaceLast?: boolean } = {}
): Promise<{ existed: boolean; prior: unknown }> {
	const store = await storeReady();
	const item = store.query(
		tables.items.where({ id }).first({ behaviour: 'fallback', fallback: () => null })
	);
	if (!item) return { existed: false, prior: null };

	const history = sortHistory(store.query(tables.reviews.where({ itemId: id })));
	const prior = deriveCard(item.introducedAt, history);
	const device = getDeviceId();
	const { at, grade } = toPlain(historyEntry);

	const replaced = opts.replaceLast ? history[history.length - 1] : undefined;
	if (replaced) {
		store.commit(
			events.reviewAmended({
				device,
				at,
				itemId: id,
				grade,
				replaces: replaced.at
			})
		);
	} else {
		store.commit(events.itemReviewed({ device, at, itemId: id, grade }));
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
	const store = await storeReady();
	const trimmed = topic?.trim();

	toPlain(challenges).forEach((challenge, index) => {
		store.commit(
			events.challengeAdded({
				challenge,
				generatedAt: now + index,
				...(trimmed ? { topic: trimmed } : {})
			})
		);
	});
}

/** Every challenge in the pool, with its serve bookkeeping attached. */
async function allPoolRows(): Promise<ChallengeRow[]> {
	const store = await storeReady();
	const byChallenge = new Map<string, { at: number }[]>();
	for (const serve of store.query(tables.serves)) {
		const list = byChallenge.get(serve.challengeId);
		if (list) list.push(serve);
		else byChallenge.set(serve.challengeId, [serve]);
	}
	return store
		.query(tables.challenges)
		.map((row) => challengeRowFrom(row, byChallenge.get(row.id) ?? []));
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
	return (await allPoolRows()).filter((row) => !row.reported);
}

/** The whole pool, reported rows included — what sync merges over. */
export async function getAllChallenges(): Promise<ChallengeRow[]> {
	return allPoolRows();
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
	const store = await storeReady();
	if (
		!store.query(
			tables.challenges.where({ id }).first({ behaviour: 'fallback', fallback: () => null })
		)
	)
		return;
	store.commit(events.challengeServed({ eventId: newUuid(), challengeId: id, at: now }));
}

/**
 * Flags a challenge the learner reported as broken. The row stays (results
 * point at it) but {@link getPool} never hands it out again.
 */
export async function reportChallenge(id: string, _now: number = Date.now()): Promise<void> {
	const store = await storeReady();
	store.commit(events.challengeReported({ challengeId: id }));
}

/**
 * Looks challenges up by id, reported and already-answered ones included —
 * nothing here ever deletes. Used to turn a result log entry back into the
 * words it exercised. Ids that no longer exist are simply absent.
 */
export async function getChallengesByIds(ids: string[]): Promise<Challenge[]> {
	if (ids.length === 0) return [];
	const store = await storeReady();
	const wanted = new Set(ids);
	return store
		.query(tables.challenges)
		.filter((row) => wanted.has(row.id))
		.map((row) => row.content as Challenge);
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

export async function addResult(result: ChallengeResult): Promise<void> {
	const store = await storeReady();
	const plain = toPlain(result);
	store.commit(
		events.resultLogged({
			eventId: newUuid(),
			challengeId: plain.challengeId,
			verdict: plain.verdict,
			answerGiven: plain.answerGiven,
			at: plain.at
		})
	);
}

/** One `results` row as the domain type, dropping the event id that keys it. */
function resultFrom(row: {
	challengeId: string;
	verdict: string;
	answerGiven: string;
	at: number;
}): ChallengeResult {
	return {
		challengeId: row.challengeId,
		verdict: row.verdict as Verdict,
		answerGiven: row.answerGiven,
		at: row.at
	};
}

/** The whole answer log, oldest first. Used by genesis; the UI wants {@link recentResults}. */
export async function getAllResults(): Promise<ChallengeResult[]> {
	const store = await storeReady();
	return store.query(tables.results.orderBy('at', 'asc')).map(resultFrom);
}

/** The most recent results, newest first. */
export async function recentResults(limit: number): Promise<ChallengeResult[]> {
	if (limit <= 0) return [];
	const store = await storeReady();
	return store.query(tables.results.orderBy('at', 'desc').limit(limit)).map(resultFrom);
}

/* -------------------------------------------------------------------------- */
/* Export / import                                                             */
/* -------------------------------------------------------------------------- */

/** Envelope version written by {@link exportData}. */
export const EXPORT_VERSION = 2;

/** Envelope versions {@link importData} still understands. */
const SUPPORTED_EXPORT_VERSIONS = [1, EXPORT_VERSION];

/** Shape of the JSON produced by {@link exportData}. */
export interface ExportEnvelope {
	version: number;
	exportedAt: number;
	profile: Profile | null;
	items: KnowledgeItem[];
}

/**
 * Serializes profile and items as JSON.
 *
 * Deliberately excludes the API key (it lives in `localStorage`) and the
 * challenge pool (regenerated content, not progress — and the pool's serve
 * bookkeeping means nothing on another device). Nothing in the envelope
 * mentions challenges, so the pool's row shape is free to change without
 * touching the export format.
 */
export async function exportData(): Promise<string> {
	const [profile, items] = await Promise.all([getProfile(), getAllItems()]);
	const envelope: ExportEnvelope = {
		version: EXPORT_VERSION,
		exportedAt: Date.now(),
		profile: profile ?? null,
		items
	};
	return JSON.stringify(envelope, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Restores a dump produced by {@link exportData}, replacing existing items.
 *
 * Throws on malformed input or an unsupported envelope version; the API key and
 * the challenge pool are untouched.
 *
 * "Replacing" is the awkward part in an append-only model, and it is done
 * honestly rather than by reaching under the log: every existing item is
 * deleted with a real `item-deleted`, and every imported one re-enters as an
 * `item-added` plus one `item-reviewed` per history entry. The restored card
 * therefore comes out of `deriveCard` replaying that history, which is the same
 * card the exporting device had — an import can no longer smuggle in a card
 * that disagrees with the reviews under it.
 */
export async function importData(json: string): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error('Import failed: the file is not valid JSON.');
	}

	if (!isRecord(parsed)) throw new Error('Import failed: unexpected file contents.');
	// A v1 envelope still restores: it carries a `stats` field that no longer
	// means anything, and everything else is unchanged, so it is simply ignored.
	if (typeof parsed.version !== 'number' || !SUPPORTED_EXPORT_VERSIONS.includes(parsed.version)) {
		throw new Error(`Import failed: unsupported export version ${String(parsed.version)}.`);
	}
	if (!Array.isArray(parsed.items)) throw new Error('Import failed: missing item list.');
	if (parsed.profile !== null && !isRecord(parsed.profile)) {
		throw new Error('Import failed: malformed profile.');
	}

	const envelope = toPlain(parsed as unknown as ExportEnvelope);
	const store = await storeReady();

	for (const row of store.query(tables.items)) {
		store.commit(events.itemDeleted({ itemId: row.id }));
	}

	for (const item of envelope.items) {
		store.commit(
			events.itemAdded({
				id: item.id,
				kind: item.kind,
				term: item.term,
				meaning: item.meaning,
				...(item.romanization === undefined ? {} : { romanization: item.romanization }),
				...(item.notes === undefined ? {} : { notes: item.notes }),
				introducedAt: item.introducedAt
			})
		);
		for (const entry of item.history ?? []) {
			store.commit(
				events.itemReviewed({
					device: entry.device ?? getDeviceId(),
					at: entry.at,
					itemId: item.id,
					grade: entry.grade
				})
			);
		}
	}

	if (envelope.profile) await saveProfile(envelope.profile);
}

/* -------------------------------------------------------------------------- */
/* Sync: outbox, state, and the non-capturing apply path                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything below still speaks Dexie, and still works, and is no longer
 * reached from the app.
 *
 * `src/lib/sync/` is the homebrew event-log sync LiveStore replaces, and it is
 * deliberately left standing until the new path has carried real data (step 5
 * of the migration). Its functions are kept compiling — and its Dexie tables
 * kept intact — because step 4 still has to read that database to migrate it.
 *
 * **It is, however, now disconnected from the app's actual state.** The three
 * routes that call `runSync` still do; that cycle now pushes an outbox nothing
 * fills and folds pulled events into Dexie tables nothing reads. It is inert
 * rather than wrong, with one sharp edge worth naming before step 4: a device
 * that still has sync configured will run genesis against the *Dexie* snapshot
 * and set `genesisDone`, which a migration must not mistake for "this data has
 * already been carried across". Wiring, or removing, is step 5's job.
 */

/** localStorage-style `syncState` keys, all in one place. */
const SYNC_STATE = {
	/** Server `seq` of the last event this device has pulled *and applied*. */
	cursor: 'cursor',
	/** Set once genesis synthesis has run; keeps it from ever running twice. */
	genesisDone: 'genesisDone',
	/** The apply engine's dedupe bookkeeping (`SyncBookkeeping`). */
	bookkeeping: 'bookkeeping',
	/** Epoch ms of the last sync that completed end to end. */
	lastSync: 'lastSync'
} as const;

/** Mints one event envelope. `at` is the write's own domain timestamp where it has one. */
function event<T extends SyncEventType>(type: T, payload: SyncPayloads[T], at: number): SyncEvent {
	return { id: newUuid(), device: getDeviceId(), at, type, payload };
}

/** Appends events to the legacy outbox. */
async function capture(pending: SyncEvent[]): Promise<void> {
	if (pending.length === 0) return;
	await db.outbox.bulkAdd(pending.map((e) => ({ event: toPlain(e) })));
}

/** Reads one `syncState` value, or `undefined` when unset. */
export async function getSyncState<T>(key: keyof typeof SYNC_STATE): Promise<T | undefined> {
	const row = await db.syncState.get(SYNC_STATE[key]);
	return row?.value as T | undefined;
}

/** Writes one `syncState` value. */
export async function setSyncState(key: keyof typeof SYNC_STATE, value: unknown): Promise<void> {
	await db.syncState.put({ key: SYNC_STATE[key], value: toPlain(value) });
}

/** How many locally produced events are waiting to be pushed. */
export async function outboxCount(): Promise<number> {
	return db.outbox.count();
}

/** The oldest `limit` outbox rows, in `seq` order — one push batch. */
export async function peekOutbox(limit: number): Promise<OutboxRow[]> {
	return db.outbox.orderBy('seq').limit(limit).toArray();
}

/** Deletes the rows a push has been acknowledged for. */
export async function drainOutbox(seqs: number[]): Promise<void> {
	if (seqs.length === 0) return;
	await db.outbox.bulkDelete(seqs);
}

/** Runs genesis synthesis (docs/sync.md §5) exactly once, over the Dexie tables. */
export async function seedOutbox(build: (state: GenesisState) => SyncEvent[]): Promise<number> {
	return db.transaction(
		'rw',
		[db.profile, db.items, db.challenges, db.results, db.outbox, db.syncState],
		async () => {
			if (await getSyncState<boolean>('genesisDone')) return 0;

			const profileRow = await db.profile.get(SINGLETON_KEY);
			const items = await db.items.toArray();
			const pool = await db.challenges.toArray();
			const results = (await db.results.orderBy('at').toArray()).map(
				({ seq: _seq, ...result }) => result
			);
			const profile = profileRow ? (({ id: _id, ...rest }) => rest)(profileRow) : null;

			const pending = build({ items, pool, results, profile });
			await capture(pending);
			await setSyncState('genesisDone', true);
			return pending.length;
		}
	);
}

/** The legacy apply path's write-back, still against Dexie. */
export async function mergeSyncSnapshot(
	fold: (before: SyncSnapshot) => SyncSnapshot
): Promise<void> {
	await db.transaction(
		'rw',
		[db.profile, db.items, db.challenges, db.results, db.syncState],
		async () => {
			const profileRow = await db.profile.get(SINGLETON_KEY);
			const before: SyncSnapshot = {
				items: await db.items.toArray(),
				pool: await db.challenges.toArray(),
				results: (await db.results.orderBy('at').toArray()).map(
					({ seq: _seq, ...result }) => result
				),
				profile: profileRow ? (({ id: _id, ...rest }) => rest)(profileRow) : null,
				bookkeeping: (await getSyncState<SyncBookkeeping>('bookkeeping')) ?? emptyBookkeeping()
			};

			const after = fold(before);

			const changedItems = diffById(before.items, after.items);
			if (changedItems.puts.length > 0) await db.items.bulkPut(changedItems.puts);
			if (changedItems.deletes.length > 0) await db.items.bulkDelete(changedItems.deletes);

			const changedPool = diffById(before.pool, after.pool);
			if (changedPool.puts.length > 0) await db.challenges.bulkPut(changedPool.puts);

			const known = new Set(before.results);
			const newResults = after.results.filter((result) => !known.has(result));
			if (newResults.length > 0) await db.results.bulkAdd(newResults);

			if (after.profile !== before.profile && after.profile) {
				await db.profile.put({ ...after.profile, id: SINGLETON_KEY });
			}
			await setSyncState('bookkeeping', after.bookkeeping);
		}
	);
}

/** Rows to write and ids to drop, by reference-identity comparison against `before`. */
function diffById<T extends { id: string }>(
	before: T[],
	after: T[]
): { puts: T[]; deletes: string[] } {
	const previous = new Map(before.map((row) => [row.id, row]));
	const puts = after.filter((row) => previous.get(row.id) !== row);
	const kept = new Set(after.map((row) => row.id));
	const deletes = before.filter((row) => !kept.has(row.id)).map((row) => row.id);
	return { puts, deletes };
}

/* Kept for the legacy sync module's imports. */
export { challengeOf, syncEnabled, EVENT_TYPES };
