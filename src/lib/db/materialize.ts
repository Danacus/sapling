/**
 * The merge rules: one event in, read-model rows out.
 *
 * Pure over an `exec`/`query` pair, so the same code runs in the OPFS Worker
 * and against an in-memory database in node — there is one implementation of
 * these rules, not a write path and a replay path that have to keep agreeing.
 *
 * Dedupe happens at the log ({@link ingest}): an event whose id is already in
 * `events` is never materialised twice, so nothing below needs an idempotency
 * trick beyond the ones the domain itself requires.
 *
 * Everything here must be total — a rule that cannot apply returns instead of
 * throwing, because the alternative is an import or a sync page that stops
 * halfway.
 */
import { localDay } from './day';
import type { EventType, PayloadFor, SyncEvent } from './events';
import {
	DDL,
	DERIVED_SCHEMA_VERSION,
	DERIVED_TABLES,
	PROFILE_ID,
	RECENT_GRADES_CAP,
	reviewKey
} from './schema';
import {
	Grade as GradeValue,
	newCardState,
	reviewCard,
	type FsrsCardState,
	type Grade
} from '$lib/srs';
import type { ChallengeType } from '$lib/types';
import type { Database } from '@sqlite.org/sqlite-wasm';

export type SqlParam = string | number | null;

/** One statement, as it travels over the Worker RPC. */
export interface SqlOp {
	sql: string;
	params?: SqlParam[];
}

/** Synchronous SQLite, the only thing the rules below are written against. */
export interface Sql {
	exec(sql: string, params?: SqlParam[]): void;
	query<T>(sql: string, params?: SqlParam[]): T[];
}

/**
 * Applies the DDL and brings the read tables up to `DERIVED_SCHEMA_VERSION`.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so
 * when a derived table changes shape the version in `meta` is what notices:
 * on a mismatch every read table is dropped, recreated and replayed from the
 * log, in one transaction. A fresh database takes the same path over an empty
 * log, which is how the version row first gets written.
 */
export function openSchema(db: Database): Sql {
	db.exec(DDL);
	const sql = sqlFor(db);
	const version = String(DERIVED_SCHEMA_VERSION);
	const stored = sql.query<{ value: string }>(
		`SELECT value FROM meta WHERE key = 'derivedSchema'`
	)[0];
	if (stored?.value === version) return sql;

	db.exec('BEGIN');
	try {
		for (const table of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
		db.exec(DDL);
		rebuild(sql);
		sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('derivedSchema', ?)`, [version]);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
	return sql;
}

/** Wraps a `sqlite-wasm` database as an {@link Sql}. */
export function sqlFor(db: Database): Sql {
	return {
		exec(sql, params) {
			db.exec(sql, { bind: params ?? [] });
		},
		query<T>(sql: string, params?: SqlParam[]): T[] {
			return db.exec(sql, {
				bind: params ?? [],
				rowMode: 'object',
				returnValue: 'resultRows'
			}) as T[];
		}
	};
}

/**
 * The challenge types this build knows how to play.
 *
 * A new member of the `Challenge` union must be added here or challenges of
 * that type are dropped on arrival. Typed as a `Record` over `ChallengeType` so
 * forgetting fails `pnpm check` at this literal; enforced here rather than in
 * the event schema so an unknown type costs one skipped row and the event stays
 * in the log for a later build to materialise.
 */
const CHALLENGE_TYPE_TABLE: Record<ChallengeType, true> = {
	'multiple-choice': true,
	cloze: true,
	'typed-translation': true,
	'match-pairs': true,
	'word-order': true,
	'spot-error': true
};

const CHALLENGE_TYPES = new Set<string>(Object.keys(CHALLENGE_TYPE_TABLE));

interface ReviewFoldRow {
	at: number;
	grade: number;
}

/**
 * The bulk-read aggregates every `items` row carries.
 *
 * They exist so a word list never reads `reviews`: the ledger's accuracy column,
 * the slot planner's difficulty dial and the tick strip are all folds of the
 * history that can be maintained one review at a time.
 */
function aggregates(rows: readonly ReviewFoldRow[]): {
	correctCount: number;
	recentGrades: string;
} {
	return {
		correctCount: rows.filter((row) => row.grade >= GradeValue.Good).length,
		recentGrades: JSON.stringify(
			rows.slice(-RECENT_GRADES_CAP).map(({ at, grade }) => ({ at, grade }))
		)
	};
}

/** Replays an item's reviews from a fresh card. The fold order is `(at, device)`. */
function refold(sql: Sql, itemId: string): void {
	const item = sql.query<{ introducedAt: number }>('SELECT introducedAt FROM items WHERE id = ?', [
		itemId
	])[0];
	if (!item) return;
	const rows = sql.query<ReviewFoldRow>(
		'SELECT at, grade FROM reviews WHERE itemId = ? ORDER BY at, device',
		[itemId]
	);
	writeFold(sql, itemId, item.introducedAt, rows);
}

function writeFold(
	sql: Sql,
	itemId: string,
	introducedAt: number,
	rows: readonly ReviewFoldRow[]
): void {
	let card = newCardState(introducedAt);
	for (const row of rows) card = reviewCard(card, row.grade as Grade, row.at);
	const { correctCount, recentGrades } = aggregates(rows);
	sql.exec(
		`UPDATE items
		 SET fsrsCard = ?, reviewCount = ?, correctCount = ?, recentGrades = ?, lastReviewedAt = ?
		 WHERE id = ?`,
		[
			JSON.stringify(card),
			rows.length,
			correctCount,
			recentGrades,
			rows.length === 0 ? null : rows[rows.length - 1].at,
			itemId
		]
	);
}

function itemAdded(sql: Sql, p: PayloadFor<'itemAdded'>): void {
	if (sql.query('SELECT 1 FROM tombstones WHERE itemId = ?', [p.id]).length > 0) return;
	if (sql.query('SELECT 1 FROM items WHERE id = ?', [p.id]).length > 0) return;

	sql.exec(
		`INSERT INTO items (id, kind, term, meaning, romanization, notes, introducedAt, fsrsCard)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			p.id,
			p.kind,
			p.term,
			p.meaning,
			p.romanization ?? null,
			p.notes ?? null,
			p.introducedAt,
			JSON.stringify(newCardState(p.introducedAt))
		]
	);

	// Reviews that arrived before their item are kept, inert; this is where they
	// start counting.
	const rows = sql.query<ReviewFoldRow>(
		'SELECT at, grade FROM reviews WHERE itemId = ? ORDER BY at, device',
		[p.id]
	);
	if (rows.length > 0) writeFold(sql, p.id, p.introducedAt, rows);
}

