//! Content objects in the local store (`docs/content-objects.md` §6): a new
//! text is an object plus a `textAdded` that names it, written together; a text
//! whose current object is absent is shown by no read until it arrives; and
//! `objects` is not an aggregate, so nothing that rebuilds the read model
//! touches it.

use std::cell::Cell;

use serde_json::{json, Value};

use sapling_db::{Core, Param};
use sapling_domain::events::{parse_payload, EventType};
use sapling_domain::objects::{ContentObject, TextContent};
use sapling_domain::types::{KnowledgeItem, Profile, ReadingText};
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;

fn core() -> Core {
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || 1_710_000_000_000.0,
        {
            let next = Cell::new(0);
            move || {
                next.set(next.get() + 1);
                format!("local-{}", next.get())
            }
        },
        Utc,
    )
    .expect("schema applies")
}

fn text(id: &str, line: &str) -> ReadingText {
    serde_json::from_value(json!({
        "id": id, "title": "T", "source": "imported",
        "segments": [{ "text": line, "start": 0, "end": 1000 }],
        "media": { "kind": "youtube", "videoId": "v" },
        "createdAt": 1
    }))
    .expect("a text")
}

fn body(line: &str) -> ContentObject {
    TextContent {
        segments: text("-", line).segments,
    }
    .to_object()
}

fn count(core: &Core, table: &str) -> f64 {
    core.query(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])
        .expect("count")[0]
        .f64("n")
        .expect("a number")
}

fn payloads(core: &Core) -> Vec<(String, Value)> {
    core.query("SELECT type, payload FROM events ORDER BY rowid", &[])
        .expect("log")
        .iter()
        .map(|row| {
            (
                row.text("type").unwrap().to_owned(),
                serde_json::from_str(row.text("payload").unwrap()).unwrap(),
            )
        })
        .collect()
}

fn lines(core: &Core) -> Vec<String> {
    core.get_texts()
        .expect("get_texts")
        .into_iter()
        .flat_map(|text| text.segments.into_iter().map(|s| s.text))
        .collect()
}

/// A pulled `textAdded` that names `hash`, as another device wrote it.
fn remote_text(core: &Core, seq: u32, id: &str, hash: &str) {
    core.apply_remote(&[json!({
        "seq": seq, "id": format!("remote-{seq}"), "type": "textAdded", "at": 2, "device": "devB",
        "payload": {
            "id": id, "title": "R", "source": "imported", "content": hash,
            "media": { "kind": "youtube", "videoId": "r" }, "createdAt": 2
        }
    })])
    .expect("apply_remote");
}

fn know(core: &Core, term: &str) {
    let item: KnowledgeItem = serde_json::from_value(json!({
        "id": "i1", "kind": "vocab", "term": term, "meaning": "-", "introducedAt": 1,
    }))
    .expect("an item");
    core.upsert_items(&[item]).expect("upsert");
}

#[test]
fn a_new_text_is_its_object_and_an_event_that_names_it() {
    let core = core();
    core.add_text(&text("t1", "你好。")).expect("add");

    let expected = body("你好。");
    let log = payloads(&core);
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].0, "textAdded");
    assert_eq!(log[0].1["content"], json!(expected.hash));
    assert!(log[0].1.get("segments").is_none(), "the body is not inline");
    assert_eq!(
        core.get_objects(std::slice::from_ref(&expected.hash))
            .unwrap(),
        [expected]
    );
    assert_eq!(core.get_text("t1").unwrap().unwrap(), text("t1", "你好。"));
}

#[test]
fn a_body_too_large_for_any_relay_is_refused_and_nothing_is_written() {
    let core = core();
    let long = "字".repeat(400_000);
    assert!(core.add_text(&text("t1", &long)).is_err());
    assert_eq!(count(&core, "events"), 0.0);
    assert_eq!(count(&core, "objects"), 0.0);
}

