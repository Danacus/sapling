//! The backend, implemented: every `Backend` method as one synchronous pass
//! over SQLite — `src/lib/db/core.ts`.
//!
//! Every write is an event: `commit` mints an envelope and hands it to the
//! materializer's `ingest`, so there is no row-then-event pair to keep in
//! agreement. Each method is one transaction.
//!
//! The four things the TypeScript reads from its runtime arrive here as
//! arguments instead, because a crate has none of them: the device id (a
//! `localStorage` fact), the clock, an id generator (`crypto.randomUUID`), and
//! the calendar ([`LocalDay`]). A host supplies all four; the golden fixtures
//! pin them.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::de::value::{Error as EnumError, StrDeserializer};
use serde::de::IntoDeserializer;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::day::LocalDay;
use crate::events::{
    parse_envelope, ChallengeAdded, ChallengeReported, ChallengeServed, ConversationDeleted,
    ItemAdded, ItemDeleted, ItemFields, ItemReviewed, ItemUpdated, Payload, RawEvent,
    ReviewAmended, SyncEvent, TextDeleted, WordLookedUp, WordMarked,
};
use crate::js;
use crate::materialize::{open_schema, raw_from_row, Materializer, LOG_ORDER};
use crate::schema::{DERIVED_TABLES, PROFILE_ID};
use crate::sql::{Error, Param, Result, Row, Sql};
use crate::srs::{item_srs, FsrsCardState};
use crate::types::{
    ChallengeResult, Conversation, ConversationDetail, ConversationExchange,
    ConversationLearnerTurn, ConversationSummary, ConversationTeacherTurn, DailyActivity,
    GradeEntry, HistoryEntry, KnowledgeItem, Profile, ReadingText, Verdict,
};

/// Envelope version `export_data` writes and a v3 `import_data` reads.
pub const EXPORT_VERSION: f64 = 3.0;

/// Envelope versions `import_data` still restores from.
const LEGACY_IMPORT_VERSIONS: [f64; 2] = [1.0, 2.0];

const PULL_CURSOR_KEY: &str = "pullCursor";

/// Columns `get_all_items` reads by default — everything but `recentGrades`.
const ITEM_COLUMNS_LEAN: &str =
    "id, kind, term, meaning, romanization, notes, introducedAt, fsrsCard, reviewCount, correctCount";

/// `reviewItem`'s answer: whether the item was there, the card as it stood, and
/// the card this review folded to.
///
/// `card` is read back after the commit rather than predicted, because
/// predicting it is exactly what the frontend no longer can: there is one FSRS
/// and it lives in `srs.rs`. Both are `null` for an item that is not there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewOutcome {
    pub existed: bool,
    pub prior: Value,
    pub card: Value,
}

/// Shape of the JSON `export_data` produces.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportEnvelope {
    pub version: f64,
    pub exported_at: f64,
    pub events: Vec<RawEvent>,
}

/// The backend over an open, schema-applied database.
pub struct Core {
    sql: Box<dyn Sql>,
    device_id: String,
    clock: Box<dyn Fn() -> f64>,
    ids: Box<dyn Fn() -> String>,
    day: Box<dyn LocalDay>,
}

/* -------------------------------------------------------------------------- */
/* Row assembly                                                                */
/* -------------------------------------------------------------------------- */

fn parse_json<T: for<'de> serde::Deserialize<'de>>(text: &str) -> Result<T> {
    Ok(serde_json::from_str(text)?)
}

/// A column that holds one of a closed set of names — `kind`, `verdict`,
/// `source`, `level` — read straight off the borrowed text.
///
/// The stored string *is* the variant name, so quoting it into JSON and parsing
/// the quotes back off (which is what this did, once per row) allocated twice to
/// arrive where serde already was. An unknown name is still the error zod's
/// `z.enum` gave.
fn parse_enum<T: for<'de> serde::Deserialize<'de>>(text: &str) -> Result<T> {
    let name: StrDeserializer<'_, EnumError> = text.into_deserializer();
    T::deserialize(name).map_err(|error| Error(error.to_string()))
}

/// One item row, with the derived schedule numbers attached as of `now`.
///
/// `srs` is computed here rather than in the browser because the browser has no
/// FSRS: it holds grades, opaque cards and timestamps. A card too old or too
/// malformed to parse simply carries no `srs` — a read must not fail over a
/// display number, and every consumer already falls back to "brand new".
fn item_from(row: &Row, history: Vec<HistoryEntry>, now: f64) -> Result<KnowledgeItem> {
    let fsrs_card: Value = parse_json(row.text("fsrsCard")?)?;
    let srs = serde_json::from_value::<FsrsCardState>(fsrs_card.clone())
        .ok()
        .map(|card| item_srs(&card, now));
    Ok(KnowledgeItem {
        id: row.text("id")?.to_owned(),
        kind: parse_enum(row.text("kind")?)?,
        term: row.text("term")?.to_owned(),
        meaning: row.text("meaning")?.to_owned(),
        romanization: row.opt_text("romanization")?.map(str::to_owned),
        notes: row.opt_text("notes")?.map(str::to_owned),
        introduced_at: row.f64("introducedAt")?,
        fsrs_card,
        srs,
        review_count: Some(row.f64("reviewCount")?),
        correct_count: Some(row.f64("correctCount")?),
        recent_grades: if row.has("recentGrades") {
            Some(parse_json::<Vec<GradeEntry>>(row.text("recentGrades")?)?)
        } else {
            None
        },
        history,
    })
}

