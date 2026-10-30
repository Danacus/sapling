//! Sapling's sync client: one cycle against the relay (`worker/`) — push what
//! this device wrote, pull what the others did, apply it, advance the cursor,
//! fetch the content objects the texts now name — plus the liveness probe,
//! pairing and the phrase.
//!
//! Content objects (`docs/content-objects.md` §6) ride beside the log, never
//! in it. Before each push page the cycle derives the page's envelope fields
//! with `sapling_domain::objects::object_refs`, asks the relay which of the
//! named objects it lacks and uploads those, so blobs land before the events
//! that reference them; the fields go on the wire envelope and are never
//! stored locally. After pulling it fetches every object a text names that the
//! store lacks, verifying each against its name. A relay without the object
//! endpoints fails the cycle with its own message rather than receive a page
//! that references objects it cannot hold; a page that references none pushes
//! exactly as before.
//!
//! Host-agnostic by construction. The HTTP request is a [`Transport`] and the
//! database a [`SyncStore`], both injected; the relay's URL and the phrase are
//! arguments. The crate reads no configuration and opens nothing: the web host
//! lends `fetch` and its `Backend`, a native one `sapling-store`'s `CoreHandle`.
//!
//! Three properties are load-bearing:
//!
//! - **It never fails.** Sync is optional everywhere; a device offline, a
//!   phrase the server refuses, a store that errors must leave the app as it
//!   was. Every failure comes back as a [`SyncOutcome`] with a message.
//! - **Interruption costs a redundant request, never an event.** A push stamps
//!   `seq` only on what the server acknowledged; the cursor advances only after
//!   its page has been applied. Both directions are safe to repeat — the log
//!   unions by event id at both ends — which is also what makes following a
//!   different library safe: the stamps and cursor belong to one room
//!   ([`room_key`]), and a cycle against another clears them and sends and
//!   fetches everything again.
//! - **One cycle at a time.** Several triggers overlap by design; joining the
//!   cycle already running is the host's to do, because only the host knows
//!   what "already running" means on its threads.

#![forbid(unsafe_code)]

use std::future::Future;

use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use sapling_domain::events::RawEvent;
use sapling_domain::objects::{is_object_hash, object_refs, ContentObject, ObjectRefs};

pub mod phrase;
pub mod relay;

pub use phrase::{BAD_PHRASE, PHRASE_LENGTH};

/// Events per push request.
pub const PUSH_PAGE: usize = 500;
/// Events asked for per pull request; the relay caps it at the same.
pub const PULL_PAGE: usize = 1000;
/// Hashes per `POST /objects/missing`; the relay refuses more.
pub const MISSING_PAGE: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
}

impl Method {
    /// The HTTP verb as a host's request API spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
        }
    }
}

/// One HTTP request. `body` is sent as these exact bytes — a pushed page, or
/// an object's bytes on `PUT /objects/<H>`, which the relay hashes as sent.
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// One HTTP request. `Err` is a failure to get any response at all.
pub trait Transport {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>>;
}

/// A store call that failed, as its message.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreError(pub String);

pub type StoreResult<T> = Result<T, StoreError>;

/// What the cycle needs of the database, and nothing more.
pub trait SyncStore {
    /// The first `limit` events without a `seq`, in log order, with no gaps.
    fn pending_events(&self, limit: usize) -> impl Future<Output = StoreResult<Vec<RawEvent>>>;
    /// Stamps the `seq` the relay assigned each id; answers how many.
    fn mark_pushed(&self, seqs: Vec<(String, f64)>) -> impl Future<Output = StoreResult<usize>>;
    /// Applies a pulled page as it arrived; answers how many reached the log.
    fn apply_remote(&self, events: Vec<Value>) -> impl Future<Output = StoreResult<usize>>;
    /// The highest `seq` whose page has been applied, `0` before the first.
    fn pull_cursor(&self) -> impl Future<Output = StoreResult<f64>>;
    fn set_pull_cursor(&self, cursor: f64) -> impl Future<Output = StoreResult<()>>;
    /// Whether this device now has a library — what pairing asks after its cycle.
    fn has_profile(&self) -> impl Future<Output = StoreResult<bool>>;
    /// Makes `room` ([`room_key`]) the one this device's push stamps and pull
    /// cursor describe. When they described another room — or none is
    /// recorded — every stamp and the cursor are cleared first, in one
    /// transaction, so the next push sends the whole log and the next pull
    /// starts at zero. Answers whether it cleared anything.
    fn follow_room(&self, room: String) -> impl Future<Output = StoreResult<bool>>;
    /// The content objects among `hashes` the store holds — what a push
    /// uploads. One it does not hold is simply not answered.
    fn objects(&self, hashes: Vec<String>)
        -> impl Future<Output = StoreResult<Vec<ContentObject>>>;
    /// Stores fetched objects; the store verifies each against its name too.
    /// Answers how many it accepted.
    fn put_objects(&self, objects: Vec<ContentObject>) -> impl Future<Output = StoreResult<usize>>;
    /// Every object a text's current body names that the store lacks.
    fn missing_objects(&self) -> impl Future<Output = StoreResult<Vec<String>>>;
}

