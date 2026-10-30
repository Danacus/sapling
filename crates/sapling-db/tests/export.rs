//! Export v4 against a real SQLite (`docs/content-objects.md` §6): the file
//! carries the objects its events reference, an import stores them with the
//! events, and one object that does not match its name refuses the whole file.
//!
//! An integration test because it needs `sapling-store`'s rusqlite adapter,
//! which a unit test under `src/` would link as a second copy of the crate.

use std::cell::Cell;
use std::rc::Rc;

use sapling_db::core::EXPORT_VERSION;
use sapling_db::Core;
use sapling_domain::types::{ReadingText, Segment, TextSource};
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::Value;

const NOW: f64 = 1_710_000_000_000.0;

fn core() -> Core {
    let counter = Rc::new(Cell::new(0u64));
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || NOW,
        move || {
            counter.set(counter.get() + 1);
            format!("local-{}", counter.get())
        },
        Utc,
    )
    .expect("schema applies")
}

fn with_a_text() -> Core {
    let core = core();
    core.add_text(&ReadingText {
        id: "t1".into(),
        title: "买书".into(),
        source: TextSource::Imported,
        topic: None,
        segments: vec![Segment {
            text: "我想买书。".into(),
            start: None,
            end: None,
        }],
        media: None,
        created_at: 1.0,
    })
    .expect("add_text");
    core
}

#[test]
fn a_v4_file_carries_its_bodies_and_reads_at_once() {
    let dump = with_a_text().export_data().expect("export");
    let file: Value = serde_json::from_str(&dump).expect("export parses");
    assert_eq!(file["version"].as_f64(), Some(EXPORT_VERSION));
    assert_eq!(file["objects"].as_object().map(|o| o.len()), Some(1));

    let restored = core();
    restored.import_data(&dump).expect("import");
    assert_eq!(
        restored.get_texts().expect("texts")[0].segments[0].text,
        "我想买书。"
    );
    assert!(restored.missing_objects().expect("missing").is_empty());
}

#[test]
fn a_tampered_object_refuses_the_whole_file() {
    let mut file: Value =
        serde_json::from_str(&with_a_text().export_data().expect("export")).expect("parses");
    let objects = file["objects"].as_object_mut().expect("objects");
    let hash = objects.keys().next().expect("one object").clone();
    objects.insert(hash, Value::String(r#"{"segments":[]}"#.into()));

    let restored = core();
    let error = restored
        .import_data(&file.to_string())
        .expect_err("refused");
    assert!(error.0.contains("does not match its name"), "{}", error.0);
    assert!(restored.get_texts().expect("texts").is_empty());
    assert!(restored.missing_objects().expect("missing").is_empty());
    let events = restored
        .query("SELECT COUNT(*) AS n FROM events", &[])
        .expect("count");
    assert_eq!(events[0].f64("n").expect("n"), 0.0);
}