function itemReviewed(sql: Sql, p: PayloadFor<'itemReviewed'>): void {
	const id = reviewKey(p.itemId, p.at, p.device);
	if (sql.query('SELECT 1 FROM reviews WHERE id = ?', [id]).length > 0) return;
	sql.exec('INSERT INTO reviews (id, itemId, at, grade, device) VALUES (?, ?, ?, ?, ?)', [
		id,
		p.itemId,
		p.at,
		p.grade,
		p.device
	]);

	const item = sql.query<{
		fsrsCard: string;
		lastReviewedAt: number | null;
		recentGrades: string;
	}>('SELECT fsrsCard, lastReviewedAt, recentGrades FROM items WHERE id = ?', [p.itemId])[0];
	if (!item) return;

	// Strictly newest reviews fold onto the stored card; a tie refolds, because
	// two devices reviewing in the same millisecond order by device, not arrival.
	if (item.lastReviewedAt === null || p.at > item.lastReviewedAt) {
		const card = reviewCard(JSON.parse(item.fsrsCard) as FsrsCardState, p.grade as Grade, p.at);
		const recent = (JSON.parse(item.recentGrades) as ReviewFoldRow[]).concat({
			at: p.at,
			grade: p.grade
		});
		sql.exec(
			`UPDATE items
			 SET fsrsCard = ?, reviewCount = reviewCount + 1, correctCount = correctCount + ?,
			     recentGrades = ?, lastReviewedAt = ?
			 WHERE id = ?`,
			[
				JSON.stringify(card),
				p.grade >= GradeValue.Good ? 1 : 0,
				JSON.stringify(recent.slice(-RECENT_GRADES_CAP)),
				p.at,
				p.itemId
			]
		);
	} else {
		refold(sql, p.itemId);
	}
}

function reviewAmended(sql: Sql, p: PayloadFor<'reviewAmended'>): void {
	if (p.replaces !== undefined) {
		sql.exec('DELETE FROM reviews WHERE id = ?', [reviewKey(p.itemId, p.replaces, p.device)]);
	}
	sql.exec(
		'INSERT OR REPLACE INTO reviews (id, itemId, at, grade, device) VALUES (?, ?, ?, ?, ?)',
		[reviewKey(p.itemId, p.at, p.device), p.itemId, p.at, p.grade, p.device]
	);
	refold(sql, p.itemId);
}

