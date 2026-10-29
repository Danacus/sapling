//! Sapling's Taal client: sends the learner's study time to their Taal
//! challenge (a friends' leaderboard of minutes studied), the way sync sends
//! the log to the relay — an optional, external service the app never waits on.
//!
//! Taal's contract is its `sendToTaal()` (`connect/README.md` on Taal's site):
//! one Firestore REST `:commit` with two writes — the code's secret into
//! `appInbox/{linkId}` and the sessions into `appSources/{linkId}` as one map
//! field each — both stamped with the server's time. Taal's security rules
//! accept exactly that shape, so [`commit_request`] reproduces it field for
//! field rather than re-deriving it. We do not use Taal's tracker: the core
//! already folds study time per mode and local hour (`studySessions`), and
//! what is sent here is that read, mapped.
//!
//! Host-agnostic like `sapling-sync`. The HTTP request is a [`Transport`] and
//! the study-time read a [`TaalStore`], both injected; the code, the profile,
//! the clock and the watermark are arguments, so the crate reads no
//! configuration and keeps no state. Three properties are load-bearing:
//!
//! - **It never fails.** Every failure comes back as a [`TaalOutcome`].
//! - **Resending is free.** A session id is stable and its numbers are totals,
//!   so Taal replaces rather than adds; a push therefore re-sends a margin
//!   behind the watermark ([`RESEND_MS`]) to pick up hours still running and
//!   events that reached this device late through sync, and the watermark only
//!   moves once every batch landed.
//! - **A refusal is not a latch.** Firestore answers 403 for any rule
//!   rejection, a mistyped code and a removed app alike; the host shows it and
//!   the next trigger simply tries again.

#![forbid(unsafe_code)]

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use ts_rs::TS;

use sapling_domain::types::{StudyMode, StudySession};

/// Taal's Firebase project.
pub const PROJECT: &str = "language-81ef3";
/// Taal's public web key — the one its own web page ships, public on purpose.
pub const WEB_KEY: &str = "AIzaSyDKFxjk7_QxTJX0vg57PfXqLP7gAK-2Clo";
/// Sessions per commit; Taal's rules allow no more.
pub const MAX_SESSIONS: usize = 100;
/// How far back a first push reaches: Taal clears anything older.
pub const BACKFILL_MS: f64 = 120.0 * 24.0 * 3_600_000.0;
/// How far behind the watermark every push starts again: hours still in
/// progress at the last push, and another device's events that arrived since.
pub const RESEND_MS: f64 = 48.0 * 3_600_000.0;

/// Taal cards per practice answer. Taal counts flashcards as cards and turns
/// five of them into one review minute, so this is how much one answered
/// challenge weighs on the leaderboard: at `1.0` five answers are a minute.
/// Fractions are fine — Taal accepts any number — so it can be tuned freely;
/// a changed value reaches Taal on the next push for every hour inside the
/// re-send window, and older hours keep the value they were sent with.
pub const CARDS_PER_ANSWER: f64 = 1.0;

/// The text a code that does not look like one answers.
pub const BAD_CODE: &str = "This is not a Taal code.";

const DOCS: &str = "projects/language-81ef3/databases/(default)/documents";

/// One HTTP POST. `Err` is a failure to get any response at all.
pub struct Request {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Sends a [`Request`] as a POST.
pub trait Transport {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>>;
}

/// What a push needs of the database: the core's `studySessions` read, for
/// the active profile. `Err` is the store's message.
pub trait TaalStore {
    fn study_sessions(&self, since: f64)
        -> impl Future<Output = Result<Vec<StudySession>, String>>;
}

/// A connect code, split. Taal shows it as `{linkId}.{secret}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub link_id: String,
    pub secret: String,
}

/// `^[A-Za-z0-9]{20}\.[A-Za-z0-9]{32}$` after trimming, split at the dot.
pub fn parse_code(raw: &str) -> Option<Code> {
    let (link_id, secret) = raw.trim().split_once('.')?;
    let alnum = |part: &str, len: usize| {
        part.len() == len && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    };
    (alnum(link_id, 20) && alnum(secret, 32)).then(|| Code {
        link_id: link_id.to_owned(),
        secret: secret.to_owned(),
    })
}

pub fn is_code(raw: &str) -> bool {
    parse_code(raw).is_some()
}

/// One session as Taal takes it: minutes per mode and cards, totals.
#[derive(Debug, Clone, PartialEq)]
pub struct TaalSession {
    pub id: String,
    /// When it started, epoch ms.
    pub at: f64,
    pub input: f64,
    pub output: f64,
    pub cards: f64,
}

/// Maps one of the core's sessions onto Taal's modes. Reading and following a
/// recording are `input`, a conversation `output`, and practice is cards —
/// never `study` or `review` minutes, which would count it twice. The id is
/// prefixed with `profile`: the core's ids are per profile, and two
/// languages studied in the same hour must stay two sessions at Taal.
pub fn to_taal(profile: &str, session: &StudySession) -> TaalSession {
    let (mut input, mut output, mut cards) = (0.0, 0.0, 0.0);
    match session.mode {
        StudyMode::Input => input = session.minutes,
        StudyMode::Output => output = session.minutes,
        StudyMode::Practice => cards = session.answers * CARDS_PER_ANSWER,
    }
    TaalSession {
        id: format!("{profile}-{}", session.id),
        at: session.at.round(),
        input,
        output,
        cards,
    }
}

/// A number as Firestore's REST API types it — `Number.isInteger` decides, as
/// in Taal's own client: whole numbers are an `integerValue` written as a
/// string, everything else a `doubleValue`.
fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!({ "integerValue": (value as i64).to_string() })
    } else {
        json!({ "doubleValue": value })
    }
}