fn history_from(rows: &[Row]) -> Result<Vec<HistoryEntry>> {
    rows.iter()
        .map(|row| {
            Ok(HistoryEntry {
                at: row.f64("at")?,
                grade: row.f64("grade")?,
                device: Some(row.text("device")?.to_owned()),
            })
        })
        .collect()
}

/// `ChallengeRow`: the stored `Challenge` plus its pool bookkeeping, as one object.
fn challenge_row_from(row: &Row) -> Result<Value> {
    let mut content: Map<String, Value> = parse_json(row.text("content")?)?;
    content.insert("generatedAt".into(), number(row.f64("generatedAt")?));
    content.insert("timesServed".into(), number(row.f64("timesServed")?));
    content.insert(
        "lastServedAt".into(),
        row.opt_f64("lastServedAt")?
            .map(number)
            .unwrap_or(Value::Null),
    );
    content.insert("reported".into(), Value::Bool(row.f64("reported")? == 1.0));
    if let Some(topic) = row.opt_text("topic")? {
        content.insert("topic".into(), Value::String(topic.to_owned()));
    }
    Ok(Value::Object(content))
}

fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn result_from(row: &Row) -> Result<ChallengeResult> {
    Ok(ChallengeResult {
        challenge_id: row.text("challengeId")?.to_owned(),
        verdict: parse_enum(row.text("verdict")?)?,
        answer_given: row.text("answerGiven")?.to_owned(),
        at: row.f64("at")?,
    })
}

fn text_from(row: &Row) -> Result<ReadingText> {
    Ok(ReadingText {
        id: row.text("id")?.to_owned(),
        title: row.text("title")?.to_owned(),
        source: parse_enum(row.text("source")?)?,
        topic: row.opt_text("topic")?.map(str::to_owned),
        sentences: parse_json(row.text("sentences")?)?,
        glossary: parse_json(row.text("glossary")?)?,
        media: match row.opt_text("media")? {
            Some(media) => Some(parse_json(media)?),
            None => None,
        },
        created_at: row.f64("createdAt")?,
    })
}

fn conversation_from(row: &Row) -> Result<Conversation> {
    Ok(Conversation {
        id: row.text("id")?.to_owned(),
        scenario: parse_json(row.text("scenario")?)?,
        topic: row.opt_text("topic")?.map(str::to_owned),
        created_at: row.f64("createdAt")?,
    })
}

fn item_added_fact(item: &KnowledgeItem) -> Payload {
    Payload::ItemAdded(ItemAdded {
        id: item.id.clone(),
        kind: item.kind,
        term: item.term.clone(),
        meaning: item.meaning.clone(),
        romanization: item.romanization.clone(),
        notes: item.notes.clone(),
        introduced_at: item.introduced_at,
    })
}

/// A usable `seq` off a row, even one too malformed to parse as an event.
fn seq_of(raw: &Value) -> Option<f64> {
    let seq = raw.as_object()?.get("seq")?.as_f64()?;
    (seq.fract() == 0.0 && seq > 0.0).then_some(seq)
}