const PATCHABLE = ['term', 'meaning', 'romanization', 'notes'] as const;

function itemUpdated(sql: Sql, at: number, p: PayloadFor<'itemUpdated'>): void {
	const row = sql.query<{ updatedAt: number }>('SELECT updatedAt FROM items WHERE id = ?', [
		p.itemId
	])[0];
	if (!row || at < row.updatedAt) return;

	const sets: string[] = [];
	const params: SqlParam[] = [];
	for (const field of PATCHABLE) {
		const value = p.fields[field];
		if (value === undefined) continue;
		sets.push(`${field} = ?`);
		params.push(value);
	}
	if (sets.length === 0) return;
	sql.exec(`UPDATE items SET ${sets.join(', ')}, updatedAt = ? WHERE id = ?`, [
		...params,
		at,
		p.itemId
	]);
}

function itemDeleted(sql: Sql, p: PayloadFor<'itemDeleted'>): void {
	sql.exec('INSERT OR IGNORE INTO tombstones (itemId) VALUES (?)', [p.itemId]);
	sql.exec('DELETE FROM reviews WHERE itemId = ?', [p.itemId]);
	sql.exec('DELETE FROM items WHERE id = ?', [p.itemId]);
}

function challengeAdded(sql: Sql, p: PayloadFor<'challengeAdded'>): void {
	const content = p.challenge as { id?: unknown; type?: unknown } | null;
	if (typeof content?.id !== 'string' || typeof content.type !== 'string') return;
	if (!CHALLENGE_TYPES.has(content.type)) return;
	sql.exec(
		`INSERT OR IGNORE INTO challenges (id, content, generatedAt, topic, reported, timesServed, lastServedAt)
		 VALUES (?, ?, ?, ?, 0, 0, NULL)`,
		[content.id, JSON.stringify(p.challenge), p.generatedAt, p.topic ?? null]
	);
}

function resultLogged(sql: Sql, id: string, p: PayloadFor<'resultLogged'>): void {
	if (sql.query('SELECT 1 FROM results WHERE id = ?', [id]).length > 0) return;
	sql.exec(
		'INSERT INTO results (id, challengeId, verdict, answerGiven, at) VALUES (?, ?, ?, ?, ?)',
		[id, p.challengeId, p.verdict, p.answerGiven, p.at]
	);
	sql.exec(
		'INSERT INTO daily (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1',
		[localDay(p.at)]
	);
}

function profileUpdated(sql: Sql, at: number, p: PayloadFor<'profileUpdated'>): void {
	const row = sql.query<{ updatedAt: number }>('SELECT updatedAt FROM profile WHERE id = ?', [
		PROFILE_ID
	])[0];
	if (row && at < row.updatedAt) return;
	sql.exec(
		`INSERT OR REPLACE INTO profile
		   (id, nativeLanguage, targetLanguage, level, interests, about, model, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			PROFILE_ID,
			p.nativeLanguage,
			p.targetLanguage,
			p.level,
			JSON.stringify(p.interests),
			p.about ?? null,
			p.model,
			p.createdAt,
			at
		]
	);
}

/**
 * A whole reading text, insert-or-ignore. Same shape as {@link itemAdded}: a
 * tombstone outranks it whenever it arrives, and a second copy of a text this
 * device already has changes nothing, because a text is immutable once stored.
 */
function textAdded(sql: Sql, p: PayloadFor<'textAdded'>): void {
	if (sql.query('SELECT 1 FROM textTombstones WHERE textId = ?', [p.id]).length > 0) return;
	sql.exec(
		`INSERT OR IGNORE INTO texts (id, title, source, topic, sentences, glossary, media, createdAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			p.id,
			p.title,
			p.source,
			p.topic ?? null,
			JSON.stringify(p.sentences),
			JSON.stringify(p.glossary),
			p.media === undefined ? null : JSON.stringify(p.media),
			p.createdAt
		]
	);
}

function textDeleted(sql: Sql, p: PayloadFor<'textDeleted'>): void {
	sql.exec('INSERT OR IGNORE INTO textTombstones (textId) VALUES (?)', [p.textId]);
	sql.exec('DELETE FROM texts WHERE id = ?', [p.textId]);
}

