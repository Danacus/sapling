//! The golden fixtures, run against the Rust core.
//!
//! `src/lib/db/fixtures/<name>/events.json` in, `expected.json` out — the same
//! files `golden.test.ts` runs, probed the same way (see the README beside
//! them), and the same four extra checks: idempotence, an export imported into
//! a fresh core, the exported log equalling the input log, and reverse arrival
//! order where the fixture says its rules are order-free. Every read is
//! canonicalised through `js::stringify` and re-parsed before comparing, which
//! is what `JSON.parse(JSON.stringify(...))` does on the TypeScript side.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use sapling_core::rusqlite_sql::RusqliteSql;
use sapling_core::{js, Core, Utc};

const RECENT_LIMIT: i64 = 5;
const PENDING_LIMIT: i64 = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    device_id: String,
    now: f64,
    order_free: bool,
}

#[derive(Deserialize)]
struct FixtureFile {
    meta: Meta,
    events: Vec<Value>,
}

struct Fixture {
    name: String,
    dir: PathBuf,
    meta: Meta,
    events: Vec<Value>,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/db/fixtures")
}

fn load_fixtures() -> Vec<Fixture> {
    let mut fixtures: Vec<Fixture> = fs::read_dir(fixtures_dir())
        .expect("fixtures directory")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let dir = entry.path();
            let file: FixtureFile =
                serde_json::from_str(&fs::read_to_string(dir.join("events.json")).ok()?)
                    .expect("events.json parses");
            Some(Fixture {
                name: entry.file_name().to_string_lossy().into_owned(),
                dir,
                meta: file.meta,
                events: file.events,
            })
        })
        .collect();
    fixtures.sort_by(|a, b| a.name.cmp(&b.name));
    fixtures
}

fn fresh(fixture: &Fixture) -> Core {
    let now = fixture.meta.now;
    let counter = Rc::new(Cell::new(0u64));
    let ids = move || {
        counter.set(counter.get() + 1);
        format!("local-{}", counter.get())
    };
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        fixture.meta.device_id.clone(),
        move || now,
        ids,
        Utc,
    )
    .expect("schema applies")
}

fn applied(fixture: &Fixture, events: &[Value]) -> (Core, usize) {
    let core = fresh(fixture);
    let count = core.apply_remote(events).expect("apply_remote");
    (core, count)
}

/* ---- Probing, exactly as golden.test.ts does ------------------------------ */

fn field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str()
}

fn unique<'a>(values: impl Iterator<Item = Option<&'a str>>) -> Vec<String> {
    values
        .flatten()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

struct Ids {
    items: Vec<String>,
    challenges: Vec<String>,
    texts: Vec<String>,
    conversations: Vec<String>,
}

fn ids_in(events: &[Value]) -> Ids {
    let of = |types: &'static [&'static str], key: &'static str| {
        events
            .iter()
            .filter(move |e| types.contains(&e["type"].as_str().unwrap_or("")))
            .map(move |e| field(&e["payload"], key))
    };
    Ids {
        items: unique(of(&["itemAdded"], "id").chain(of(
            &[
                "itemReviewed",
                "reviewAmended",
                "itemUpdated",
                "itemDeleted",
            ],
            "itemId",
        ))),
        challenges: unique(
            events
                .iter()
                .filter(|e| e["type"] == "challengeAdded")
                .map(|e| field(&e["payload"]["challenge"], "id"))
                .chain(of(
                    &["challengeServed", "challengeReported", "resultLogged"],
                    "challengeId",
                )),
        ),
        texts: unique(
            of(&["textAdded"], "id").chain(of(&["textDeleted", "wordLookedUp"], "textId")),
        ),
        conversations: unique(
            of(&["conversationStarted"], "id")
                .chain(of(&["turnAdded", "conversationDeleted"], "conversationId")),
        ),
    }
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("reads serialise")
}

fn by_id(mut rows: Vec<Value>) -> Value {
    rows.sort_by(|a, b| {
        a["id"]
            .as_str()
            .unwrap_or("")
            .cmp(b["id"].as_str().unwrap_or(""))
    });
    Value::Array(rows)
}

fn by_key<T: serde::Serialize>(ids: &[String], read: impl Fn(&str) -> Option<T>) -> Value {
    let mut map = Map::new();
    for id in ids {
        map.insert(id.clone(), read(id).map(to_value).unwrap_or(Value::Null));
    }
    Value::Object(map)
}

/// `JSON.parse(JSON.stringify(value))`, with JavaScript's number formatting.
fn canonical(value: Value) -> Value {
    serde_json::from_str(&js::stringify(&value)).expect("canonical JSON re-parses")
}

fn probe(core: &Core, events: &[Value]) -> Value {
    let ids = ids_in(events);
    let all = |recent: bool| {
        by_id(
            core.get_all_items(recent)
                .expect("get_all_items")
                .into_iter()
                .map(to_value)
                .collect(),
        )
    };
    let mut known = core.get_known_terms().expect("get_known_terms");
    known.sort();
    let mut reads = json!({
        "getAllItems": { "lean": all(false), "withRecentGrades": all(true) },
        "getItem": by_key(&ids.items, |id| core.get_item(id).expect("get_item")),
        "getPool": by_id(core.get_pool().expect("get_pool")),
        "poolSize": core.pool_size().expect("pool_size"),
        "getChallengesByIds": by_id(core.get_challenges_by_ids(&ids.challenges).expect("get_challenges_by_ids")),
        "recentResults": core.recent_results(RECENT_LIMIT).expect("recent_results"),
        "getDailyActivity": core.get_daily_activity().expect("get_daily_activity"),
        "getTexts": core.get_texts().expect("get_texts"),
        "getText": by_key(&ids.texts, |id| core.get_text(id).expect("get_text")),
        "getKnownTerms": known,
        "getConversations": core.get_conversations().expect("get_conversations"),
        "getConversation": by_key(&ids.conversations, |id| core.get_conversation(id).expect("get_conversation")),
        "exportData": serde_json::from_str::<Value>(&core.export_data().expect("export_data")).expect("export parses"),
        "pendingEvents": core.pending_events(PENDING_LIMIT).expect("pending_events"),
        "getPullCursor": core.get_pull_cursor().expect("get_pull_cursor"),
    });
    // `JSON.stringify` drops a key whose value is `undefined`, so a missing
    // profile is an absent key in `expected.json`, not a `null`.
    if let Some(profile) = core.get_profile().expect("get_profile") {
        let object = reads.as_object_mut().expect("probe is an object");
        object.shift_insert(0, "getProfile".to_owned(), to_value(profile));
    }
    canonical(reads)
}

