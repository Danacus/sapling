//! The whole local database, as one DDL string.
//!
//! Two layers: `events` is the facts log, everything under it an aggregate the
//! materializer maintains.

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
  lastReviewedAt INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0, skill REAL);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, itemId TEXT NOT NULL, at INTEGER NOT NULL, grade INTEGER NOT NULL,
  device TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_item ON reviews(itemId, at);
CREATE INDEX IF NOT EXISTS reviews_at ON reviews(at);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, generatedAt INTEGER NOT NULL, topic TEXT,
  reported INTEGER NOT NULL DEFAULT 0, timesServed INTEGER NOT NULL DEFAULT 0,
  lastServedAt INTEGER, correction REAL);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, challengeId TEXT NOT NULL, verdict TEXT NOT NULL,
  answerGiven TEXT NOT NULL, at INTEGER NOT NULL, shown TEXT);
CREATE INDEX IF NOT EXISTS results_at ON results(at);
CREATE INDEX IF NOT EXISTS results_challenge ON results(challengeId);

-- The difficulty model's shared numbers (`learned.rs`): `base:<kind>/<help
-- level>` and `slope:<kind>`. A key not here is at its starting value.
CREATE TABLE IF NOT EXISTS difficultyParts (key TEXT PRIMARY KEY, value REAL NOT NULL);
-- One row: the newest answer folded, and whether a full replay is owed.
CREATE TABLE IF NOT EXISTS difficultyFold (
  id INTEGER PRIMARY KEY, at REAL, resultId TEXT, dirty INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS tombstones (itemId TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS profile (
  id TEXT PRIMARY KEY, nativeLanguage TEXT, targetLanguage TEXT, level TEXT, interests TEXT,
  about TEXT, model TEXT, createdAt INTEGER, updatedAt INTEGER NOT NULL DEFAULT 0, aim TEXT);

CREATE TABLE IF NOT EXISTS texts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, topic TEXT,
  segments TEXT NOT NULL, media TEXT,
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

/// Device-local selection. It deliberately does not travel in the event log:
/// choosing Japanese on a phone must not switch a laptop away from Spanish.
pub const ACTIVE_PROFILE_KEY: &str = "activeProfile";

/// How many recent reviews `items.recentGrades` keeps.
pub const RECENT_GRADES_CAP: usize = 40;

/// Identity of one review: `(itemId, at, device)` — not the event id, so two
/// devices that recorded the same review collapse to one row.
///
/// The string is what every device has to agree on, and `at` is a whole
/// millisecond: `f64`'s `Display` prints it without a fraction
/// (`1700000000000`, never `1700000000000.0`), which is also what the old
/// JavaScript core wrote into the rows a device already holds.
pub fn review_key(item_id: &str, at: f64, device: &str) -> String {
    format!("{item_id}|{at}|{device}")
}

/// The shape of the read tables, as a number to bump. The host reads it off the
/// core (`WasmCore.derivedSchemaVersion`), so there is no second copy.
///
/// Bumped for 4 when the SRS moved from the ts-fsrs port to the `fsrs` crate:
/// the numbers a review folds to changed, and a device that kept its stored
/// cards would carry old ones beside new ones, item by item, forever. Rebuilding
/// from the log is what makes every device agree again.
///
/// Bumped for 5 when `texts` traded its `sentences` and `glossary` columns for
/// one `segments` column: the rebuild replays every `textAdded`, old shape
/// included, into the new table.
///
/// Bumped for 6 when `results` gained `shown`, the help level an answer was
/// given at: the rebuild carries it over from every `resultLogged` that has one.
///
/// Bumped for 7 when the difficulty model's numbers became derived data:
/// `items.skill`, `challenges.correction`, `difficultyParts` and
/// `difficultyFold`, replayed from every answer in the log.
///
/// Bumped for 8 when `profile` gained `aim`, the success rate challenges are
/// pitched at.
pub const DERIVED_SCHEMA_VERSION: u32 = 8;

/// Every read table the materializer owns; `events` and `meta` survive a rebuild.
///
/// `daily` (answers per local day) used to be one of these and is gone: the
/// activity read folds the base tables at read time instead, since a day is
/// made of reviews, lookups and added words as much as of answers. A database
/// from before still carries the empty table; nothing reads or drops it.
pub const DERIVED_TABLES: [&str; 15] = [
    "items",
    "reviews",
    "challenges",
    "results",
    "tombstones",
    "profile",
    "texts",
    "textTombstones",
    "wordMarks",
    "lookups",
    "conversations",
    "conversationTurns",
    "conversationTombstones",
    "difficultyParts",
    "difficultyFold",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_key_prints_a_whole_millisecond_without_a_fraction() {
        // The cross-device identity of a review: a `.0` here would split every
        // review this build writes from the same review an older build wrote.
        assert_eq!(review_key("i", 1710061260000.0, "d"), "i|1710061260000|d");
        assert_eq!(review_key("i", 1700000000000.0, "d"), "i|1700000000000|d");
        assert_eq!(review_key("i", 0.0, "d"), "i|0|d");
    }
}