/**
 * The known/not-known toggle, last write by `at` wins — the third overwrite,
 * resolved exactly like `itemUpdated` and `profileUpdated`.
 *
 * The term is the key, stored trimmed and otherwise verbatim; normalising for
 * lookup is the reader's job, not the log's.
 */
function wordMarked(sql: Sql, at: number, p: PayloadFor<'wordMarked'>): void {
	const term = p.term.trim();
	if (term === '') return;
	const row = sql.query<{ updatedAt: number }>('SELECT updatedAt FROM wordMarks WHERE term = ?', [
		term
	])[0];
	if (row && at < row.updatedAt) return;
	sql.exec('INSERT OR REPLACE INTO wordMarks (term, known, updatedAt) VALUES (?, ?, ?)', [
		term,
		p.known ? 1 : 0,
		at
	]);
}

/**
 * One "explain this word" tap, set-unioned by the envelope id like
 * {@link resultLogged}.
 *
 * Two lookups of the same word are two rows on purpose — the count is the
 * signal — so nothing here collapses by content; only a re-delivery of one
 * event collapses, which is what the id buys.
 */
function wordLookedUp(sql: Sql, id: string, at: number, p: PayloadFor<'wordLookedUp'>): void {
	const term = p.term.trim();
	if (term === '') return;
	sql.exec('INSERT OR IGNORE INTO lookups (id, term, itemId, textId, at) VALUES (?, ?, ?, ?, ?)', [
		id,
		term,
		p.itemId ?? null,
		p.textId,
		at
	]);
}

/**
 * The scene of one conversation, insert-or-ignore — {@link textAdded}'s shape
 * exactly, and for the same reason: a scenario is decided once and never
 * revised, so a second copy of it changes nothing and a tombstone outranks it
 * whenever it arrives.
 */
function conversationStarted(sql: Sql, p: PayloadFor<'conversationStarted'>): void {
	if (sql.query('SELECT 1 FROM conversationTombstones WHERE conversationId = ?', [p.id]).length > 0)
		return;
	sql.exec(
		`INSERT OR IGNORE INTO conversations (id, scenario, topic, createdAt) VALUES (?, ?, ?, ?)`,
		[p.id, JSON.stringify(p.scenario), p.topic ?? null, p.createdAt]
	);
}

/**
 * One exchange of a transcript, keyed by `(conversationId, idx)`.
 *
 * Deliberately not conditional on the conversation row existing: across a sync
 * the turns of a conversation can land before the `conversationStarted` that
 * opened it, and a turn dropped for arriving early would never come back. The
 * row follows, `getConversation` joins the two on id, and until then the turn
 * sits inert exactly as a review that outran its item does.
 *
 * The tombstone is still checked, because that one *is* a decision the learner
 * made about this id and it outranks anything still in flight.
 */
