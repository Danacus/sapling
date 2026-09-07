//! The event model: seventeen immutable facts, and the only thing sync moves.
//!
//! `src/lib/db/events.ts`, with serde standing in for zod. The rules are the
//! same: the envelope is `{ id, type, at, device, payload }`, unknown fields
//! inside a payload are stripped, and an optional field that is present must
//! have a value — `null` is not `undefined`. [`parse_event`] is the gate every
//! row off sync or out of a backup file passes *into the merge rules*; a local
//! commit never goes through it.
//!
//! **An unknown type or a payload that will not parse costs the rule, not the
//! row.** [`parse_envelope`] reads the envelope alone and keeps the payload as
//! it arrived, so the log stores what a newer build wrote and push and export
//! ship it back verbatim; [`typed_event`] is the second half, and only the
//! materializer needs it.
//!
//! **A payload struct must name every optional field of the type it carries.**
//! Serde drops what a struct does not declare exactly as zod does, and the
//! field then works on the device that wrote it and vanishes on the one it
//! arrives at. `parse_event(raw) == raw`, field for field, is the test.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{
    absent_or, ChallengeResult, Conversation, ConversationExchange, ItemKind, Profile, ReadingText,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventType {
    ItemAdded,
    ItemReviewed,
    ReviewAmended,
    ItemUpdated,
    ItemDeleted,
    ChallengeAdded,
    ChallengeServed,
    ChallengeReported,
    ResultLogged,
    ProfileUpdated,
    TextAdded,
    TextDeleted,
    WordMarked,
    WordLookedUp,
    ConversationStarted,
    TurnAdded,
    ConversationDeleted,
}

impl EventType {
    pub const ALL: [EventType; 17] = [
        EventType::ItemAdded,
        EventType::ItemReviewed,
        EventType::ReviewAmended,
        EventType::ItemUpdated,
        EventType::ItemDeleted,
        EventType::ChallengeAdded,
        EventType::ChallengeServed,
        EventType::ChallengeReported,
        EventType::ResultLogged,
        EventType::ProfileUpdated,
        EventType::TextAdded,
        EventType::TextDeleted,
        EventType::WordMarked,
        EventType::WordLookedUp,
        EventType::ConversationStarted,
        EventType::TurnAdded,
        EventType::ConversationDeleted,
    ];

    /// The wire name — the `type` column.
    pub fn as_str(self) -> &'static str {
        match self {
            EventType::ItemAdded => "itemAdded",
            EventType::ItemReviewed => "itemReviewed",
            EventType::ReviewAmended => "reviewAmended",
            EventType::ItemUpdated => "itemUpdated",
            EventType::ItemDeleted => "itemDeleted",
            EventType::ChallengeAdded => "challengeAdded",
            EventType::ChallengeServed => "challengeServed",
            EventType::ChallengeReported => "challengeReported",
            EventType::ResultLogged => "resultLogged",
            EventType::ProfileUpdated => "profileUpdated",
            EventType::TextAdded => "textAdded",
            EventType::TextDeleted => "textDeleted",
            EventType::WordMarked => "wordMarked",
            EventType::WordLookedUp => "wordLookedUp",
            EventType::ConversationStarted => "conversationStarted",
            EventType::TurnAdded => "turnAdded",
            EventType::ConversationDeleted => "conversationDeleted",
        }
    }

    /// The type for a wire name, or `None` for one this build does not know.
    pub fn from_name(name: &str) -> Option<EventType> {
        EventType::ALL.into_iter().find(|t| t.as_str() == name)
    }
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

/// Item content only. The card is computed from the reviews that follow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAdded {
    pub id: String,
    pub kind: ItemKind,
    pub term: String,
    pub meaning: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub romanization: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<String>,
    pub introduced_at: f64,
}

/// One review. Identity is `(itemId, at, device)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReviewed {
    pub device: String,
    pub at: f64,
    pub item_id: String,
    pub grade: f64,
}

/// A re-grade. `replaces` names the `at` of the review it displaced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAmended {
    pub device: String,
    pub at: f64,
    pub item_id: String,
    pub grade: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub replaces: Option<f64>,
}

/// The mutable fields of an item; identity and birth date are not among them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ItemFields {
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub term: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub meaning: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub romanization: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<String>,
}

/// The item columns a patch can touch, in application order. `refold_patches`
/// in `materialize.rs` rewrites the same columns from a fresh `itemAdded`, so
/// this is the one place the list lives rather than two that can drift apart.
pub const PATCHABLE_COLUMNS: [&str; 4] = ["term", "meaning", "romanization", "notes"];

