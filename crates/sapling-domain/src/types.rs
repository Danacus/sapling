//! The domain types persistence carries — the source of the wire types
//! `src/lib/types.ts` re-exports.
//!
//! Every struct derives both directions: the same shape is a `Backend`
//! argument on the way in and a read result on the way out, and several are
//! event payloads verbatim (`Profile` is `profileUpdated`, `ReadingText` is
//! `textAdded`, `Conversation` is `conversationStarted`,
//! `ConversationExchange` is `turnAdded`, `ChallengeResult` is `resultLogged`).
//! Each also derives `TS`: `pnpm core:types` writes its TypeScript declaration,
//! doc comments included, into `src/lib/db/generated/` at build time.
//!
//! Optional fields follow zod's `.optional()` exactly: absent is fine, `null`
//! is a parse error, and an absent field is *omitted* when written back rather
//! than serialised as `null` — which is what `JSON.stringify` does with
//! `undefined`, and what keeps `parseEvent(raw)` equal to `raw`. Each carries
//! `#[ts(optional)]` beside its serde attributes, so TypeScript reads it as
//! `field?: T`, never `T | null`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_srs::ItemSrs;

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

/// CEFR-ish proficiency buckets used to steer generation difficulty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
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

/// What a knowledge item is: a word or phrase, or a grammar point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
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

/// Grading outcome for a single answered challenge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
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

/// Where a reading text came from: written by the model from the vocabulary,
/// or imported by the learner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
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

/// Who opens a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Speaker {
    Teacher,
    Learner,
}

/// `z.literal('learner')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum LearnerRole {
    Learner,
}

/// `z.literal('teacher')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum TeacherRole {
    Teacher,
}

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

/// The learner's configuration, captured during onboarding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Language the learner already speaks, e.g. `'nl'` or `'English'`.
    pub native_language: String,
    /// Language being learned.
    pub target_language: String,
    pub level: Level,
    /// Free-form topics used to personalize generated content.
    pub interests: Vec<String>,
    /// The learner describing themselves in their own words — job, city,
    /// family, tastes, whatever they care to say. Written on the profile page
    /// and sent (capped, see `MAX_ABOUT_CHARS` in `$lib/llm`) with every
    /// generation request, so scenarios can be set in their actual life
    /// instead of a generic one. Never required: absent or blank simply
    /// personalizes nothing.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub about: Option<String>,
    /// OpenRouter model id, e.g. `'openai/gpt-4o-mini'`.
    pub model: String,
    /// Epoch milliseconds.
    pub created_at: f64,
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                             */
/* -------------------------------------------------------------------------- */

/// One review, as `KnowledgeItem.history` lists it. `grade` is the FSRS
/// rating, 1–4.
///
/// `device` is the reviewing device's stable id, and it is what makes a merged
/// history dedupe exactly: an entry's identity is `(itemId, at, device)`, so
/// two devices reviewing the same word in the same millisecond stay two
/// reviews. Every read attaches it; an item built by hand may leave it out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct HistoryEntry {
    pub at: f64,
    pub grade: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub device: Option<String>,
}

/// One review as a time and a grade — what the tick strip shows, and what
/// `reviewItem` files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct GradeEntry {
    pub at: f64,
    pub grade: f64,
}

