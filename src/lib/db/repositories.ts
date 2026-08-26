/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so callers never import Dexie. Keep the
 * functions thin — they are not unit-tested (IndexedDB is unavailable in the
 * node test environment), so all the logic worth testing lives elsewhere.
 *
 * ## Sync capture (docs/sync.md §9)
 *
 * Every mutating function below also appends the matching `SyncEvent` to the
 * `outbox` table **inside its own transaction**, so the materialized view and
 * the event log can never disagree — a write either lands with its event or not
 * at all. Capture is gated on {@link syncEnabled}: it is opt-in and starts when
 * sync is configured, because genesis synthesis has to exist anyway and an
 * always-on outbox would grow forever on devices that never sync.
 *
 * **Nothing on the apply path goes through these functions**, which is how
 * pulled events can never echo back into the outbox. Remote state is written by
 * {@link mergeSyncSnapshot} alone — one whole-snapshot write that captures
 * nothing by construction. That is deliberately *not* a `{capture: false}` flag
 * on each function: a flag is something a future call site can forget to pass,
 * and a merged snapshot is anyway not expressible as a sequence of
 * `upsertItems`/`updateItemAfterReview` calls (the engine rewrites history
 * entries and re-folds cards wholesale).
 */

import type { Challenge, ChallengeResult, KnowledgeItem, Profile } from '$lib/types';
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
import { challengeOf, db, SINGLETON_KEY } from './database';
import type { ChallengeRow, OutboxRow } from './database';
import { toPlain } from './plain';

export { activityByDay, localDay, previousDay, streakFrom } from './day';

/* -------------------------------------------------------------------------- */
/* Sync capture plumbing                                                       */
/* -------------------------------------------------------------------------- */

/** Mints one event envelope. `at` is the write's own domain timestamp where it has one. */
function event<T extends SyncEventType>(type: T, payload: SyncPayloads[T], at: number): SyncEvent {
	return { id: newUuid(), device: getDeviceId(), at, type, payload };
}

/**
 * Appends events to the outbox. Call only from inside the transaction that
 * performs the corresponding write, and only when {@link syncEnabled} is true.
 */
async function capture(events: SyncEvent[]): Promise<void> {
	if (events.length === 0) return;
	await db.outbox.bulkAdd(events.map((e) => ({ event: toPlain(e) })));
}

/** The content half of an item — what `item-added` carries (no card, no history). */
function itemContent(item: KnowledgeItem): SyncPayloads['item-added'] {
	return {
		id: item.id,
		kind: item.kind,
		term: item.term,
		meaning: item.meaning,
		romanization: item.romanization,
		notes: item.notes,
		introducedAt: item.introducedAt
	};
}

/**
 * The payload-typed view of {@link challengeOf}.
 *
 * The cast goes through `unknown` because `challengeContentSchema` is a loose
 * shape check (see its doc comment) and `Challenge` is a union of interfaces
 * with no implicit index signature, even though every one of its members
 * satisfies the schema. Nothing is lost — the four checked keys are exactly
 * what the merge reads, and the rest travels verbatim.
 */
function challengeContent(row: ChallengeRow): SyncPayloads['challenge-added']['challenge'] {
	return challengeOf(row) as unknown as SyncPayloads['challenge-added']['challenge'];
}

