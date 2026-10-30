//! What the cycle promises is not "it moves events" but what survives an
//! interruption: a local event keeps its missing `seq` until the relay has
//! answered for it, the cursor moves only behind an applied page, and every
//! failure is a returned value. The store here is a fake that keeps a log; the
//! merge rules behind a real one are `sapling-store`'s `tests/sync.rs`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::future::{ready, Future};

use serde_json::{json, Value};

use sapling_domain::events::{parse_envelope, RawEvent};
use sapling_domain::objects::{object_refs, ContentObject};

use super::*;
use crate::relay::MemoryRelay;

const PHRASE: &str = "ABCDEFGHJKMNPQRSTVWX";
const SERVER: &str = "https://sync.example";

#[derive(Default)]
struct MemoryStore {
    log: RefCell<Vec<(RawEvent, Option<f64>)>>,
    cursor: Cell<f64>,
    cursor_writes: Cell<usize>,
    /// The room the stamps and cursor describe.
    room: RefCell<Option<String>>,
    /// A store call that fails, by name.
    broken: Option<&'static str>,
    /// Content objects, by hash.
    objects: RefCell<BTreeMap<String, String>>,
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

    fn objects(
        &self,
        hashes: Vec<String>,
    ) -> impl Future<Output = StoreResult<Vec<ContentObject>>> {
        let held = self.objects.borrow();
        ready(Ok(hashes
            .into_iter()
            .filter_map(|hash| {
                let bytes = held.get(&hash)?.clone();
                Some(ContentObject { hash, bytes })
            })
            .collect()))
    }

    fn put_objects(&self, objects: Vec<ContentObject>) -> impl Future<Output = StoreResult<usize>> {
        let mut held = self.objects.borrow_mut();
        let mut accepted = 0;
        for object in objects.into_iter().filter(ContentObject::verifies) {
            held.insert(object.hash, object.bytes);
            accepted += 1;
        }
        ready(self.check("put_objects").map(|()| accepted))
    }

    /// Every object an event in the log names, minus the ones held — the
    /// fake's stand-in for "a text's current body".
    fn missing_objects(&self) -> impl Future<Output = StoreResult<Vec<String>>> {
        let held = self.objects.borrow();
        let mut missing: Vec<String> = self
            .log
            .borrow()
            .iter()
            .flat_map(|(event, _)| object_refs(event).objects)
            .filter(|hash| !held.contains_key(hash))
            .collect();
        missing.sort();
        missing.dedup();
        ready(self.check("missing_objects").map(|()| missing))
    }

