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
//! command calls, so the path under test is the one the app uses. There is no
//! webview here and there does not need to be: the command is two lines around
//! this call, and what it adds — `spawn_blocking`, so the main thread is not
//! the one waiting — is what the second test covers, since it means several
//! pool threads can now be inside the handle at once.
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

/// The persistence commands are `async` and wait on `spawn_blocking`, so calls
/// no longer arrive one at a time from the main thread: several pool threads
/// can be inside the handle at once. Two things have to hold for that to be
/// safe, and neither is visible from a single-threaded test.
///
/// The first is that the handle can be shared at all — `Arc<Database>` is what
/// Tauri manages and what the command clones into its blocking closure, which
/// needs `Send + Sync`. The second is that concurrent callers are *serialised*
/// rather than racing: one thread owns the core, so sixteen writes issued at
/// once must all land, none lost to a half-applied transaction.
///
/// What is deliberately not asserted is which of two concurrent calls wins.
/// Nothing here decides that — the pool does — and it is the window that keeps
/// the order it meant, by chaining its `invoke`s (`src/lib/db/tauri.ts`). The
/// host's own guarantee is the weaker, sequential one, and it is checked at the
/// end: a read issued after a write sees it.
#[test]
fn concurrent_calls_are_serialised_and_none_is_lost() {
    use std::sync::Arc;

    fn shareable<T: Send + Sync + 'static>() {}
    shareable::<CoreHandle>();
    shareable::<sapling_desktop::host::Database>();

    let dir = std::env::temp_dir().join(format!(
        "sapling-desktop-concurrent-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = fs::remove_dir_all(&dir);

    let core = Arc::new(CoreHandle::open(&dir).expect("the core opens on a fresh directory"));
    let terms: Vec<String> = (0..16).map(|n| format!("word-{n}")).collect();

    let writers: Vec<_> = terms
        .iter()
        .map(|term| {
            let core = Arc::clone(&core);
            let term = term.clone();
            std::thread::spawn(move || {
                read(&core, "markWord", json!([term, true]));
            })
        })
        .collect();
    for writer in writers {
        writer.join().expect("a writer finishes");
    }

    let mut known: Vec<String> = read(&core, "getKnownTerms", json!([]))
        .expect("getKnownTerms answers")
        .as_array()
        .expect("an array of terms")
        .iter()
        .map(|term| term.as_str().unwrap_or_default().to_owned())
        .collect();
    known.sort();
    let mut expected = terms.clone();
    expected.sort();
    assert_eq!(
        known, expected,
        "every concurrent write landed exactly once"
    );

    // Back to back on one thread: the sequential guarantee the window's queue
    // restores on top of the pool.
    read(&core, "markWord", json!(["written-then-read", true]));
    let after = read(&core, "getKnownTerms", json!([])).expect("getKnownTerms answers");
    assert!(
        after
            .as_array()
            .expect("an array of terms")
            .iter()
            .any(|term| term == "written-then-read"),
        "a read issued after a write sees it"
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