impl ItemFields {
    /// `(column, value)` for every field the patch names, in `PATCHABLE_COLUMNS` order.
    pub fn set(&self) -> Vec<(&'static str, &str)> {
        let values: [&Option<String>; 4] =
            [&self.term, &self.meaning, &self.romanization, &self.notes];
        PATCHABLE_COLUMNS
            .into_iter()
            .zip(values)
            .filter_map(|(column, value)| value.as_deref().map(|v| (column, v)))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUpdated {
    pub item_id: String,
    pub fields: ItemFields,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDeleted {
    pub item_id: String,
}

/// Immutable challenge content plus its pool metadata.
///
/// `challenge` is unvalidated on purpose, as `z.unknown()` is: the producer
/// validated it at generation time, and a schema here would strip the fields it
/// did not know. `z.unknown()` also accepts an absent key, which is why this is
/// an `Option` rather than a required `Value`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeAdded {
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub challenge: Option<Value>,
    pub generated_at: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeServed {
    pub challenge_id: String,
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeReported {
    pub challenge_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDeleted {
    pub text_id: String,
}

/// "I know this word" / "I don't". Last write by the envelope `at` wins, per term.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WordMarked {
    pub term: String,
    pub known: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordLookedUp {
    pub term: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub item_id: Option<String>,
    pub text_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeleted {
    pub conversation_id: String,
}

/// One parsed payload; the variant is the event type.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Payload {
    ItemAdded(ItemAdded),
    ItemReviewed(ItemReviewed),
    ReviewAmended(ReviewAmended),
    ItemUpdated(ItemUpdated),
    ItemDeleted(ItemDeleted),
    ChallengeAdded(ChallengeAdded),
    ChallengeServed(ChallengeServed),
    ChallengeReported(ChallengeReported),
    ResultLogged(ChallengeResult),
    ProfileUpdated(Profile),
    TextAdded(ReadingText),
    TextDeleted(TextDeleted),
    WordMarked(WordMarked),
    WordLookedUp(WordLookedUp),
    ConversationStarted(Conversation),
    TurnAdded(ConversationExchange),
    ConversationDeleted(ConversationDeleted),
}

impl Payload {
    pub fn kind(&self) -> EventType {
        match self {
            Payload::ItemAdded(_) => EventType::ItemAdded,
            Payload::ItemReviewed(_) => EventType::ItemReviewed,
            Payload::ReviewAmended(_) => EventType::ReviewAmended,
            Payload::ItemUpdated(_) => EventType::ItemUpdated,
            Payload::ItemDeleted(_) => EventType::ItemDeleted,
            Payload::ChallengeAdded(_) => EventType::ChallengeAdded,
            Payload::ChallengeServed(_) => EventType::ChallengeServed,
            Payload::ChallengeReported(_) => EventType::ChallengeReported,
            Payload::ResultLogged(_) => EventType::ResultLogged,
            Payload::ProfileUpdated(_) => EventType::ProfileUpdated,
            Payload::TextAdded(_) => EventType::TextAdded,
            Payload::TextDeleted(_) => EventType::TextDeleted,
            Payload::WordMarked(_) => EventType::WordMarked,
            Payload::WordLookedUp(_) => EventType::WordLookedUp,
            Payload::ConversationStarted(_) => EventType::ConversationStarted,
            Payload::TurnAdded(_) => EventType::TurnAdded,
            Payload::ConversationDeleted(_) => EventType::ConversationDeleted,
        }
    }

    /// The payload as the log stores it: `JSON.stringify` of the parsed value.
    pub fn to_json(&self) -> String {
        crate::js::stringify(&serde_json::to_value(self).expect("payloads serialise"))
    }
}

/// Parses one payload against the schema its type names — `payloadSchemas[type].safeParse`.
pub fn parse_payload(kind: EventType, raw: &Value) -> Option<Payload> {
    fn typed<T: for<'de> Deserialize<'de>>(raw: &Value, wrap: fn(T) -> Payload) -> Option<Payload> {
        serde_json::from_value::<T>(raw.clone()).ok().map(wrap)
    }
    match kind {
        EventType::ItemAdded => typed(raw, Payload::ItemAdded),
        EventType::ItemReviewed => typed(raw, Payload::ItemReviewed),
        EventType::ReviewAmended => typed(raw, Payload::ReviewAmended),
        EventType::ItemUpdated => typed(raw, Payload::ItemUpdated),
        EventType::ItemDeleted => typed(raw, Payload::ItemDeleted),
        EventType::ChallengeAdded => typed(raw, Payload::ChallengeAdded),
        EventType::ChallengeServed => typed(raw, Payload::ChallengeServed),
        EventType::ChallengeReported => typed(raw, Payload::ChallengeReported),
        EventType::ResultLogged => typed(raw, Payload::ResultLogged),
        EventType::ProfileUpdated => typed(raw, Payload::ProfileUpdated),
        EventType::TextAdded => typed(raw, Payload::TextAdded),
        EventType::TextDeleted => typed(raw, Payload::TextDeleted),
        EventType::WordMarked => typed(raw, Payload::WordMarked),
        EventType::WordLookedUp => typed(raw, Payload::WordLookedUp),
        EventType::ConversationStarted => typed(raw, Payload::ConversationStarted),
        EventType::TurnAdded => typed(raw, Payload::TurnAdded),
        EventType::ConversationDeleted => typed(raw, Payload::ConversationDeleted),
    }
}

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

/// One row as the log holds it and as push and export ship it: the envelope
/// read, the payload untouched.
///
/// Neither sync nor export may require that *this* build understands a row. A
/// kind a newer build writes, or a payload whose schema has since widened, has
/// to survive a round trip through an older device rather than be dropped on
/// the floor — so `kind` is a plain string here and `payload` an opaque
/// [`Value`]. Only [`typed_event`], and the merge rules behind it, ever
/// interpret one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RawEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub at: f64,
    pub device: String,
    pub payload: Value,
}

/// One event this build understands: a known type and a payload its schema
/// accepts, ready for a merge rule.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SyncEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: EventType,
    pub at: f64,
    pub device: String,
    pub payload: Payload,
}

/// Reads one row off the wire or out of an export file as far as the envelope,
/// and no further.
///
/// `None` only for something that is not an envelope at all — no `id`, a type
/// that is not a string, an `at` that is not a number. The payload is carried
/// exactly as it arrived, because a row this build cannot type is still a row
/// the log has to keep and push.
pub fn parse_envelope(raw: &Value) -> Option<RawEvent> {
    let outer = raw.as_object()?;
    Some(RawEvent {
        id: outer.get("id")?.as_str()?.to_owned(),
        kind: outer.get("type")?.as_str()?.to_owned(),
        at: outer.get("at")?.as_f64()?,
        device: outer.get("device")?.as_str()?.to_owned(),
        // `z.unknown()` lets the key be absent; what stands in for it is `null`,
        // which no payload schema accepts.
        payload: outer.get("payload").cloned().unwrap_or(Value::Null),
    })
}

/// The typed event a merge rule can be applied from, or `None` for a row whose
/// type or payload shape this build does not know — which is a row to skip,
/// never one to drop from the log.
pub fn typed_event(raw: &RawEvent) -> Option<SyncEvent> {
    let kind = EventType::from_name(&raw.kind)?;
    Some(SyncEvent {
        id: raw.id.clone(),
        kind,
        at: raw.at,
        device: raw.device.clone(),
        payload: parse_payload(kind, &raw.payload)?,
    })
}

/// Validates one event off the wire or out of an export file: the envelope and
/// the schema its type names, in one step.
///
/// `None` for anything else — the caller skips the *rule*, not the row.
pub fn parse_event(raw: &Value) -> Option<SyncEvent> {
    typed_event(&parse_envelope(raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One raw payload per type with **every** optional field present: the
    /// `parseEvent(raw) == raw` test, which is what catches a struct that forgot
    /// a field. Add a field to a type, add it here, or this is the test that fails.
    fn full_payloads() -> Vec<(EventType, Value)> {
        let line = json!({ "text": "你好", "reading": "nǐ hǎo" });
        vec![
            (
                EventType::ItemAdded,
                json!({ "id": "i", "kind": "vocab", "term": "t", "meaning": "m", "romanization": "r", "notes": "n", "introducedAt": 1 }),
            ),
            (
                EventType::ItemReviewed,
                json!({ "device": "d", "at": 2, "itemId": "i", "grade": 3 }),
            ),
            (
                EventType::ReviewAmended,
                json!({ "device": "d", "at": 3, "itemId": "i", "grade": 4, "replaces": 2 }),
            ),
            (
                EventType::ItemUpdated,
                json!({ "itemId": "i", "fields": { "term": "t", "meaning": "m", "romanization": "r", "notes": "n" } }),
            ),
            (EventType::ItemDeleted, json!({ "itemId": "i" })),
            (
                EventType::ChallengeAdded,
                json!({ "challenge": { "id": "c", "type": "cloze", "anything": [1, 2] }, "generatedAt": 5, "topic": "food" }),
            ),
            (
                EventType::ChallengeServed,
                json!({ "challengeId": "c", "at": 6 }),
            ),
            (EventType::ChallengeReported, json!({ "challengeId": "c" })),
            (
                EventType::ResultLogged,
                json!({ "challengeId": "c", "verdict": "almost", "answerGiven": "a", "at": 7 }),
            ),
            (
                EventType::ProfileUpdated,
                json!({ "nativeLanguage": "en", "targetLanguage": "zh", "level": "beginner", "interests": ["food"], "about": "me", "model": "m", "createdAt": 8 }),
            ),
            (
                EventType::TextAdded,
                json!({
                    "id": "t", "title": "T", "source": "imported", "topic": "x",
                    "sentences": [{ "text": "s", "reading": "r", "translation": "tr", "start": 0, "end": 1200 }],
                    "glossary": [{ "term": "g", "reading": "gr", "meaning": "gm" }],
                    "media": { "kind": "file", "name": "a.mp4", "type": "video/mp4" },
                    "createdAt": 9
                }),
            ),
            (EventType::TextDeleted, json!({ "textId": "t" })),
            (EventType::WordMarked, json!({ "term": "w", "known": true })),
            (
                EventType::WordLookedUp,
                json!({ "term": "w", "itemId": "i", "textId": "t" }),
            ),
            (
                EventType::ConversationStarted,
                json!({
                    "id": "c", "scenario": {
                        "setting": "s", "teacherRole": "tr", "learnerRole": "lr", "firstSpeaker": "teacher",
                        "opener": line, "openerTranslation": "hi"
                    },
                    "topic": "x", "createdAt": 10
                }),
            ),
            (
                EventType::TurnAdded,
                json!({
                    "conversationId": "c", "index": 1,
                    "learner": { "role": "learner", "text": "l", "heard": line, "correction": { "corrected": line, "note": "n" } },
                    "teacher": { "role": "teacher", "reply": line, "translation": "t", "actions": [{ "tool": "add_words", "summary": "s", "ok": true }] }
                }),
            ),
            (
                EventType::ConversationDeleted,
                json!({ "conversationId": "c" }),
            ),
        ]
    }

    #[test]
    fn every_type_is_covered() {
        let covered: Vec<EventType> = full_payloads().into_iter().map(|(t, _)| t).collect();
        for kind in EventType::ALL {
            assert!(covered.contains(&kind), "{kind:?} has no full payload");
        }
    }

    #[test]
    fn parse_event_round_trips_every_field() {
        for (kind, payload) in full_payloads() {
            let raw = json!({ "id": "e", "type": kind.as_str(), "at": 1, "device": "d", "payload": payload });
            let event = parse_event(&raw).unwrap_or_else(|| panic!("{kind:?} did not parse"));
            let back: Value = serde_json::from_str(&crate::js::stringify(
                &serde_json::to_value(&event).unwrap(),
            ))
            .unwrap();
            assert_eq!(back, raw, "{kind:?} lost or changed a field");
            assert_eq!(event.kind, kind);
            assert_eq!(event.payload.kind(), kind);
        }
    }

    #[test]
    fn rejects_what_zod_rejects() {
        let base = |payload: Value| json!({ "id": "e", "type": "itemAdded", "at": 1, "device": "d", "payload": payload });
        let ok =
            json!({ "id": "i", "kind": "vocab", "term": "t", "meaning": "m", "introducedAt": 1 });
        assert!(parse_event(&base(ok.clone())).is_some());

        let mut null_notes = ok.clone();
        null_notes["notes"] = Value::Null;
        assert!(
            parse_event(&base(null_notes)).is_none(),
            "null is not undefined"
        );

        let mut bad_kind = ok.clone();
        bad_kind["kind"] = json!("noun");
        assert!(parse_event(&base(bad_kind)).is_none(), "enum");

        let mut string_at = ok;
        string_at["introducedAt"] = json!("1");
        assert!(
            parse_event(&base(string_at)).is_none(),
            "a string is not a number"
        );

        let unknown =
            json!({ "id": "e", "type": "itemRenamed", "at": 1, "device": "d", "payload": {} });
        assert!(parse_event(&unknown).is_none(), "unknown type");

        let no_payload = json!({ "id": "e", "type": "itemDeleted", "at": 1, "device": "d" });
        assert!(
            parse_event(&no_payload).is_none(),
            "an absent payload fails its schema"
        );
    }

    #[test]
    fn strips_unknown_payload_fields_but_keeps_the_challenge_verbatim() {
        let raw = json!({
            "id": "e", "type": "challengeAdded", "at": 1, "device": "d",
            "payload": { "challenge": { "id": "c", "type": "cloze", "extra": { "deep": true } }, "generatedAt": 1, "surprise": 1 }
        });
        let event = parse_event(&raw).unwrap();
        let payload = serde_json::to_value(&event.payload).unwrap();
        assert_eq!(payload.get("surprise"), None);
        assert_eq!(payload["challenge"]["extra"]["deep"], json!(true));
    }
}
