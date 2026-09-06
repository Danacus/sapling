//! The merge rules: one event in, read-model rows out — `src/lib/db/materialize.ts`.
//!
//! Dedupe happens at the log ([`Materializer::ingest`]): an event whose id is
//! already in `events` is never materialised twice. Everything here is total —
//! a rule that cannot apply returns instead of failing — because the
//! alternative is an import or a sync page that stops halfway. The one thing
//! that does fail is a card the scheduler cannot fold, which the TypeScript
//! throws on too.
//!
//! The SQL text is the TypeScript's, statement for statement.

use serde_json::{json, Value};

use crate::day::LocalDay;
use crate::events::{
    ChallengeAdded, ChallengeReported, ChallengeServed, ConversationDeleted, EventType, ItemAdded,
    ItemDeleted, ItemReviewed, ItemUpdated, Payload, ReviewAmended, SyncEvent, TextDeleted,
    WordLookedUp, WordMarked, PATCHABLE_COLUMNS,
};
use crate::js;
use crate::schema::{
    review_key, DDL, DERIVED_SCHEMA_VERSION, DERIVED_TABLES, PROFILE_ID, RECENT_GRADES_CAP,
};
use crate::sql::{Error, Param, Result, Row, Sql};
use crate::srs::{new_card_state, review_card, FsrsCardState, Grade, GOOD};
use crate::types::{ChallengeResult, Conversation, ConversationExchange, Profile, ReadingText};

/// Replay order: the backend's `seq`, then local insertion order for whatever
/// this device has not pushed yet. Not `at` — see the TypeScript for why.
pub const LOG_ORDER: &str = "seq IS NULL, seq, rowid";

/// The challenge types this build knows how to play; an unknown type costs one
/// skipped row and the event stays in the log for a later build.
const CHALLENGE_TYPES: [&str; 6] = [
    "multiple-choice",
    "cloze",
    "typed-translation",
    "match-pairs",
    "word-order",
    "spot-error",
];

/// The rules, bound to a database and a calendar.
#[derive(Clone, Copy)]
pub struct Materializer<'a> {
    pub sql: &'a dyn Sql,
    pub day: &'a dyn LocalDay,
}

struct ReviewFold {
    at: f64,
    grade: f64,
}

fn folds(rows: &[Row]) -> Result<Vec<ReviewFold>> {
    rows.iter()
        .map(|row| {
            Ok(ReviewFold {
                at: row.f64("at")?,
                grade: row.f64("grade")?,
            })
        })
        .collect()
}

/// The bulk-read aggregates every `items` row carries: `(correctCount, recentGrades)`.
fn aggregates(rows: &[ReviewFold]) -> (i64, String) {
    let correct = rows.iter().filter(|row| row.grade >= GOOD).count() as i64;
    let recent: Vec<Value> = rows
        .iter()
        .skip(rows.len().saturating_sub(RECENT_GRADES_CAP))
        .map(|row| json!({ "at": row.at, "grade": row.grade }))
        .collect();
    (correct, js::stringify(&Value::Array(recent)))
}

fn card_json(card: &FsrsCardState) -> Result<String> {
    Ok(js::stringify(&serde_json::to_value(card)?))
}

fn parse_card(text: &str) -> Result<FsrsCardState> {
    Ok(serde_json::from_str(text)?)
}

fn scheduler_error(message: String) -> Error {
    Error(message)
}