#[test]
fn an_object_is_kept_only_under_its_own_name() {
    let core = core();
    let good = body("好。");
    let forged = ContentObject {
        hash: good.hash.clone(),
        bytes: r#"{"segments":[]}"#.into(),
    };
    let not_json = ContentObject {
        hash: sapling_domain::objects::object_hash(b"not json"),
        bytes: "not json".into(),
    };
    assert_eq!(core.put_objects(&[forged, not_json]).unwrap(), 0);
    assert_eq!(count(&core, "objects"), 0.0);
    assert_eq!(core.put_objects(&[good.clone(), good.clone()]).unwrap(), 2);
    assert_eq!(count(&core, "objects"), 1.0);
    assert_eq!(
        core.get_objects(&[good.hash.clone(), "sha256:x".into()])
            .unwrap(),
        [good]
    );
}

#[test]
fn a_text_whose_object_is_absent_is_returned_by_no_read_until_it_arrives() {
    let core = core();
    know(&core, "猫");
    let object = body("猫在睡觉。");
    remote_text(&core, 1, "t1", &object.hash);

    assert!(core.get_texts().unwrap().is_empty());
    assert_eq!(core.get_text("t1").unwrap(), None);
    assert!(core.clips_for(&["猫".into()], None).unwrap().is_empty());
    assert!(core.cues_for(&["i1".into()]).unwrap().is_empty());
    assert_eq!(
        core.missing_objects().unwrap(),
        std::slice::from_ref(&object.hash)
    );

    // Stored: readable at once, everywhere, with no rebuild.
    core.put_objects(&[object]).unwrap();
    assert_eq!(lines(&core), ["猫在睡觉。"]);
    assert!(core.get_text("t1").unwrap().is_some());
    assert_eq!(core.clips_for(&["猫".into()], None).unwrap().len(), 1);
    assert_eq!(core.cues_for(&["i1".into()]).unwrap().len(), 1);
    assert!(core.missing_objects().unwrap().is_empty());
}

#[test]
fn an_object_that_is_json_but_not_a_body_hides_its_text_and_fails_no_read() {
    let core = core();
    core.add_text(&text("t1", "留下。")).unwrap();
    let odd = ContentObject {
        hash: sapling_domain::objects::object_hash(br#"{"pages":[]}"#),
        bytes: r#"{"pages":[]}"#.into(),
    };
    core.put_objects(std::slice::from_ref(&odd)).unwrap();
    remote_text(&core, 1, "t2", &odd.hash);
    assert_eq!(lines(&core), ["留下。"]);
}

#[test]
fn a_rebuild_keeps_the_objects_and_a_reset_does_not() {
    let core = core();
    core.add_text(&text("t1", "一。")).unwrap();
    // An import rebuilds every read table from the log.
    core.import_data(r#"{ "version": 3, "exportedAt": 1, "events": [] }"#)
        .unwrap();
    assert_eq!(lines(&core), ["一。"]);
    assert_eq!(count(&core, "objects"), 1.0);

    core.reset_data().unwrap();
    assert_eq!(count(&core, "objects"), 0.0);
}

#[test]
fn a_revision_in_a_profile_s_library_is_scoped_and_survives_a_switch() {
    let core = core();
    let profile: Profile = serde_json::from_value(json!({
        "nativeLanguage": "English", "targetLanguage": "Mandarin", "level": "beginner",
        "interests": [], "model": "m", "createdAt": 1
    }))
    .unwrap();
    let id = core.create_profile(&profile).unwrap();
    core.add_text(&text("t1", "旧。")).unwrap();
    let revised = body("新。");
    core.put_objects(std::slice::from_ref(&revised)).unwrap();
    core.commit(
        parse_payload(
            EventType::TextRevised,
            &json!({ "textId": "t1", "content": revised.hash }),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(lines(&core), ["新。"]);
    let wrapped = core
        .query(
            "SELECT payload FROM events WHERE type = 'profileEvent' AND payload LIKE ?",
            &[Param::text("%textRevised%")],
        )
        .unwrap();
    assert_eq!(wrapped.len(), 1, "logged inside its profile");

    // Away and back: two rebuilds, and the body is still the revised one.
    let other = core.create_profile(&profile).unwrap();
    assert!(lines(&core).is_empty());
    assert_ne!(other, id);
    core.set_active_profile(&id).unwrap();
    assert_eq!(lines(&core), ["新。"]);
}
