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

import { getDeviceId, newUuid } from '$lib/device';
import { deriveCard, serveStats, sortHistory } from '$lib/livestore/derive';
import { events, PROFILE_ID, tables } from '$lib/livestore/schema';
import { storeReady } from '$lib/livestore/store';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Verdict } from '$lib/types';
import { challengeOf } from './database';
import type { ChallengeRow } from './database';
import type { SyncEvent } from './events';
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
export const EXPORT_VERSION = 3;

/** Envelope versions {@link importData} still restores from. */
const SUPPORTED_IMPORT_VERSIONS = [1, 2];

/** Shape of the JSON produced by {@link exportData}. */
export interface ExportEnvelope {
	version: number;
	exportedAt: number;
	events: SyncEvent[];
}

/** Turns every LiveStore table row into the one event it would have produced. */
function eventsFromTables(
	items: readonly {
		id: string;
		kind: string;
		term: string;
		meaning: string;
		romanization: string | null;
		notes: string | null;
		introducedAt: number;
	}[],
	reviews: readonly { id: string; itemId: string; at: number; grade: number; device: string }[],
	tombstones: readonly { itemId: string }[],
	challenges: readonly {
		id: string;
		content: unknown;
		generatedAt: number;
		topic: string | null;
		reported: boolean;
	}[],
	serves: readonly { id: string; challengeId: string; at: number }[],
	results: readonly {
		id: string;
		challengeId: string;
		verdict: string;
		answerGiven: string;
		at: number;
	}[],
	profile: {
		nativeLanguage: string;
		targetLanguage: string;
		level: string;
		interests: string[];
		about: string | null;
		model: string;
		createdAt: number;
	} | null
): SyncEvent[] {
	const device = getDeviceId();
	const out: SyncEvent[] = [];

	for (const row of items) {
		out.push({
			id: `item:${row.id}`,
			type: 'itemAdded',
			at: row.introducedAt,
			device,
			payload: {
				id: row.id,
				kind: row.kind,
				term: row.term,
				meaning: row.meaning,
				...(row.romanization === null ? {} : { romanization: row.romanization }),
				...(row.notes === null ? {} : { notes: row.notes }),
				introducedAt: row.introducedAt
			}
		});
	}

	for (const row of reviews) {
		out.push({
			id: `review:${row.id}`,
			type: 'itemReviewed',
			at: row.at,
			device: row.device,
			payload: { device: row.device, at: row.at, itemId: row.itemId, grade: row.grade }
		});
	}

	for (const row of tombstones) {
		out.push({
			id: `tombstone:${row.itemId}`,
			type: 'itemDeleted',
			at: 0,
			device,
			payload: { itemId: row.itemId }
		});
	}

	for (const row of challenges) {
		out.push({
			id: `challenge:${row.id}`,
			type: 'challengeAdded',
			at: row.generatedAt,
			device,
			payload: {
				challenge: row.content,
				generatedAt: row.generatedAt,
				...(row.topic === null ? {} : { topic: row.topic })
			}
		});
		if (row.reported) {
			out.push({
				id: `reported:${row.id}`,
				type: 'challengeReported',
				at: row.generatedAt,
				device,
				payload: { challengeId: row.id }
			});
		}
	}

	for (const row of serves) {
		out.push({
			id: row.id,
			type: 'challengeServed',
			at: row.at,
			device,
			payload: { challengeId: row.challengeId, at: row.at }
		});
	}

	for (const row of results) {
		out.push({
			id: row.id,
			type: 'resultLogged',
			at: row.at,
			device,
			payload: {
				challengeId: row.challengeId,
				verdict: row.verdict,
				answerGiven: row.answerGiven,
				at: row.at
			}
		});
	}

	if (profile) {
		out.push({
			id: 'profile',
			type: 'profileUpdated',
			at: profile.createdAt,
			device,
			payload: {
				nativeLanguage: profile.nativeLanguage,
				targetLanguage: profile.targetLanguage,
				level: profile.level,
				interests: profile.interests,
				...(profile.about === null ? {} : { about: profile.about }),
				model: profile.model,
				createdAt: profile.createdAt
			}
		});
	}

	return out;
}

/**
 * Serializes the whole eventlog as JSON — one event per table row, with a
 * deterministic id so re-exporting an unchanged store reproduces it exactly.
 * Excludes only the API key, which lives in `localStorage`.
 */
export async function exportData(): Promise<string> {
	const store = await storeReady();
	const profileRow = store.query(
		tables.profile.where({ id: PROFILE_ID }).first({ behaviour: 'fallback', fallback: () => null })
	);
	const syncEvents = eventsFromTables(
		store.query(tables.items),
		store.query(tables.reviews),
		store.query(tables.tombstones),
		store.query(tables.challenges),
		store.query(tables.serves),
		store.query(tables.results),
		profileRow
			? {
					nativeLanguage: profileRow.nativeLanguage,
					targetLanguage: profileRow.targetLanguage,
					level: profileRow.level,
					interests: [...profileRow.interests],
					about: profileRow.about,
					model: profileRow.model,
					createdAt: profileRow.createdAt
				}
			: null
	);
	const envelope: ExportEnvelope = {
		version: EXPORT_VERSION,
		exportedAt: Date.now(),
		events: syncEvents
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

/**
 * Restores a v1 or v2 dump, replacing existing items. A v3 export is rejected
 * — this LiveStore build only produces v3, the next one reads it back.
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
	if (parsed.version === 3) {
		throw new Error('Import failed: v3 exports are read by the next version of Sapling.');
	}
	// A v1 envelope still restores: it carries a `stats` field that no longer
	// means anything, and everything else is unchanged, so it is simply ignored.
	if (typeof parsed.version !== 'number' || !SUPPORTED_IMPORT_VERSIONS.includes(parsed.version)) {
		throw new Error(`Import failed: unsupported export version ${String(parsed.version)}.`);
	}
	if (!Array.isArray(parsed.items)) throw new Error('Import failed: missing item list.');
	if (parsed.profile !== null && !isRecord(parsed.profile)) {
		throw new Error('Import failed: malformed profile.');
	}

	const envelope = toPlain(parsed as unknown as LegacyExportEnvelope);
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

export { challengeOf };
