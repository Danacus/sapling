/**
 * The whole local database, as one DDL string.
 *
 * Two layers, and the split is the design: `events` is the facts log — every
 * write the learner ever made, in arrival order, and the only thing sync moves
 * — while everything below it is an *aggregate* the materializer maintains.
 * UI reads never touch `events`.
 *
 * `seq` is the server's sequence number, `NULL` until the event has been pushed.
 * `items` carries every aggregate a bulk read needs — the card, the counters and
 * the last {@link RECENT_GRADES_CAP} grades — so a word list is one `SELECT` and
 * never touches `reviews`. `reviews` stays because an out-of-order review has to
 * be able to refold one item exactly, and because one item's full history is
 * still shown on demand.
 *
 * `texts` keeps `sentences` and `glossary` as JSON: a text is immutable once
 * stored and always read whole, so there is nothing to query inside them.
 *
 * `conversations` keeps its scenario as JSON for the same reason, and
 * `conversationTurns` keeps a whole turn per row: the transcript is only ever
 * read in one piece, in `idx` order, and `(conversationId, idx)` is the primary
 * key because that pair — not an event id — is what makes the same exchange
 * arriving twice one row. `at` is the envelope's, carried onto the row so the
 * library can say when a conversation was last spoken in without reading a
 * single transcript.
 *
 * `lookups` is a log nothing reads yet — every "explain this word" tap, kept
 * because it is FSRS evidence a later slice will grade and cannot be
 * reconstructed after the fact. The index is the read it is waiting for: one
 * term's lookups, in time order.
 *
 * `CREATE TABLE IF NOT EXISTS` throughout, and the DDL runs on every open, so a
 * database written by an older build picks up a new table the next time it is
 * opened.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER, id TEXT PRIMARY KEY, type TEXT NOT NULL, at INTEGER NOT NULL,
  device TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_seq ON events(seq);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, kind TEXT, term TEXT, meaning TEXT, romanization TEXT, notes TEXT,
  introducedAt INTEGER, fsrsCard TEXT NOT NULL, reviewCount INTEGER NOT NULL DEFAULT 0,
  correctCount INTEGER NOT NULL DEFAULT 0, recentGrades TEXT NOT NULL DEFAULT '[]',
  lastReviewedAt INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, itemId TEXT NOT NULL, at INTEGER NOT NULL, grade INTEGER NOT NULL,
  device TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_item ON reviews(itemId, at);
CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, generatedAt INTEGER NOT NULL, topic TEXT,
  reported INTEGER NOT NULL DEFAULT 0, timesServed INTEGER NOT NULL DEFAULT 0,
  lastServedAt INTEGER);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, challengeId TEXT NOT NULL, verdict TEXT NOT NULL,
  answerGiven TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS results_at ON results(at);

CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, count INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tombstones (itemId TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS profile (
  id TEXT PRIMARY KEY, nativeLanguage TEXT, targetLanguage TEXT, level TEXT, interests TEXT,
  about TEXT, model TEXT, createdAt INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, topic TEXT,
  sentences TEXT NOT NULL, glossary TEXT NOT NULL, createdAt INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS textTombstones (textId TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS wordMarks (
  term TEXT PRIMARY KEY, known INTEGER NOT NULL, updatedAt INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS lookups (
  id TEXT PRIMARY KEY, term TEXT NOT NULL, itemId TEXT, textId TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lookups_term ON lookups(term, at);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, scenario TEXT NOT NULL, topic TEXT, createdAt INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS conversationTurns (
  conversationId TEXT NOT NULL, idx INTEGER NOT NULL, learner TEXT, teacher TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (conversationId, idx));

CREATE TABLE IF NOT EXISTS conversationTombstones (conversationId TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** The `profile` table holds exactly one row under this key. */
export const PROFILE_ID = 'singleton';

/**
 * How many recent reviews `items.recentGrades` keeps.
 *
 * Matches `HISTORY_CAP` in `src/routes/words/+page.svelte` — the tick strip is
 * the only thing that renders them, and it shows at most this many.
 */
export const RECENT_GRADES_CAP = 40;

/**
 * Identity of one review: `(itemId, at, device)`.
 *
 * Not the originating event id — that is what makes two devices that recorded
 * the same review collapse to one row instead of counting it twice.
 */
export function reviewKey(itemId: string, at: number, device: string): string {
	return `${itemId}|${at}|${device}`;
}

/** Every read table the materializer owns; `events` and `meta` survive a rebuild. */
export const DERIVED_TABLES = [
	'items',
	'reviews',
	'challenges',
	'results',
	'daily',
	'tombstones',
	'profile',
	'texts',
	'textTombstones',
	'wordMarks',
	'lookups',
	'conversations',
	'conversationTurns',
	'conversationTombstones'
] as const;