impl<'a> Materializer<'a> {
    pub fn new(sql: &'a dyn Sql, day: &'a dyn LocalDay) -> Materializer<'a> {
        Materializer { sql, day }
    }

    fn exists(&self, sql: &str, params: &[Param]) -> Result<bool> {
        Ok(!self.sql.query(sql, params)?.is_empty())
    }

    fn write_fold(&self, item_id: &str, introduced_at: f64, rows: &[ReviewFold]) -> Result<()> {
        let mut card = new_card_state(introduced_at);
        for row in rows {
            let grade = Grade::from_f64(row.grade).map_err(scheduler_error)?;
            card = review_card(&card, grade, row.at).map_err(scheduler_error)?;
        }
        let (correct_count, recent_grades) = aggregates(rows);
        self.sql.exec(
            "UPDATE items
		 SET fsrsCard = ?, reviewCount = ?, correctCount = ?, recentGrades = ?, lastReviewedAt = ?
		 WHERE id = ?",
            &[
                Param::text(card_json(&card)?),
                Param::Integer(rows.len() as i64),
                Param::Integer(correct_count),
                Param::text(recent_grades),
                Param::opt_number(rows.last().map(|row| row.at)),
                Param::text(item_id),
            ],
        )
    }

    /// Replays an item's reviews from a fresh card. The fold order is `(at, device)`.
    fn refold(&self, item_id: &str) -> Result<()> {
        let item = self.sql.query(
            "SELECT introducedAt FROM items WHERE id = ?",
            &[Param::text(item_id)],
        )?;
        let Some(item) = item.first() else {
            return Ok(());
        };
        let rows = self.sql.query(
            "SELECT at, grade FROM reviews WHERE itemId = ? ORDER BY at, device",
            &[Param::text(item_id)],
        )?;
        self.write_fold(item_id, item.f64("introducedAt")?, &folds(&rows)?)
    }

    fn item_added(&self, p: &ItemAdded) -> Result<()> {
        if self.exists(
            "SELECT 1 FROM tombstones WHERE itemId = ?",
            &[Param::text(&p.id)],
        )? {
            return Ok(());
        }
        if self.exists("SELECT 1 FROM items WHERE id = ?", &[Param::text(&p.id)])? {
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO items (id, kind, term, meaning, romanization, notes, introducedAt, fsrsCard)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Param::text(&p.id),
                Param::text(p.kind.as_str()),
                Param::text(&p.term),
                Param::text(&p.meaning),
                Param::opt_text(p.romanization.as_deref()),
                Param::opt_text(p.notes.as_deref()),
                Param::number(p.introduced_at),
                Param::text(card_json(&new_card_state(p.introduced_at))?),
            ],
        )?;

        // Reviews that arrived before their item are kept, inert; this is where
        // they start counting.
        let rows = self.sql.query(
            "SELECT at, grade FROM reviews WHERE itemId = ? ORDER BY at, device",
            &[Param::text(&p.id)],
        )?;
        if !rows.is_empty() {
            self.write_fold(&p.id, p.introduced_at, &folds(&rows)?)?;
        }

        // Patches that arrived before their item wait in the log; this is where
        // they apply. The row was just written from the add, so no reset is needed.
        for (at, patch) in self.patches_of(&p.id)? {
            self.apply_patch(at, &patch)?;
        }
        Ok(())
    }

    fn item_reviewed(&self, p: &ItemReviewed) -> Result<()> {
        let id = review_key(&p.item_id, p.at, &p.device);
        if self.exists("SELECT 1 FROM reviews WHERE id = ?", &[Param::text(&id)])? {
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO reviews (id, itemId, at, grade, device) VALUES (?, ?, ?, ?, ?)",
            &[
                Param::text(&id),
                Param::text(&p.item_id),
                Param::number(p.at),
                Param::number(p.grade),
                Param::text(&p.device),
            ],
        )?;

        let item = self.sql.query(
            "SELECT fsrsCard, lastReviewedAt, recentGrades FROM items WHERE id = ?",
            &[Param::text(&p.item_id)],
        )?;
        let Some(item) = item.first() else {
            return Ok(());
        };

        // Strictly newest reviews fold onto the stored card; a tie refolds, because
        // two devices reviewing in the same millisecond order by device, not arrival.
        let last_reviewed_at = item.opt_f64("lastReviewedAt")?;
        if last_reviewed_at.is_none_or(|last| p.at > last) {
            let grade = Grade::from_f64(p.grade).map_err(scheduler_error)?;
            let card = review_card(&parse_card(item.text("fsrsCard")?)?, grade, p.at)
                .map_err(scheduler_error)?;
            let mut recent: Vec<Value> = serde_json::from_str(item.text("recentGrades")?)?;
            recent.push(json!({ "at": p.at, "grade": p.grade }));
            let recent = recent.split_off(recent.len().saturating_sub(RECENT_GRADES_CAP));
            self.sql.exec(
                "UPDATE items
			 SET fsrsCard = ?, reviewCount = reviewCount + 1, correctCount = correctCount + ?,
			     recentGrades = ?, lastReviewedAt = ?
			 WHERE id = ?",
                &[
                    Param::text(card_json(&card)?),
                    Param::Integer(if p.grade >= GOOD { 1 } else { 0 }),
                    Param::text(js::stringify(&Value::Array(recent))),
                    Param::number(p.at),
                    Param::text(&p.item_id),
                ],
            )
        } else {
            self.refold(&p.item_id)
        }
    }

    fn review_amended(&self, p: &ReviewAmended) -> Result<()> {
        if let Some(replaces) = p.replaces {
            self.sql.exec(
                "DELETE FROM reviews WHERE id = ?",
                &[Param::text(review_key(&p.item_id, replaces, &p.device))],
            )?;
        }
        self.sql.exec(
            "INSERT OR REPLACE INTO reviews (id, itemId, at, grade, device) VALUES (?, ?, ?, ?, ?)",
            &[
                Param::text(review_key(&p.item_id, p.at, &p.device)),
                Param::text(&p.item_id),
                Param::number(p.at),
                Param::number(p.grade),
                Param::text(&p.device),
            ],
        )?;
        self.refold(&p.item_id)
    }

    /// The `itemUpdated` rows the log holds for one item, in fold order `(at, device)`.
    fn patches_of(&self, item_id: &str) -> Result<Vec<(f64, ItemUpdated)>> {
        let rows = self.sql.query(
            "SELECT at, device, payload FROM events
		 WHERE type = 'itemUpdated' AND json_extract(payload, '$.itemId') = ?
		 ORDER BY at, device",
            &[Param::text(item_id)],
        )?;
        rows.iter()
            .map(|row| Ok((row.f64("at")?, serde_json::from_str(row.text("payload")?)?)))
            .collect()
    }

    /// Writes the fields one patch names; the others keep whatever they hold.
    fn apply_patch(&self, at: f64, p: &ItemUpdated) -> Result<()> {
        let set = p.fields.set();
        if set.is_empty() {
            return Ok(());
        }
        let assignments: Vec<String> = set
            .iter()
            .map(|(column, _)| format!("{column} = ?"))
            .collect();
        let mut params: Vec<Param> = set.iter().map(|(_, value)| Param::text(*value)).collect();
        params.push(Param::number(at));
        params.push(Param::text(&p.item_id));
        self.sql.exec(
            &format!(
                "UPDATE items SET {}, updatedAt = ? WHERE id = ?",
                assignments.join(", ")
            ),
            &params,
        )
    }

    /// Replays an item's patches over the fields its `itemAdded` carried, per field.
    fn refold_patches(&self, item_id: &str) -> Result<()> {
        let base = self.sql.query(
            &format!(
                "SELECT payload FROM events
		 WHERE type = 'itemAdded' AND json_extract(payload, '$.id') = ?
		 ORDER BY {LOG_ORDER} LIMIT 1"
            ),
            &[Param::text(item_id)],
        )?;
        let Some(base) = base.first() else {
            return Ok(());
        };
        let added: ItemAdded = serde_json::from_str(base.text("payload")?)?;
        // Same columns `ItemFields::set` patches, in the same order — see `PATCHABLE_COLUMNS`.
        let values: [Option<&str>; 4] = [
            Some(added.term.as_str()),
            Some(added.meaning.as_str()),
            added.romanization.as_deref(),
            added.notes.as_deref(),
        ];
        let assignments: Vec<String> = PATCHABLE_COLUMNS
            .iter()
            .map(|column| format!("{column} = ?"))
            .collect();
        let mut params: Vec<Param> = values.into_iter().map(Param::opt_text).collect();
        params.push(Param::text(item_id));
        self.sql.exec(
            &format!(
                "UPDATE items SET {}, updatedAt = 0 WHERE id = ?",
                assignments.join(", ")
            ),
            &params,
        )?;
        for (at, patch) in self.patches_of(item_id)? {
            self.apply_patch(at, &patch)?;
        }
        Ok(())
    }

    fn item_updated(&self, at: f64, p: &ItemUpdated) -> Result<()> {
        let row = self.sql.query(
            "SELECT updatedAt FROM items WHERE id = ?",
            &[Param::text(&p.item_id)],
        )?;
        // No row yet: the patch waits in the log, and `itemAdded` folds it in.
        let Some(row) = row.first() else {
            return Ok(());
        };
        // Strictly newest patches apply straight onto the row; a tie refolds,
        // because two devices patching in the same millisecond order by
        // device, not arrival — matching `patches_of`'s `(at, device)` order.
        if at > row.f64("updatedAt")? {
            self.apply_patch(at, p)
        } else {
            self.refold_patches(&p.item_id)
        }
    }

    fn item_deleted(&self, p: &ItemDeleted) -> Result<()> {
        let id = Param::text(&p.item_id);
        self.sql.exec(
            "INSERT OR IGNORE INTO tombstones (itemId) VALUES (?)",
            std::slice::from_ref(&id),
        )?;
        self.sql.exec(
            "DELETE FROM reviews WHERE itemId = ?",
            std::slice::from_ref(&id),
        )?;
        self.sql
            .exec("DELETE FROM items WHERE id = ?", std::slice::from_ref(&id))
    }

    fn challenge_added(&self, p: &ChallengeAdded) -> Result<()> {
        let Some(challenge) = p.challenge.as_ref().and_then(Value::as_object) else {
            return Ok(());
        };
        let (Some(id), Some(kind)) = (
            challenge.get("id").and_then(Value::as_str),
            challenge.get("type").and_then(Value::as_str),
        ) else {
            return Ok(());
        };
        if !CHALLENGE_TYPES.contains(&kind) {
            return Ok(());
        }
        self.sql.exec(
            "INSERT OR IGNORE INTO challenges (id, content, generatedAt, topic, reported, timesServed, lastServedAt)
		 VALUES (?, ?, ?, ?, 0, 0, NULL)",
            &[
                Param::text(id),
                Param::text(js::stringify(p.challenge.as_ref().unwrap_or(&Value::Null))),
                Param::number(p.generated_at),
                Param::opt_text(p.topic.as_deref()),
            ],
        )
    }

    fn challenge_served(&self, p: &ChallengeServed) -> Result<()> {
        self.sql.exec(
            "UPDATE challenges
			 SET timesServed = timesServed + 1, lastServedAt = max(coalesce(lastServedAt, ?), ?)
			 WHERE id = ?",
            &[
                Param::number(p.at),
                Param::number(p.at),
                Param::text(&p.challenge_id),
            ],
        )
    }

    fn challenge_reported(&self, p: &ChallengeReported) -> Result<()> {
        self.sql.exec(
            "UPDATE challenges SET reported = 1 WHERE id = ?",
            &[Param::text(&p.challenge_id)],
        )
    }

    fn result_logged(&self, id: &str, p: &ChallengeResult) -> Result<()> {
        if self.exists("SELECT 1 FROM results WHERE id = ?", &[Param::text(id)])? {
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO results (id, challengeId, verdict, answerGiven, at) VALUES (?, ?, ?, ?, ?)",
            &[
                Param::text(id),
                Param::text(&p.challenge_id),
                Param::text(p.verdict.as_str()),
                Param::text(&p.answer_given),
                Param::number(p.at),
            ],
        )?;
        self.sql.exec(
            "INSERT INTO daily (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1",
            &[Param::text(self.day.local_day(p.at))],
        )
    }

    fn profile_updated(&self, at: f64, p: &Profile) -> Result<()> {
        let row = self.sql.query(
            "SELECT updatedAt FROM profile WHERE id = ?",
            &[Param::text(PROFILE_ID)],
        )?;
        if let Some(row) = row.first() {
            if at < row.f64("updatedAt")? {
                return Ok(());
            }
        }
        self.sql.exec(
            "INSERT OR REPLACE INTO profile
			   (id, nativeLanguage, targetLanguage, level, interests, about, model, createdAt, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Param::text(PROFILE_ID),
                Param::text(&p.native_language),
                Param::text(&p.target_language),
                Param::text(p.level.as_str()),
                Param::text(js::stringify(&serde_json::to_value(&p.interests)?)),
                Param::opt_text(p.about.as_deref()),
                Param::text(&p.model),
                Param::number(p.created_at),
                Param::number(at),
            ],
        )
    }

    fn text_added(&self, p: &ReadingText) -> Result<()> {
        if self.exists(
            "SELECT 1 FROM textTombstones WHERE textId = ?",
            &[Param::text(&p.id)],
        )? {
            return Ok(());
        }
        let media = match &p.media {
            Some(media) => Param::text(js::stringify(&serde_json::to_value(media)?)),
            None => Param::Null,
        };
        self.sql.exec(
            "INSERT OR IGNORE INTO texts (id, title, source, topic, sentences, glossary, media, createdAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                Param::text(&p.id),
                Param::text(&p.title),
                Param::text(p.source.as_str()),
                Param::opt_text(p.topic.as_deref()),
                Param::text(js::stringify(&serde_json::to_value(&p.sentences)?)),
                Param::text(js::stringify(&serde_json::to_value(&p.glossary)?)),
                media,
                Param::number(p.created_at),
            ],
        )
    }

    fn text_deleted(&self, p: &TextDeleted) -> Result<()> {
        let id = Param::text(&p.text_id);
        self.sql.exec(
            "INSERT OR IGNORE INTO textTombstones (textId) VALUES (?)",
            std::slice::from_ref(&id),
        )?;
        self.sql
            .exec("DELETE FROM texts WHERE id = ?", std::slice::from_ref(&id))
    }

    fn word_marked(&self, at: f64, p: &WordMarked) -> Result<()> {
        let term = p.term.trim();
        if term.is_empty() {
            return Ok(());
        }
        let row = self.sql.query(
            "SELECT updatedAt FROM wordMarks WHERE term = ?",
            &[Param::text(term)],
        )?;
        if let Some(row) = row.first() {
            if at < row.f64("updatedAt")? {
                return Ok(());
            }
        }
        self.sql.exec(
            "INSERT OR REPLACE INTO wordMarks (term, known, updatedAt) VALUES (?, ?, ?)",
            &[Param::text(term), Param::flag(p.known), Param::number(at)],
        )
    }

    fn word_looked_up(&self, id: &str, at: f64, p: &WordLookedUp) -> Result<()> {
        let term = p.term.trim();
        if term.is_empty() {
            return Ok(());
        }
        self.sql.exec(
            "INSERT OR IGNORE INTO lookups (id, term, itemId, textId, at) VALUES (?, ?, ?, ?, ?)",
            &[
                Param::text(id),
                Param::text(term),
                Param::opt_text(p.item_id.as_deref()),
                Param::text(&p.text_id),
                Param::number(at),
            ],
        )
    }

    fn conversation_started(&self, p: &Conversation) -> Result<()> {
        if self.exists(
            "SELECT 1 FROM conversationTombstones WHERE conversationId = ?",
            &[Param::text(&p.id)],
        )? {
            return Ok(());
        }
        self.sql.exec(
            "INSERT OR IGNORE INTO conversations (id, scenario, topic, createdAt) VALUES (?, ?, ?, ?)",
            &[
                Param::text(&p.id),
                Param::text(js::stringify(&serde_json::to_value(&p.scenario)?)),
                Param::opt_text(p.topic.as_deref()),
                Param::number(p.created_at),
            ],
        )
    }

    fn turn_added(&self, at: f64, p: &ConversationExchange) -> Result<()> {
        if self.exists(
            "SELECT 1 FROM conversationTombstones WHERE conversationId = ?",
            &[Param::text(&p.conversation_id)],
        )? {
            return Ok(());
        }
        let learner = match &p.learner {
            Some(learner) => Param::text(js::stringify(&serde_json::to_value(learner)?)),
            None => Param::Null,
        };
        self.sql.exec(
            "INSERT OR IGNORE INTO conversationTurns (conversationId, idx, learner, teacher, at)
		 VALUES (?, ?, ?, ?, ?)",
            &[
                Param::text(&p.conversation_id),
                Param::number(p.index),
                learner,
                Param::text(js::stringify(&serde_json::to_value(&p.teacher)?)),
                Param::number(at),
            ],
        )
    }

    fn conversation_deleted(&self, p: &ConversationDeleted) -> Result<()> {
        let id = Param::text(&p.conversation_id);
        self.sql.exec(
            "INSERT OR IGNORE INTO conversationTombstones (conversationId) VALUES (?)",
            std::slice::from_ref(&id),
        )?;
        self.sql.exec(
            "DELETE FROM conversationTurns WHERE conversationId = ?",
            std::slice::from_ref(&id),
        )?;
        self.sql.exec(
            "DELETE FROM conversations WHERE id = ?",
            std::slice::from_ref(&id),
        )
    }

    /// Applies one event's merge rule. Assumes the caller has already deduped by id.
    pub fn apply_event(&self, event: &SyncEvent) -> Result<()> {
        match &event.payload {
            Payload::ItemAdded(p) => self.item_added(p),
            Payload::ItemReviewed(p) => self.item_reviewed(p),
            Payload::ReviewAmended(p) => self.review_amended(p),
            Payload::ItemUpdated(p) => self.item_updated(event.at, p),
            Payload::ItemDeleted(p) => self.item_deleted(p),
            Payload::ChallengeAdded(p) => self.challenge_added(p),
            Payload::ChallengeServed(p) => self.challenge_served(p),
            Payload::ChallengeReported(p) => self.challenge_reported(p),
            Payload::ResultLogged(p) => self.result_logged(&event.id, p),
            Payload::ProfileUpdated(p) => self.profile_updated(event.at, p),
            Payload::TextAdded(p) => self.text_added(p),
            Payload::TextDeleted(p) => self.text_deleted(p),
            Payload::WordMarked(p) => self.word_marked(event.at, p),
            Payload::WordLookedUp(p) => self.word_looked_up(&event.id, event.at, p),
            Payload::ConversationStarted(p) => self.conversation_started(p),
            Payload::TurnAdded(p) => self.turn_added(event.at, p),
            Payload::ConversationDeleted(p) => self.conversation_deleted(p),
        }
    }

    /// Writes one event to the log and materialises it, once.
    ///
    /// An id already present is not re-applied; a remote copy of an event this
    /// device produced only stamps the `seq` the backend gave it.
    pub fn ingest(&self, event: &SyncEvent, seq: Option<f64>) -> Result<()> {
        let existing = self.sql.query(
            "SELECT seq FROM events WHERE id = ?",
            &[Param::text(&event.id)],
        )?;
        if let Some(existing) = existing.first() {
            if let (Some(seq), None) = (seq, existing.opt_f64("seq")?) {
                self.sql.exec(
                    "UPDATE events SET seq = ? WHERE id = ?",
                    &[Param::number(seq), Param::text(&event.id)],
                )?;
            }
            return Ok(());
        }
        self.sql.exec(
            "INSERT INTO events (seq, id, type, at, device, payload) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Param::opt_number(seq),
                Param::text(&event.id),
                Param::text(event.kind.as_str()),
                Param::number(event.at),
                Param::text(&event.device),
                Param::text(event.payload.to_json()),
            ],
        )?;
        self.apply_event(event)
    }

    /// Inserts an event without materialising it — [`Materializer::rebuild`] is what applies it.
    pub fn insert_only(&self, event: &SyncEvent) -> Result<()> {
        self.sql.exec(
            "INSERT OR IGNORE INTO events (seq, id, type, at, device, payload) VALUES (NULL, ?, ?, ?, ?, ?)",
            &[
                Param::text(&event.id),
                Param::text(event.kind.as_str()),
                Param::number(event.at),
                Param::text(&event.device),
                Param::text(event.payload.to_json()),
            ],
        )
    }

    /// Drops every read table's rows and replays the whole log, in [`LOG_ORDER`].
    ///
    /// A stored row whose type or payload this build cannot parse is skipped:
    /// it stays in the log for a build that can.
    pub fn rebuild(&self) -> Result<()> {
        for table in DERIVED_TABLES {
            self.sql.exec(&format!("DELETE FROM {table}"), &[])?;
        }
        let rows = self.sql.query(
            &format!("SELECT id, type, at, device, payload FROM events ORDER BY {LOG_ORDER}"),
            &[],
        )?;
        for row in &rows {
            if let Some(event) = event_from_row(row)? {
                self.apply_event(&event)?;
            }
        }
        Ok(())
    }
}