/// Which room on which relay a phrase names, as this device records it beside
/// its sync position — never the phrase itself, and never the relay's own room
/// name (that hash is the Worker's, and nothing here needs to agree with it).
///
/// A `seq` is a position in *one* room's log, and the pull cursor is one too:
/// carried over to another room they claim events were pushed that never were,
/// and skip that room's first events as already pulled. So the cycle hands
/// this key to [`SyncStore::follow_room`] before anything else, and a device
/// that follows a different library — a new phrase from Settings, from
/// onboarding, from anywhere — starts over against it whatever path changed
/// the phrase. The relay's URL is part of the key for the same reason: the
/// same phrase on another server is another log.
///
/// 64-bit FNV-1a: an identity, not a secret — the phrase it is taken over has
/// 100 bits and already sits in the host's own storage.
pub fn room_key(url: &str, phrase: &str) -> String {
    let normalized = phrase::normalize(phrase);
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in ["sapling:room:v1", url.trim_end_matches('/'), &normalized]
        .join("\n")
        .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// What one cycle did. `ok` is the only field a caller has to look at.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct SyncOutcome {
    pub ok: bool,
    /// Local events the relay acknowledged and this device stamped.
    pub pushed: usize,
    /// Events applied from the log, this device's own echoes included.
    pub pulled: usize,
    /// Learner-facing; present on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    /// One learner-facing line for whichever way it went.
    pub summary: String,
}

impl SyncOutcome {
    fn done(pushed: usize, pulled: usize) -> Self {
        let summary = if pushed == 0 && pulled == 0 {
            "Already up to date.".to_owned()
        } else {
            format!("Sent {pushed}, received {pulled}.")
        };
        SyncOutcome {
            ok: true,
            pushed,
            pulled,
            message: None,
            summary,
        }
    }

    fn failed(pushed: usize, pulled: usize, message: String) -> Self {
        SyncOutcome {
            ok: false,
            pushed,
            pulled,
            summary: message.clone(),
            message: Some(message),
        }
    }
}

/// Why a cycle stopped, already worded for the learner.
struct Failure(String);

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure(if error.0.is_empty() {
            "Sync failed.".to_owned()
        } else {
            error.0
        })
    }
}

fn fail<T>(message: &str) -> Result<T, Failure> {
    Err(Failure(message.to_owned()))
}

/// The relay's address and the learner's credentials, for one request.
struct Relay<'a, T> {
    transport: &'a T,
    base: &'a str,
    headers: Vec<(String, String)>,
}

impl<'a, T: Transport> Relay<'a, T> {
    /// `None` when `phrase` does not normalise to a valid one.
    fn new(transport: &'a T, url: &'a str, phrase: &str) -> Option<Self> {
        let phrase = phrase::normalize(phrase);
        if !phrase::is_valid(&phrase) {
            return None;
        }
        Some(Relay {
            transport,
            base: url.trim_end_matches('/'),
            headers: vec![
                ("Authorization".to_owned(), format!("Bearer {phrase}")),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ],
        })
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> Result<Response, Failure> {
        let request = Request {
            method,
            url: format!("{}{path}", self.base),
            headers: self.headers.clone(),
            body,
        };
        // Offline, DNS, CORS: the host cannot tell them apart either.
        self.transport
            .send(request)
            .await
            .map_err(|_| Failure("Could not reach the sync server.".to_owned()))
    }

    async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
    ) -> Result<Value, Failure> {
        let response = self.send(method, path, body).await?;
        if !(200..300).contains(&response.status) {
            return Err(Failure(status_message(response.status)));
        }
        serde_json::from_str(&response.body)
            .map_err(|_| Failure("The sync server sent something unreadable.".to_owned()))
    }
}

