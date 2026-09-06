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
//!
//! One field of an item cannot be compared against `expected.json` here and is
//! stripped: `srs`, the schedule the core derives from the card **at read
//! time**. The fixtures pin a clock (`meta.now`) and this host owns the system
//! one — as a host should — so the forgetting curve read on the day the suite
//! runs is not the one blessed in 2024. What is checked instead is the fact
//! that belongs to this test: the derived field is there, and it says the same
//! thing before and after the process ended.

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

/// The same reads with every item's clock-dependent `srs` taken off — see the
/// module note for why it cannot be compared against a blessed file. Applied to
/// both sides, since `expected.json` records the fixture clock's answer.
fn without_derived(mut items: Value) -> Value {
    for rows in items
        .as_object_mut()
        .expect("both read shapes")
        .values_mut()
    {
        for row in rows.as_array_mut().expect("an array of items") {
            row.as_object_mut().expect("an item").remove("srs");
        }
    }
    items
}

/// Every item's `(id, srs)`, from the lean read — what the module note says is
/// checked instead of a blessed value.
fn derived(items: &Value) -> Vec<(String, Value)> {
    items["lean"]
        .as_array()
        .expect("an array of items")
        .iter()
        .map(|row| {
            let srs = row["srs"].clone();
            assert!(srs.is_object(), "every item read carries its derived srs");
            assert_eq!(
                srs["due"], row["fsrsCard"]["due"],
                "srs.due is the card's own due, passed straight through"
            );
            (row["id"].as_str().unwrap_or_default().to_owned(), srs)
        })
        .collect()
}

#[test]
fn the_database_outlives_the_process() {
    let expected = read_json(fixture_dir().join("expected.json"));
    let expected_items = without_derived(expected["getAllItems"].clone());
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
    let first = all_items(&core);
    assert_eq!(
        without_derived(first.clone()),
        expected_items,
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
    let second = all_items(&core);
    assert_eq!(
        without_derived(second.clone()),
        expected_items,
        "getAllItems, after reopening"
    );
    assert_eq!(
        derived(&second),
        derived(&first),
        "the derived schedule survives the process, and is read off the same cards"
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

/// A file that will not open is a message, not a crash: `Database` keeps the
/// reason and answers it to every call, which is what the window turns into
/// the boot-error screen.
#[test]
fn a_database_that_will_not_open_answers_why() {
    use sapling_desktop::host::Database;

    // A data directory *under a regular file* cannot be created on any OS.
    let file = std::env::temp_dir().join(format!(
        "sapling-desktop-not-a-directory-{}",
        std::process::id()
    ));
    fs::write(&file, b"").expect("the blocking file is written");
    let dir = file.join("data");

    let db = Database::open(&dir);
    let error = db.error().expect("the open failed").to_owned();
    assert!(
        error.starts_with("The database could not be opened: "),
        "the message is readable as-is: {error}"
    );
    assert_eq!(
        db.dispatch("poolSize".to_owned(), "[]".to_owned()),
        Err(error.clone()),
        "the probe answers the reason"
    );
    assert_eq!(
        db.commit_all("[]".to_owned()),
        Err(error),
        "so does every other command"
    );

    let _ = fs::remove_file(&file);
}
