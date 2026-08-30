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
	'profile'
] as const;