/// The reads that are data. Sync bookkeeping differs, by design, on a core that imported the log.
fn data_only(mut reads: Value) -> Value {
    let object = reads.as_object_mut().expect("probe is an object");
    object.remove("pendingEvents");
    object.remove("getPullCursor");
    reads
}

/// The first path where two JSON values differ, for a failure message that says where to look.
fn first_difference(a: &Value, b: &Value, path: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: BTreeSet<&String> = x.keys().chain(y.keys()).collect();
            keys.into_iter()
                .find_map(|key| match (x.get(key), y.get(key)) {
                    (Some(p), Some(q)) => first_difference(p, q, &format!("{path}.{key}")),
                    (Some(_), None) => Some(format!("{path}.{key}: present in first only")),
                    (None, Some(_)) => Some(format!("{path}.{key}: present in second only")),
                    (None, None) => None,
                })
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: {} vs {} elements", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| first_difference(p, q, &format!("{path}[{i}]")))
        }
        _ if a == b => None,
        _ => Some(format!(
            "{path}: {} vs {}",
            js::stringify(a),
            js::stringify(b)
        )),
    }
}

fn assert_same(actual: &Value, expected: &Value, what: &str) {
    if let Some(difference) = first_difference(actual, expected, "$") {
        panic!("{what}: first difference at {difference}");
    }
}

/* ---- The checks ------------------------------------------------------------ */

#[test]
fn has_fixtures_to_run() {
    assert!(
        !load_fixtures().is_empty(),
        "no fixtures under {}",
        fixtures_dir().display()
    );
}

#[test]
fn applies_every_row() {
    for fixture in load_fixtures() {
        let (_, count) = applied(&fixture, &fixture.events);
        assert_eq!(
            count,
            fixture.events.len(),
            "{}: a row the gate rejects is a fixture bug, not a case",
            fixture.name
        );
    }
}

#[test]
fn reads_match_expected_json() {
    for fixture in load_fixtures() {
        let expected: Value = serde_json::from_str(
            &fs::read_to_string(fixture.dir.join("expected.json"))
                .unwrap_or_else(|_| panic!("{}/expected.json is missing", fixture.name)),
        )
        .expect("expected.json parses");
        let (core, _) = applied(&fixture, &fixture.events);
        let reads = probe(&core, &fixture.events);
        assert_same(
            &reads,
            &expected,
            &format!("{}: reads vs expected.json", fixture.name),
        );
    }
}

#[test]
fn reads_the_same_after_applying_the_log_twice() {
    for fixture in load_fixtures() {
        let (core, _) = applied(&fixture, &fixture.events);
        let once = probe(&core, &fixture.events);
        core.apply_remote(&fixture.events).expect("second apply");
        assert_same(
            &probe(&core, &fixture.events),
            &once,
            &format!("{}: idempotence", fixture.name),
        );
    }
}

#[test]
fn reads_the_same_from_a_fresh_core_that_imported_the_export() {
    for fixture in load_fixtures() {
        let (core, _) = applied(&fixture, &fixture.events);
        let restored = fresh(&fixture);
        restored
            .import_data(&core.export_data().expect("export"))
            .expect("import");
        assert_same(
            &data_only(probe(&restored, &fixture.events)),
            &data_only(probe(&core, &fixture.events)),
            &format!("{}: export/import round trip", fixture.name),
        );
    }
}

#[test]
fn exports_the_log_it_was_given_field_for_field() {
    for fixture in load_fixtures() {
        let (core, _) = applied(&fixture, &fixture.events);
        let exported: Value =
            serde_json::from_str(&core.export_data().expect("export")).expect("export parses");
        let mut seen = BTreeSet::new();
        let mut input: Vec<Value> = fixture
            .events
            .iter()
            .filter(|e| seen.insert(e["id"].as_str().unwrap_or("").to_owned()))
            .cloned()
            .collect();
        input.sort_by(|a, b| {
            a["seq"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&b["seq"].as_f64().unwrap_or(0.0))
                .expect("seqs are numbers")
        });
        for event in &mut input {
            event
                .as_object_mut()
                .expect("event is an object")
                .remove("seq");
        }
        assert_same(
            &canonical(exported["events"].clone()),
            &canonical(Value::Array(input)),
            &format!("{}: exported log vs input", fixture.name),
        );
    }
}

#[test]
fn reads_the_same_in_reverse_arrival_order_where_order_free() {
    for fixture in load_fixtures().into_iter().filter(|f| f.meta.order_free) {
        let (forwards, _) = applied(&fixture, &fixture.events);
        let reversed: Vec<Value> = fixture.events.iter().rev().cloned().collect();
        let (backwards, _) = applied(&fixture, &reversed);
        assert_same(
            &probe(&backwards, &fixture.events),
            &probe(&forwards, &fixture.events),
            &format!("{}: reverse arrival order", fixture.name),
        );
    }
}
