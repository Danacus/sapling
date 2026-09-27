//! The `Backend` protocol, by name: one call in as `(method, args)`, one JSON
//! answer out.
//!
//! `backend!` below is **the** method table: each entry names a method, its
//! typed arguments, its return type, and the call on `sapling-db`'s [`Core`]
//! that answers it. The same list expands into [`dispatch`] and, under `cargo
//! test`, into the TypeScript `Backend` interface and `BACKEND_METHODS` in
//! `src/lib/db/generated/backend.ts` (`pnpm core:types` writes it at build
//! time; it is never committed). So a method, its
//! arguments and its answer are declared once, and the argument and return
//! types are checked by the compiler against the `Core` call they describe.
//!
//! A host (the wasm build inside the database Worker, a native shell, a server)
//! parses nothing itself — it hands the method name and the argument array here
//! as JSON and gets JSON back, so every transport shares one argument
//! convention and one formatting of the answer (serde_json's compact form).
//!
//! `None` is JavaScript's `undefined`: what a `void` method answers, and what a
//! read answers for a row that is not there (`-> T | undefined` in the table).
//! JSON has no `undefined`, so an argument the caller left out arrives as
//! `null` and is read as absent; the arguments after a `;` are the optional
//! ones, `name?: T` in TypeScript and `Option<T>` in the body.
//!
//! A method may also answer without the database: `importSource` is
//! `sapling-import`'s, and ignores `core`.
//!
//! Where Rust treats a value as opaque JSON because TypeScript owns its shape —
//! a challenge, a pool row, a raw pulled event — the entry says which
//! TypeScript type it is with `as "..."`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use sapling_db::core::LanguageProfile;
use sapling_db::{Core, Error, Result, ReviewOutcome};
use sapling_domain::events::{parse_payload, EventType, Payload, RawEvent};
use sapling_domain::types::{
    ChallengeResult, Conversation, ConversationDetail, ConversationExchange, ConversationSummary,
    DailyActivity, GradeEntry, KnowledgeItem, Profile, ReadingText,
};
use sapling_import::ImportedSource;

#[cfg(test)]
mod typescript;

/// `getAllItems`' options.
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AllItemsOptions {
    /// Attach `recentGrades` to every item — only the words page's tick strip
    /// draws them.
    #[serde(default)]
    #[ts(optional)]
    pub with_recent_grades: Option<bool>,
}

/// `reviewItem`'s options.
#[derive(Debug, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOptions {
    /// Supersede the newest review instead of appending one.
    #[serde(default)]
    #[ts(optional)]
    pub replace_last: Option<bool>,
}

/// The `i`th argument, `null` when the caller passed fewer.
fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

/// A required argument, parsed as `T`.
fn required<T: DeserializeOwned>(method: &str, args: &[Value], i: usize) -> Result<T> {
    let value = arg(args, i);
    if value.is_null() {
        return Err(Error(format!("{method}: argument {i} is missing")));
    }
    serde_json::from_value(value.clone()).map_err(|e| Error(format!("{method}: argument {i}: {e}")))
}

/// An optional argument: `None` when absent, otherwise parsed as `T`.
fn optional<T: DeserializeOwned>(method: &str, args: &[Value], i: usize) -> Result<Option<T>> {
    if arg(args, i).is_null() {
        Ok(None)
    } else {
        required(method, args, i).map(Some)
    }
}

/// A method's answer as JSON: `-> T` is the value, `-> T | undefined` is
/// `None` for a missing row, and no arrow is `void`. The `let` pins the body's
/// type to the one the table declares.
macro_rules! answer {
    ($body:block;) => {{
        let () = $body?;
        Ok(None)
    }};
    ($body:block; $ret:ty;) => {{
        let value: $ret = $body?;
        Ok(Some(serde_json::to_value(value)?))
    }};
    ($body:block; $ret:ty; undefined) => {{
        let value: Option<$ret> = $body?;
        match value {
            Some(value) => Ok(Some(serde_json::to_value(value)?)),
            None => Ok(None),
        }
    }};
}

