//! What the cycle promises is not "it moves events" but what survives an
//! interruption: a local event keeps its missing `seq` until the relay has
//! answered for it, the cursor moves only behind an applied page, and every
//! failure is a returned value. The store here is a fake that keeps a log; the
//! merge rules behind a real one are `sapling-store`'s `tests/sync.rs`.

use std::cell::{Cell, RefCell};
use std::future::{ready, Future};

use serde_json::{json, Value};

use sapling_domain::events::{parse_envelope, RawEvent};

use super::*;
use crate::relay::MemoryRelay;

const PHRASE: &str = "ABCDEFGHJKMNPQRSTVWX";
const SERVER: &str = "https://sync.example";

#[derive(Default)]
struct MemoryStore {
    log: RefCell<Vec<(RawEvent, Option<f64>)>>,
    cursor: Cell<f64>,
    cursor_writes: Cell<usize>,
    /// A store call that fails, by name.
    broken: Option<&'static str>,
}

impl MemoryStore {
    fn with_local(count: usize) -> Self {
        let store = MemoryStore::default();
        for n in 1..=count {
            store
                .log
                .borrow_mut()
                .push((event(&format!("e{n}"), "itemAdded"), None));
        }
        store
    }

    fn seqs(&self) -> Vec<Option<f64>> {
        self.log.borrow().iter().map(|(_, seq)| *seq).collect()
    }

    fn check(&self, method: &str) -> StoreResult<()> {
        match self.broken {
            Some(broken) if broken == method => Err(StoreError(format!("{method} broke"))),
            _ => Ok(()),
        }
    }
}

fn event(id: &str, kind: &str) -> RawEvent {
    RawEvent {
        id: id.to_owned(),
        kind: kind.to_owned(),
        at: 1.0,
        device: "devA".to_owned(),
        payload: json!({}),
    }
}

impl SyncStore for MemoryStore {
    fn pending_events(&self, limit: usize) -> impl Future<Output = StoreResult<Vec<RawEvent>>> {
        let page = self.check("pending_events").map(|()| {
            self.log
                .borrow()
                .iter()
                .filter(|(_, seq)| seq.is_none())
                .take(limit)
                .map(|(event, _)| event.clone())
                .collect()
        });
        ready(page)
    }

    fn mark_pushed(&self, seqs: Vec<(String, f64)>) -> impl Future<Output = StoreResult<usize>> {
        let mut log = self.log.borrow_mut();
        for (id, seq) in &seqs {
            if let Some(row) = log.iter_mut().find(|(event, _)| &event.id == id) {
                row.1 = Some(*seq);
            }
        }
        ready(self.check("mark_pushed").map(|()| seqs.len()))
    }

    fn apply_remote(&self, events: Vec<Value>) -> impl Future<Output = StoreResult<usize>> {
        let mut applied = 0;
        let mut log = self.log.borrow_mut();
        for raw in &events {
            let (Some(seq), Some(event)) = (seq_of(raw), parse_envelope(raw)) else {
                continue;
            };
            match log.iter_mut().find(|(held, _)| held.id == event.id) {
                Some(row) => row.1 = Some(seq),
                None => log.push((event, Some(seq))),
            }
            applied += 1;
        }
        ready(self.check("apply_remote").map(|()| applied))
    }

    fn pull_cursor(&self) -> impl Future<Output = StoreResult<f64>> {
        ready(self.check("pull_cursor").map(|()| self.cursor.get()))
    }

    fn set_pull_cursor(&self, cursor: f64) -> impl Future<Output = StoreResult<()>> {
        self.cursor.set(cursor);
        self.cursor_writes.set(self.cursor_writes.get() + 1);
        ready(Ok(()))
    }

    fn has_profile(&self) -> impl Future<Output = StoreResult<bool>> {
        let log = self.log.borrow();
        ready(Ok(log
            .iter()
            .any(|(event, _)| event.kind == "profileUpdated")))
    }
}

#[derive(Debug, Clone)]
struct Call {
    method: Method,
    url: String,
    authorization: Option<String>,
    body: Option<Value>,
}

impl Call {
    fn after(&self) -> Option<String> {
        let (_, query) = self.url.split_once("after=")?;
        Some(query.split('&').next()?.to_owned())
    }
}

/// A transport answering from a script; `Err` is "offline".
struct Scripted<F> {
    respond: F,
    calls: RefCell<Vec<Call>>,
}