/// One learnable atom (a word, phrase or grammar point) tracked by the SRS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
    pub id: String,
    pub kind: ItemKind,
    /// The item as it appears in the target language.
    pub term: String,
    /// The meaning in the learner's native language.
    pub meaning: String,
    /// Latin-script reading of `term`, for target languages that are not
    /// written in the Latin script (pinyin, romaji, revised romanization, ...).
    /// Absent for Latin-script languages.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub romanization: Option<String>,
    /// Optional usage notes, gender, conjugation hints, etc.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub notes: Option<String>,
    /// Epoch milliseconds.
    pub introduced_at: f64,
    /// The stored FSRS card (`FsrsCardState`). Opaque: only the core reads
    /// inside it, and only the words ledger names its fields. What screens read
    /// is `srs`.
    #[serde(default)]
    #[ts(type = "unknown")]
    pub fsrs_card: Value,
    /// The schedule as of the moment this item was read — derived by the core,
    /// because the frontend runs no FSRS. Every read that returns items attaches
    /// it; an item built by hand (an argument to `upsertItems`, an import) has
    /// none, and every reader falls back to "brand new".
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub srs: Option<ItemSrs>,
    /// How many reviews there are — a fold the store keeps, so the bulk read
    /// never carries `history`. Every read attaches it; an item built by hand
    /// supplies `history` alone.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub review_count: Option<f64>,
    /// How many of the reviews were graded Good or better.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub correct_count: Option<f64>,
    /// The most recent reviews, oldest first — what the ledger's tick strip
    /// shows. Only `getAllItems({ withRecentGrades: true })` and `getItem`
    /// attach it: it is up to `RECENT_GRADES_CAP` entries per item and nothing
    /// else reads it.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub recent_grades: Option<Vec<GradeEntry>>,
    /// Review log, oldest first. `getItem` fills it; `getAllItems` leaves it
    /// empty.
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/// The learner's answer to a single challenge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResult {
    pub challenge_id: String,
    pub verdict: Verdict,
    /// Raw input, kept for review screens and analytics.
    pub answer_given: String,
    /// Epoch milliseconds.
    pub at: f64,
}

/// Everything the learner did on one local calendar day, read straight off
/// the base tables — there is no aggregate to keep in step. `count` keeps its
/// old name: it is the answers given in drills, and the home screen's strip
/// reads it. The rest is what a day looks like beyond the drill: how those
/// answers went, how many distinct words were reviewed by any route, how many
/// were looked up while reading, and how many joined the garden.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
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

/// One unit of a `ReadingText`, as its source cut it: a subtitle cue, or a
/// paragraph of prose.
///
/// Stored as the source had it and never re-cut: a cue keeps the span it was
/// shown for, and sentences exist only on screen, where the reader splits a
/// segment too long for one page (`$lib/reading`'s `paginate`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Segment {
    /// The segment in the target language, verbatim apart from trimming.
    pub text: String,
    /// When this segment is spoken, in milliseconds from the start of the
    /// media it was imported from — present only for a text imported as
    /// subtitles. Offsets into a recording, not epoch times. Both or neither
    /// with `end`.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub start: Option<f64>,
    /// End of `start`'s span, same units and the same all-or-nothing rule.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub end: Option<f64>,
}

/// What a text's segment timings are timings *into*: the recording the
/// learner imported the subtitles from.
///
/// A reference, never the media itself — nothing about a video is small enough
/// or ours enough to put in a log that syncs to every paired device. A `file`
/// keeps only the name, enough to ask "is this the one?" when the text is
/// opened again; a `youtube` keeps the id, which is the whole address.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadingMedia {
    Youtube {
        #[serde(rename = "videoId")]
        video_id: String,
    },
    File {
        /// The file's name as the learner's disk spells it, for the "choose it
        /// again" prompt.
        name: String,
        /// Its MIME type when the browser offered one — a hint for the picker.
        #[serde(
            rename = "type",
            default,
            deserialize_with = "absent_or",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        mime: Option<String>,
    },
}

/// A text the learner reads (or listens to) for comprehension — written by the
/// model from their vocabulary, or imported from a paste, a file or a video's
/// subtitles.
///
/// Immutable once stored, and only the text: no readings, no translations, no
/// glossary. Everything the reader shows about a word (its status, its reading,
/// whether it is highlighted) is derived at render time from the vocabulary and
/// the learner's marks.
///
/// A `textAdded` written before segments were the stored unit carries
/// `sentences` with a `reading`, a `translation` and a `glossary` beside them;
/// `sentences` reads as `segments` and the rest is dropped on the way in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReadingText {
    pub id: String,
    /// Short, in the target language.
    pub title: String,
    pub source: TextSource,
    /// The learner's topic, when a generated text was asked for one.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub topic: Option<String>,
    /// The text as its source cut it — one per cue, or one per paragraph.
    #[serde(alias = "sentences")]
    pub segments: Vec<Segment>,
    /// What the segment timings belong to, when the text was imported from
    /// subtitles and the learner said which recording they came from. Attached
    /// at import and never afterwards.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub media: Option<ReadingMedia>,
    /// Epoch milliseconds.
    pub created_at: f64,
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