fn status_message(status: u16) -> String {
    match status {
        401 | 403 => {
            "The sync server rejected the pairing phrase. Check it in Settings.".to_owned()
        }
        429 => "The sync server is rate-limiting this device. Try again shortly.".to_owned(),
        500.. => "The sync server had a problem on its side. Try again in a minute.".to_owned(),
        _ => format!("The sync server refused the request ({status})."),
    }
}

const UNEXPECTED: &str = "The sync server sent an unexpected response.";

/// A usable `seq` off a row, even one too malformed to parse as an event.
fn seq_of(raw: &Value) -> Option<f64> {
    let seq = raw.get("seq")?.as_f64()?;
    (seq > 0.0 && seq.fract() == 0.0).then_some(seq)
}

/// One whole cycle against the relay at `url` as `phrase`. Never fails; see the crate docs.
pub async fn run<T: Transport, S: SyncStore>(
    transport: &T,
    store: &S,
    url: &str,
    phrase: &str,
) -> SyncOutcome {
    let Some(relay) = Relay::new(transport, url, phrase) else {
        return SyncOutcome::failed(0, 0, BAD_PHRASE.to_owned());
    };
    let (mut pushed, mut pulled) = (0, 0);
    let result = async {
        // Before anything is read: a position in another room's log is no
        // position in this one (`room_key`).
        store.follow_room(room_key(url, phrase)).await?;
        push(&relay, store, &mut pushed).await?;
        pull(&relay, store, &mut pulled).await?;
        fetch_objects(&relay, store).await
    }
    .await;
    match result {
        Ok(()) => SyncOutcome::done(pushed, pulled),
        Err(Failure(message)) => SyncOutcome::failed(pushed, pulled, message),
    }
}

/// Sends every unacknowledged event in log order and stamps the seqs that come
/// back. Stopping on a short page is safe only because `pending_events` is
/// exactly the first `limit` unpushed rows — an unreadable row is pushed like
/// any other — so a short page really does mean the queue is empty.
async fn push<T: Transport, S: SyncStore>(
    relay: &Relay<'_, T>,
    store: &S,
    pushed: &mut usize,
) -> Result<(), Failure> {
    loop {
        let events = store.pending_events(PUSH_PAGE).await?;
        if events.is_empty() {
            return Ok(());
        }
        // Derived here, every time, and never stored: the local log is
        // unchanged, and a pull never returns them either.
        let refs: Vec<ObjectRefs> = events.iter().map(object_refs).collect();
        upload_objects(relay, store, &refs).await?;
        let wire: Vec<Value> = events
            .iter()
            .zip(&refs)
            .map(|(event, refs)| on_the_wire(event, refs))
            .collect();
        let body = json!({ "events": wire }).to_string();
        let answer = relay.json(Method::Post, "/push", Some(body)).await?;
        let Some(seqs) = answer.get("seqs").and_then(Value::as_object) else {
            return fail(UNEXPECTED);
        };
        let acknowledged: Vec<(String, f64)> = events
            .iter()
            .filter_map(|event| Some((event.id.clone(), seqs.get(&event.id)?.as_f64()?)))
            .collect();
        // A page nothing could be stamped from would be re-sent forever.
        if acknowledged.is_empty() {
            return fail("The sync server did not accept this device’s changes.");
        }
        *pushed += store.mark_pushed(acknowledged).await?;
        if events.len() < PUSH_PAGE {
            return Ok(());
        }
    }
}

/// The relay answered `404` to `/objects/missing`: it predates content objects.
pub const NO_OBJECT_STORE: &str =
    "The sync server is out of date: it cannot hold texts yet. Redeploy it, then sync again.";

/// A fetched object's bytes did not hash to its name.
const OBJECT_MISMATCH: &str = "The sync server sent a text that does not match its name.";

