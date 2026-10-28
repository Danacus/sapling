//! `clip_for`: which subtitle cue of an imported video a word is heard in.

use sapling_db::{Clip, Core};
use sapling_domain::types::ReadingText;
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::{json, Value};

fn core() -> Core {
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || 1_710_000_000_000.0,
        || "local-1".to_owned(),
        Utc,
    )
    .expect("schema applies")
}

fn add(core: &Core, id: &str, media: Value, segments: Value) {
    let text: ReadingText = serde_json::from_value(json!({
        "id": id,
        "title": format!("Title {id}"),
        "source": "imported",
        "segments": segments,
        "media": media,
        "createdAt": 1.0,
    }))
    .expect("a text");
    core.add_text(&text).expect("add");
}

fn youtube(id: &str) -> Value {
    json!({ "kind": "youtube", "videoId": id })
}

fn clip(core: &Core, terms: &[&str]) -> Option<Clip> {
    let terms: Vec<String> = terms.iter().map(|t| (*t).to_owned()).collect();
    core.clip_for(&terms).expect("clip_for")
}

#[test]
fn a_timed_cue_of_a_youtube_text_matches() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "我们去吃早餐吧。", "start": 1000, "end": 2500 },
            { "text": "早餐", "start": 3000, "end": 3600 },
        ]),
    );
    assert_eq!(
        clip(&core, &["早餐"]),
        Some(Clip {
            text_id: "t1".into(),
            title: "Title t1".into(),
            video_id: "vid1".into(),
            start: 3000.0,
            end: 3600.0,
            text: "早餐".into(),
        }),
        "the shortest cue, a plain substring for Han"
    );
    assert_eq!(clip(&core, &["我们"]).map(|c| c.start), Some(1000.0));
    assert_eq!(clip(&core, &["晚饭"]), None);
}

#[test]
fn file_media_untimed_and_deleted_texts_never_match() {
    let core = core();
    add(
        &core,
        "file",
        json!({ "kind": "file", "name": "ep1.mp4" }),
        json!([{ "text": "the car", "start": 0, "end": 900 }]),
    );
    add(
        &core,
        "untimed",
        youtube("vid2"),
        json!([{ "text": "a car" }]),
    );
    add(
        &core,
        "gone",
        youtube("vid3"),
        json!([{ "text": "car", "start": 0, "end": 500 }]),
    );
    core.delete_text("gone").expect("delete");
    assert_eq!(clip(&core, &["car"]), None);
}

#[test]
fn words_match_whole_and_case_blind_in_spaced_scripts() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "Push the cart", "start": 0, "end": 1000 },
            { "text": "Scar tissue heals slowly here", "start": 1000, "end": 2000 },
            { "text": "Car, the long way round, again", "start": 2000, "end": 3000 },
        ]),
    );
    let found = clip(&core, &["car"]).expect("a whole-word cue");
    assert_eq!(found.text, "Car, the long way round, again");
    assert_eq!(clip(&core, &["ar"]), None);
    assert_eq!(clip(&core, &["  ", ""]), None);
    assert_eq!(
        clip(&core, &["bike", "the cart"]).map(|c| c.start),
        Some(0.0),
        "any of several terms, a phrase included"
    );
}