/// A log row back into an event, or `None` when this build does not know its
/// type or shape.
pub fn event_from_row(row: &Row) -> Result<Option<SyncEvent>> {
    let Some(kind) = EventType::from_name(row.text("type")?) else {
        return Ok(None);
    };
    let raw: Value = serde_json::from_str(row.text("payload")?)?;
    let Some(payload) = crate::events::parse_payload(kind, &raw) else {
        return Ok(None);
    };
    Ok(Some(SyncEvent {
        id: row.text("id")?.to_owned(),
        kind,
        at: row.f64("at")?,
        device: row.text("device")?.to_owned(),
        payload,
    }))
}

/// Applies the DDL and brings the read tables up to `DERIVED_SCHEMA_VERSION`.
///
/// `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly as it was, so
/// when a derived table changes shape the version in `meta` is what notices:
/// on a mismatch every read table is dropped, recreated and replayed from the
/// log, in one transaction. A fresh database takes the same path over an empty
/// log, which is how the version row first gets written.
pub fn open_schema(sql: &dyn Sql, day: &dyn LocalDay) -> Result<()> {
    sql.exec(DDL, &[])?;
    let version = DERIVED_SCHEMA_VERSION.to_string();
    let stored = sql.query("SELECT value FROM meta WHERE key = 'derivedSchema'", &[])?;
    if let Some(row) = stored.first() {
        if row.opt_text("value")? == Some(version.as_str()) {
            return Ok(());
        }
    }

    sql.exec("BEGIN", &[])?;
    let outcome = (|| {
        for table in DERIVED_TABLES {
            sql.exec(&format!("DROP TABLE IF EXISTS {table}"), &[])?;
        }
        sql.exec(DDL, &[])?;
        Materializer::new(sql, day).rebuild()?;
        sql.exec(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('derivedSchema', ?)",
            &[Param::text(&version)],
        )
    })();
    match outcome {
        Ok(()) => sql.exec("COMMIT", &[]),
        Err(error) => {
            sql.exec("ROLLBACK", &[])?;
            Err(error)
        }
    }
}
