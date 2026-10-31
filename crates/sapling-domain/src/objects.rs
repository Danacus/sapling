//! Content objects: immutable byte strings named by their hash, which events
//! reference instead of carrying (`docs/content-objects.md` §2, §4).
//!
//! The log is the record of what the learner *did*; a text's body is content,
//! and riding inside `textAdded` for ever meant a deleted text's body could
//! never leave any device. So a new text's body is an object — a UTF-8 JSON
//! document — named `sha256:<64 lowercase hex>` over its **exact bytes**, and
//! the event holds the name. Every ingress verifies the name against the bytes
//! (the Worker on `PUT`, the client on fetch, the core on store); a mismatch is
//! refused, never kept.
//!
//! The bytes are the Rust struct serialised by `serde_json` — field order, no
//! whitespace — so the same body written on two devices is one object. That
//! canonical form buys dedup only: integrity is the hash over whatever bytes
//! arrived, so a future encoding change costs dedup, never correctness.
//!
//! Which objects an event makes some entity use, and which entity it ends, is
//! [`object_refs`] — the one function that derives the envelope fields the
//! relay records for a later GC. Nothing stores them locally and nothing writes
//! them by hand: the sync client computes them at push time.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::events::{typed_event, Payload, RawEvent};
use crate::types::{Chapter, Segment};

/// The algorithm, as the name spells it. Another one is another prefix.
pub const OBJECT_PREFIX: &str = "sha256:";

/// The largest object anything stores: the relay's Durable Object SQLite rows
/// cap at 2 MB, and `worker/protocol.ts`'s `MAX_OBJECT_BYTES` is the same.
pub const MAX_OBJECT_BYTES: usize = 1024 * 1024;

/// The name of these bytes.
pub fn object_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut name = String::with_capacity(OBJECT_PREFIX.len() + 64);
    name.push_str(OBJECT_PREFIX);
    for byte in digest {
        name.push_str(&format!("{byte:02x}"));
    }
    name
}

/// Whether a string names an object: the prefix and exactly 64 *lowercase*
/// hex digits — one spelling per hash, so nothing holds one body twice.
pub fn is_object_hash(name: &str) -> bool {
    name.strip_prefix(OBJECT_PREFIX).is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// One object as it crosses the protocol: its name and its bytes, which are
/// UTF-8 JSON and so travel as a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ContentObject {
    pub hash: String,
    pub bytes: String,
}

impl ContentObject {
    /// Whether `hash` really is the name of `bytes`.
    pub fn verifies(&self) -> bool {
        is_object_hash(&self.hash) && object_hash(self.bytes.as_bytes()) == self.hash
    }
}

/// A text's body as an object — the only kind in this slice. The field that
/// references an object fixes its schema: `textAdded.content` and
/// `textRevised.content` name one of these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextContent {
    pub segments: Vec<Segment>,
}

impl TextContent {
    /// The object: the canonical bytes and their name.
    pub fn to_object(&self) -> ContentObject {
        let bytes = serde_json::to_string(self).expect("a text body serialises");
        ContentObject {
            hash: object_hash(bytes.as_bytes()),
            bytes,
        }
    }
}

/// A textbook's chapters as an object: `textbookAdded.content` names one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextbookContent {
    pub chapters: Vec<Chapter>,
}

impl TextbookContent {
    /// The object: the canonical bytes and their name.
    pub fn to_object(&self) -> ContentObject {
        let bytes = serde_json::to_string(self).expect("a textbook serialises");
        ContentObject {
            hash: object_hash(bytes.as_bytes()),
            bytes,
        }
    }
}

/// The entity a textbook's object belongs to, scoped by profile like a text.
pub fn textbook_owner(profile_id: &str, textbook_id: &str) -> String {
    format!("textbook:{profile_id}:{textbook_id}")
}

/// The entity a text's objects belong to. Scoped by profile, because a text id
/// is unique within its library and nothing promises more.
pub fn text_owner(profile_id: &str, text_id: &str) -> String {
    format!("text:{profile_id}:{text_id}")
}

