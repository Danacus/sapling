//! `record_study` and `study_sessions`: study time per mode and local hour,
//! folded from the base tables — spans, conversation turns and answers.

use std::cell::Cell;

use sapling_db::Core;
use sapling_domain::types::{StudyMode, StudySession};
use sapling_domain::{LocalDay, Utc};
use sapling_store::rusqlite_sql::RusqliteSql;
use serde_json::{json, Value};

/// 2024-03-10T10:00:00Z, the start of a UTC hour.
const H10: f64 = 1_710_064_800_000.0;
const MIN: f64 = 60_000.0;
const HOUR: f64 = 3_600_000.0;

fn open(day: impl LocalDay + 'static) -> Core {
    let next = Cell::new(0);
    Core::open(
        Box::new(RusqliteSql::in_memory().expect("in-memory sqlite")),
        "dev-test",
        || H10 + 10.0 * HOUR,
        move || {
            next.set(next.get() + 1);
            format!("local-{}", next.get())
        },
        day,
    )
    .expect("schema applies")
}

/// India's calendar: every local hour starts at :30 UTC.
struct HalfHour;

impl LocalDay for HalfHour {
    fn local_day(&self, at: f64) -> String {
        Utc.local_day(at + 5.5 * HOUR)
    }
    fn local_hour(&self, at: f64) -> f64 {
        Utc.local_hour(at + 5.5 * HOUR) - 5.5 * HOUR
    }
}

thread_local! {
    static SEQ: Cell<u32> = const { Cell::new(0) };
}

/// A row as a pull delivers it, `seq` and all.
fn event(id: &str, kind: &str, at: f64, payload: Value) -> Value {
    let seq = SEQ.with(|seq| {
        seq.set(seq.get() + 1);
        seq.get()
    });
    json!({ "seq": seq, "id": id, "type": kind, "at": at, "device": "devA", "payload": payload })
}

fn studied(id: &str, at: f64, ms: f64) -> Value {
    event(id, "studied", at, json!({ "textId": "t1", "ms": ms }))
}

fn answer(id: &str, at: f64) -> Value {
    event(
        id,
        "resultLogged",
        at,
        json!({ "challengeId": "c1", "verdict": "correct", "answerGiven": "a", "at": at }),
    )
}

fn turn(index: f64, at: f64) -> Value {
    event(
        &format!("turn-{index}"),
        "turnAdded",
        at,
        json!({
            "conversationId": "conv1", "index": index,
            "teacher": { "role": "teacher", "reply": { "text": "好", "reading": "hǎo" }, "translation": "ok", "actions": [] }
        }),
    )
}

fn session(mode: StudyMode, hour: f64, at: f64, minutes: f64, answers: f64) -> StudySession {
    StudySession {
        id: format!("{}-{}", mode.as_str(), hour as i64),
        at,
        mode,
        minutes,
        answers,
    }
}

#[test]
fn a_span_is_split_across_the_hours_it_crosses() {
    let core = open(Utc);
    // 10:50 for 20 minutes: ten in the 10:00 hour, ten in the 11:00 hour.
    core.apply_remote(&[studied("s1", H10 + 50.0 * MIN, 20.0 * MIN)])
        .expect("apply");
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![
            session(StudyMode::Input, H10, H10 + 50.0 * MIN, 10.0, 0.0),
            session(StudyMode::Input, H10 + HOUR, H10 + HOUR, 10.0, 0.0),
        ]
    );
}

#[test]
fn spans_in_one_hour_add_up_and_round_to_a_tenth() {
    let core = open(Utc);
    core.apply_remote(&[
        studied("s2", H10 + 30.0 * MIN, 100_000.0),
        studied("s1", H10 + 5.0 * MIN, 50_000.0),
    ])
    .expect("apply");
    // 150 s is 2.5 minutes; the hour's `at` is the earliest span.
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![session(StudyMode::Input, H10, H10 + 5.0 * MIN, 2.5, 0.0)]
    );
}

#[test]
fn answers_are_counted_per_hour_with_no_minutes() {
    let core = open(Utc);
    core.apply_remote(&[
        answer("r1", H10 + 3.0 * MIN),
        answer("r2", H10 + 59.0 * MIN),
        answer("r3", H10 + HOUR),
    ])
    .expect("apply");
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![
            session(StudyMode::Practice, H10, H10 + 3.0 * MIN, 0.0, 2.0),
            session(StudyMode::Practice, H10 + HOUR, H10 + HOUR, 0.0, 1.0),
        ]
    );
}