/// A type's TypeScript name: the `as "..."` override when the entry gives one.
#[cfg(test)]
macro_rules! ts_name {
    ($cfg:expr, $ty:ty) => {
        <$ty as ts_rs::TS>::name($cfg)
    };
    ($cfg:expr, $ty:ty, $ts:literal) => {
        String::from($ts)
    };
}

/// Visits a type for the generated imports, unless TypeScript names it itself.
#[cfg(test)]
macro_rules! visit_ts {
    ($visitor:expr, $ty:ty) => {
        $visitor.visit::<$ty>()
    };
    ($visitor:expr, $ty:ty, $ts:literal) => {};
}

/// What a method's promise resolves to: `void`, the type, or the type or
/// `undefined`.
#[cfg(test)]
macro_rules! ts_returns {
    ($cfg:expr;) => {
        String::from("void")
    };
    ($cfg:expr; $ret:ty $(, $rts:literal)?;) => {
        ts_name!($cfg, $ret $(, $rts)?)
    };
    ($cfg:expr; $ret:ty $(, $rts:literal)?; undefined) => {
        format!("{} | undefined", ts_name!($cfg, $ret $(, $rts)?))
    };
}

macro_rules! backend {
    (
        $(#[doc = $interface_doc:literal])*
        |$core:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident(
                    $($arg:ident: $ty:ty $(as $ts:literal)?),*
                    $(; $($opt:ident: $oty:ty $(as $ots:literal)?),*)?
                ) $(-> $ret:ty $(as $rts:literal)? $(| $undefined:ident)?)? $body:block
            )*
        }
    ) => {
        /// Runs one `Backend` method by name. `None` is `undefined`.
        #[allow(non_snake_case, unused_mut, unused_assignments, unused_variables)]
        pub fn dispatch($core: &Core, method: &str, args: &[Value]) -> Result<Option<Value>> {
            match method {
                $(
                    stringify!($method) => {
                        let mut index = 0;
                        $(
                            let $arg: $ty = required(method, args, index)?;
                            index += 1;
                        )*
                        $($(
                            let $opt: Option<$oty> = optional(method, args, index)?;
                            index += 1;
                        )*)?
                        answer!($body; $($ret; $($undefined)?)?)
                    }
                )*
                _ => Err(Error(format!("Unknown backend method {method}"))),
            }
        }

        /// The `Backend` interface's own doc comment.
        #[cfg(test)]
        pub(crate) const INTERFACE_DOCS: &[&str] = &[$($interface_doc),*];

        /// Every method as TypeScript sees it, in table order.
        #[cfg(test)]
        pub(crate) fn methods(cfg: &ts_rs::Config) -> Vec<typescript::Method> {
            vec![$(
                typescript::Method {
                    name: stringify!($method),
                    docs: &[$($doc),*],
                    params: vec![
                        $((stringify!($arg), false, ts_name!(cfg, $ty $(, $ts)?)),)*
                        $($((stringify!($opt), true, ts_name!(cfg, $oty $(, $ots)?)),)*)?
                    ],
                    returns: ts_returns!(cfg; $($ret $(, $rts)?; $($undefined)?)?),
                },
            )*]
        }

        /// Visits every argument and return type the table names.
        #[cfg(test)]
        pub(crate) fn visit_method_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                $(visit_ts!(visitor, $ty $(, $ts)?);)*
                $($(visit_ts!(visitor, $oty $(, $ots)?);)*)?
                $(visit_ts!(visitor, $ret $(, $rts)?);)?
            )*
        }
    };
}