    fn follow_room(&self, room: String) -> impl Future<Output = StoreResult<bool>> {
        if let Err(error) = self.check("follow_room") {
            return ready(Err(error));
        }
        let mut held = self.room.borrow_mut();
        if held.as_deref() == Some(&*room) {
            return ready(Ok(false));
        }
        for row in self.log.borrow_mut().iter_mut() {
            row.1 = None;
        }
        self.cursor.set(0.0);
        *held = Some(room);
        ready(Ok(true))
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
    seed_room(relay, PHRASE, events);
}

fn seed_room(relay: &MemoryRelay, phrase: &str, events: Vec<Value>) {
    let body = json!({ "events": events }).to_string();
    let request = Request {
        method: Method::Post,
        url: format!("{SERVER}/push"),
        headers: vec![("Authorization".to_owned(), format!("Bearer {phrase}"))],
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
            Method::Put => (404, json!({})),
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
            Method::Put => (404, json!({})),
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

/* ---- following another library ------------------------------------------ */

const OTHER: &str = "ZYXWVTSRQPNMKJHGFEDC";

#[test]
fn following_another_room_sends_everything_again_and_pulls_it_from_zero() {
    let relay = MemoryRelay::default();
    let store = MemoryStore::with_local(2);
    sync(&relay, &store);
    assert_eq!(store.cursor.get(), 2.0);
    // The other library already holds two events of its own, so its seqs
    // overlap the cursor this device earned in the first room.
    seed_room(&relay, OTHER, vec![remote(1), remote(2)]);

    let switched = pollster::block_on(run(&relay, &store, SERVER, OTHER));

    assert!(switched.ok, "{switched:?}");
    assert_eq!(switched.pushed, 2, "local events reach the new room");
    let ids: Vec<Value> = relay
        .log(OTHER)
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    assert_eq!(
        ids,
        [
            json!("remote-1"),
            json!("remote-2"),
            json!("e1"),
            json!("e2")
        ]
    );
    assert_eq!(store.log.borrow().len(), 4, "the room's own events arrive");
    assert_eq!(store.cursor.get(), 4.0);
    assert_eq!(store.seqs(), [Some(3.0), Some(4.0), Some(1.0), Some(2.0)]);
}

#[test]
fn going_back_to_a_room_is_a_redundant_resend_and_nothing_more() {
    let relay = MemoryRelay::default();
    let store = MemoryStore::with_local(1);
    sync(&relay, &store);
    pollster::block_on(run(&relay, &store, SERVER, OTHER));

    let back = sync(&relay, &store);

    assert!(back.ok);
    // The first room answers the seq it already gave: no second row there.
    assert_eq!(relay.log(PHRASE).len(), 1);
    assert_eq!(store.seqs(), [Some(1.0)]);
    assert_eq!(sync(&relay, &store).summary, "Already up to date.");
}

#[test]
fn a_room_is_its_phrase_however_typed_on_its_server() {
    assert_eq!(
        room_key(SERVER, PHRASE),
        room_key(&format!("{SERVER}/"), "abcde-fghjk-mnpqr-stvwx")
    );
    assert_ne!(room_key(SERVER, PHRASE), room_key(SERVER, OTHER));
    assert_ne!(
        room_key(SERVER, PHRASE),
        room_key("https://other.example", PHRASE)
    );
    assert_eq!(room_key(SERVER, PHRASE).len(), 16);
}

#[test]
fn a_store_that_cannot_follow_the_room_stops_the_cycle_before_it_pushes() {
    let store = MemoryStore {
        broken: Some("follow_room"),
        ..MemoryStore::with_local(1)
    };
    let server = scripted(|_| Ok((200, json!({}))));
    let outcome = sync(&server, &store);
    assert_eq!(outcome.message.as_deref(), Some("follow_room broke"));
    assert!(server.calls.borrow().is_empty());
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

/* ---- content objects ----------------------------------------------------- */

const BODY: &str = r#"{"segments":[{"text":"你好。"}]}"#;

fn body_hash() -> String {
    sapling_domain::objects::object_hash(BODY.as_bytes())
}

fn text_by_reference(id: &str, hash: &str) -> RawEvent {
    RawEvent {
        id: id.to_owned(),
        kind: "textAdded".to_owned(),
        at: 1.0,
        device: "devA".to_owned(),
        payload: json!({ "id": "t1", "title": "T", "source": "imported", "content": hash, "createdAt": 1 }),
    }
}

/// A store that wrote one text by reference, its object beside it.
fn store_with_text() -> MemoryStore {
    let store = MemoryStore::default();
    store
        .log
        .borrow_mut()
        .push((text_by_reference("e1", &body_hash()), None));
    store
        .objects
        .borrow_mut()
        .insert(body_hash(), BODY.to_owned());
    store
}

fn routes(recording: &Recording<'_>) -> Vec<String> {
    recording
        .calls
        .borrow()
        .iter()
        .map(|(method, url)| {
            let path = url.trim_start_matches(SERVER);
            format!("{} {}", method.as_str(), path.split('?').next().unwrap())
        })
        .collect()
}

#[test]
fn a_text_s_object_lands_before_the_page_that_names_it() {
    let relay = MemoryRelay::default();
    let recording = Recording::new(&relay);
    let store = store_with_text();

    let outcome = sync(&recording, &store);

    assert!(outcome.ok, "{outcome:?}");
    let hash = body_hash();
    assert_eq!(
        routes(&recording)[..3],
        [
            "POST /objects/missing".to_owned(),
            format!("PUT /objects/{hash}"),
            "POST /push".to_owned()
        ]
    );
    assert_eq!(
        relay.objects(PHRASE).get(&hash).map(String::as_str),
        Some(BODY)
    );
    assert_eq!(
        relay.edges(PHRASE),
        [("text:singleton:t1".to_owned(), hash)]
    );
    // The fields ride the wire, not the row: a pull never returns them.
    let row = &relay.log(PHRASE)[0];
    assert!(row.get("owner").is_none() && row.get("objects").is_none());
}

#[test]
fn the_envelope_fields_ride_the_push_body() {
    let store = store_with_text();
    let server = scripted(|call| {
        Ok(match (call.method, call.url.as_str()) {
            (Method::Post, url) if url.ends_with("/objects/missing") => {
                (200, json!({ "missing": [] }))
            }
            (Method::Post, _) => (200, json!({ "seqs": { "e1": 1 } })),
            _ => (200, json!({ "events": [], "latest": 1 })),
        })
    });

    assert!(sync(&server, &store).ok);

    let push = server
        .calls(Method::Post)
        .into_iter()
        .find(|call| call.url.ends_with("/push"))
        .expect("a push");
    let event = &push.body.unwrap()["events"][0];
    assert_eq!(event["owner"], "text:singleton:t1");
    assert_eq!(event["objects"], json!([body_hash()]));
    assert!(event.get("retire").is_none());
    assert!(server.calls(Method::Put).is_empty(), "nothing was missing");
}

#[test]
fn an_object_the_relay_already_holds_is_not_sent_again() {
    let relay = MemoryRelay::default();
    relay.hold(PHRASE, BODY);
    let recording = Recording::new(&relay);

    assert!(sync(&recording, &store_with_text()).ok);

    assert!(!routes(&recording)
        .iter()
        .any(|route| route.starts_with("PUT")));
}

#[test]
fn a_relay_without_object_endpoints_fails_the_cycle_and_the_page_stays_put() {
    let relay = MemoryRelay::without_objects();
    let store = store_with_text();

    let outcome = sync(&relay, &store);

    assert!(!outcome.ok);
    assert_eq!(outcome.message.as_deref(), Some(NO_OBJECT_STORE));
    assert_eq!(store.seqs(), [None]);
    assert!(relay.log(PHRASE).is_empty());
}

#[test]
fn a_page_that_names_no_object_pushes_to_an_old_relay_as_before() {
    let relay = MemoryRelay::without_objects();
    let store = MemoryStore::with_local(2);

    let outcome = sync(&relay, &store);

    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.pushed, 2);
}

#[test]
fn a_deleted_text_retires_its_owner() {
    let relay = MemoryRelay::default();
    let store = MemoryStore::default();
    let mut deleted = event("e1", "textDeleted");
    deleted.payload = json!({ "textId": "t1" });
    store.log.borrow_mut().push((deleted, None));

    assert!(sync(&relay, &store).ok);

    assert_eq!(relay.retired(PHRASE), ["text:singleton:t1"]);
}

#[test]
fn an_object_the_store_never_had_does_not_hold_the_page_back() {
    // An event this device pulled whose body never arrived, re-pushed after
    // following another room: nobody here can supply the object.
    let relay = MemoryRelay::default();
    let store = MemoryStore::default();
    store
        .log
        .borrow_mut()
        .push((text_by_reference("e1", &body_hash()), None));

    let outcome = sync(&relay, &store);

    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.pushed, 1);
    assert!(relay.objects(PHRASE).is_empty());
}

fn remote_text(seq: usize, hash: &str) -> Value {
    let mut row = serde_json::to_value(text_by_reference(&format!("remote-{seq}"), hash)).unwrap();
    row["seq"] = json!(seq);
    row["device"] = json!("devB");
    row
}

#[test]
fn a_pulled_text_brings_its_object() {
    let relay = MemoryRelay::default();
    let hash = relay.hold(PHRASE, BODY);
    seed(&relay, vec![remote_text(1, &hash)]);
    let store = MemoryStore::default();

    let outcome = sync(&relay, &store);

    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(
        store.objects.borrow().get(&hash).map(String::as_str),
        Some(BODY)
    );
}

#[test]
fn an_object_not_on_the_relay_yet_is_asked_for_again_next_cycle() {
    let relay = MemoryRelay::default();
    let hash = body_hash();
    seed(&relay, vec![remote_text(1, &hash)]);
    let store = MemoryStore::default();

    let first = sync(&relay, &store);
    assert!(first.ok, "a 404 is a state, not a failure: {first:?}");
    assert!(store.objects.borrow().is_empty());

    relay.hold(PHRASE, BODY);
    assert!(sync(&relay, &store).ok);
    assert!(store.objects.borrow().contains_key(&hash));
}

#[test]
fn a_fetched_object_that_is_not_its_name_is_refused() {
    let store = MemoryStore::default();
    let hash = body_hash();
    let row = remote_text(1, &hash);
    let server = scripted(move |call| {
        Ok(if call.url.contains("/objects/") {
            (200, json!({ "segments": [] }))
        } else {
            (200, json!({ "events": [row.clone()], "latest": 1 }))
        })
    });

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert!(outcome.message.unwrap().contains("does not match"));
    assert!(store.objects.borrow().is_empty());
    assert_eq!(store.cursor.get(), 1.0, "the events still landed");
}

#[test]
fn an_unreachable_object_fails_the_cycle_after_the_events_landed() {
    let store = MemoryStore::default();
    let row = remote_text(1, &body_hash());
    let server = scripted(move |call| {
        if call.url.contains("/objects/") {
            Err("offline".to_owned())
        } else {
            Ok((200, json!({ "events": [row.clone()], "latest": 1 })))
        }
    });

    let outcome = sync(&server, &store);

    assert!(!outcome.ok);
    assert_eq!(outcome.pulled, 1);
    assert_eq!(
        outcome.message.as_deref(),
        Some("Could not reach the sync server.")
    );
}
