//! The one thing the desktop host adds that no other host has: a file.
//!
//! The merge rules are already proven twice over — `crates/sapling-core`'s
//! `tests/golden.rs` runs every fixture natively and `src/lib/db/golden.test.ts`
//! runs the same files through the wasm build. What is new here is that the
//! database outlives the process, so this test proves exactly that and nothing
//! else: apply the `broad` fixture's log, close the core, reopen the *same
//! file*, and read the same answers back.
//!
//! Everything goes through `CoreHandle::dispatch`, which is what the Tauri
//! command calls, so the path under test is the one the app uses.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use sapling_desktop::host::{CoreHandle, DATABASE_FILE, DEVICE_ID_FILE};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/db/fixtures/broad")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(&path).expect("fixture file")).expect("fixture parses")
}

/// One `Backend` read, as JSON — panics on the errors a fixture cannot produce.
fn read(core: &CoreHandle, method: &str, args: Value) -> Option<Value> {
    core.dispatch(method.to_owned(), args.to_string())
        .unwrap_or_else(|error| panic!("{method}: {error}"))
        .map(|answer| serde_json::from_str(&answer).expect("the answer is JSON"))
}

/// `getAllItems`, both ways, sorted by id — the shape `expected.json` records.
fn all_items(core: &CoreHandle) -> Value {
    let of = |recent: bool| {
        let mut rows = read(core, "getAllItems", json!([{ "withRecentGrades": recent }]))
            .expect("getAllItems answers")
            .as_array()
            .expect("getAllItems is an array")
            .clone();
        rows.sort_by(|a, b| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .cmp(b["id"].as_str().unwrap_or(""))
        });
        Value::Array(rows)
    };
    json!({ "lean": of(false), "withRecentGrades": of(true) })
}

#[test]
fn the_database_outlives_the_process() {
    let expected = read_json(fixture_dir().join("expected.json"));
    let events = read_json(fixture_dir().join("events.json"))["events"].clone();
    let count = events.as_array().expect("events is an array").len();

    let dir = std::env::temp_dir().join(format!(
        "sapling-desktop-persistence-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);

    // First run: a directory that does not exist yet, and a log arriving off sync.
    let core = CoreHandle::open(&dir).expect("the core opens on a fresh directory");
    let applied = read(&core, "applyRemote", json!([events])).expect("applyRemote answers");
    assert_eq!(applied, json!(count), "every fixture row applies");
    assert_eq!(
        all_items(&core),
        expected["getAllItems"],
        "getAllItems, first run"
    );
    assert_eq!(
        read(&core, "getProfile", json!([])),
        Some(expected["getProfile"].clone()),
        "getProfile, first run"
    );

    let device_id = fs::read_to_string(dir.join(DEVICE_ID_FILE)).expect("the device id is written");
    assert!(!device_id.trim().is_empty(), "the device id is not blank");
    assert!(
        dir.join(DATABASE_FILE).is_file(),
        "the database is a file on disk"
    );

    // Closing: dropping the handle joins the thread, so the connection is gone.
    drop(core);

    // Second run: the same directory, nothing re-applied.
    let core = CoreHandle::open(&dir).expect("the core reopens on the same file");
    assert_eq!(
        all_items(&core),
        expected["getAllItems"],
        "getAllItems, after reopening"
    );
    assert_eq!(
        read(&core, "getProfile", json!([])),
        Some(expected["getProfile"].clone()),
        "getProfile, after reopening"
    );
    assert_eq!(
        fs::read_to_string(dir.join(DEVICE_ID_FILE)).expect("the device id is still there"),
        device_id,
        "the device id is minted once and kept — it is half of a review's identity"
    );

    drop(core);
    let _ = fs::remove_dir_all(&dir);
}
