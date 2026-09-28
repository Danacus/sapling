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