/// One row as `/push` takes it: the envelope as stored, plus whatever
/// `owner`/`objects`/`retire` it declares — each only when present, so a row
/// that declares nothing is byte for byte what an older client sent.
fn on_the_wire(event: &RawEvent, refs: &ObjectRefs) -> Value {
    let mut row = serde_json::to_value(event).expect("a log row serialises");
    if let (Value::Object(row), Ok(Value::Object(fields))) = (&mut row, serde_json::to_value(refs))
    {
        row.extend(fields);
    }
    row
}

/// Makes sure the relay holds every object this page names before the page
/// goes: asks which it lacks, then `PUT`s each of those this store holds. One
/// the store does not hold either — an event pulled from elsewhere whose body
/// never arrived — is not this device's to supply, and the page still goes:
/// the relay records an edge without requiring its object.
async fn upload_objects<T: Transport, S: SyncStore>(
    relay: &Relay<'_, T>,
    store: &S,
    refs: &[ObjectRefs],
) -> Result<(), Failure> {
    let mut hashes: Vec<String> = refs
        .iter()
        .flat_map(|refs| refs.objects.iter().cloned())
        .collect();
    hashes.sort();
    hashes.dedup();
    // A page that names no object asks nothing, so it pushes as it always
    // did — to a relay with the object endpoints or without.
    for page in hashes.chunks(MISSING_PAGE) {
        let body = json!({ "hashes": page }).to_string();
        let response = relay
            .send(Method::Post, "/objects/missing", Some(body))
            .await?;
        if response.status == 404 {
            return fail(NO_OBJECT_STORE);
        }
        if !(200..300).contains(&response.status) {
            return Err(Failure(status_message(response.status)));
        }
        let missing: Vec<String> = serde_json::from_str::<Value>(&response.body)
            .ok()
            .and_then(|answer| serde_json::from_value(answer.get("missing")?.clone()).ok())
            .ok_or_else(|| Failure(UNEXPECTED.to_owned()))?;
        let missing: Vec<String> = missing
            .into_iter()
            .filter(|hash| page.contains(hash))
            .collect();
        if missing.is_empty() {
            continue;
        }
        for object in store.objects(missing).await? {
            if !object.verifies() {
                continue;
            }
            let path = format!("/objects/{}", object.hash);
            let response = relay.send(Method::Put, &path, Some(object.bytes)).await?;
            match response.status {
                200..=299 => {}
                413 => return fail("A text is too large for the sync server to hold."),
                status => return Err(Failure(status_message(status))),
            }
        }
    }
    Ok(())
}

/// Fetches every object a text names that the store lacks, verifying each
/// against its name before it is stored. The set is re-derived from the texts
/// every cycle, never queued, so whatever does not arrive now is asked for
/// next time. A `404` is an object no device has uploaded yet — a state, not a
/// failure; a mismatch, a refusal or no answer fails the cycle with its
/// message, after keeping everything that did arrive.
async fn fetch_objects<T: Transport, S: SyncStore>(
    relay: &Relay<'_, T>,
    store: &S,
) -> Result<(), Failure> {
    let mut fetched = Vec::new();
    let mut failure = None;
    for hash in store.missing_objects().await? {
        if !is_object_hash(&hash) {
            continue;
        }
        match relay
            .send(Method::Get, &format!("/objects/{hash}"), None)
            .await
        {
            Ok(response) if (200..300).contains(&response.status) => {
                let object = ContentObject {
                    hash,
                    bytes: response.body,
                };
                if object.verifies() {
                    fetched.push(object);
                } else {
                    failure = Some(Failure(OBJECT_MISMATCH.to_owned()));
                }
            }
            Ok(response) if response.status == 404 => {}
            Ok(response) => failure = Some(Failure(status_message(response.status))),
            // No answer at all: the rest would go the same way.
            Err(unreachable) => {
                failure = Some(unreachable);
                break;
            }
        }
    }
    if !fetched.is_empty() {
        store.put_objects(fetched).await?;
    }
    failure.map_or(Ok(()), Err)
}

