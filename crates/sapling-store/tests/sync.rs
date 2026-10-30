//! The sync client over the native core, end to end: two devices, each a
//! `CoreHandle` on its own directory, and `sapling-sync`'s in-memory relay
//! between them. This is the whole of what a native frontend needs to sync —
//! a store and a transport — and the merge rules under it are the real ones,
//! so the cases that depend on them (an own event coming back is a stamp, a
//! row this build cannot read is carried rather than dropped) live here.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use sapling_db::{Core, Param};
use sapling_domain::events::{parse_payload, EventType, Payload};
use sapling_store::CoreHandle;
use sapling_sync::relay::MemoryRelay;
use sapling_sync::{pair, phrase, run, SyncOutcome, Transport, PHRASE_LENGTH};

const SERVER: &str = "https://sync.example";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sapling-sync-{name}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn device(name: &str) -> CoreHandle {
    CoreHandle::open(&scratch(name)).expect("the core opens")
}

fn on<T: Send + 'static>(
    core: &CoreHandle,
    call: impl FnOnce(&Core) -> sapling_db::Result<T> + Send + 'static,
) -> T {
    core.run(call).expect("core thread").expect("core call")
}

fn fact(kind: EventType, payload: Value) -> Payload {
    parse_payload(kind, &payload).expect("payload parses")
}

fn add_word(core: &CoreHandle, n: u32) {
    let payload = fact(
        EventType::ItemAdded,
        json!({
            "id": format!("i{n}"), "kind": "vocab", "term": format!("term{n}"),
            "meaning": format!("meaning {n}"), "introducedAt": 1_700_000_000_000u64 + u64::from(n)
        }),
    );
    on(core, move |core| core.commit(payload));
}

fn terms(core: &CoreHandle) -> Vec<String> {
    let mut terms: Vec<String> = on(core, |core| core.get_all_items(false))
        .into_iter()
        .map(|item| item.term)
        .collect();
    terms.sort();
    terms
}

/// `(id, seq)` for every row of the log, in insertion order.
fn log(core: &CoreHandle) -> Vec<(String, Option<f64>)> {
    on(core, |core| {
        core.query("SELECT id, seq FROM events ORDER BY rowid", &[])?
            .iter()
            .map(|row| Ok((row.text("id")?.to_owned(), row.opt_f64("seq")?)))
            .collect()
    })
}

fn count(core: &CoreHandle, table: &'static str) -> f64 {
    on(core, move |core| {
        core.query(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])?[0].f64("n")
    })
}

fn sync<T: Transport>(relay: &T, core: &CoreHandle, phrase: &str) -> SyncOutcome {
    let outcome = pollster::block_on(run(relay, core, SERVER, phrase));
    assert!(outcome.ok, "{outcome:?}");
    outcome
}

#[test]
fn two_devices_converge_through_the_relay() {
    let relay = MemoryRelay::default();
    let phrase = phrase::mint(&[42; PHRASE_LENGTH]);
    let laptop = device("laptop");
    let phone = device("phone");

    let profile = fact(
        EventType::ProfileUpdated,
        json!({
            "nativeLanguage": "English", "targetLanguage": "Spanish", "level": "beginner",
            "interests": ["cooking"], "model": "m", "createdAt": 1
        }),
    );
    on(&laptop, move |core| core.commit(profile));
    add_word(&laptop, 1);
    add_word(&laptop, 2);

    let first = sync(&relay, &laptop, &phrase);
    assert_eq!((first.pushed, first.pulled), (3, 3));

    // The second device pairs from the phrase as a learner would type it.
    let typed = phrase::format(&phrase).to_lowercase();
    let paired = pollster::block_on(pair(&relay, &phone, SERVER, &typed));
    assert!(paired.ok && paired.paired, "{paired:?}");
    assert_eq!(terms(&phone), ["term1", "term2"]);
    assert_eq!(
        on(&phone, Core::get_profile).map(|p| p.target_language),
        Some("Spanish".to_owned())
    );

    add_word(&phone, 3);
    let back = sync(&relay, &phone, &phrase);
    assert_eq!((back.pushed, back.pulled), (1, 1));
    sync(&relay, &laptop, &phrase);

    assert_eq!(terms(&laptop), ["term1", "term2", "term3"]);
    assert_eq!(terms(&phone), terms(&laptop));
    assert_eq!(relay.log(&phrase).len(), 4);
    for core in [&laptop, &phone] {
        assert!(log(core).iter().all(|(_, seq)| seq.is_some()));
        assert_eq!(on(core, Core::get_pull_cursor), 4.0);
    }
    assert_eq!(
        sync(&relay, &laptop, &phrase).summary,
        "Already up to date."
    );
}

