//! The request is pinned against Taal's `sendToTaal()` as JSON, not as a
//! re-statement of the builder: these bodies are what that function sends for
//! the same sessions, so a drift from the shape Taal's rules accept fails here.

use std::cell::{Cell, RefCell};
use std::future::{ready, Future};

use serde_json::{json, Value};

use super::*;

const LINK: &str = "Kx3aaaaaaaaaaaaaaaaa";
const SECRET: &str = "Q8mbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DAY: f64 = 24.0 * 3_600_000.0;
const NOW: f64 = 1_800_000_000_000.0;

fn code() -> String {
    format!("{LINK}.{SECRET}")
}

fn session(mode: StudyMode, hour: f64, minutes: f64, answers: f64) -> StudySession {
    StudySession {
        id: format!("{}-{hour}", mode.as_str()),
        at: hour + 60_000.0,
        mode,
        minutes,
        answers,
    }
}

/// Answers every request with the next status in line (the last repeats), or
/// no response at all for `0`; keeps what it was sent.
struct Fake {
    statuses: Vec<u16>,
    sent: RefCell<Vec<Request>>,
}

impl Fake {
    fn new(statuses: &[u16]) -> Self {
        Fake {
            statuses: statuses.to_vec(),
            sent: RefCell::new(Vec::new()),
        }
    }

    fn bodies(&self) -> Vec<Value> {
        self.sent
            .borrow()
            .iter()
            .map(|request| serde_json::from_str(&request.body).unwrap())
            .collect()
    }
}

impl Transport for Fake {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>> {
        let n = self.sent.borrow().len();
        self.sent.borrow_mut().push(request);
        let status = self.statuses[n.min(self.statuses.len() - 1)];
        ready(if status == 0 {
            Err("offline".to_owned())
        } else {
            Ok(Response {
                status,
                body: "{}".to_owned(),
            })
        })
    }
}

/// The core's read over a fixed list; remembers the `since` it was asked for.
struct Store {
    sessions: Vec<StudySession>,
    asked: Cell<Option<f64>>,
    broken: bool,
}

impl Store {
    fn of(sessions: Vec<StudySession>) -> Self {
        Store {
            sessions,
            asked: Cell::new(None),
            broken: false,
        }
    }
}

impl TaalStore for Store {
    fn study_sessions(
        &self,
        since: f64,
    ) -> impl Future<Output = Result<Vec<StudySession>, String>> {
        self.asked.set(Some(since));
        ready(if self.broken {
            Err("database closed".to_owned())
        } else {
            Ok(self
                .sessions
                .iter()
                .filter(|session| session.at >= since)
                .cloned()
                .collect())
        })
    }
}

fn args(pushed_through: Option<f64>) -> TaalPushArgs {
    TaalPushArgs {
        code: code(),
        profile: "p1".to_owned(),
        now: NOW,
        pushed_through,
    }
}

fn run(transport: &Fake, store: &Store, args: &TaalPushArgs) -> TaalOutcome {
    pollster::block_on(push(transport, store, args))
}

#[test]
fn a_code_is_twenty_and_thirty_two_alphanumerics() {
    assert_eq!(
        parse_code(&format!("  {}\n", code())),
        Some(Code {
            link_id: LINK.to_owned(),
            secret: SECRET.to_owned()
        })
    );
    for bad in [
        "",
        LINK,
        &format!("{LINK}.{SECRET}x"),
        &format!("{LINK}x.{SECRET}"),
        &format!("{LINK}-{SECRET}"),
        &format!("{}é.{SECRET}", &LINK[..19]),
        &format!("{LINK}.{}_", &SECRET[..31]),
        &format!("{LINK}.{SECRET}.x"),
    ] {
        assert!(!is_code(bad), "{bad:?}");
    }
}