fn scripted<F: Fn(&Call) -> Result<(u16, Value), String>>(respond: F) -> Scripted<F> {
    Scripted {
        respond,
        calls: RefCell::default(),
    }
}

impl<F: Fn(&Call) -> Result<(u16, Value), String>> Scripted<F> {
    fn calls(&self, method: Method) -> Vec<Call> {
        let calls = self.calls.borrow();
        calls
            .iter()
            .filter(|call| call.method == method)
            .cloned()
            .collect()
    }
}

impl<F: Fn(&Call) -> Result<(u16, Value), String>> Transport for Scripted<F> {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>> {
        let call = Call {
            method: request.method,
            url: request.url,
            authorization: request
                .headers
                .iter()
                .find(|(name, _)| name == "Authorization")
                .map(|(_, value)| value.clone()),
            body: request
                .body
                .map(|body| serde_json::from_str(&body).expect("json body")),
        };
        self.calls.borrow_mut().push(call.clone());
        ready((self.respond)(&call).map(|(status, body)| Response {
            status,
            body: body.to_string(),
        }))
    }
}

/// A relay that records what it was asked, over the real in-memory one.
struct Recording<'a> {
    relay: &'a MemoryRelay,
    calls: RefCell<Vec<(Method, String)>>,
}

impl<'a> Recording<'a> {
    fn new(relay: &'a MemoryRelay) -> Self {
        Recording {
            relay,
            calls: RefCell::default(),
        }
    }

    fn afters(&self) -> Vec<String> {
        self.calls
            .borrow()
            .iter()
            .filter(|(method, _)| *method == Method::Get)
            .filter_map(|(_, url)| Some(url.split_once("after=")?.1.split('&').next()?.to_owned()))
            .collect()
    }
}

impl Transport for Recording<'_> {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>> {
        self.calls
            .borrow_mut()
            .push((request.method, request.url.clone()));
        self.relay.send(request)
    }
}

fn remote(seq: usize) -> Value {
    json!({
        "seq": seq, "id": format!("remote-{seq}"), "type": "itemAdded",
        "at": seq, "device": "devB", "payload": { "id": format!("i{seq}") }
    })
}

/// Puts rows in the relay's room the way another device would.
fn seed(relay: &MemoryRelay, events: Vec<Value>) {
    let body = json!({ "events": events }).to_string();
    let request = Request {
        method: Method::Post,
        url: format!("{SERVER}/push"),
        headers: vec![("Authorization".to_owned(), format!("Bearer {PHRASE}"))],
        body: Some(body),
    };
    let response = pollster::block_on(relay.send(request)).expect("seed");
    assert_eq!(response.status, 200);
}

fn sync<T: Transport>(transport: &T, store: &MemoryStore) -> SyncOutcome {
    pollster::block_on(run(transport, store, SERVER, PHRASE))
}

/* ---- push ---------------------------------------------------------------- */

#[test]
fn a_push_sends_pending_events_with_the_bearer_phrase_and_stamps_the_answer() {
    let store = MemoryStore::with_local(2);
    let seen = scripted(|call| {
        Ok(match call.method {
            Method::Post => (200, json!({ "seqs": { "e1": 1, "e2": 2 } })),
            Method::Get => (200, json!({ "events": [], "latest": 2 })),
        })
    });

    let outcome = pollster::block_on(run(&seen, &store, SERVER, "abcde-fghjk-mnpqr-stvwx"));

    assert!(outcome.ok);
    assert_eq!(outcome.pushed, 2);
    assert_eq!(store.seqs(), [Some(1.0), Some(2.0)]);
    let push = &seen.calls(Method::Post)[0];
    assert_eq!(push.url, format!("{SERVER}/push"));
    assert_eq!(
        push.authorization.as_deref(),
        Some(&*format!("Bearer {PHRASE}"))
    );
    assert_eq!(push.body.as_ref().unwrap()["events"][1]["id"], "e2");
}

#[test]
fn a_failed_push_leaves_the_seq_missing_and_never_pulls() {
    let store = MemoryStore::with_local(1);
    let server = scripted(|_| Ok((500, json!({}))));

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert_eq!(outcome.pushed, 0);
    assert!(outcome.message.unwrap().contains("problem on its side"));
    assert_eq!(store.seqs(), [None]);
    assert!(server.calls(Method::Get).is_empty());
    assert_eq!(store.cursor_writes.get(), 0);
}

