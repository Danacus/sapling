//! The domain types the reads return — `src/lib/types.ts`, for the fields
//! persistence carries.
//!
//! Every struct derives both directions: the same shape is a `Backend`
//! argument on the way in and a read result on the way out, and several are
//! event payloads verbatim (`Profile` is `profileUpdated`, `ReadingText` is
//! `textAdded`, `Conversation` is `conversationStarted`,
//! `ConversationExchange` is `turnAdded`, `ChallengeResult` is `resultLogged`).
//!
//! Optional fields follow zod's `.optional()` exactly: absent is fine, `null`
//! is a parse error, and an absent field is *omitted* when written back rather
//! than serialised as `null` — which is what `JSON.stringify` does with
//! `undefined`, and what keeps `parseEvent(raw)` equal to `raw`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::srs::ItemSrs;

/// zod's `.optional()`: missing is `None`, present must parse, `null` does not.
///
/// Pair with `#[serde(default)]` so a missing key becomes `None` without ever
/// reaching this function — serde's own `Option` would also accept `null`.
pub fn absent_or<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/* -------------------------------------------------------------------------- */
/* Enumerations — zod `z.enum`/`z.literal`, so an unknown string is a parse error */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Beginner,
    Elementary,
    Intermediate,
    Advanced,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Beginner => "beginner",
            Level::Elementary => "elementary",
            Level::Intermediate => "intermediate",
            Level::Advanced => "advanced",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Vocab,
    Grammar,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Vocab => "vocab",
            ItemKind::Grammar => "grammar",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Correct,
    Almost,
    Wrong,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Correct => "correct",
            Verdict::Almost => "almost",
            Verdict::Wrong => "wrong",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextSource {
    Generated,
    Imported,
}

impl TextSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TextSource::Generated => "generated",
            TextSource::Imported => "imported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    Teacher,
    Learner,
}

/// `z.literal('learner')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LearnerRole {
    Learner,
}

/// `z.literal('teacher')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeacherRole {
    Teacher,
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub native_language: String,
    pub target_language: String,
    pub level: Level,
    pub interests: Vec<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub about: Option<String>,
    pub model: String,
    pub created_at: f64,
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                             */
/* -------------------------------------------------------------------------- */

/// One review, as `KnowledgeItem.history` lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: f64,
    pub grade: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub device: Option<String>,
}

/// One of the last `RECENT_GRADES_CAP` reviews, as the tick strip shows them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradeEntry {
    pub at: f64,
    pub grade: f64,
}

/// `KnowledgeItem`, field order as `itemFrom` in `core.ts` assembles it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
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
    /// The FSRS card, opaque here as it is in `types.ts`; `srs` knows its shape.
    #[serde(default)]
    pub fsrs_card: Value,
    /// What the card *says*, derived at read time — the frontend runs no FSRS,
    /// so this is the only way a screen gets a strength or a forgetting curve.
    /// Absent on an item built by hand (an argument, an import) rather than read.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub srs: Option<ItemSrs>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub review_count: Option<f64>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub correct_count: Option<f64>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub recent_grades: Option<Vec<GradeEntry>>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResult {
    pub challenge_id: String,
    pub verdict: Verdict,
    pub answer_given: String,
    pub at: f64,
}

/// Everything the learner did on one local calendar day, read straight off
/// the base tables — there is no aggregate to keep in step. `count` keeps its
/// old name: it is the answers given in drills, and the home screen's strip
/// reads it. The rest is what a day looks like beyond the drill: how those
/// answers went, how many distinct words were reviewed by any route, how many
/// were looked up while reading, and how many joined the garden.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyActivity {
    pub day: String,
    pub count: f64,
    pub correct: f64,
    pub almost: f64,
    pub wrong: f64,
    pub reviewed: f64,
    pub lookups: f64,
    pub added: f64,
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReadingSentence {
    pub text: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub reading: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub translation: Option<String>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub start: Option<f64>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub end: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlossEntry {
    pub term: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub reading: Option<String>,
    pub meaning: String,
}

/// A reference to the recording a text's timings belong to — never the media.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadingMedia {
    Youtube {
        #[serde(rename = "videoId")]
        video_id: String,
    },
    File {
        name: String,
        #[serde(
            rename = "type",
            default,
            deserialize_with = "absent_or",
            skip_serializing_if = "Option::is_none"
        )]
        mime: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingText {
    pub id: String,
    pub title: String,
    pub source: TextSource,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub topic: Option<String>,
    pub sentences: Vec<ReadingSentence>,
    pub glossary: Vec<GlossEntry>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub media: Option<ReadingMedia>,
    pub created_at: f64,
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationLine {
    pub text: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub reading: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationScenario {
    pub setting: String,
    pub teacher_role: String,
    pub learner_role: String,
    pub first_speaker: Speaker,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub opener: Option<ConversationLine>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub opener_translation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationCorrection {
    pub corrected: ConversationLine,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationAction {
    pub tool: String,
    pub summary: String,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationLearnerTurn {
    pub role: LearnerRole,
    pub text: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub heard: Option<ConversationLine>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub correction: Option<ConversationCorrection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConversationTeacherTurn {
    pub role: TeacherRole,
    pub reply: ConversationLine,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub translation: Option<String>,
    pub actions: Vec<ConversationAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub scenario: ConversationScenario,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub topic: Option<String>,
    pub created_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExchange {
    pub conversation_id: String,
    pub index: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    pub learner: Option<ConversationLearnerTurn>,
    pub teacher: ConversationTeacherTurn,
}

/// One library row: the conversation plus what the shelf needs of its transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(flatten)]
    pub conversation: Conversation,
    pub turn_count: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn_at: Option<f64>,
}

/// `getConversation`'s answer: the scene and its whole transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConversationDetail {
    pub conversation: Conversation,
    pub exchanges: Vec<ConversationExchange>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_rejects_null_and_omits_absent() {
        let ok: ReadingSentence = serde_json::from_value(json!({ "text": "a" })).unwrap();
        assert_eq!(ok.reading, None);
        assert_eq!(serde_json::to_value(&ok).unwrap(), json!({ "text": "a" }));

        let null =
            serde_json::from_value::<ReadingSentence>(json!({ "text": "a", "reading": null }));
        assert!(null.is_err(), "zod's .optional() does not accept null");
    }

    #[test]
    fn unknown_fields_are_stripped() {
        let entry: GlossEntry =
            serde_json::from_value(json!({ "term": "t", "meaning": "m", "extra": 1 })).unwrap();
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({ "term": "t", "meaning": "m" })
        );
    }

    #[test]
    fn media_is_a_tagged_union() {
        let file: ReadingMedia =
            serde_json::from_value(json!({ "kind": "file", "name": "a.mp4", "type": "video/mp4" }))
                .unwrap();
        assert_eq!(
            serde_json::to_value(&file).unwrap(),
            json!({ "kind": "file", "name": "a.mp4", "type": "video/mp4" })
        );
        assert!(serde_json::from_value::<ReadingMedia>(json!({ "kind": "tape" })).is_err());
    }
}