backend! {
    /// Everything persistence can be asked to do.
    ///
    /// ## Every write is an event
    ///
    /// There is no "write the row, then also append the event" pair to keep in
    /// agreement — the event *is* the write, and the read tables are what the
    /// materializer makes of the log. Reads never touch `events`.
    ///
    /// ## Bulk reads are aggregates; the history is per-item
    ///
    /// `fsrsCard`, `reviewCount`, `correctCount` and `recentGrades` are columns,
    /// folded forward one review at a time by the materializer, so `getAllItems`
    /// costs a single `SELECT` and never scans `reviews`. The rows are still
    /// there — they are what lets one item be refolded exactly when a review
    /// arrives out of order, and `getItem` attaches them for the one word being
    /// looked at.
    ///
    /// ## Items carry their derived schedule
    ///
    /// Every read that returns items attaches `srs` — due, retrievability,
    /// strength — computed by the core against its clock as the row is fetched.
    /// The window thread has no FSRS to derive them with, which is the point; the
    /// cost is that they are a snapshot, so a view must refetch to see the
    /// schedule move.
    ///
    /// Every argument is plain JSON-shaped data: it crosses `postMessage` in the
    /// browser, so there is no place for a function or a `$state` proxy here.
    |core| {
        /* ---- Profile ---------------------------------------------------- */

        /// The stored profile, or `undefined` before onboarding completes.
        getProfile() -> Profile | undefined {
            core.get_profile()
        }
        /// Every language library, in creation order.
        listProfiles() -> Vec<LanguageProfile> {
            core.list_profiles()
        }
        /// Creates a separate language library, selects it, and returns its id.
        createProfile(profile: Profile) -> String {
            core.create_profile(&profile)
        }
        /// Selects a language library on this device.
        setActiveProfile(id: String) {
            core.set_active_profile(&id)
        }
        /// Creates or replaces the profile.
        saveProfile(profile: Profile) {
            core.save_profile(&profile)
        }

        /* ---- Knowledge items -------------------------------------------- */

        /// Every knowledge item the learner has met so far, with an **empty**
        /// `history`.
        ///
        /// This is the hot read — most call sites, session start included — so it
        /// costs one `SELECT` over `items` and never touches `reviews`.
        /// `recentGrades` is up to `RECENT_GRADES_CAP` entries (~1 KB) per item and
        /// only ever drawn by the words page's tick strip, so it is left out unless
        /// `withRecentGrades` asks for it. `reviewCount` and `correctCount` are
        /// single numbers and always come along.
        getAllItems(; opts: AllItemsOptions) -> Vec<KnowledgeItem> {
            core.get_all_items(opts.and_then(|o| o.with_recent_grades).unwrap_or(false))
        }
        /// One item, with its whole review history attached.
        getItem(id: String) -> KnowledgeItem | undefined {
            core.get_item(&id)
        }
        /// Inserts or replaces items by `id`.
        ///
        /// An id the table has never seen emits `itemAdded` (full content); a known
        /// one emits `itemUpdated` (the mutable fields only). That distinction is
        /// what lets another device tell "the learner met a new word" from "the
        /// learner edited a note". Card and history on the passed items are
        /// deliberately ignored: reviews arrive through `reviewItem` and the card
        /// follows from them.
        upsertItems(items: Vec<KnowledgeItem>) {
            core.upsert_items(&items)
        }
        /// Forgets one word entirely — the item and its whole review history.
        ///
        /// Safe to call mid-session: pooled challenges keep pointing at the id, and
        /// `reviewItem` skips items that are no longer there.
        deleteItem(id: String) {
            core.delete_item(&id)
        }
        /// Folds a review into an item: appends one history entry.
        ///
        /// A review is `{at, grade}` and nothing else — the caller has no FSRS to
        /// compute a card with, and does not need one. `card` is what the review
        /// folded to, read back after the commit; `prior` is the card as it stood
        /// before it. `existed` is `false`, and both cards `null`, when the item
        /// no longer exists.
        ///
        /// With `replaceLast`, the entry supersedes the newest one instead of being
        /// appended — for a review being *recomputed* rather than added (the
        /// learner re-graded the answer they just gave). The rewind is the core's:
        /// it refolds the whole log from the introduction, so nothing has to be
        /// handed back to it. An empty history simply appends.
        reviewItem(id: String, historyEntry: GradeEntry; opts: ReviewOptions) -> ReviewOutcome {
            let replace_last = opts.and_then(|o| o.replace_last).unwrap_or(false);
            core.review_item(&id, historyEntry.at, historyEntry.grade, replace_last)
        }

        /* ---- Challenge pool --------------------------------------------- */

        /// Adds a freshly generated batch to the pool.
        ///
        /// `generatedAt` is offset by the index so a batch keeps the order it was
        /// written in even when every row lands in the same millisecond — the
        /// planner's "newest first" freshness fill leans on that ordering being
        /// total.
        addToPool(challenges: Vec<Value> as "Array<Challenge>"; now: f64, topic: String) {
            core.add_to_pool(&challenges, now, topic.as_deref())
        }
        /// Every challenge the learner could still be shown, in no particular
        /// order.
        ///
        /// Reported rows are dropped here rather than at the planner, so "flagged"
        /// means gone everywhere at once. Everything else — eligibility, recycling
        /// gaps, ordering — is `planSession`'s business, working in memory over
        /// this array.
        getPool() -> Vec<Value> as "Array<ChallengeRow>" {
            core.get_pool()
        }
        /// How many challenges `getPool` would return.
        poolSize() -> f64 {
            core.pool_size()
        }
        /// Stamps a challenge as served: one more play, at `now`.
        ///
        /// Called when an answer is *committed*, not when a challenge is planned,
        /// which is what makes an early quit self-cleaning. A missing id is a
        /// no-op: locally built match-pairs rounds are never pooled.
        recordServe(id: String; now: f64) {
            core.record_serve(&id, now)
        }
        /// Flags a challenge as broken. The row stays; `getPool` never hands it
        /// out again.
        reportChallenge(id: String) {
            core.report_challenge(&id)
        }
        /// Looks challenges up by id, reported ones included. Ids that no longer
        /// exist are absent.
        getChallengesByIds(ids: Vec<String>) -> Vec<Value> as "Array<Challenge>" {
            core.get_challenges_by_ids(&ids)
        }

        /* ---- Results ---------------------------------------------------- */

        /// Logs one answered challenge.
        addResult(result: ChallengeResult) {
            core.add_result(&result)
        }
        /// The most recent results, newest first.
        recentResults(limit: f64) -> Vec<ChallengeResult> {
            core.recent_results(limit as i64)
        }
        /// What the learner did on each local calendar day, oldest day first — a
        /// day is present when anything at all happened on it. Folded from the
        /// base tables at read time; there is no aggregate behind it.
        getDailyActivity() -> Vec<DailyActivity> {
            core.get_daily_activity()
        }

        /* ---- Reading texts, word marks and lookups ---------------------- */

        /// Stores one reading text, whole. Immutable once written; a deleted id
        /// never comes back.
        addText(text: ReadingText) {
            core.add_text(&text)
        }
        /// Every stored text, newest first.
        getTexts() -> Vec<ReadingText> {
            core.get_texts()
        }
        /// One text by id, or `undefined` when it was deleted (here or on another
        /// device).
        getText(id: String) -> ReadingText | undefined {
            core.get_text(&id)
        }
        /// Forgets one text. Tombstoned, so a late copy from another device stays
        /// gone.
        deleteText(id: String) {
            core.delete_text(&id)
        }
        /// Marks a word known, or takes the mark back.
        ///
        /// Not a knowledge item: a marked word is one the learner does not need
        /// help with. Terms are stored trimmed and otherwise verbatim.
        markWord(term: String, known: bool) {
            core.mark_word(&term, known)
        }
        /// The terms currently marked known.
        getKnownTerms() -> Vec<String> {
            core.get_known_terms()
        }
        /// Records that the learner opened a word's card — "I don't understand
        /// this". Write-only for now; pass `itemId` when the word is tracked.
        recordLookup(term: String, textId: String; itemId: String) {
            core.record_lookup(&term, &textId, itemId.as_deref())
        }

        /// Recognises an imported text and cuts it into sentences: subtitles
        /// (SRT, VTT, json3, a copied transcript panel) are cleaned into cues
        /// and re-cut into sentences that keep their timings; anything else is
        /// prose, split on sentence-final punctuation and hard newlines. A pure
        /// function of `text` — it touches no table.
        importSource(text: String) -> ImportedSource {
            Ok::<_, Error>(sapling_import::import_source(&text))
        }

        /* ---- Conversations ---------------------------------------------- */

        /// Opens a conversation: the scene, and nothing else. Immutable once
        /// written.
        addConversation(conversation: Conversation) {
            core.add_conversation(&conversation)
        }
        /// Appends one exchange — a learner message and the teacher turn that
        /// answered it, or at index 0 the scenario's opener alone. A stored
        /// transcript always ends on a teacher line.
        addExchange(exchange: ConversationExchange) {
            core.add_exchange(&exchange)
        }
        /// Every conversation, newest first, each with its turn count and last
        /// activity.
        getConversations() -> Vec<ConversationSummary> {
            core.get_conversations()
        }
        /// One conversation and its whole transcript in `index` order, or
        /// `undefined` when deleted.
        getConversation(id: String) -> ConversationDetail | undefined {
            core.get_conversation(&id)
        }
        /// Forgets one conversation. Tombstoned.
        deleteConversation(id: String) {
            core.delete_conversation(&id)
        }

        /* ---- Export / import -------------------------------------------- */

        /// Empties the whole database, log included — Settings' "reset my
        /// progress".
        resetData() {
            core.reset_data()
        }
        /// Serializes the whole log as JSON (an `ExportEnvelope`), in log order.
        /// The log *is* the data, so the file is complete. Excludes only the API
        /// key, which lives in `localStorage`.
        exportData() -> String {
            core.export_data()
        }
        /// Restores a dump.
        ///
        /// A v3 file is the log itself: its events are unioned in by id and the
        /// read model is rebuilt, so an import is idempotent and order-free. A
        /// v1/v2 file predates the log and replaces the item list wholesale.
        importData(json: String) {
            core.import_data(&json)
        }

        /* ---- Sync ------------------------------------------------------- */

        /// Up to `limit` events the server has not acknowledged, in log order.
        ///
        /// Exactly the first `limit` unpushed rows, with no gaps — a row this build
        /// cannot read is pushed verbatim like any other, so nothing behind it can
        /// starve behind a page that never empties.
        pendingEvents(limit: f64) -> Vec<RawEvent> {
            core.pending_events(limit as i64)
        }
        /// Stamps the `seq` the server assigned each id. Returns how many were
        /// stamped.
        markPushed(seqs: BTreeMap<String, f64>) -> usize {
            core.mark_pushed(&seqs.into_iter().collect::<Vec<_>>())
        }
        /// Applies a page pulled from the server, in arrival order.
        ///
        /// Rows are raw: one that is not an envelope at all, or carries no `seq`,
        /// is skipped. Returns how many reached the log — this device's own echoes
        /// included, which only stamp their `seq`. A payload this build cannot read
        /// costs its merge rule and nothing else: the row is logged, pushed on and
        /// exported, and a build that knows the kind materialises it.
        applyRemote(events: Vec<Value> as "Array<unknown>") -> usize {
            core.apply_remote(&events)
        }
        /// The pull cursor: the highest `seq` whose page has been applied, `0`
        /// before the first.
        getPullCursor() -> f64 {
            core.get_pull_cursor()
        }
        /// Moves the pull cursor.
        setPullCursor(cursor: f64) {
            core.set_pull_cursor(cursor)
        }
    }
}