/// Pulls from the stored cursor until caught up, applying each page as it
/// lands. Caught up is `cursor >= latest`, not a short page: the relay may
/// answer with fewer events than asked for and still have more.
async fn pull<T: Transport, S: SyncStore>(
    relay: &Relay<'_, T>,
    store: &S,
    pulled: &mut usize,
) -> Result<(), Failure> {
    let mut cursor = store.pull_cursor().await?;
    loop {
        let path = format!("/pull?after={cursor}&limit={PULL_PAGE}");
        let mut answer = relay.json(Method::Get, &path, None).await?;
        let (Some(latest), Some(Value::Array(events))) = (
            answer.get("latest").and_then(Value::as_f64),
            answer.get_mut("events").map(Value::take),
        ) else {
            return fail(UNEXPECTED);
        };
        if events.is_empty() {
            return Ok(());
        }
        // Past every row with a usable `seq`, readable or not: a row this
        // build cannot read costs one row, never the whole sync.
        let highest = events.iter().filter_map(seq_of).fold(cursor, f64::max);
        if highest <= cursor {
            return fail("The sync server sent a page that does not advance the cursor.");
        }
        // Apply strictly before the cursor that covers it: an interruption
        // between the two costs a re-apply, which the log dedupes, while the
        // other order would skip events for good.
        *pulled += store.apply_remote(events).await?;
        store.set_pull_cursor(highest).await?;
        cursor = highest;
        if cursor >= latest {
            return Ok(());
        }
    }
}

/// Why a probe could not connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ProbeFailure {
    Rejected,
    Unreachable,
    Unexpected,
}

/// Where the probe got to, in the learner's terms.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct SyncProbeResult {
    pub ok: bool,
    /// Present when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<ProbeFailure>,
    pub message: String,
}

impl SyncProbeResult {
    fn failed(reason: ProbeFailure, message: impl Into<String>) -> Self {
        SyncProbeResult {
            ok: false,
            reason: Some(reason),
            message: message.into(),
        }
    }
}

/// Asks the relay whether this device could connect. Sync fails silently by
/// design, so a refused phrase and a healthy connection look the same unless
/// something asks; an empty pull is the cheapest request through the whole
/// path — routing, the bearer phrase, the room.
pub async fn probe<T: Transport>(transport: &T, url: &str, phrase: &str) -> SyncProbeResult {
    let Some(relay) = Relay::new(transport, url, phrase) else {
        return SyncProbeResult::failed(ProbeFailure::Rejected, BAD_PHRASE);
    };
    let response = match relay.send(Method::Get, "/pull?after=0&limit=0", None).await {
        Ok(response) => response,
        Err(Failure(message)) => {
            return SyncProbeResult::failed(ProbeFailure::Unreachable, message)
        }
    };
    match response.status {
        200..=299 => SyncProbeResult {
            ok: true,
            reason: None,
            message: "Connected to the sync server.".to_owned(),
        },
        401 | 403 => SyncProbeResult::failed(
            ProbeFailure::Rejected,
            "The sync server did not accept this pairing phrase.",
        ),
        status => SyncProbeResult::failed(
            ProbeFailure::Unexpected,
            format!("The sync server answered with {status}."),
        ),
    }
}

/// What a pairing attempt did. `paired` means a profile arrived from the log.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct PairOutcome {
    pub ok: bool,
    /// A profile is now present locally, so this device has a library.
    pub paired: bool,
    /// Learner-facing; present on failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
}

impl PairOutcome {
    fn failed(message: String) -> Self {
        PairOutcome {
            ok: false,
            paired: false,
            message: Some(message),
        }
    }
}

/// Joins a device to the library `phrase` names: one cycle, then whether a
/// profile came down the log.
///
/// A second device has no profile, and onboarding would write a fresh one that
/// wins last-write-wins on every device the learner owns; pulling *before*
/// writing anything is the way out. So this only ever reads — it never writes a
/// profile — and a phrase that is not one asks no one. Storing the phrase is
/// the host's, and comes first.
pub async fn pair<T: Transport, S: SyncStore>(
    transport: &T,
    store: &S,
    url: &str,
    phrase: &str,
) -> PairOutcome {
    if !phrase::is_valid(&phrase::normalize(phrase)) {
        return PairOutcome::failed(BAD_PHRASE.to_owned());
    }
    let outcome = run(transport, store, url, phrase).await;
    if !outcome.ok {
        return PairOutcome::failed(outcome.summary);
    }
    match store.has_profile().await {
        Ok(paired) => PairOutcome {
            ok: true,
            paired,
            message: None,
        },
        Err(error) => PairOutcome::failed(Failure::from(error).0),
    }
}

#[cfg(test)]
mod tests;