#[test]
fn a_long_queue_goes_up_in_pages() {
    let store = MemoryStore::with_local(PUSH_PAGE + 1);
    let relay = MemoryRelay::default();

    let outcome = sync(&relay, &store);

    assert_eq!(outcome.pushed, PUSH_PAGE + 1);
    assert!(store.seqs().iter().all(Option::is_some));
    assert_eq!(relay.log(PHRASE).len(), PUSH_PAGE + 1);
}

#[test]
fn a_push_nothing_was_acknowledged_from_is_a_failure_not_a_loop() {
    let store = MemoryStore::with_local(1);
    let server = scripted(|_| Ok((200, json!({ "seqs": {} }))));

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert!(outcome.message.unwrap().contains("did not accept"));
    assert_eq!(server.calls(Method::Post).len(), 1);
}

/* ---- pull ---------------------------------------------------------------- */

#[test]
fn a_pull_pages_until_caught_up_moving_the_cursor_behind_each_page() {
    let store = MemoryStore::default();
    let server = scripted(|call| {
        Ok((
            200,
            if call.after().as_deref() == Some("0") {
                json!({ "events": [remote(1), remote(2)], "latest": 4 })
            } else {
                json!({ "events": [remote(3), remote(4)], "latest": 4 })
            },
        ))
    });

    let outcome = sync(&server, &store);

    assert!(outcome.ok);
    assert_eq!(outcome.pulled, 4);
    let afters: Vec<_> = server.calls(Method::Get).iter().map(Call::after).collect();
    assert_eq!(afters, [Some("0".to_owned()), Some("2".to_owned())]);
    assert_eq!(store.cursor.get(), 4.0);
    assert_eq!(store.log.borrow().len(), 4);
}

#[test]
fn a_second_cycle_resumes_from_the_stored_cursor() {
    let relay = MemoryRelay::default();
    seed(&relay, vec![remote(1), remote(2)]);
    let recording = Recording::new(&relay);
    let store = MemoryStore::default();

    sync(&recording, &store);
    let second = sync(&recording, &store);

    assert_eq!(recording.afters(), ["0", "2"]);
    assert_eq!(store.cursor.get(), 2.0);
    assert_eq!(second.summary, "Already up to date.");
}

#[test]
fn a_page_that_cannot_advance_the_cursor_ends_the_cycle() {
    let store = MemoryStore::default();
    let server = scripted(|call| {
        Ok(match call.method {
            Method::Post => (200, json!({ "seqs": {} })),
            Method::Get => (200, json!({ "events": [{ "garbage": true }], "latest": 9 })),
        })
    });

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert!(outcome
        .message
        .unwrap()
        .contains("does not advance the cursor"));
    assert_eq!(server.calls(Method::Get).len(), 1);
    assert_eq!(store.cursor_writes.get(), 0);
}

#[test]
fn a_cursor_already_earned_is_kept_when_a_later_page_dies() {
    let store = MemoryStore::default();
    let server = scripted(|call| match call.after().as_deref() {
        Some("0") => Ok((200, json!({ "events": [remote(1)], "latest": 4 }))),
        _ => Err("offline".to_owned()),
    });

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert_eq!(outcome.pulled, 1);
    assert_eq!(store.cursor.get(), 1.0);
}

/* ---- failures ------------------------------------------------------------ */

#[test]
fn a_refused_phrase_is_named_and_leaves_the_cursor_alone() {
    let store = MemoryStore::default();
    let server = scripted(|_| Ok((401, json!("Unauthorized"))));

    let outcome = sync(&server, &store);

    assert_eq!((outcome.ok, outcome.pushed, outcome.pulled), (false, 0, 0));
    assert!(outcome.summary.contains("rejected the pairing phrase"));
    assert_eq!(store.cursor_writes.get(), 0);
}

#[test]
fn an_unreachable_server_is_named() {
    let server = scripted(|_| Err("network error".to_owned()));
    let outcome = sync(&server, &MemoryStore::default());
    assert_eq!(
        outcome.message.as_deref(),
        Some("Could not reach the sync server.")
    );
}

#[test]
fn an_unreadable_answer_is_named() {
    let server = scripted(|_| Ok((200, json!("not an object"))));
    let outcome = sync(&server, &MemoryStore::default());
    assert!(!outcome.ok);
    assert_eq!(outcome.message.as_deref(), Some(UNEXPECTED));
}

