//! A log with a row this build cannot read sitting in the middle of it — the
//! version-skew shape: a kind only a newer build writes, and a payload whose
//! schema has since widened.
//!
//! Push, export and materialization against a real SQLite, which this crate
//! reaches through `sapling-store`'s adapter as a dev-dependency — so the test
//! lives here, outside `src/`, where that cycle links one copy of the crate.

use sapling_db::core::EXPORT_VERSION;
use sapling_db::Core;
use sapling_domain::events::RawEvent;
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::{json, Value};

const NOW: f64 = 1_710_000_000_000.0;

fn core() -> Core {
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || NOW,
        || "local-1".to_owned(),
        Utc,
    )
    .expect("schema applies")
}

/// Four unpushed rows, second and third unreadable. An import writes
/// the log without a `seq`, which is what makes them pending.
fn imported() -> Core {
    let core = core();
    let file = json!({
        "version": EXPORT_VERSION,
        "exportedAt": NOW,
        "events": [
            { "id": "e1", "type": "itemAdded", "at": 1.0, "device": "devA",
              "payload": { "id": "i1", "kind": "vocab", "term": "书", "meaning": "book", "introducedAt": 1.0 } },
            { "id": "e2", "type": "wordShelved", "at": 2.0, "device": "devB",
              "payload": { "term": "水", "shelf": "later" } },
            { "id": "e3", "type": "itemAdded", "at": 3.0, "device": "devB",
              "payload": { "id": "i2", "kind": "vocab", "term": "水", "meaning": "water", "notes": null, "introducedAt": 3.0 } },
            { "id": "e4", "type": "itemDeleted", "at": 4.0, "device": "devA",
              "payload": { "itemId": "i1" } },
        ]
    });
    core.import_data(&file.to_string()).expect("import");
    core
}

fn ids(events: &[RawEvent]) -> Vec<&str> {
    events.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn a_page_is_the_first_limit_rows_with_no_gap() {
    let core = imported();
    // The old filter ran after `LIMIT`, so a page over a bad row came
    // back short and `pushPending` stopped on it — the rows behind
    // never left the device.
    assert_eq!(ids(&core.pending_events(2).expect("page")), ["e1", "e2"]);
    assert_eq!(
        ids(&core.pending_events(100).expect("page")),
        ["e1", "e2", "e3", "e4"]
    );
}

#[test]
fn a_pushed_page_leaves_the_rows_behind_it_pending() {
    let core = imported();
    let page = core.pending_events(2).expect("page");
    let seqs: Vec<(String, f64)> = page
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.clone(), i as f64 + 1.0))
        .collect();
    core.mark_pushed(&seqs).expect("mark pushed");
    assert_eq!(ids(&core.pending_events(2).expect("page")), ["e3", "e4"]);
}

#[test]
fn an_unreadable_row_is_pushed_and_exported_verbatim_and_materialises_nothing() {
    let core = imported();
    let exported: Value =
        serde_json::from_str(&core.export_data().expect("export")).expect("export parses");
    let kinds: Vec<&str> = exported["events"]
        .as_array()
        .expect("events is an array")
        .iter()
        .map(|e| e["type"].as_str().expect("a type"))
        .collect();
    assert_eq!(
        kinds,
        ["itemAdded", "wordShelved", "itemAdded", "itemDeleted"]
    );
    assert_eq!(
        exported["events"][1]["payload"],
        json!({ "term": "水", "shelf": "later" })
    );
    assert_eq!(exported["events"][2]["payload"]["notes"], Value::Null);

    // `i1` was added and deleted; `i2`'s add is the row that will not
    // parse, so the read model has neither.
    assert!(core.get_all_items(false).expect("items").is_empty());
}