function turnAdded(sql: Sql, at: number, p: PayloadFor<'turnAdded'>): void {
	if (
		sql.query('SELECT 1 FROM conversationTombstones WHERE conversationId = ?', [p.conversationId])
			.length > 0
	)
		return;
	sql.exec(
		`INSERT OR IGNORE INTO conversationTurns (conversationId, idx, learner, teacher, at)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			p.conversationId,
			p.index,
			p.learner === undefined ? null : JSON.stringify(p.learner),
			JSON.stringify(p.teacher),
			at
		]
	);
}

function conversationDeleted(sql: Sql, p: PayloadFor<'conversationDeleted'>): void {
	sql.exec('INSERT OR IGNORE INTO conversationTombstones (conversationId) VALUES (?)', [
		p.conversationId
	]);
	sql.exec('DELETE FROM conversationTurns WHERE conversationId = ?', [p.conversationId]);
	sql.exec('DELETE FROM conversations WHERE id = ?', [p.conversationId]);
}

/** Applies one event's merge rule. Assumes the caller has already deduped by id. */
export function applyEvent(sql: Sql, event: SyncEvent): void {
	const type: EventType = event.type;
	switch (type) {
		case 'itemAdded':
			return itemAdded(sql, event.payload as PayloadFor<'itemAdded'>);
		case 'itemReviewed':
			return itemReviewed(sql, event.payload as PayloadFor<'itemReviewed'>);
		case 'reviewAmended':
			return reviewAmended(sql, event.payload as PayloadFor<'reviewAmended'>);
		case 'itemUpdated':
			return itemUpdated(sql, event.at, event.payload as PayloadFor<'itemUpdated'>);
		case 'itemDeleted':
			return itemDeleted(sql, event.payload as PayloadFor<'itemDeleted'>);
		case 'challengeAdded':
			return challengeAdded(sql, event.payload as PayloadFor<'challengeAdded'>);
		case 'challengeServed': {
			const p = event.payload as PayloadFor<'challengeServed'>;
			return sql.exec(
				`UPDATE challenges
				 SET timesServed = timesServed + 1, lastServedAt = max(coalesce(lastServedAt, ?), ?)
				 WHERE id = ?`,
				[p.at, p.at, p.challengeId]
			);
		}
		case 'challengeReported': {
			const p = event.payload as PayloadFor<'challengeReported'>;
			return sql.exec('UPDATE challenges SET reported = 1 WHERE id = ?', [p.challengeId]);
		}
		case 'resultLogged':
			return resultLogged(sql, event.id, event.payload as PayloadFor<'resultLogged'>);
		case 'profileUpdated':
			return profileUpdated(sql, event.at, event.payload as PayloadFor<'profileUpdated'>);
		case 'textAdded':
			return textAdded(sql, event.payload as PayloadFor<'textAdded'>);
		case 'textDeleted':
			return textDeleted(sql, event.payload as PayloadFor<'textDeleted'>);
		case 'wordMarked':
			return wordMarked(sql, event.at, event.payload as PayloadFor<'wordMarked'>);
		case 'wordLookedUp':
			return wordLookedUp(sql, event.id, event.at, event.payload as PayloadFor<'wordLookedUp'>);
		case 'conversationStarted':
			return conversationStarted(sql, event.payload as PayloadFor<'conversationStarted'>);
		case 'turnAdded':
			return turnAdded(sql, event.at, event.payload as PayloadFor<'turnAdded'>);
		case 'conversationDeleted':
			return conversationDeleted(sql, event.payload as PayloadFor<'conversationDeleted'>);
	}
}

/**
 * Writes one event to the log and materialises it, once.
 *
 * An id already present is not re-applied; a remote copy of an event this
 * device produced only stamps the `seq` the backend gave it.
 */
export function ingest(sql: Sql, event: SyncEvent, seq: number | null): void {
	const existing = sql.query<{ seq: number | null }>('SELECT seq FROM events WHERE id = ?', [
		event.id
	])[0];
	if (existing) {
		if (seq !== null && existing.seq === null) {
			sql.exec('UPDATE events SET seq = ? WHERE id = ?', [seq, event.id]);
		}
		return;
	}
	sql.exec('INSERT INTO events (seq, id, type, at, device, payload) VALUES (?, ?, ?, ?, ?, ?)', [
		seq,
		event.id,
		event.type,
		event.at,
		event.device,
		JSON.stringify(event.payload)
	]);
	applyEvent(sql, event);
}

/** Inserts events without materialising them — {@link rebuild} is what applies them. */
export function insertOnly(sql: Sql, event: SyncEvent): void {
	sql.exec(
		'INSERT OR IGNORE INTO events (seq, id, type, at, device, payload) VALUES (NULL, ?, ?, ?, ?, ?)',
		[event.id, event.type, event.at, event.device, JSON.stringify(event.payload)]
	);
}

interface EventRow {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: string;
}

/**
 * Replay order: the backend's `seq`, then local insertion order for whatever
 * this device has not pushed yet.
 *
 * Not `at`. Most rules are order-free, but two are not — a serve or a report
 * for a challenge that has not been added is dropped, and an amend that
 * precedes the review it replaces leaves two rows — and a whole action's events
 * routinely share a millisecond, so a timestamp cannot separate them. `rowid`
 * is the order they were written in, which is the causal order that produced
 * them; once pushed, `seq` is the same order, shared by every device.
 */
export const LOG_ORDER = 'seq IS NULL, seq, rowid';

/**
 * Drops every read table and replays the whole log, in {@link LOG_ORDER}.
 *
 * Used by a v3 import, and available as a repair.
 */
export function rebuild(sql: Sql): void {
	for (const table of DERIVED_TABLES) sql.exec(`DELETE FROM ${table}`);
	const rows = sql.query<EventRow>(
		`SELECT id, type, at, device, payload FROM events ORDER BY ${LOG_ORDER}`
	);
	for (const row of rows) {
		applyEvent(sql, {
			id: row.id,
			type: row.type as EventType,
			at: row.at,
			device: row.device,
			payload: JSON.parse(row.payload) as unknown
		});
	}
}