#[test]
fn a_store_failure_is_an_outcome_too() {
    let store = MemoryStore {
        broken: Some("pending_events"),
        ..MemoryStore::default()
    };
    let relay = MemoryRelay::default();
    let outcome = sync(&relay, &store);
    assert!(!outcome.ok);
    assert_eq!(outcome.message.as_deref(), Some("pending_events broke"));
}

#[test]
fn a_phrase_that_is_not_one_asks_no_one() {
    let server = scripted(|_| Ok((200, json!({}))));
    let outcome = pollster::block_on(run(&server, &MemoryStore::default(), SERVER, "nope"));
    assert_eq!(outcome.message.as_deref(), Some(BAD_PHRASE));
    assert!(server.calls.borrow().is_empty());
}

#[test]
fn the_summary_counts_both_directions() {
    let relay = MemoryRelay::default();
    let store = MemoryStore::with_local(1);
    let outcome = sync(&relay, &store);
    // The own event comes back on the pull: a stamp, counted as received.
    assert_eq!(outcome.summary, "Sent 1, received 1.");
    assert_eq!(store.log.borrow().len(), 1);
}

/* ---- probe --------------------------------------------------------------- */

fn probe_with(reply: Result<u16, String>) -> (SyncProbeResult, Vec<Call>) {
    let server = scripted(|_| reply.clone().map(|status| (status, json!({}))));
    let result = pollster::block_on(probe(&server, SERVER, PHRASE));
    (result, server.calls.into_inner())
}

#[test]
fn the_probe_asks_for_an_empty_page() {
    let (result, calls) = probe_with(Ok(200));
    assert_eq!(calls[0].url, format!("{SERVER}/pull?after=0&limit=0"));
    assert_eq!(
        calls[0].authorization.as_deref(),
        Some(&*format!("Bearer {PHRASE}"))
    );
    assert_eq!(
        result,
        SyncProbeResult {
            ok: true,
            reason: None,
            message: "Connected to the sync server.".to_owned()
        }
    );
}

#[test]
fn the_probe_tells_a_refusal_from_an_outage_from_anything_else() {
    assert_eq!(probe_with(Ok(401)).0.reason, Some(ProbeFailure::Rejected));
    assert_eq!(probe_with(Ok(403)).0.reason, Some(ProbeFailure::Rejected));
    assert_eq!(
        probe_with(Err("offline".to_owned())).0.reason,
        Some(ProbeFailure::Unreachable)
    );
    let (unexpected, _) = probe_with(Ok(502));
    assert_eq!(unexpected.reason, Some(ProbeFailure::Unexpected));
    assert!(unexpected.message.contains("502"));
}

/* ---- pair ---------------------------------------------------------------- */

fn pair_with<T: Transport>(transport: &T, store: &MemoryStore, phrase: &str) -> PairOutcome {
    pollster::block_on(pair(transport, store, SERVER, phrase))
}

#[test]
fn pairing_reports_paired_when_a_profile_is_in_the_room() {
    let relay = MemoryRelay::default();
    let mut profile = remote(1);
    profile["type"] = json!("profileUpdated");
    seed(&relay, vec![profile]);

    let outcome = pair_with(&relay, &MemoryStore::default(), "abcde-fghjk-mnpqr-stvwx");

    assert_eq!(
        outcome,
        PairOutcome {
            ok: true,
            paired: true,
            message: None
        }
    );
}

#[test]
fn pairing_an_empty_room_succeeds_unpaired() {
    let outcome = pair_with(&MemoryRelay::default(), &MemoryStore::default(), PHRASE);
    assert_eq!((outcome.ok, outcome.paired), (true, false));
}

#[test]
fn pairing_passes_a_refusal_through() {
    let server = scripted(|_| Ok((401, json!({}))));
    let outcome = pair_with(&server, &MemoryStore::default(), PHRASE);
    assert_eq!((outcome.ok, outcome.paired), (false, false));
    assert!(outcome
        .message
        .unwrap()
        .contains("rejected the pairing phrase"));
}

#[test]
fn pairing_with_a_phrase_that_is_not_one_asks_no_one() {
    let server = scripted(|_| Ok((200, json!({}))));
    let outcome = pair_with(&server, &MemoryStore::default(), "nope");
    assert_eq!(outcome.message.as_deref(), Some(BAD_PHRASE));
    assert!(server.calls.borrow().is_empty());
}