/// A map key as a Firestore field path segment: backticks, with `\` and `` ` ``
/// escaped.
fn quote(id: &str) -> String {
    let mut out = String::with_capacity(id.len() + 2);
    out.push('`');
    for ch in id.chars() {
        if ch == '\\' || ch == '`' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('`');
    out
}

/// The `:commit` request for up to [`MAX_SESSIONS`] sessions — `sendToTaal()`'s
/// request, field for field.
pub fn commit_request(code: &Code, sessions: &[TaalSession]) -> Request {
    let mut fields = Map::new();
    for session in sessions {
        let mut values = Map::new();
        values.insert("at".to_owned(), number(session.at));
        for (name, value) in [
            ("input", session.input),
            ("output", session.output),
            ("cards", session.cards),
        ] {
            if value > 0.0 {
                values.insert(name.to_owned(), number(value));
            }
        }
        fields.insert(
            session.id.clone(),
            json!({ "mapValue": { "fields": values } }),
        );
    }
    let stamp = json!({ "fieldPath": "updatedAt", "setToServerValue": "REQUEST_TIME" });
    let paths: Vec<String> = sessions
        .iter()
        .map(|session| format!("sessions.{}", quote(&session.id)))
        .collect();
    let body = json!({
        "writes": [
            {
                "update": {
                    "name": format!("{DOCS}/appInbox/{}", code.link_id),
                    "fields": { "code": { "stringValue": code.secret } },
                },
                "updateTransforms": [stamp],
            },
            {
                "update": {
                    "name": format!("{DOCS}/appSources/{}", code.link_id),
                    "fields": { "sessions": { "mapValue": { "fields": fields } } },
                },
                "updateMask": { "fieldPaths": paths },
                "updateTransforms": [stamp],
            },
        ],
    });
    Request {
        url: format!("https://firestore.googleapis.com/v1/{DOCS}:commit?key={WEB_KEY}"),
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: body.to_string(),
    }
}

/// Where a push starts reading: the re-send margin behind the watermark, but
/// never further back than Taal keeps anything.
pub fn since(now: f64, pushed_through: Option<f64>) -> f64 {
    let floor = now - BACKFILL_MS;
    pushed_through.map_or(floor, |through| floor.max(through - RESEND_MS))
}

/// One push: the code, whose sessions, and how far the last one got.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaalPushArgs {
    pub code: String,
    /// The active profile's id: the prefix that keeps profiles apart at Taal.
    pub profile: String,
    /// The host's clock, epoch ms.
    pub now: f64,
    /// The `now` of the last push that landed whole, for this code and profile.
    #[serde(default)]
    #[ts(optional)]
    pub pushed_through: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum TaalStatus {
    /// Every batch landed.
    Ok,
    /// Taal answered 403: the code is mistyped, or the app was removed in Taal.
    Refused,
    /// No answer, another status, or the store failed; try again later.
    Failed,
    /// The stored code does not look like a code; nothing was asked.
    Invalid,
}

/// What one push did.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaalOutcome {
    pub status: TaalStatus,
    /// Sessions Taal accepted, in whole batches.
    pub sent: usize,
    /// The watermark to keep — the push's `now` — present only when `ok`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pushed_through: Option<f64>,
    /// One learner-facing line.
    pub message: String,
}

impl TaalOutcome {
    fn stopped(status: TaalStatus, sent: usize, message: impl Into<String>) -> Self {
        TaalOutcome {
            status,
            sent,
            pushed_through: None,
            message: message.into(),
        }
    }
}

/// The refusal, worded for Settings.
pub const REFUSED: &str = "Taal refused the code — copy it again.";

/// Sends every session from [`since`] to Taal, oldest first, in batches of
/// [`MAX_SESSIONS`]. Never fails; see the crate docs.
pub async fn push<T: Transport, S: TaalStore>(
    transport: &T,
    store: &S,
    args: &TaalPushArgs,
) -> TaalOutcome {
    let Some(code) = parse_code(&args.code) else {
        return TaalOutcome::stopped(TaalStatus::Invalid, 0, BAD_CODE);
    };
    let sessions = match store
        .study_sessions(since(args.now, args.pushed_through))
        .await
    {
        Ok(sessions) => sessions,
        Err(message) => {
            let message = if message.is_empty() {
                "Could not read the study time.".to_owned()
            } else {
                message
            };
            return TaalOutcome::stopped(TaalStatus::Failed, 0, message);
        }
    };
    let sessions: Vec<TaalSession> = sessions
        .iter()
        .map(|session| to_taal(&args.profile, session))
        .collect();
    let mut sent = 0;
    for batch in sessions.chunks(MAX_SESSIONS) {
        let response = match transport.send(commit_request(&code, batch)).await {
            Ok(response) => response,
            Err(_) => {
                return TaalOutcome::stopped(TaalStatus::Failed, sent, "Could not reach Taal.")
            }
        };
        match response.status {
            200..=299 => sent += batch.len(),
            403 => return TaalOutcome::stopped(TaalStatus::Refused, sent, REFUSED),
            status => {
                return TaalOutcome::stopped(
                    TaalStatus::Failed,
                    sent,
                    format!("Taal could not save the study time ({status})."),
                )
            }
        }
    }
    let message = match sent {
        0 => "Nothing new to send.".to_owned(),
        1 => "Sent 1 session.".to_owned(),
        n => format!("Sent {n} sessions."),
    };
    TaalOutcome {
        status: TaalStatus::Ok,
        sent,
        pushed_through: Some(args.now),
        message,
    }
}

#[cfg(test)]
mod tests;
