/**
 * SQLite storage: the whole persistence layer of the sync service.
 *
 * The server is a dumb, opaque relay (docs/sync.md §8): it validates the event
 * *envelope*, stamps a `seq`, and stores the payload as an untouched JSON
 * string. It never parses, merges or interprets a payload — every merge rule
 * lives client-side, which is what keeps this file small and what makes
 * end-to-end encrypting payloads a client-only change later (§10).
 *
 * The store takes its database path as an argument rather than reading env, so
 * tests can pass `':memory:'` and run without touching a disk.
 */

import Database from 'better-sqlite3';
import type { StoredSyncEvent, SyncEvent } from '../../src/lib/sync/events.ts';

/**
 * `seq` is a single global AUTOINCREMENT counter, not a per-user one, and that
 * is enough: AUTOINCREMENT is strictly increasing over the whole table, so the
 * subsequence belonging to any one user is strictly increasing too. A client's
 * cursor only ever needs "give me my events with seq > X" — gaps where another
 * user's events took numbers are invisible to it. (AUTOINCREMENT, not plain
 * rowid: plain rowids can be *reused* after a delete, which would silently
 * rewind a cursor.)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  hash       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  device     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, event_id)
);

-- Every read is "this user's events after this seq", so the cursor scan wants
-- exactly this index.
CREATE INDEX IF NOT EXISTS events_user_seq ON events(user_id, seq);
`;

interface EventRow {
	seq: number;
	event_id: string;
	device: string;
	at: number;
	type: string;
	payload: string;
}

export interface SyncStore {
	/** Escape hatch for the provisioning CLI and tests; endpoints go through the methods. */
	readonly db: Database.Database;
	/** Resolves an API-key hash to its user, or `undefined` if unknown. */
	userForKeyHash(hash: string): string | undefined;
	/** Registers a key hash for a user. Used by `scripts/new-key.ts`. */
	insertKey(hash: string, userId: string, now: number): void;
	/** Highest `seq` in this user's log; 0 when the log is empty. */
	latestSeq(userId: string): number;
	/** Appends a push in one transaction. Duplicates are ignored, not errors. */
	appendEvents(
		userId: string,
		events: SyncEvent[],
		now: number
	): { accepted: number; latest: number };
	/** This user's events with `seq > after`, ascending, at most `limit`. */
	readEvents(userId: string, after: number, limit: number): StoredSyncEvent[];
	close(): void;
}

export function openStore(path: string): SyncStore {
	const db = new Database(path);
	// WAL lets a pull read while a push writes — the only concurrency this
	// service has. (A `:memory:` database ignores the pragma; harmless.)
	db.pragma('journal_mode = WAL');
	// Without this, `UNIQUE(user_id, event_id)` on the events table is enforced
	// but foreign keys elsewhere would not be; cheap to set, easy to forget.
	db.pragma('foreign_keys = ON');
	db.exec(SCHEMA);

	const selectUser = db.prepare<[string], { user_id: string }>(
		'SELECT user_id FROM keys WHERE hash = ?'
	);
	const insertKeyStmt = db.prepare(
		'INSERT INTO keys (hash, user_id, created_at) VALUES (?, ?, ?)'
	);
	const selectLatest = db.prepare<[string], { latest: number }>(
		'SELECT COALESCE(MAX(seq), 0) AS latest FROM events WHERE user_id = ?'
	);
	// INSERT OR IGNORE against `UNIQUE(user_id, event_id)` is the whole
	// idempotency story (§6): a retried push re-sends events the server already
	// has, and re-sending must be a no-op rather than a conflict.
	const insertEvent = db.prepare(
		`INSERT OR IGNORE INTO events (user_id, event_id, device, at, type, payload, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
	);
	const selectAfter = db.prepare<[string, number, number], EventRow>(
		`SELECT seq, event_id, device, at, type, payload
		   FROM events
		  WHERE user_id = ? AND seq > ?
		  ORDER BY seq ASC
		  LIMIT ?`
	);

	// One transaction per request: a push either lands whole or not at all, so a
	// client that times out mid-write never has to reason about a partial batch.
	const appendTx = db.transaction((userId: string, events: SyncEvent[], now: number) => {
		for (const event of events) {
			insertEvent.run(
				userId,
				event.id,
				event.device,
				event.at,
				event.type,
				// `payload` may legitimately be null; JSON.stringify(undefined)
				// returns undefined, which would violate the NOT NULL column.
				JSON.stringify(event.payload ?? null),
				now
			);
		}
	});

	const latestSeq = (userId: string): number => selectLatest.get(userId)?.latest ?? 0;

	return {
		db,

		userForKeyHash(hash) {
			return selectUser.get(hash)?.user_id;
		},

		insertKey(hash, userId, now) {
			insertKeyStmt.run(hash, userId, now);
		},

		latestSeq,

		appendEvents(userId, events, now) {
			appendTx(userId, events, now);
			// Everything the client sent is "accepted", duplicates included —
			// the client's contract is "these are durably stored", and for a
			// duplicate that was already true (§6).
			return { accepted: events.length, latest: latestSeq(userId) };
		},

		readEvents(userId, after, limit) {
			return selectAfter.all(userId, after, limit).map((row) => ({
				seq: row.seq,
				id: row.event_id,
				device: row.device,
				at: row.at,
				type: row.type,
				// Stored verbatim as written; re-parsed here so the response is
				// JSON, not a JSON string inside JSON.
				payload: JSON.parse(row.payload) as unknown
			}));
		},

		close() {
			db.close();
		}
	};
}