/** The mutable content fields — what `item-updated` patches. */
function itemPatch(item: KnowledgeItem): SyncPayloads['item-updated']['fields'] {
	return {
		term: item.term,
		meaning: item.meaning,
		romanization: item.romanization,
		notes: item.notes
	};
}

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
export async function saveProfile(profile: Profile, now: number = Date.now()): Promise<void> {
	const plain = toPlain(profile);
	const capturing = syncEnabled();
	await db.transaction('rw', db.profile, db.outbox, async () => {
		await db.profile.put({ ...plain, id: SINGLETON_KEY });
		if (capturing) await capture([event(EVENT_TYPES.profileUpdated, plain, now)]);
	});
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

/**
 * Inserts or replaces items by `id`.
 *
 * With capture on this becomes a read-then-write transaction: an id the table
 * has never seen emits `item-added` (full content), a known one emits
 * `item-updated` (the mutable fields only). The extra `bulkGet` is what lets
 * another device tell "the learner met a new word" from "the learner edited a
 * note", which are different merges.
 *
 * Card and history are deliberately *not* captured here. They are derived state
 * on the receiving side — replayed from `item-reviewed` events — so shipping
 * them would invite two devices to disagree about a card neither of them folded.
 */
export async function upsertItems(items: KnowledgeItem[], now: number = Date.now()): Promise<void> {
	if (items.length === 0) return;
	const plain = toPlain(items);
	const capturing = syncEnabled();

	await db.transaction('rw', db.items, db.outbox, async () => {
		let events: SyncEvent[] = [];
		if (capturing) {
			const existing = await db.items.bulkGet(plain.map((item) => item.id));
			events = plain.map((item, index) =>
				existing[index]
					? event(EVENT_TYPES.itemUpdated, { itemId: item.id, fields: itemPatch(item) }, now)
					: event(EVENT_TYPES.itemAdded, itemContent(item), now)
			);
		}
		await db.items.bulkPut(plain);
		if (capturing) await capture(events);
	});
}

/**
 * Forgets one word entirely.
 *
 * Safe to call mid-session: pooled challenges keep pointing at the id, and
 * {@link updateItemAfterReview} — via `applyResult` — skips items that are no
 * longer there. The learner sees the challenge play out, it just grades nothing.
 */
export async function deleteItem(id: string, now: number = Date.now()): Promise<void> {
	const capturing = syncEnabled();
	await db.transaction('rw', db.items, db.outbox, async () => {
		await db.items.delete(id);
		if (capturing) await capture([event(EVENT_TYPES.itemDeleted, { itemId: id }, now)]);
	});
}

/**
 * Folds a review into an item: appends one history entry, and writes back the
 * card `nextCard` derives from the one already stored.
 *
 * `nextCard` is a function rather than a finished card because the row has to
 * be read here anyway — handing callers the prior card they would otherwise
 * fetch themselves turns the app's hottest write path from two reads per
 * reviewed item into one. It is called inside the transaction, with `null` for
 * an item that has never been reviewed. `prior` comes back out for callers that
 * need to remember where the card stood (see `amendResult`).
 *
 * With `replaceLast`, the entry overwrites the newest one instead of being
 * appended — for a review that is being *recomputed* rather than added (the
 * learner re-graded the answer they just gave; see `amendResult`). Appending
 * there would double-count the review in `reps` and in `accuracyFromHistory`.
 * An empty history has nothing to replace, so it simply appends.
 *
 * `existed` is `false` when the item no longer exists; `nextCard` is not
 * called in that case.
 */
export async function updateItemAfterReview(
	id: string,
	nextCard: (prior: unknown) => unknown,
	historyEntry: { at: number; grade: number },
	opts: { replaceLast?: boolean } = {}
): Promise<{ existed: boolean; prior: unknown }> {
	const plainEntry = toPlain(historyEntry);
	const capturing = syncEnabled();

	return db.transaction('rw', db.items, db.outbox, async () => {
		const item = await db.items.get(id);
		if (!item) return { existed: false, prior: null };

		const prior = item.fsrsCard ?? null;
		const plainCard = toPlain(nextCard(prior));

		const replaced =
			opts.replaceLast && item.history.length > 0
				? item.history[item.history.length - 1]
				: undefined;
		const entry = capturing ? { ...plainEntry, device: getDeviceId() } : plainEntry;
		const history = replaced ? [...item.history.slice(0, -1), entry] : [...item.history, entry];

		await db.items.put({ ...item, fsrsCard: plainCard, history });

		if (capturing) {
			// A replacement is a re-grade of a review this device already logged,
			// so it ships as `review-amended` carrying both timestamps — the entry
			// as it now stands, and the `at` of the entry it displaced. See
			// `amendPayloadSchema` for why the two differ.
			await capture([
				replaced
					? event(
							EVENT_TYPES.reviewAmended,
							{ itemId: id, ...plainEntry, replaces: replaced.at },
							plainEntry.at
						)
					: event(EVENT_TYPES.itemReviewed, { itemId: id, ...plainEntry }, plainEntry.at)
			]);
		}
		return { existed: true, prior };
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
	const capturing = syncEnabled();

	await db.transaction('rw', db.challenges, db.outbox, async () => {
		await db.challenges.bulkPut(rows);
		if (!capturing) return;
		await capture(
			rows.map((row) =>
				event(
					EVENT_TYPES.challengeAdded,
					{ challenge: challengeContent(row), generatedAt: row.generatedAt, topic: row.topic },
					row.generatedAt
				)
			)
		);
	});
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

/** The whole pool, reported rows included — what sync merges over. */
export async function getAllChallenges(): Promise<ChallengeRow[]> {
	return db.challenges.toArray();
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
	const capturing = syncEnabled();
	await db.transaction('rw', db.challenges, db.outbox, async () => {
		const row = await db.challenges.get(id);
		if (!row) return;
		await db.challenges.put({ ...row, timesServed: row.timesServed + 1, lastServedAt: now });
		if (capturing) await capture([event(EVENT_TYPES.challengeServed, { challengeId: id }, now)]);
	});
}

/**
 * Flags a challenge the learner reported as broken. The row stays (results
 * point at it) but {@link getPool} never hands it out again.
 */
export async function reportChallenge(id: string, now: number = Date.now()): Promise<void> {
	const capturing = syncEnabled();
	await db.transaction('rw', db.challenges, db.outbox, async () => {
		await db.challenges.update(id, { reported: true });
		if (capturing) await capture([event(EVENT_TYPES.challengeReported, { challengeId: id }, now)]);
	});
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
	const plain = toPlain(result);
	const capturing = syncEnabled();
	await db.transaction('rw', db.results, db.outbox, async () => {
		await db.results.add(plain);
		if (capturing) await capture([event(EVENT_TYPES.resultLogged, plain, plain.at)]);
	});
}

/** The whole answer log, oldest first. Used by genesis; the UI wants {@link recentResults}. */
export async function getAllResults(): Promise<ChallengeResult[]> {
	const rows = await db.results.orderBy('at').toArray();
	return rows.map(({ seq: _seq, ...result }) => result);
}

/** The most recent results, newest first. */
export async function recentResults(limit: number): Promise<ChallengeResult[]> {
	if (limit <= 0) return [];
	const rows = await db.results.orderBy('at').reverse().limit(limit).toArray();
	return rows.map(({ seq: _seq, ...result }) => result);
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
 * Restores a dump produced by {@link exportData}, replacing existing data.
 *
 * Throws on malformed input or an unsupported envelope version; the API key and
 * the challenge pool are untouched.
 *
 * Deliberately captures **no** sync events, and its transaction deliberately
 * omits `outbox`/`syncState`: an import is a wholesale replacement of local
 * state, which the append-only event model has no vocabulary for. A device that
 * imports a dump and then syncs would need a fresh genesis, not a diff — a
 * combination worth handling explicitly if it ever comes up, not worth guessing
 * at now.
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

	await db.transaction('rw', db.profile, db.items, async () => {
		await db.items.clear();
		if (envelope.items.length > 0) await db.items.bulkPut(envelope.items);

		if (envelope.profile) await db.profile.put({ ...envelope.profile, id: SINGLETON_KEY });
		else await db.profile.delete(SINGLETON_KEY);
	});
}

/* -------------------------------------------------------------------------- */
/* Sync: outbox, state, and the non-capturing apply path                       */
/* -------------------------------------------------------------------------- */

/** localStorage-style `syncState` keys, all in one place. */
const SYNC_STATE = {
	/** Server `seq` of the last event this device has pulled *and applied*. */
	cursor: 'cursor',
	/** Set once genesis synthesis has run; keeps it from ever running twice. */
	genesisDone: 'genesisDone',
	/** The apply engine's dedupe bookkeeping (`SyncBookkeeping`). */
	bookkeeping: 'bookkeeping',
	/**
	 * Epoch ms of the last sync that completed end to end — pushed, pulled and
	 * applied. Written by `runSync` on success only, so the Settings status line
	 * says when the device was last actually in step, not when it last tried.
	 */
	lastSync: 'lastSync'
} as const;

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

/**
 * The oldest `limit` outbox rows, in `seq` order — one push batch.
 *
 * Rows keep their `seq`, because that is what {@link drainOutbox} deletes by:
 * the server acknowledges *event ids*, but the local row is identified only by
 * its auto-increment key (a re-pushed event keeps its id and gets a new row).
 */
export async function peekOutbox(limit: number): Promise<OutboxRow[]> {
	return db.outbox.orderBy('seq').limit(limit).toArray();
}

/**
 * Deletes the rows a push has been acknowledged for.
 *
 * Called only with the seqs of a batch the server answered 2xx to, which is
 * what makes a failed push free: the outbox is left exactly as it was, and the
 * next sync re-pushes it — the server dedupes on event id, so anything that did
 * land the first time is a no-op the second (docs/sync.md §6).
 */
export async function drainOutbox(seqs: number[]): Promise<void> {
	if (seqs.length === 0) return;
	await db.outbox.bulkDelete(seqs);
}

/**
 * Runs genesis synthesis (docs/sync.md §5) exactly once.
 *
 * Reads the whole local state, hands it to `build` — the pure
 * `synthesizeGenesis` — and enqueues the result, all in one transaction, so a
 * half-written genesis is impossible. Returns the number of events enqueued, or
 * `0` if genesis had already run.
 */
export async function seedOutbox(build: (state: GenesisState) => SyncEvent[]): Promise<number> {
	return db.transaction(
		'rw',
		[db.profile, db.items, db.challenges, db.results, db.outbox, db.syncState],
		async () => {
			if (await getSyncState<boolean>('genesisDone')) return 0;

			const [profile, items, pool, results] = await Promise.all([
				getProfile(),
				getAllItems(),
				getAllChallenges(),
				getAllResults()
			]);
			const events = build({
				items,
				pool,
				results,
				profile: profile ?? null
			});

			await capture(events);
			await setSyncState('genesisDone', true);
			return events.length;
		}
	);
}

/**
 * The **only** write path for remotely produced state, and the reason no
 * `{capture: false}` flag exists: `fold` is the pure apply engine, and this
 * function writes its output straight to the tables without touching `outbox`,
 * so a pulled event physically cannot echo back into it.
 *
 * Load, fold and write-back happen inside one transaction, so a session writing
 * concurrently cannot be clobbered by a stale read.
 *
 * The write-back is a **reference diff**: the pure engine returns the very same
 * object for anything it did not touch, so `!==` against the loaded snapshot is
 * an exact — and free — "what changed" test. That keeps a sync that brings in
 * three reviews to three item writes instead of rewriting the whole table.
 */
export async function mergeSyncSnapshot(
	fold: (before: SyncSnapshot) => SyncSnapshot
): Promise<void> {
	await db.transaction(
		'rw',
		[db.profile, db.items, db.challenges, db.results, db.syncState],
		async () => {
			const [profile, items, pool, results] = await Promise.all([
				getProfile(),
				getAllItems(),
				getAllChallenges(),
				getAllResults()
			]);
			const before: SyncSnapshot = {
				items,
				pool,
				results,
				profile: profile ?? null,
				bookkeeping: (await getSyncState<SyncBookkeeping>('bookkeeping')) ?? emptyBookkeeping()
			};

			// Not `toPlain`d: the engine only ever moves already-plain objects
			// around (rows loaded from Dexie, payloads parsed from JSON), and a
			// round-trip here would destroy the very reference identity the diff
			// below depends on.
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