#[test]
fn the_request_is_send_to_taals_request() {
    let sessions = vec![
        TaalSession {
            id: "p1-input-1700000000000".to_owned(),
            at: 1_700_000_060_000.0,
            input: 12.5,
            output: 0.0,
            cards: 0.0,
        },
        TaalSession {
            id: "we`ird\\id".to_owned(),
            at: 1_700_000_000_000.0,
            input: 0.0,
            output: 3.0,
            cards: 7.0,
        },
    ];
    let request = commit_request(&parse_code(&code()).unwrap(), &sessions);
    assert_eq!(
        request.url,
        "https://firestore.googleapis.com/v1/projects/language-81ef3/databases/(default)/documents:commit?key=AIzaSyDKFxjk7_QxTJX0vg57PfXqLP7gAK-2Clo"
    );
    assert_eq!(
        request.headers,
        vec![("Content-Type".to_owned(), "application/json".to_owned())]
    );
    let docs = "projects/language-81ef3/databases/(default)/documents";
    let stamp = json!({ "fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME" });
    let expected = json!({
        "writes": [
            {
                "update": {
                    "name": format!("{docs}/appInbox/{LINK}"),
                    "fields": { "code": { "stringValue": SECRET } },
                },
                "updateTransforms": [stamp],
            },
            {
                "update": {
                    "name": format!("{docs}/appSources/{LINK}"),
                    "fields": { "sessions": { "mapValue": { "fields": {
                        "p1-input-1700000000000": { "mapValue": { "fields": {
                            "at": { "integerValue": "1700000060000" },
                            "input": { "doubleValue": 12.5 },
                        } } },
                        "we`ird\\id": { "mapValue": { "fields": {
                            "at": { "integerValue": "1700000000000" },
                            "output": { "integerValue": "3" },
                            "cards": { "integerValue": "7" },
                        } } },
                    } } } },
                },
                "updateMask": { "fieldPaths": [
                    "sessions.`p1-input-1700000000000`",
                    "sessions.`we\\`ird\\\\id`",
                ] },
                "updateTransforms": [stamp],
            },
        ],
    });
    let body: Value = serde_json::from_str(&request.body).unwrap();
    assert_eq!(body, expected);
    // `JSON.stringify` keeps insertion order; so does this body.
    assert_eq!(request.body, expected.to_string());
    assert!(docs.contains(PROJECT));
}

#[test]
fn modes_map_to_taals_and_ids_carry_the_profile() {
    let hour = 1_700_000_000_000.0;
    let input = to_taal("p1", &session(StudyMode::Input, hour, 4.2, 0.0));
    assert_eq!(
        input,
        TaalSession {
            id: format!("p1-input-{hour}"),
            at: hour + 60_000.0,
            input: 4.2,
            output: 0.0,
            cards: 0.0
        }
    );
    let output = to_taal("p1", &session(StudyMode::Output, hour, 6.0, 0.0));
    assert_eq!((output.input, output.output, output.cards), (0.0, 6.0, 0.0));
    let practice = to_taal("p2", &session(StudyMode::Practice, hour, 0.0, 9.0));
    assert_eq!(practice.id, format!("p2-practice-{hour}"));
    assert_eq!(
        (practice.input, practice.output, practice.cards),
        (0.0, 0.0, 9.0 * CARDS_PER_ANSWER)
    );
    // `at` goes as whole milliseconds, an integer at Taal.
    let mut odd = session(StudyMode::Input, hour, 1.0, 0.0);
    odd.at = hour + 0.4;
    assert_eq!(to_taal("p1", &odd).at, hour);
}

#[test]
fn since_reaches_back_120_days_or_48_hours_behind_the_watermark() {
    assert_eq!(since(NOW, None), NOW - 120.0 * DAY);
    assert_eq!(since(NOW, Some(NOW - DAY)), NOW - 3.0 * DAY);
    // A watermark older than Taal keeps anything is no reason to read further.
    assert_eq!(since(NOW, Some(NOW - 200.0 * DAY)), NOW - 120.0 * DAY);
}

#[test]
fn a_push_sends_in_batches_of_100_and_returns_the_watermark() {
    let base = NOW - 50.0 * DAY;
    let sessions: Vec<StudySession> = (0..250)
        .map(|n| session(StudyMode::Input, base + n as f64 * 3_600_000.0, 5.0, 0.0))
        .collect();
    let store = Store::of(sessions);
    let fake = Fake::new(&[200]);
    let outcome = run(&fake, &store, &args(None));
    assert_eq!(
        outcome,
        TaalOutcome {
            status: TaalStatus::Ok,
            sent: 250,
            pushed_through: Some(NOW),
            message: "Sent 250 sessions.".to_owned()
        }
    );
    assert_eq!(store.asked.get(), Some(NOW - 120.0 * DAY));
    let sizes: Vec<usize> = fake
        .bodies()
        .iter()
        .map(|body| {
            body["writes"][1]["updateMask"]["fieldPaths"]
                .as_array()
                .unwrap()
                .len()
        })
        .collect();
    assert_eq!(sizes, vec![100, 100, 50]);
    // Oldest first, so a push cut short still backfilled from the start.
    let first = &fake.bodies()[0]["writes"][1]["updateMask"]["fieldPaths"][0];
    assert_eq!(first, &json!(format!("sessions.`p1-input-{base}`")));
}

