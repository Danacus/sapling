//! The whole local database, as one DDL string — `src/lib/db/schema.ts`.
//!
//! Two layers: `events` is the facts log, everything under it an aggregate the
//! materializer maintains. The text is the TypeScript's verbatim so the two
//! cores can be diffed statement for statement, and so a database one of them
//! created opens under the other.

pub const DDL: &str = "
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER, id TEXT PRIMARY KEY, type TEXT NOT NULL, at INTEGER NOT NULL,
  device TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS events_type ON events(type);
-- `patches_of` and `refold_patches` look an item's patches and its `itemAdded`
-- up by an id folded into the JSON payload; these partial expression indexes
-- must textually match those queries' `WHERE` clauses or SQLite won't use
-- them, and `IF NOT EXISTS` is what brings an already-open database along.
CREATE INDEX IF NOT EXISTS events_item_updated_item_id
  ON events(json_extract(payload, '$.itemId')) WHERE type = 'itemUpdated';
CREATE INDEX IF NOT EXISTS events_item_added_id
  ON events(json_extract(payload, '$.id')) WHERE type = 'itemAdded';

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
  sentences TEXT NOT NULL, glossary TEXT NOT NULL, media TEXT,
  createdAt INTEGER NOT NULL);

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
";

/// The `profile` table holds exactly one row under this key.
pub const PROFILE_ID: &str = "singleton";

/// How many recent reviews `items.recentGrades` keeps.
pub const RECENT_GRADES_CAP: usize = 40;

/// Identity of one review: `(itemId, at, device)` — not the event id, so two
/// devices that recorded the same review collapse to one row.
pub fn review_key(item_id: &str, at: f64, device: &str) -> String {
    format!("{item_id}|{}|{device}", crate::js::number_to_string(at))
}

/// The shape of the read tables, as a number to bump. Must match the TypeScript.
pub const DERIVED_SCHEMA_VERSION: u32 = 3;

/// Every read table the materializer owns; `events` and `meta` survive a rebuild.
pub const DERIVED_TABLES: [&str; 14] = [
    "items",
    "reviews",
    "challenges",
    "results",
    "daily",
    "tombstones",
    "profile",
    "texts",
    "textTombstones",
    "wordMarks",
    "lookups",
    "conversations",
    "conversationTurns",
    "conversationTombstones",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_key_prints_the_timestamp_as_javascript_does() {
        assert_eq!(review_key("i", 1710061260000.0, "d"), "i|1710061260000|d");
    }
}