#[test]
fn following_another_library_sends_it_everything_and_pulls_it_from_the_start() {
    let relay = MemoryRelay::default();
    let first = phrase::mint(&[3; PHRASE_LENGTH]);
    let second = phrase::mint(&[5; PHRASE_LENGTH]);
    let laptop = device("follow-laptop");
    let phone = device("follow-phone");
    add_word(&laptop, 1);
    add_word(&laptop, 2);
    sync(&relay, &laptop, &first);
    assert_eq!(on(&laptop, Core::get_pull_cursor), 2.0);
    // The second library already has a history of its own, at seqs the
    // laptop's cursor has already passed in the first.
    add_word(&phone, 3);
    add_word(&phone, 4);
    sync(&relay, &phone, &second);

    let switched = sync(&relay, &laptop, &second);

    assert_eq!(switched.pushed, 2, "{switched:?}");
    assert_eq!(terms(&laptop), ["term1", "term2", "term3", "term4"]);
    assert_eq!(relay.log(&second).len(), 4);
    assert_eq!(on(&laptop, Core::get_pull_cursor), 4.0);
    sync(&relay, &phone, &second);
    assert_eq!(terms(&phone), terms(&laptop));

    // And back again: a resend the first room answers with the seqs it gave.
    sync(&relay, &laptop, &first);
    assert_eq!(relay.log(&first).len(), 4);
    assert_eq!(count(&laptop, "events"), 4.0);
}

#[test]
fn the_same_room_keeps_its_position() {
    let core = device("follow-same");
    add_word(&core, 1);
    let room = sapling_sync::room_key(SERVER, &phrase::mint(&[1; PHRASE_LENGTH]));
    // No room recorded yet: cleared, which on a fresh device clears nothing.
    let room_again = room.clone();
    assert!(on(&core, move |core| core.follow_sync_room(&room_again)));
    let id = log(&core)[0].0.clone();
    on(&core, move |core| core.mark_pushed(&[(id, 1.0)]));
    on(&core, |core| core.set_pull_cursor(7.0));
    let same = room.clone();
    assert!(!on(&core, move |core| core.follow_sync_room(&same)));
    assert_eq!(on(&core, Core::get_pull_cursor), 7.0);
    assert_eq!(log(&core)[0].1, Some(1.0));
    assert!(on(&core, |core| core.follow_sync_room("elsewhere")));
    assert_eq!(on(&core, Core::get_pull_cursor), 0.0);
    assert!(log(&core).iter().all(|(_, seq)| seq.is_none()));
}

#[test]
fn an_own_event_coming_back_is_a_stamp_not_a_second_row() {
    let relay = MemoryRelay::default();
    let phrase = phrase::mint(&[7; PHRASE_LENGTH]);
    let core = device("echo");
    add_word(&core, 1);

    sync(&relay, &core, &phrase);

    assert_eq!(count(&core, "events"), 1.0);
    assert_eq!(count(&core, "items"), 1.0);
    assert_eq!(log(&core)[0].1, Some(1.0));
    assert_eq!(on(&core, Core::get_pull_cursor), 1.0);
}

#[test]
fn a_row_this_build_cannot_read_travels_both_ways() {
    let relay = MemoryRelay::default();
    let phrase = phrase::mint(&[9; PHRASE_LENGTH]);
    let older = device("skew-older");
    // A kind only a newer build writes, imported ahead of an ordinary event:
    // pushed like any other, so the row behind it does not starve.
    let import = json!({
        "version": 3, "exportedAt": 1,
        "events": [
            { "id": "e1", "type": "wordShelved", "at": 1, "device": "devB", "payload": { "term": "水" } },
            { "id": "e2", "type": "itemAdded", "at": 2, "device": "devA", "payload": {
                "id": "i1", "kind": "vocab", "term": "term1", "meaning": "m", "introducedAt": 2 } }
        ]
    })
    .to_string();
    on(&older, move |core| core.import_data(&import));

    let outcome = sync(&relay, &older, &phrase);
    assert_eq!(outcome.pushed, 2);
    let pushed: Vec<Value> = relay
        .log(&phrase)
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    assert_eq!(pushed, [json!("e1"), json!("e2")]);

    // And pulled into a fresh device: kept in the log, cursor past it,
    // materialising nothing for the row it cannot read.
    let fresh = device("skew-fresh");
    sync(&relay, &fresh, &phrase);
    let ids: Vec<String> = log(&fresh).into_iter().map(|(id, _)| id).collect();
    assert_eq!(ids, ["e1", "e2"]);
    assert_eq!(on(&fresh, Core::get_pull_cursor), 2.0);
    assert_eq!(terms(&fresh), ["term1"]);
    let kept = on(&fresh, |core| {
        core.query("SELECT type FROM events WHERE id = ?", &[Param::text("e1")])
    });
    assert_eq!(kept[0].text("type").unwrap(), "wordShelved");
}

