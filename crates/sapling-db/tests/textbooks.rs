//! Textbooks in the local store: a book is its chapters as one content object
//! plus a `textbookAdded` that names it, written together; a book whose object
//! has not arrived is shown by no read and is named by `missingObjects`; a
//! deleted book stays deleted whichever order its events arrive in.

use std::cell::Cell;

use serde_json::json;

use sapling_db::Core;
use sapling_domain::objects::TextbookContent;
use sapling_domain::types::{
    Chapter, Section, SectionKind, Textbook, TextbookLine, TextbookSummary, TextbookWord,
};
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

fn chapters() -> Vec<Chapter> {
    vec![Chapter {
        label: Some("3".into()),
        title: Some("你叫什么名字".into()),
        first_page: Some("14".into()),
        last_page: Some("21".into()),
        sections: vec![
            Section {
                kind: SectionKind::Dialogue,
                heading: Some("在学校".into()),
                number: Some("1".into()),
                lines: vec![
                    TextbookLine {
                        speaker: Some("A".into()),
                        text: "你叫什么名字？".into(),
                    },
                    TextbookLine {
                        speaker: Some("B".into()),
                        text: "我叫李月。".into(),
                    },
                ],
                words: vec![],
            },
            Section {
                kind: SectionKind::Words,
                heading: Some("New Words".into()),
                number: None,
                lines: vec![],
                words: vec![
                    TextbookWord {
                        term: "叫".into(),
                        notes: Some("v.".into()),
                        meaning: Some("to be called".into()),
                        proper: false,
                    },
                    TextbookWord {
                        term: "李月".into(),
                        notes: None,
                        meaning: None,
                        proper: true,
                    },
                ],
            },
        ],
    }]
}

fn book(id: &str) -> Textbook {
    Textbook {
        id: id.into(),
        title: "HSK Standard Course 1".into(),
        file_name: Some("hsk1.pdf".into()),
        chapters: chapters(),
        created_at: 5.0,
    }
}

#[test]
fn a_book_is_its_object_and_an_event_that_names_it_and_reads_back_whole() {
    let core = core();
    core.add_textbook(&book("b1")).expect("add");

    let object = TextbookContent {
        chapters: chapters(),
    }
    .to_object();
    let log = core
        .query("SELECT type, payload FROM events", &[])
        .expect("log");
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].text("type").unwrap(), "textbookAdded");
    let payload: serde_json::Value = serde_json::from_str(log[0].text("payload").unwrap()).unwrap();
    assert_eq!(payload["content"], json!(object.hash));
    assert!(
        payload.get("chapters").is_none(),
        "the chapters are not inline"
    );

    assert_eq!(core.get_textbook("b1").unwrap().unwrap(), book("b1"));
    assert_eq!(
        core.get_textbooks().unwrap(),
        [TextbookSummary {
            id: "b1".into(),
            title: "HSK Standard Course 1".into(),
            file_name: Some("hsk1.pdf".into()),
            chapters: 1,
            created_at: 5.0,
        }]
    );
    assert!(core.missing_objects().unwrap().is_empty());
}

#[test]
fn a_book_without_a_title_or_a_chapter_is_refused() {
    let core = core();
    assert!(core
        .add_textbook(&Textbook {
            title: " ".into(),
            ..book("b1")
        })
        .is_err());
    assert!(core
        .add_textbook(&Textbook {
            chapters: vec![],
            ..book("b1")
        })
        .is_err());
    assert!(core.get_textbooks().unwrap().is_empty());
}

#[test]
fn a_pulled_book_waits_for_its_object_and_a_tombstone_wins_either_way() {
    let core = core();
    let object = TextbookContent {
        chapters: chapters(),
    }
    .to_object();
    let added = json!({
        "seq": 1, "id": "remote-1", "type": "textbookAdded", "at": 2, "device": "devB",
        "payload": { "id": "b2", "title": "Remote", "content": object.hash, "createdAt": 2 }
    });
    core.apply_remote(std::slice::from_ref(&added))
        .expect("apply");
    assert!(core.get_textbook("b2").unwrap().is_none());
    assert_eq!(
        core.missing_objects().unwrap(),
        std::slice::from_ref(&object.hash)
    );

    core.put_objects(std::slice::from_ref(&object))
        .expect("put");
    assert_eq!(
        core.get_textbook("b2").unwrap().unwrap().chapters,
        chapters()
    );
    assert!(core.missing_objects().unwrap().is_empty());

    core.delete_textbook("b2").expect("delete");
    assert!(core.get_textbook("b2").unwrap().is_none());
    assert!(core.get_textbooks().unwrap().is_empty());

    // The tombstone first, then the book: still gone.
    let other = self::core();
    other
        .apply_remote(&[json!({
            "seq": 2, "id": "remote-2", "type": "textbookDeleted", "at": 3, "device": "devB",
            "payload": { "textbookId": "b2" }
        })])
        .expect("apply");
    other.apply_remote(&[added]).expect("apply");
    other.put_objects(&[object]).expect("put");
    assert!(other.get_textbooks().unwrap().is_empty());
}

#[test]
fn the_export_carries_the_book_and_its_object() {
    let core = core();
    core.add_textbook(&book("b1")).expect("add");
    let export: serde_json::Value = serde_json::from_str(&core.export_data().unwrap()).unwrap();
    let hash = TextbookContent {
        chapters: chapters(),
    }
    .to_object()
    .hash;
    assert!(export["objects"].get(&hash).is_some());

    let restored = self::core();
    restored
        .import_data(&core.export_data().unwrap())
        .expect("import");
    assert_eq!(restored.get_textbook("b1").unwrap().unwrap(), book("b1"));
}
