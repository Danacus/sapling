//! `clips_for`: which subtitle cues of imported videos a word is best heard in.

use std::cell::Cell;

use sapling_db::clips::TIER_CAP;
use sapling_db::{Clip, Core};
use sapling_domain::types::{KnowledgeItem, ReadingText};
use sapling_domain::Utc;
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::{json, Value};

fn core() -> Core {
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || 1_710_000_000_000.0,
        {
            // Every write is an event, and an event id seen twice is dropped.
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

fn know(core: &Core, id: &str, term: &str) {
    let item: KnowledgeItem = serde_json::from_value(json!({
        "id": id, "kind": "vocab", "term": term, "meaning": "-", "introducedAt": 1.0,
    }))
    .expect("an item");
    core.upsert_items(&[item]).expect("upsert");
}

fn youtube(id: &str) -> Value {
    json!({ "kind": "youtube", "videoId": id })
}

fn clips(core: &Core, terms: &[&str], sentence: Option<&str>) -> Vec<Clip> {
    let terms: Vec<String> = terms.iter().map(|t| (*t).to_owned()).collect();
    core.clips_for(&terms, sentence).expect("clips_for")
}

fn texts(found: &[Clip]) -> Vec<&str> {
    found.iter().map(|c| c.text.as_str()).collect()
}

#[test]
fn a_timed_cue_of_a_youtube_text_matches() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "我们明天早上去吃早餐吧。", "start": 1000, "end": 3500 },
        ]),
    );
    assert_eq!(
        clips(&core, &["早餐"], None),
        vec![Clip {
            text_id: "t1".into(),
            title: "Title t1".into(),
            video_id: "vid1".into(),
            start: 1000.0,
            end: 3500.0,
            text: "我们明天早上去吃早餐吧。".into(),
        }]
    );
    assert!(clips(&core, &["晚饭"], None).is_empty());
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
    assert!(clips(&core, &["car"], None).is_empty());
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
    assert_eq!(
        texts(&clips(&core, &["car"], None)),
        vec!["Car, the long way round, again"]
    );
    assert!(clips(&core, &["ar"], None).is_empty());
    assert!(clips(&core, &["  ", ""], None).is_empty());
    assert_eq!(
        texts(&clips(&core, &["bike", "the cart"], None)),
        vec!["Push the cart"],
        "any of several terms, a phrase included"
    );
}

#[test]
fn the_served_sentence_wins_over_a_better_sized_cue() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "We drove the car to the coast today", "start": 0, "end": 3000 },
            { "text": "The car is red!", "start": 3000, "end": 3400 },
            { "text": "She parked the car behind the house", "start": 4000, "end": 7000 },
        ]),
    );
    let found = clips(&core, &["car"], Some("the car is RED"));
    assert_eq!(
        texts(&found),
        vec!["The car is red!"],
        "the exact sentence, punctuation and case aside, is a tier of its own"
    );
}

#[test]
fn more_asked_words_win() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "I bought a new car yesterday", "start": 0, "end": 2500 },
            { "text": "The red car is in the garage now", "start": 3000, "end": 6000 },
            { "text": "My car needs a wash soon", "start": 7000, "end": 9000 },
        ]),
    );
    assert_eq!(
        texts(&clips(&core, &["car", "garage"], None)),
        vec!["The red car is in the garage now"]
    );
}

#[test]
fn a_fragment_loses_to_a_fitting_cue() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([
            { "text": "Car.", "start": 0, "end": 400 },
            { "text": "That car was parked outside all night", "start": 1000, "end": 4000 },
            {
                "text": "and then the car that we had been talking about for most of the afternoon finally drove away down the road",
                "start": 5000, "end": 19000
            },
        ]),
    );
    assert_eq!(
        texts(&clips(&core, &["car"], None)),
        vec!["That car was parked outside all night"],
        "neither the one-word fragment nor the run-on"
    );
}

#[test]
fn a_known_longer_word_covers_a_han_term() {
    let core = core();
    add(
        &core,
        "t1",
        youtube("vid1"),
        json!([{ "text": "我明天要去银行办点事", "start": 0, "end": 2500 }]),
    );
    assert_eq!(
        clips(&core, &["行"], None).len(),
        1,
        "with 银行 unknown, 行 is heard there"
    );
    know(&core, "i1", "银行");
    assert!(
        clips(&core, &["行"], None).is_empty(),
        "with 银行 a known word, 行 inside it is not 行"
    );
    add(
        &core,
        "t2",
        youtube("vid2"),
        json!([{ "text": "这样做不行，我们再想想吧", "start": 0, "end": 2500 }]),
    );
    assert_eq!(
        texts(&clips(&core, &["行"], None)),
        vec!["这样做不行，我们再想想吧"]
    );
}

#[test]
fn the_tier_holds_near_equal_cues_capped_and_in_a_fixed_order() {
    let core = core();
    let segments: Vec<Value> = (0..8)
        .map(|i| {
            let at = f64::from(i) * 5000.0;
            json!({ "text": format!("the car stopped near house number {i}"), "start": at, "end": at + 3000.0 })
        })
        .chain([json!({ "text": "car", "start": 50000, "end": 50500 })])
        .collect();
    add(&core, "t1", youtube("vid1"), Value::Array(segments));
    let found = clips(&core, &["car"], None);
    assert_eq!(found.len(), TIER_CAP);
    assert!(found.iter().all(|c| c.text != "car"), "the fragment is out");
    assert_eq!(
        texts(&found),
        (0..TIER_CAP)
            .map(|i| format!("the car stopped near house number {i}"))
            .collect::<Vec<_>>(),
        "ties keep cue order"
    );
    assert_eq!(found, clips(&core, &["car"], None), "deterministic");
}