/// What one event declares about content, on the envelope beside `payload`:
/// the `owner` it makes use `objects` (one edge each), and the owner it ends
/// for good (`retire`, tombstones only). Serialised as the relay reads it —
/// each field only when it says something.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ObjectRefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retire: Option<String>,
}

impl ObjectRefs {
    pub fn is_empty(&self) -> bool {
        self.owner.is_none() && self.objects.is_empty() && self.retire.is_none()
    }
}

/// The envelope fields one log row declares (`docs/content-objects.md` §4),
/// unwrapping `profileEvent`:
///
/// | event                     | owner    | objects     | retire   |
/// |---------------------------|----------|-------------|----------|
/// | `textAdded` with `content`| the text | `[content]` | —        |
/// | `textRevised`             | the text | `[content]` | —        |
/// | `textDeleted`             | —        | —           | the text |
/// | `textbookAdded`           | the book | `[content]` | —        |
/// | `textbookDeleted`         | —        | —           | the book |
/// | anything else, inline too | —        | —           | —        |
///
/// A row this build cannot type declares nothing: an older build's gap is a
/// leak (an object nobody collects), never a lost body.
pub fn object_refs(raw: &RawEvent) -> ObjectRefs {
    let Some(event) = typed_event(raw) else {
        return ObjectRefs::default();
    };
    let owner = |text_id: &str| text_owner(&event.profile_id, text_id);
    match &event.payload {
        Payload::TextAdded(text) => match &text.content {
            Some(content) => ObjectRefs {
                owner: Some(owner(&text.id)),
                objects: vec![content.clone()],
                retire: None,
            },
            None => ObjectRefs::default(),
        },
        Payload::TextRevised(revised) => ObjectRefs {
            owner: Some(owner(&revised.text_id)),
            objects: vec![revised.content.clone()],
            retire: None,
        },
        Payload::TextDeleted(deleted) => ObjectRefs {
            retire: Some(owner(&deleted.text_id)),
            ..ObjectRefs::default()
        },
        Payload::TextbookAdded(book) => ObjectRefs {
            owner: Some(textbook_owner(&event.profile_id, &book.id)),
            objects: vec![book.content.clone()],
            retire: None,
        },
        Payload::TextbookDeleted(deleted) => ObjectRefs {
            retire: Some(textbook_owner(&event.profile_id, &deleted.textbook_id)),
            ..ObjectRefs::default()
        },
        _ => ObjectRefs::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::parse_envelope;
    use serde_json::{json, Value};

    const HASH: &str = "sha256:4d82ad43ab140c87d50cf46db35623b814ea3b4530590916f54696edc3419ead";

    /// The encoding and the hash, pinned: a change here splits every body this
    /// build writes from the same body an older build wrote.
    #[test]
    fn a_text_body_encodes_and_hashes_to_its_test_vector() {
        let body = TextContent {
            segments: vec![
                Segment {
                    text: "你好。".into(),
                    start: None,
                    end: None,
                },
                Segment {
                    text: "再见".into(),
                    start: Some(0.0),
                    end: Some(1200.0),
                },
            ],
        };
        let object = body.to_object();
        assert_eq!(
            object.bytes,
            r#"{"segments":[{"text":"你好。"},{"text":"再见","start":0.0,"end":1200.0}]}"#
        );
        assert_eq!(object.hash, HASH);
        assert!(object.verifies());
    }

    #[test]
    fn a_textbook_owns_its_object_and_its_tombstone_retires_it() {
        let row = |kind: &str, payload: Value| {
            parse_envelope(
                &json!({ "id": "e", "type": kind, "at": 1, "device": "d", "payload": payload }),
            )
            .unwrap()
        };
        let added = object_refs(&row(
            "textbookAdded",
            json!({ "id": "b1", "title": "T", "content": HASH, "createdAt": 1 }),
        ));
        assert_eq!(added.owner.as_deref(), Some("textbook:singleton:b1"));
        assert_eq!(added.objects, [HASH]);
        let deleted = object_refs(&row("textbookDeleted", json!({ "textbookId": "b1" })));
        assert_eq!(deleted.retire.as_deref(), Some("textbook:singleton:b1"));
        assert!(deleted.objects.is_empty());
    }

    #[test]
    fn the_hash_of_nothing_is_sha256_of_nothing() {
        assert_eq!(
            object_hash(b""),
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_name_has_one_spelling() {
        assert!(is_object_hash(HASH));
        assert!(!is_object_hash(&HASH.to_uppercase()));
        assert!(!is_object_hash(&HASH.replace("sha256:", "sha512:")));
        assert!(!is_object_hash(&HASH[..HASH.len() - 1]));
        assert!(!is_object_hash(&format!("{HASH}0")));
        assert!(!is_object_hash("sha256:"));
    }

    #[test]
    fn bytes_that_are_not_their_name_do_not_verify() {
        let object = ContentObject {
            hash: HASH.into(),
            bytes: r#"{"segments":[]}"#.into(),
        };
        assert!(!object.verifies());
    }

    fn row(kind: &str, payload: Value) -> RawEvent {
        parse_envelope(
            &json!({ "id": "e", "type": kind, "at": 1, "device": "d", "payload": payload }),
        )
        .expect("an envelope")
    }

    fn scoped(kind: &str, payload: Value) -> RawEvent {
        row(
            "profileEvent",
            json!({ "profileId": "p1", "type": kind, "payload": payload }),
        )
    }

    fn text(body: Value) -> Value {
        let mut payload = json!({ "id": "t1", "title": "T", "source": "imported", "createdAt": 1 });
        for (key, value) in body.as_object().unwrap() {
            payload[key] = value.clone();
        }
        payload
    }

    #[test]
    fn a_text_added_by_reference_owns_its_object() {
        assert_eq!(
            object_refs(&row("textAdded", text(json!({ "content": HASH })))),
            ObjectRefs {
                owner: Some("text:singleton:t1".into()),
                objects: vec![HASH.into()],
                retire: None,
            }
        );
    }

    #[test]
    fn a_revision_adds_an_edge_from_its_text() {
        assert_eq!(
            object_refs(&row(
                "textRevised",
                json!({ "textId": "t1", "content": HASH })
            )),
            ObjectRefs {
                owner: Some("text:singleton:t1".into()),
                objects: vec![HASH.into()],
                retire: None,
            }
        );
    }

    #[test]
    fn a_deleted_text_is_retired() {
        assert_eq!(
            object_refs(&row("textDeleted", json!({ "textId": "t1" }))),
            ObjectRefs {
                owner: None,
                objects: vec![],
                retire: Some("text:singleton:t1".into()),
            }
        );
    }

    #[test]
    fn an_inline_text_and_everything_else_declare_nothing() {
        let inline = row("textAdded", text(json!({ "segments": [{ "text": "s" }] })));
        assert!(object_refs(&inline).is_empty());
        let other = row("wordMarked", json!({ "term": "w", "known": true }));
        assert!(object_refs(&other).is_empty());
        // A row this build cannot type, and one with both bodies.
        assert!(object_refs(&row("textRenamed", json!({ "textId": "t1" }))).is_empty());
        let both = row(
            "textAdded",
            text(json!({ "segments": [], "content": HASH })),
        );
        assert!(object_refs(&both).is_empty());
    }

    #[test]
    fn a_scoped_event_is_owned_inside_its_profile() {
        let added = object_refs(&scoped("textAdded", text(json!({ "content": HASH }))));
        assert_eq!(added.owner.as_deref(), Some("text:p1:t1"));
        let revised = object_refs(&scoped(
            "textRevised",
            json!({ "textId": "t1", "content": HASH }),
        ));
        assert_eq!(revised.owner.as_deref(), Some("text:p1:t1"));
        let deleted = object_refs(&scoped("textDeleted", json!({ "textId": "t1" })));
        assert_eq!(deleted.retire.as_deref(), Some("text:p1:t1"));
    }

    #[test]
    fn the_fields_serialise_only_when_they_say_something() {
        let refs = object_refs(&row("textDeleted", json!({ "textId": "t1" })));
        assert_eq!(
            serde_json::to_value(&refs).unwrap(),
            json!({ "retire": "text:singleton:t1" })
        );
        assert_eq!(
            serde_json::to_value(ObjectRefs::default()).unwrap(),
            json!({})
        );
    }
}