/// `Number.parseInt(value, 10)`: the leading integer, or nothing.
fn parse_int(text: &str) -> Option<f64> {
    let text = text.trim_start();
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<f64>().ok().map(|n| sign * n)
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/* -------------------------------------------------------------------------- */
/* The core                                                                    */
/* -------------------------------------------------------------------------- */

impl Core {
    /// Wraps a database whose schema is already applied — see [`Core::open`].
    pub fn new(
        sql: Box<dyn Sql>,
        device_id: impl Into<String>,
        clock: impl Fn() -> f64 + 'static,
        ids: impl Fn() -> String + 'static,
        day: impl LocalDay + 'static,
    ) -> Core {
        Core {
            sql,
            device_id: device_id.into(),
            clock: Box::new(clock),
            ids: Box::new(ids),
            day: Box::new(day),
        }
    }

    /// Applies the schema (replaying the log if the read tables are stale) and wraps the database.
    pub fn open(
        sql: Box<dyn Sql>,
        device_id: impl Into<String>,
        clock: impl Fn() -> f64 + 'static,
        ids: impl Fn() -> String + 'static,
        day: impl LocalDay + 'static,
    ) -> Result<Core> {
        open_schema(&*sql, &day)?;
        Ok(Core::new(sql, device_id, clock, ids, day))
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    fn materializer(&self) -> Materializer<'_> {
        Materializer::new(&*self.sql, &*self.day)
    }

    /// Runs `body` in one transaction; an error rolls the whole thing back.
    fn transaction<T>(&self, body: impl FnOnce() -> Result<T>) -> Result<T> {
        self.sql.exec("BEGIN", &[])?;
        match body() {
            Ok(value) => {
                self.sql.exec("COMMIT", &[])?;
                Ok(value)
            }
            Err(error) => {
                self.sql.exec("ROLLBACK", &[])?;
                Err(error)
            }
        }
    }

    /// Appends a run of local facts that belong to one action and materialises them — one transaction.
    pub fn commit_all(&self, facts: Vec<Payload>) -> Result<()> {
        if facts.is_empty() {
            return Ok(());
        }
        let at = (self.clock)();
        self.transaction(|| {
            let m = self.materializer();
            for payload in facts {
                let event = SyncEvent {
                    id: (self.ids)(),
                    kind: payload.kind(),
                    at,
                    device: self.device_id.clone(),
                    payload,
                };
                m.ingest(&event, None)?;
            }
            Ok(())
        })
    }

    /// Appends one local fact and materialises it.
    pub fn commit(&self, fact: Payload) -> Result<()> {
        self.commit_all(vec![fact])
    }

    /// A raw read, for tests that inspect a table the protocol does not expose.
    pub fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        self.sql.query(sql, params)
    }

    /* ---- Profile ------------------------------------------------------ */

    pub fn get_profile(&self) -> Result<Option<Profile>> {
        let rows = self.sql.query(
            "SELECT * FROM profile WHERE id = ?",
            &[Param::text(PROFILE_ID)],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(Some(Profile {
            native_language: row.text("nativeLanguage")?.to_owned(),
            target_language: row.text("targetLanguage")?.to_owned(),
            level: parse_enum(row.text("level")?)?,
            interests: parse_json(row.text("interests")?)?,
            about: row.opt_text("about")?.map(str::to_owned),
            model: row.text("model")?.to_owned(),
            created_at: row.f64("createdAt")?,
        }))
    }

    pub fn save_profile(&self, profile: &Profile) -> Result<()> {
        self.commit(Payload::ProfileUpdated(profile.clone()))
    }

    /* ---- Knowledge items --------------------------------------------- */

    /// Every item, with an empty `history`; `recentGrades` only when asked for.
    ///
    /// The clock is read once for the whole batch, so every row's `srs` is taken
    /// at the same instant — a collection where one word is due and the next is
    /// not because the millisecond turned over mid-`SELECT` would be nonsense.
    pub fn get_all_items(&self, with_recent_grades: bool) -> Result<Vec<KnowledgeItem>> {
        let columns = if with_recent_grades {
            "*"
        } else {
            ITEM_COLUMNS_LEAN
        };
        let now = (self.clock)();
        self.sql
            .query(&format!("SELECT {columns} FROM items"), &[])?
            .iter()
            .map(|row| item_from(row, Vec::new(), now))
            .collect()
    }

    /// One item, with its whole review history attached.
    pub fn get_item(&self, id: &str) -> Result<Option<KnowledgeItem>> {
        let rows = self
            .sql
            .query("SELECT * FROM items WHERE id = ?", &[Param::text(id)])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let history = self.sql.query(
            "SELECT itemId, at, grade, device FROM reviews WHERE itemId = ? ORDER BY at, device",
            &[Param::text(id)],
        )?;
        Ok(Some(item_from(
            row,
            history_from(&history)?,
            (self.clock)(),
        )?))
    }

    /// Inserts or replaces items by id: a new id emits `itemAdded`, a known one `itemUpdated`.
    pub fn upsert_items(&self, items: &[KnowledgeItem]) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let ids: Vec<Param> = items.iter().map(|item| Param::text(&item.id)).collect();
        // A set, not a list: one `upsert_items` can carry a whole imported
        // vocabulary, and a scan per item is the quadratic half of that.
        let known: HashSet<String> = self
            .sql
            .query(
                &format!(
                    "SELECT id FROM items WHERE id IN ({})",
                    placeholders(items.len())
                ),
                &ids,
            )?
            .iter()
            .map(|row| Ok(row.text("id")?.to_owned()))
            .collect::<Result<_>>()?;
        let facts = items
            .iter()
            .map(|item| {
                if known.contains(&item.id) {
                    Payload::ItemUpdated(ItemUpdated {
                        item_id: item.id.clone(),
                        fields: ItemFields {
                            term: Some(item.term.clone()),
                            meaning: Some(item.meaning.clone()),
                            romanization: item.romanization.clone(),
                            notes: item.notes.clone(),
                        },
                    })
                } else {
                    item_added_fact(item)
                }
            })
            .collect();
        self.commit_all(facts)
    }

    pub fn delete_item(&self, id: &str) -> Result<()> {
        self.commit(Payload::ItemDeleted(ItemDeleted {
            item_id: id.to_owned(),
        }))
    }

    /// Folds a review into an item; with `replace_last`, it supersedes the newest one.
    pub fn review_item(
        &self,
        id: &str,
        at: f64,
        grade: f64,
        replace_last: bool,
    ) -> Result<ReviewOutcome> {
        let rows = self.sql.query(
            "SELECT fsrsCard FROM items WHERE id = ?",
            &[Param::text(id)],
        )?;
        let Some(row) = rows.first() else {
            return Ok(ReviewOutcome {
                existed: false,
                prior: Value::Null,
                card: Value::Null,
            });
        };
        let prior: Value = parse_json(row.text("fsrsCard")?)?;

        let replaced = if replace_last {
            self.sql
                .query(
                    "SELECT at FROM reviews WHERE itemId = ? ORDER BY at DESC, device DESC LIMIT 1",
                    &[Param::text(id)],
                )?
                .first()
                .map(|row| row.f64("at"))
                .transpose()?
        } else {
            None
        };

        match replaced {
            Some(replaces) => self.commit(Payload::ReviewAmended(ReviewAmended {
                device: self.device_id.clone(),
                at,
                item_id: id.to_owned(),
                grade,
                replaces: Some(replaces),
            }))?,
            None => self.commit(Payload::ItemReviewed(ItemReviewed {
                device: self.device_id.clone(),
                at,
                item_id: id.to_owned(),
                grade,
            }))?,
        }
        // The materializer has folded by now — including the full refold a
        // `reviewAmended` triggers — so this is the stored card, not a guess at it.
        let card: Value = self
            .sql
            .query(
                "SELECT fsrsCard FROM items WHERE id = ?",
                &[Param::text(id)],
            )?
            .first()
            .map(|row| parse_json(row.text("fsrsCard")?))
            .transpose()?
            .unwrap_or(Value::Null);

        Ok(ReviewOutcome {
            existed: true,
            prior,
            card,
        })
    }

    /* ---- Challenge pool ---------------------------------------------- */

    /// Adds a freshly generated batch to the pool, `generatedAt` offset by index.
    pub fn add_to_pool(
        &self,
        challenges: &[Value],
        now: Option<f64>,
        topic: Option<&str>,
    ) -> Result<()> {
        if challenges.is_empty() {
            return Ok(());
        }
        let now = now.unwrap_or_else(|| (self.clock)());
        let trimmed = topic.map(str::trim).filter(|t| !t.is_empty());
        let facts = challenges
            .iter()
            .enumerate()
            .map(|(index, challenge)| {
                Payload::ChallengeAdded(ChallengeAdded {
                    challenge: Some(challenge.clone()),
                    generated_at: now + index as f64,
                    topic: trimmed.map(str::to_owned),
                })
            })
            .collect();
        self.commit_all(facts)
    }

    /// Every challenge the learner could still be shown — reported rows dropped.
    pub fn get_pool(&self) -> Result<Vec<Value>> {
        self.sql
            .query("SELECT * FROM challenges WHERE reported = 0", &[])?
            .iter()
            .map(challenge_row_from)
            .collect()
    }

    pub fn pool_size(&self) -> Result<f64> {
        let rows = self.sql.query(
            "SELECT count(*) AS count FROM challenges WHERE reported = 0",
            &[],
        )?;
        rows.first().map(|row| row.f64("count")).unwrap_or(Ok(0.0))
    }

    /// Stamps a challenge as served. A missing id is a no-op.
    pub fn record_serve(&self, id: &str, now: Option<f64>) -> Result<()> {
        let known = self
            .sql
            .query("SELECT 1 FROM challenges WHERE id = ?", &[Param::text(id)])?;
        if known.is_empty() {
            return Ok(());
        }
        self.commit(Payload::ChallengeServed(ChallengeServed {
            challenge_id: id.to_owned(),
            at: now.unwrap_or_else(|| (self.clock)()),
        }))
    }

    pub fn report_challenge(&self, id: &str) -> Result<()> {
        self.commit(Payload::ChallengeReported(ChallengeReported {
            challenge_id: id.to_owned(),
        }))
    }

    /// Looks challenges up by id, reported ones included. Ids that no longer exist are absent.
    pub fn get_challenges_by_ids(&self, ids: &[String]) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let params: Vec<Param> = ids.iter().map(Param::text).collect();
        self.sql
            .query(
                &format!(
                    "SELECT content FROM challenges WHERE id IN ({})",
                    placeholders(ids.len())
                ),
                &params,
            )?
            .iter()
            .map(|row| parse_json(row.text("content")?))
            .collect()
    }

    /* ---- Results ----------------------------------------------------- */

    pub fn add_result(&self, result: &ChallengeResult) -> Result<()> {
        self.commit(Payload::ResultLogged(result.clone()))
    }

    /// The most recent results, newest first.
    pub fn recent_results(&self, limit: i64) -> Result<Vec<ChallengeResult>> {
        if limit <= 0 {
            return Ok(Vec::new());
        }
        self.sql
            .query(
                "SELECT * FROM results ORDER BY at DESC LIMIT ?",
                &[Param::Integer(limit)],
            )?
            .iter()
            .map(result_from)
            .collect()
    }

    /// What the learner did on each local calendar day, oldest day first.
    ///
    /// Folded at read time from the four base tables rather than kept as an
    /// aggregate: a day is *any* day something happened — an answer, a review
    /// from reading, a lookup, a word added — and four counters maintained by
    /// four materializers would be four things to keep agreeing. The tables are
    /// small (a review a second for a year is still a few hundred thousand
    /// rows) and the day boundary is the host's, through `LocalDay`, which SQL
    /// cannot be asked to draw.
    pub fn get_daily_activity(&self) -> Result<Vec<DailyActivity>> {
        let mut days: BTreeMap<String, DailyActivity> = BTreeMap::new();
        let day_of = |at: f64, days: &mut BTreeMap<String, DailyActivity>| -> String {
            let day = self.day.local_day(at);
            days.entry(day.clone()).or_insert_with(|| DailyActivity {
                day: day.clone(),
                count: 0.0,
                correct: 0.0,
                almost: 0.0,
                wrong: 0.0,
                reviewed: 0.0,
                lookups: 0.0,
                added: 0.0,
            });
            day
        };

        for row in self
            .sql
            .query("SELECT at, verdict FROM results", &[])?
            .iter()
        {
            let day = day_of(row.f64("at")?, &mut days);
            let entry = days.get_mut(&day).expect("just inserted");
            entry.count += 1.0;
            match parse_enum::<Verdict>(row.text("verdict")?)? {
                Verdict::Correct => entry.correct += 1.0,
                Verdict::Almost => entry.almost += 1.0,
                Verdict::Wrong => entry.wrong += 1.0,
            }
        }

        // Distinct words, not reviews: a word drilled three times in one
        // session was one word's worth of work that day. Only words still in
        // the garden — a forgotten word takes its history with it everywhere
        // else, and a review row for an item the log never added (or one whose
        // tombstone arrived first) is present or absent by arrival order, which
        // a read must not expose.
        let mut reviewed: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for row in self
            .sql
            .query(
                "SELECT r.itemId AS itemId, r.at AS at FROM reviews r
                 JOIN items i ON i.id = r.itemId",
                &[],
            )?
            .iter()
        {
            let day = day_of(row.f64("at")?, &mut days);
            reviewed
                .entry(day)
                .or_default()
                .insert(row.text("itemId")?.to_owned());
        }
        for (day, items) in reviewed {
            days.get_mut(&day).expect("just inserted").reviewed = items.len() as f64;
        }

        for row in self.sql.query("SELECT at FROM lookups", &[])?.iter() {
            let day = day_of(row.f64("at")?, &mut days);
            days.get_mut(&day).expect("just inserted").lookups += 1.0;
        }

        for row in self
            .sql
            .query(
                "SELECT introducedAt FROM items WHERE introducedAt IS NOT NULL",
                &[],
            )?
            .iter()
        {
            let day = day_of(row.f64("introducedAt")?, &mut days);
            days.get_mut(&day).expect("just inserted").added += 1.0;
        }

        Ok(days.into_values().collect())
    }

    /* ---- Reading texts, word marks and lookups ----------------------- */

    pub fn add_text(&self, text: &ReadingText) -> Result<()> {
        self.commit(Payload::TextAdded(text.clone()))
    }

    /// Every stored text, newest first.
    pub fn get_texts(&self) -> Result<Vec<ReadingText>> {
        self.sql
            .query("SELECT * FROM texts ORDER BY createdAt DESC", &[])?
            .iter()
            .map(text_from)
            .collect()
    }

    pub fn get_text(&self, id: &str) -> Result<Option<ReadingText>> {
        let rows = self
            .sql
            .query("SELECT * FROM texts WHERE id = ?", &[Param::text(id)])?;
        rows.first().map(text_from).transpose()
    }

    pub fn delete_text(&self, id: &str) -> Result<()> {
        self.commit(Payload::TextDeleted(TextDeleted {
            text_id: id.to_owned(),
        }))
    }

    /// Marks a word known, or takes the mark back. Terms are stored trimmed.
    pub fn mark_word(&self, term: &str, known: bool) -> Result<()> {
        let trimmed = term.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        self.commit(Payload::WordMarked(WordMarked {
            term: trimmed.to_owned(),
            known,
        }))
    }

    pub fn get_known_terms(&self) -> Result<Vec<String>> {
        self.sql
            .query("SELECT term FROM wordMarks WHERE known = 1", &[])?
            .iter()
            .map(|row| Ok(row.text("term")?.to_owned()))
            .collect()
    }

    /// Records that the learner opened a word's card. Write-only for now.
    pub fn record_lookup(&self, term: &str, text_id: &str, item_id: Option<&str>) -> Result<()> {
        let trimmed = term.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        self.commit(Payload::WordLookedUp(WordLookedUp {
            term: trimmed.to_owned(),
            item_id: item_id.map(str::to_owned),
            text_id: text_id.to_owned(),
        }))
    }

    /* ---- Conversations ----------------------------------------------- */

    pub fn add_conversation(&self, conversation: &Conversation) -> Result<()> {
        self.commit(Payload::ConversationStarted(conversation.clone()))
    }

    pub fn add_exchange(&self, exchange: &ConversationExchange) -> Result<()> {
        self.commit(Payload::TurnAdded(exchange.clone()))
    }

    /// Every conversation, newest first, each with its turn count and last activity.
    pub fn get_conversations(&self) -> Result<Vec<ConversationSummary>> {
        self.sql
            .query(
                "SELECT c.id, c.scenario, c.topic, c.createdAt,
				        count(t.idx) AS turnCount, max(t.at) AS lastTurnAt
				 FROM conversations c
				 LEFT JOIN conversationTurns t ON t.conversationId = c.id
				 GROUP BY c.id
				 ORDER BY c.createdAt DESC",
                &[],
            )?
            .iter()
            .map(|row| {
                Ok(ConversationSummary {
                    conversation: conversation_from(row)?,
                    turn_count: row.f64("turnCount")?,
                    last_turn_at: row.opt_f64("lastTurnAt")?,
                })
            })
            .collect()
    }

    /// One conversation and its whole transcript in `idx` order.
    pub fn get_conversation(&self, id: &str) -> Result<Option<ConversationDetail>> {
        let rows = self.sql.query(
            "SELECT * FROM conversations WHERE id = ?",
            &[Param::text(id)],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        // Read by id rather than joined, so a turn that outran its
        // `conversationStarted` across a sync is still picked up once the scene lands.
        let turns = self.sql.query(
            "SELECT idx, learner, teacher FROM conversationTurns WHERE conversationId = ? ORDER BY idx",
            &[Param::text(id)],
        )?;
        let exchanges = turns
            .iter()
            .map(|turn| {
                Ok(ConversationExchange {
                    conversation_id: id.to_owned(),
                    index: turn.f64("idx")?,
                    learner: match turn.opt_text("learner")? {
                        Some(learner) => Some(parse_json::<ConversationLearnerTurn>(learner)?),
                        None => None,
                    },
                    teacher: parse_json::<ConversationTeacherTurn>(turn.text("teacher")?)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(ConversationDetail {
            conversation: conversation_from(row)?,
            exchanges,
        }))
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.commit(Payload::ConversationDeleted(ConversationDeleted {
            conversation_id: id.to_owned(),
        }))
    }

    /* ---- Export / import --------------------------------------------- */

    /// Empties the whole database, log included.
    pub fn reset_data(&self) -> Result<()> {
        self.transaction(|| {
            for table in DERIVED_TABLES.iter().chain(["events", "meta"].iter()) {
                self.sql.exec(&format!("DELETE FROM {table}"), &[])?;
            }
            Ok(())
        })
    }

    /// Log rows as the log holds them — every row the query returned, in its
    /// order, payloads uninterpreted.
    ///
    /// Push and export both read through here, and neither may ask whether this
    /// build understands a row: one it cannot type still has to reach the
    /// server and still has to appear in a backup file, or a device that never
    /// learned an event kind quietly becomes where those events go to die.
    fn log_events(&self, sql: &str, params: &[Param]) -> Result<Vec<RawEvent>> {
        self.sql
            .query(sql, params)?
            .iter()
            .map(raw_from_row)
            .collect()
    }

    /// The whole log as JSON, in log order — `JSON.stringify(envelope, null, 2)`.
    pub fn export_data(&self) -> Result<String> {
        let envelope = ExportEnvelope {
            version: EXPORT_VERSION,
            exported_at: (self.clock)(),
            events: self.log_events(
                &format!("SELECT id, type, at, device, payload FROM events ORDER BY {LOG_ORDER}"),
                &[],
            )?,
        };
        Ok(js::stringify_pretty(&serde_json::to_value(&envelope)?, 2))
    }

    /// Restores a dump: a v3 file is unioned into the log and the read model
    /// rebuilt; a v1/v2 file replaces the item list wholesale.
    pub fn import_data(&self, json: &str) -> Result<()> {
        let parsed: Value = serde_json::from_str(json)
            .map_err(|_| Error("Import failed: the file is not valid JSON.".into()))?;
        let Some(object) = parsed.as_object() else {
            return Err(Error("Import failed: unexpected file contents.".into()));
        };
        let version = object.get("version").and_then(Value::as_f64);

        if version == Some(EXPORT_VERSION) {
            let Some(raw_events) = object.get("events").and_then(Value::as_array) else {
                return Err(Error("Import failed: missing event list.".into()));
            };
            let events: Vec<RawEvent> = raw_events.iter().filter_map(parse_envelope).collect();
            return self.transaction(|| {
                let m = self.materializer();
                for event in &events {
                    m.insert_only(event)?;
                }
                m.rebuild()
            });
        }

        match version {
            Some(v) if LEGACY_IMPORT_VERSIONS.contains(&v) => self.import_legacy(object),
            _ => Err(Error(format!(
                "Import failed: unsupported export version {}.",
                object
                    .get("version")
                    .map(js::stringify)
                    .unwrap_or_else(|| "undefined".into())
            ))),
        }
    }

    /// v1/v2: replaces the item list wholesale, as those envelopes meant.
    fn import_legacy(&self, parsed: &Map<String, Value>) -> Result<()> {
        let Some(items) = parsed.get("items").and_then(Value::as_array) else {
            return Err(Error("Import failed: missing item list.".into()));
        };
        let profile = match parsed.get("profile") {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => Some(serde_json::from_value::<Profile>(
                parsed["profile"].clone(),
            )?),
            Some(_) => return Err(Error("Import failed: malformed profile.".into())),
        };
        let items: Vec<KnowledgeItem> = items
            .iter()
            .map(|item| Ok(serde_json::from_value(item.clone())?))
            .collect::<Result<_>>()?;

        let mut facts = Vec::new();
        for row in self.sql.query("SELECT id FROM items", &[])? {
            facts.push(Payload::ItemDeleted(ItemDeleted {
                item_id: row.text("id")?.to_owned(),
            }));
        }
        for item in &items {
            facts.push(item_added_fact(item));
            for entry in &item.history {
                facts.push(Payload::ItemReviewed(ItemReviewed {
                    device: entry
                        .device
                        .clone()
                        .unwrap_or_else(|| self.device_id.clone()),
                    at: entry.at,
                    item_id: item.id.clone(),
                    grade: entry.grade,
                }));
            }
        }

        self.commit_all(facts)?;
        match profile {
            Some(profile) => self.save_profile(&profile),
            None => Ok(()),
        }
    }

    /* ---- Sync -------------------------------------------------------- */

    /// Up to `limit` events the server has not acknowledged, in log order.
    ///
    /// Exactly the first `limit` unpushed rows, with no gaps: a row this build
    /// cannot type is pushed like any other, so nothing behind it starves
    /// behind a page that never empties.
    pub fn pending_events(&self, limit: i64) -> Result<Vec<RawEvent>> {
        self.log_events(
            &format!(
                "SELECT id, type, at, device, payload FROM events
					 WHERE seq IS NULL ORDER BY {LOG_ORDER} LIMIT ?"
            ),
            &[Param::Integer(limit)],
        )
    }

    /// Stamps the `seq` the server assigned each id. Returns how many were stamped.
    pub fn mark_pushed(&self, seqs: &[(String, f64)]) -> Result<usize> {
        self.transaction(|| {
            for (id, seq) in seqs {
                self.sql.exec(
                    "UPDATE events SET seq = ? WHERE id = ?",
                    &[Param::number(*seq), Param::text(id)],
                )?;
            }
            Ok(seqs.len())
        })
    }

    /// Applies a page pulled from the server, in arrival order. Rows are raw:
    /// one that is not an envelope at all, or carries no `seq`, is skipped.
    /// Returns how many reached the log.
    ///
    /// A payload this build cannot read costs its merge rule and nothing else —
    /// the row lands in the log, is pushed on and exported like the rest, and a
    /// build that knows the kind materialises it on its next rebuild.
    pub fn apply_remote(&self, events: &[Value]) -> Result<usize> {
        self.transaction(|| {
            let m = self.materializer();
            let mut applied = 0;
            for raw in events {
                let (Some(seq), Some(event)) = (seq_of(raw), parse_envelope(raw)) else {
                    continue;
                };
                m.ingest_raw(&event, Some(seq))?;
                applied += 1;
            }
            Ok(applied)
        })
    }

    /// The pull cursor: the highest `seq` whose page has been applied, `0` before the first.
    pub fn get_pull_cursor(&self) -> Result<f64> {
        let rows = self.sql.query(
            "SELECT value FROM meta WHERE key = ?",
            &[Param::text(PULL_CURSOR_KEY)],
        )?;
        Ok(rows
            .first()
            .and_then(|row| row.opt_text("value").ok().flatten())
            .and_then(parse_int)
            .unwrap_or(0.0))
    }

    pub fn set_pull_cursor(&self, cursor: f64) -> Result<()> {
        self.sql.exec(
            "INSERT INTO meta (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            &[
                Param::text(PULL_CURSOR_KEY),
                Param::text(js::number_to_string(cursor)),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ItemKind, Level, TextSource, Verdict};

    #[test]
    fn parse_enum_takes_the_stored_name_and_refuses_anything_else() {
        assert_eq!(parse_enum::<ItemKind>("vocab").unwrap(), ItemKind::Vocab);
        assert_eq!(parse_enum::<Verdict>("almost").unwrap(), Verdict::Almost);
        assert_eq!(parse_enum::<Level>("advanced").unwrap(), Level::Advanced);
        assert_eq!(
            parse_enum::<TextSource>("imported").unwrap(),
            TextSource::Imported
        );
        assert!(parse_enum::<ItemKind>("Vocab").is_err());
        assert!(parse_enum::<Verdict>("").is_err());
        assert!(parse_enum::<Level>("\"beginner\"").is_err());
    }

    #[test]
    fn parse_int_reads_a_leading_integer_like_javascript() {
        assert_eq!(parse_int("42"), Some(42.0));
        assert_eq!(parse_int("12abc"), Some(12.0));
        assert_eq!(parse_int("-7"), Some(-7.0));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn seq_of_wants_a_positive_integer() {
        assert_eq!(seq_of(&serde_json::json!({ "seq": 3 })), Some(3.0));
        assert_eq!(seq_of(&serde_json::json!({ "seq": 0 })), None);
        assert_eq!(seq_of(&serde_json::json!({ "seq": 1.5 })), None);
        assert_eq!(seq_of(&serde_json::json!({ "seq": "3" })), None);
        assert_eq!(seq_of(&serde_json::json!({})), None);
    }

    /// A log with a row this build cannot read sitting in the middle of it —
    /// the version-skew shape: a kind only a newer build writes, and a payload
    /// whose schema has since widened.
    #[cfg(feature = "sqlite")]
    mod pending {
        use super::*;
        use crate::rusqlite_sql::RusqliteSql;
        use crate::Utc;
        use serde_json::json;

        const NOW: f64 = 1_710_000_000_000.0;

        fn core() -> Core {
            Core::open(
                Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
                "dev-test",
                || NOW,
                || "local-1".to_owned(),
                Utc,
            )
            .expect("schema applies")
        }

        /// Four unpushed rows, second and third unreadable. An import writes
        /// the log without a `seq`, which is what makes them pending.
        fn imported() -> Core {
            let core = core();
            let file = json!({
                "version": EXPORT_VERSION,
                "exportedAt": NOW,
                "events": [
                    { "id": "e1", "type": "itemAdded", "at": 1.0, "device": "devA",
                      "payload": { "id": "i1", "kind": "vocab", "term": "书", "meaning": "book", "introducedAt": 1.0 } },
                    { "id": "e2", "type": "wordShelved", "at": 2.0, "device": "devB",
                      "payload": { "term": "水", "shelf": "later" } },
                    { "id": "e3", "type": "itemAdded", "at": 3.0, "device": "devB",
                      "payload": { "id": "i2", "kind": "vocab", "term": "水", "meaning": "water", "notes": null, "introducedAt": 3.0 } },
                    { "id": "e4", "type": "itemDeleted", "at": 4.0, "device": "devA",
                      "payload": { "itemId": "i1" } },
                ]
            });
            core.import_data(&js::stringify(&file)).expect("import");
            core
        }

        fn ids(events: &[RawEvent]) -> Vec<&str> {
            events.iter().map(|e| e.id.as_str()).collect()
        }

        #[test]
        fn a_page_is_the_first_limit_rows_with_no_gap() {
            let core = imported();
            // The old filter ran after `LIMIT`, so a page over a bad row came
            // back short and `pushPending` stopped on it — the rows behind
            // never left the device.
            assert_eq!(ids(&core.pending_events(2).expect("page")), ["e1", "e2"]);
            assert_eq!(
                ids(&core.pending_events(100).expect("page")),
                ["e1", "e2", "e3", "e4"]
            );
        }

        #[test]
        fn a_pushed_page_leaves_the_rows_behind_it_pending() {
            let core = imported();
            let page = core.pending_events(2).expect("page");
            let seqs: Vec<(String, f64)> = page
                .iter()
                .enumerate()
                .map(|(i, e)| (e.id.clone(), i as f64 + 1.0))
                .collect();
            core.mark_pushed(&seqs).expect("mark pushed");
            assert_eq!(ids(&core.pending_events(2).expect("page")), ["e3", "e4"]);
        }

        #[test]
        fn an_unreadable_row_is_pushed_and_exported_verbatim_and_materialises_nothing() {
            let core = imported();
            let exported: Value =
                serde_json::from_str(&core.export_data().expect("export")).expect("export parses");
            let kinds: Vec<&str> = exported["events"]
                .as_array()
                .expect("events is an array")
                .iter()
                .map(|e| e["type"].as_str().expect("a type"))
                .collect();
            assert_eq!(
                kinds,
                ["itemAdded", "wordShelved", "itemAdded", "itemDeleted"]
            );
            assert_eq!(
                exported["events"][1]["payload"],
                json!({ "term": "水", "shelf": "later" })
            );
            assert_eq!(exported["events"][2]["payload"]["notes"], Value::Null);

            // `i1` was added and deleted; `i2`'s add is the row that will not
            // parse, so the read model has neither.
            assert!(core.get_all_items(false).expect("items").is_empty());
        }
    }
}