fn reading_text(id: &str, line: &str) -> sapling_domain::types::ReadingText {
    serde_json::from_value(json!({
        "id": id, "title": "T", "source": "imported",
        "segments": [{ "text": line, "start": 0, "end": 1000 }], "createdAt": 1
    }))
    .expect("a text")
}

fn bodies(core: &CoreHandle) -> Vec<String> {
    on(core, |core| core.get_texts())
        .into_iter()
        .flat_map(|text| text.segments.into_iter().map(|segment| segment.text))
        .collect()
}

#[test]
fn a_text_travels_as_an_event_and_an_object_and_its_revision_follows() {
    let relay = MemoryRelay::default();
    let phrase = phrase::mint(&[11; PHRASE_LENGTH]);
    let laptop = device("text-laptop");
    let phone = device("text-phone");
    on(&laptop, |core| core.add_text(&reading_text("t1", "你好。")));

    sync(&relay, &laptop, &phrase);
    // The relay holds the body once, and an edge from the text to it; the
    // row it stores carries neither, so the log here and there is unchanged.
    assert_eq!(relay.objects(&phrase).len(), 1);
    let (hash, bytes) = relay.objects(&phrase).into_iter().next().unwrap();
    assert_eq!(
        relay.edges(&phrase),
        [("text:singleton:t1".to_owned(), hash.clone())]
    );
    assert_eq!(relay.log(&phrase)[0]["payload"]["content"], json!(hash));
    assert!(relay.log(&phrase)[0].get("owner").is_none());

    sync(&relay, &phone, &phrase);
    assert_eq!(bodies(&phone), ["你好。"]);

    // A revision by reference: the phone stores the new body as an object
    // (as an editor would) and logs the edge to it.
    let revised = sapling_domain::objects::TextContent {
        segments: reading_text("t1", "你好吗？").segments,
    }
    .to_object();
    let content = revised.hash.clone();
    on(&phone, move |core| core.put_objects(&[revised]));
    let fact = fact(
        EventType::TextRevised,
        json!({ "textId": "t1", "content": content }),
    );
    on(&phone, move |core| core.commit(fact));
    assert_eq!(bodies(&phone), ["你好吗？"]);
    sync(&relay, &phone, &phrase);
    sync(&relay, &laptop, &phrase);
    assert_eq!(bodies(&laptop), ["你好吗？"]);
    assert!(on(&laptop, Core::missing_objects).is_empty());
    assert_eq!(relay.objects(&phrase).len(), 2);
    assert!(relay.objects(&phrase).get(&hash) == Some(&bytes));

    // Deleted: retired at the relay, gone everywhere; nothing is collected.
    on(&laptop, |core| core.delete_text("t1"));
    sync(&relay, &laptop, &phrase);
    sync(&relay, &phone, &phrase);
    assert_eq!(relay.retired(&phrase), ["text:singleton:t1"]);
    assert!(bodies(&phone).is_empty());
    assert_eq!(count(&phone, "objects"), 2.0);
}

#[test]
fn a_text_waits_for_its_object_and_a_rebuild_keeps_what_arrived() {
    let relay = MemoryRelay::default();
    let phrase = phrase::mint(&[13; PHRASE_LENGTH]);
    let laptop = device("wait-laptop");
    on(&laptop, |core| core.add_text(&reading_text("t1", "再见。")));
    sync(&relay, &laptop, &phrase);

    // The phone pulls the event from a relay that has lost the object (as if
    // another device had pushed the event without it): the text is not shown.
    let event = relay.log(&phrase)[0].clone();
    let lonely = MemoryRelay::default();
    let body = relay.objects(&phrase).into_values().next().unwrap();
    let phone = device("wait-phone");
    on(&phone, move |core| core.apply_remote(&[event]));
    sync(&lonely, &phone, &phrase);
    assert!(bodies(&phone).is_empty());
    assert_eq!(on(&phone, Core::missing_objects).len(), 1);

    // Once it is on the relay, the next cycle fetches it, and a rebuild (a
    // profile switch, an import) does not throw it away.
    lonely.hold(&phrase, &body);
    sync(&lonely, &phone, &phrase);
    assert_eq!(bodies(&phone), ["再见。"]);
    on(&phone, |core| {
        core.import_data(r#"{ "version": 3, "exportedAt": 1, "events": [] }"#)
    });
    assert_eq!(bodies(&phone), ["再见。"]);
}