#[test]
fn turns_form_runs_split_at_gaps_over_five_minutes() {
    let core = open(Utc);
    core.apply_remote(&[
        // One run, 10:52 → 10:58 plus the minute after the last turn: 7 minutes.
        turn(0.0, H10 + 52.0 * MIN),
        turn(1.0, H10 + 55.0 * MIN),
        turn(2.0, H10 + 58.0 * MIN),
        // Six minutes later: a run of its own, 11:04 → 11:05.
        turn(3.0, H10 + 64.0 * MIN),
    ])
    .expect("apply");
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![
            session(StudyMode::Output, H10, H10 + 52.0 * MIN, 7.0, 0.0),
            session(StudyMode::Output, H10 + HOUR, H10 + 64.0 * MIN, 1.0, 0.0),
        ]
    );
}

#[test]
fn a_run_crossing_the_hour_is_split_there() {
    let core = open(Utc);
    core.apply_remote(&[turn(0.0, H10 + 57.0 * MIN), turn(1.0, H10 + 61.0 * MIN)])
        .expect("apply");
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![
            session(StudyMode::Output, H10, H10 + 57.0 * MIN, 3.0, 0.0),
            session(StudyMode::Output, H10 + HOUR, H10 + HOUR, 2.0, 0.0),
        ]
    );
}

#[test]
fn since_keeps_hours_starting_at_or_after_it_and_modes_order_by_at() {
    let core = open(Utc);
    core.apply_remote(&[
        studied("s1", H10 + 10.0 * MIN, 5.0 * MIN),
        answer("r1", H10 + 2.0 * MIN),
        studied("s2", H10 + HOUR + 20.0 * MIN, 5.0 * MIN),
        answer("r2", H10 + HOUR + 5.0 * MIN),
    ])
    .expect("apply");
    let all = core.study_sessions(0.0).expect("read");
    let ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
    let h10 = H10 as i64;
    let h11 = (H10 + HOUR) as i64;
    assert_eq!(
        ids,
        vec![
            format!("practice-{h10}"),
            format!("input-{h10}"),
            format!("practice-{h11}"),
            format!("input-{h11}"),
        ]
    );
    let later = core.study_sessions(H10 + 1.0).expect("read");
    assert_eq!(later.len(), 2);
    assert!(later.iter().all(|s| s.id.ends_with(&h11.to_string())));
    assert_eq!(core.study_sessions(H10 + HOUR).expect("read"), later);
}

#[test]
fn an_hour_that_rounds_to_nothing_and_an_empty_span_are_left_out() {
    let core = open(Utc);
    core.apply_remote(&[
        // 2 s of this span fall in the 10:00 hour: 0.0 minutes there.
        studied("s1", H10 + HOUR - 2_000.0, 5.0 * MIN),
        studied("s2", H10 + 3.0 * HOUR, 0.0),
    ])
    .expect("apply");
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![session(StudyMode::Input, H10 + HOUR, H10 + HOUR, 5.0, 0.0)]
    );
}

#[test]
fn hours_are_local_hours() {
    let core = open(HalfHour);
    // 10:50–11:10 UTC is 16:20–16:40 in India: one local hour, from 10:30 UTC.
    core.apply_remote(&[studied("s1", H10 + 50.0 * MIN, 20.0 * MIN)])
        .expect("apply");
    let local = H10 + 30.0 * MIN;
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![session(
            StudyMode::Input,
            local,
            H10 + 50.0 * MIN,
            20.0,
            0.0
        )]
    );
}

#[test]
fn record_study_logs_the_span_at_its_start() {
    let core = open(Utc);
    core.record_study("t1", H10 + 5.0 * MIN, 3.0 * MIN)
        .expect("record");
    let events = core.pending_events(10).expect("pending");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "studied");
    assert_eq!(events[0].at, H10 + 5.0 * MIN);
    assert_eq!(events[0].payload, json!({ "textId": "t1", "ms": 180000.0 }));
    assert_eq!(
        core.study_sessions(0.0).expect("read"),
        vec![session(StudyMode::Input, H10, H10 + 5.0 * MIN, 3.0, 0.0)]
    );
}

#[test]
fn a_span_outlives_its_text() {
    let core = open(Utc);
    core.apply_remote(&[
        studied("s1", H10, 4.0 * MIN),
        event("d1", "textDeleted", H10 + HOUR, json!({ "textId": "t1" })),
    ])
    .expect("apply");
    assert_eq!(core.study_sessions(0.0).expect("read").len(), 1);
}