/// [`dispatch`] over the wire: `args_json` is the argument array, the answer
/// is the result as JSON, or `None` for `undefined`.
pub fn dispatch_json(core: &Core, method: &str, args_json: &str) -> Result<Option<String>> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| Error(format!("{method}: arguments are not a JSON array: {e}")))?;
    Ok(dispatch(core, method, &args)?
        .as_ref()
        .map(Value::to_string))
}

/// Appends local facts from their wire shape — `[{ type, payload }, ...]`, the
/// TypeScript `Fact[]` — in one transaction. What a test rig seeds a store with.
pub fn commit_facts_json(core: &Core, facts_json: &str) -> Result<()> {
    let raw: Vec<Value> = serde_json::from_str(facts_json)
        .map_err(|e| Error(format!("facts are not a JSON array: {e}")))?;
    let mut facts = Vec::with_capacity(raw.len());
    for fact in &raw {
        let type_name = fact
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("fact has no `type`".into()))?;
        let kind = EventType::from_name(type_name)
            .ok_or_else(|| Error(format!("unknown event type {type_name}")))?;
        let payload = fact.get("payload").unwrap_or(&Value::Null);
        let parsed: Payload = parse_payload(kind, payload)
            .ok_or_else(|| Error(format!("payload for {type_name} will not parse")))?;
        facts.push(parsed);
    }
    core.commit_all(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_db::{Param, Row, Sql};
    use sapling_domain::Utc;

    /// A database that answers nothing: enough to tell "unknown method" from
    /// "known method, wrong arguments".
    struct Silent;

    impl Sql for Silent {
        fn exec(&self, _sql: &str, _params: &[Param]) -> Result<()> {
            Ok(())
        }

        fn query(&self, _sql: &str, _params: &[Param]) -> Result<Vec<Row>> {
            Ok(Vec::new())
        }
    }

    fn silent_core() -> Core {
        Core::new(Box::new(Silent), "dev", || 0.0, || "id".to_owned(), Utc)
    }

    #[test]
    fn an_unknown_method_is_an_error() {
        assert!(matches!(
            dispatch(&silent_core(), "notAMethod", &[]),
            Err(Error(message)) if message == "Unknown backend method notAMethod"
        ));
    }

    #[test]
    fn a_void_method_answers_undefined_and_a_read_answers_json() {
        let core = silent_core();
        assert_eq!(dispatch_json(&core, "resetData", "[]").unwrap(), None);
        assert_eq!(
            dispatch_json(&core, "getKnownTerms", "[]").unwrap(),
            Some("[]".to_owned())
        );
        assert_eq!(dispatch_json(&core, "getProfile", "[]").unwrap(), None);
        let pool_size = dispatch_json(&core, "poolSize", "[]").unwrap().unwrap();
        assert_eq!(serde_json::from_str::<f64>(&pool_size).unwrap(), 0.0);
    }

    #[test]
    fn a_missing_required_argument_is_an_error_not_a_panic() {
        let core = silent_core();
        assert!(dispatch_json(&core, "getItem", "[]").is_err());
        assert!(dispatch_json(&core, "getItem", "[null]").is_err());
        assert!(dispatch_json(&core, "markWord", "[\"木\"]").is_err());
        assert!(dispatch_json(&core, "reviewItem", "[\"i\", {\"at\": 1}]").is_err());
    }

    #[test]
    fn an_optional_argument_may_be_left_out_or_null() {
        let core = silent_core();
        assert!(dispatch_json(&core, "getAllItems", "[]").is_ok());
        assert!(dispatch_json(&core, "getAllItems", "[null]").is_ok());
        assert!(dispatch_json(&core, "getAllItems", "[{\"withRecentGrades\": true}]").is_ok());
        assert!(dispatch_json(&core, "recordServe", "[\"c\", null]").is_ok());
    }

    #[test]
    fn import_source_answers_without_the_database() {
        let answer = dispatch_json(&silent_core(), "importSource", r#"["Hola. Adiós."]"#)
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(value["sentences"], serde_json::json!(["Hola.", "Adiós."]));
        assert!(value.get("format").is_none());
    }

    #[test]
    fn facts_parse_by_type() {
        let core = silent_core();
        assert!(commit_facts_json(
            &core,
            r#"[{"type":"itemDeleted","payload":{"itemId":"i1"}}]"#
        )
        .is_ok());
        assert!(commit_facts_json(&core, r#"[{"type":"xpBanked","payload":{}}]"#).is_err());
        assert!(
            commit_facts_json(&core, r#"[{"type":"itemAdded","payload":{"id":"i1"}}]"#).is_err()
        );
    }
}
