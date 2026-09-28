//! Sapling's sync client: one cycle against the relay (`worker/`) — push what
//! this device wrote, pull what the others did, apply it, advance the cursor —
//! plus the liveness probe, pairing and the phrase.
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
//!   unions by event id at both ends.
//! - **One cycle at a time.** Several triggers overlap by design; joining the
//!   cycle already running is the host's to do, because only the host knows
//!   what "already running" means on its threads.

#![forbid(unsafe_code)]

use std::future::Future;

use serde::Serialize;
use serde_json::{json, Value};
use ts_rs::TS;

use sapling_domain::events::RawEvent;

pub mod phrase;
pub mod relay;

pub use phrase::{BAD_PHRASE, PHRASE_LENGTH};

/// Events per push request.
pub const PUSH_PAGE: usize = 500;
/// Events asked for per pull request; the relay caps it at the same.
pub const PULL_PAGE: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

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
        push(&relay, store, &mut pushed).await?;
        pull(&relay, store, &mut pulled).await
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
        let body = json!({ "events": events }).to_string();
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