#[test]
fn a_push_after_one_reads_from_the_resend_margin() {
    let store = Store::of(vec![session(StudyMode::Practice, NOW - DAY, 0.0, 3.0)]);
    let fake = Fake::new(&[200]);
    let outcome = run(&fake, &store, &args(Some(NOW - 10.0 * 3_600_000.0)));
    assert_eq!(outcome.sent, 1);
    assert_eq!(store.asked.get(), Some(NOW - 58.0 * 3_600_000.0));
}

#[test]
fn nothing_to_send_asks_no_one_and_still_advances() {
    let fake = Fake::new(&[500]);
    let outcome = run(&fake, &Store::of(Vec::new()), &args(Some(NOW - DAY)));
    assert_eq!(outcome.status, TaalStatus::Ok);
    assert_eq!(outcome.pushed_through, Some(NOW));
    assert!(fake.sent.borrow().is_empty());
}

#[test]
fn a_refusal_stops_the_push_without_a_watermark() {
    let sessions: Vec<StudySession> = (0..150)
        .map(|n| session(StudyMode::Input, NOW - DAY + n as f64, 5.0, 0.0))
        .collect();
    let fake = Fake::new(&[200, 403]);
    let outcome = run(&fake, &Store::of(sessions), &args(None));
    assert_eq!(
        outcome,
        TaalOutcome {
            status: TaalStatus::Refused,
            sent: 100,
            pushed_through: None,
            message: REFUSED.to_owned()
        }
    );
    assert_eq!(fake.sent.borrow().len(), 2);
}

#[test]
fn other_failures_are_failed_and_keep_the_watermark_where_it_was() {
    let one = || Store::of(vec![session(StudyMode::Input, NOW - DAY, 5.0, 0.0)]);
    for (status, message) in [
        (0, "Could not reach Taal."),
        (500, "Taal could not save the study time (500)."),
        (401, "Taal could not save the study time (401)."),
    ] {
        let outcome = run(&Fake::new(&[status]), &one(), &args(None));
        assert_eq!(outcome.status, TaalStatus::Failed, "{status}");
        assert_eq!(outcome.pushed_through, None);
        assert_eq!(outcome.message, message);
    }

    let mut broken = one();
    broken.broken = true;
    let fake = Fake::new(&[200]);
    let outcome = run(&fake, &broken, &args(None));
    assert_eq!(outcome.status, TaalStatus::Failed);
    assert_eq!(outcome.message, "database closed");
    assert!(fake.sent.borrow().is_empty());
}

#[test]
fn a_junk_code_asks_no_one() {
    let fake = Fake::new(&[200]);
    let store = Store::of(vec![session(StudyMode::Input, NOW - DAY, 5.0, 0.0)]);
    let mut junk = args(None);
    junk.code = "nope".to_owned();
    let outcome = run(&fake, &store, &junk);
    assert_eq!(outcome.status, TaalStatus::Invalid);
    assert_eq!(outcome.message, BAD_CODE);
    assert!(fake.sent.borrow().is_empty());
    assert_eq!(store.asked.get(), None);
}

#[test]
fn the_outcome_serialises_as_the_host_reads_it() {
    let outcome = TaalOutcome {
        status: TaalStatus::Ok,
        sent: 2,
        pushed_through: Some(NOW),
        message: "Sent 2 sessions.".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(&outcome).unwrap(),
        json!({ "status": "ok", "sent": 2, "pushedThrough": NOW, "message": "Sent 2 sessions." })
    );
    let refused = TaalOutcome::stopped(TaalStatus::Refused, 0, REFUSED);
    assert_eq!(
        serde_json::to_value(&refused).unwrap(),
        json!({ "status": "refused", "sent": 0, "message": REFUSED })
    );
    let parsed: TaalPushArgs =
        serde_json::from_value(json!({ "code": "c", "profile": "p", "now": 1 })).unwrap();
    assert_eq!(parsed.pushed_through, None);
}