/// One line of the target language with its Latin reading. `$lib/conversation`'s
/// `TargetLine` has the same shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ConversationLine {
    pub text: String,
    /// Absent for targets already written in the Latin script.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub reading: Option<String>,
}

/// The scene both sides play, fixed for a conversation's whole life.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationScenario {
    /// Native language: the setup has to be understood before the target
    /// language starts.
    pub setting: String,
    pub teacher_role: String,
    pub learner_role: String,
    pub first_speaker: Speaker,
    /// The teacher's opening line — present exactly when it speaks first.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub opener: Option<ConversationLine>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub opener_translation: Option<String>,
}

/// The learner's whole message rewritten, with an optional note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ConversationCorrection {
    pub corrected: ConversationLine,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub note: Option<String>,
}

/// One tool the teacher ran on a turn — `add_words`, in practice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ConversationAction {
    pub tool: String,
    pub summary: String,
    pub ok: bool,
}

/// What the learner wrote, with what came back *about* it.
///
/// `heard` and `correction` arrive with the *next* teacher turn and belong to
/// this bubble, so they are stored on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ConversationLearnerTurn {
    pub role: LearnerRole,
    /// Exactly what they typed, never the corrected version.
    pub text: String,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub heard: Option<ConversationLine>,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub correction: Option<ConversationCorrection>,
}

/// One teacher line, with whatever it filed away while writing it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ConversationTeacherTurn {
    pub role: TeacherRole,
    pub reply: ConversationLine,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub translation: Option<String>,
    pub actions: Vec<ConversationAction>,
}

/// A role-played conversation, as the library lists it. The scene is
/// immutable; only the transcript grows, one `ConversationExchange` at a time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub scenario: ConversationScenario,
    /// What the learner asked to talk about, when they asked for anything.
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub topic: Option<String>,
    /// Epoch milliseconds.
    pub created_at: f64,
}

/// The unit of persistence: one learner message and the teacher turn that
/// answered it, stored together because that is the only state the turn loop
/// can resume from. `learner` is absent only at index 0, where the scenario's
/// opener seeds the transcript.
///
/// Identity is `(conversationId, index)`, derived from the content and so the
/// same on every device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExchange {
    pub conversation_id: String,
    /// Position in the transcript, from 0.
    pub index: f64,
    #[serde(
        default,
        deserialize_with = "absent_or",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub learner: Option<ConversationLearnerTurn>,
    pub teacher: ConversationTeacherTurn,
}

/// One library row: the conversation plus the two facts a shelf entry needs of
/// its transcript, counted in SQL rather than by loading every transcript.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(flatten)]
    pub conversation: Conversation,
    /// How many exchanges are stored, opener included.
    pub turn_count: f64,
    /// When the last one landed; absent while the transcript is still empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_turn_at: Option<f64>,
}

/// `getConversation`'s answer: the scene and its whole transcript in `index`
/// order.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
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
        let ok: Segment = serde_json::from_value(json!({ "text": "a" })).unwrap();
        assert_eq!(ok.start, None);
        assert_eq!(serde_json::to_value(&ok).unwrap(), json!({ "text": "a" }));

        let null = serde_json::from_value::<Segment>(json!({ "text": "a", "start": null }));
        assert!(null.is_err(), "zod's .optional() does not accept null");
    }

    #[test]
    fn unknown_fields_are_stripped() {
        let segment: Segment = serde_json::from_value(json!({ "text": "t", "extra": 1 })).unwrap();
        assert_eq!(
            serde_json::to_value(&segment).unwrap(),
            json!({ "text": "t" })
        );
    }

    #[test]
    fn an_old_text_reads_as_segments_and_loses_its_annotations() {
        let text: ReadingText = serde_json::from_value(json!({
            "id": "t", "title": "T", "source": "imported",
            "sentences": [
                { "text": "Hola.", "reading": "r", "translation": "Hi.", "start": 0, "end": 1200 },
                { "text": "Adiós.", "translation": "Bye." }
            ],
            "glossary": [{ "term": "hola", "meaning": "hi" }],
            "createdAt": 9
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            json!({
                "id": "t", "title": "T", "source": "imported",
                "segments": [{ "text": "Hola.", "start": 0.0, "end": 1200.0 }, { "text": "Adiós." }],
                "createdAt": 9.0
            })
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
