//! An in-memory relay, speaking `worker/`'s wire protocol, for tests of the
//! cycle — here, and for any host that wants to prove its [`SyncStore`] end to
//! end without a network (`sapling-store`'s two-device test does).
//!
//! Faithful where the cycle could notice: a room per normalised phrase and 401
//! for anything else, `INSERT OR IGNORE` by id with the existing `seq` answered
//! for a re-push, and pulls clamped to [`PULL_PAGE`] and answering `latest`.
//!
//! [`SyncStore`]: crate::SyncStore

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::{ready, Future};

use serde_json::{json, Map, Value};

use crate::{phrase, Method, Request, Response, Transport, PULL_PAGE};

#[derive(Default)]
pub struct MemoryRelay {
    rooms: RefCell<HashMap<String, Vec<Value>>>,
}

impl MemoryRelay {
    /// The room `phrase` names, as the relay holds it: rows with their `seq`.
    pub fn log(&self, phrase: &str) -> Vec<Value> {
        self.rooms
            .borrow()
            .get(&phrase::normalize(phrase))
            .cloned()
            .unwrap_or_default()
    }

    fn answer(&self, request: Request) -> Response {
        let bearer = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .and_then(|(_, value)| value.strip_prefix("Bearer "))
            .map(phrase::normalize)
            .filter(|phrase| phrase::is_valid(phrase));
        let Some(room) = bearer else {
            return Response {
                status: 401,
                body: "Unauthorized\n".to_owned(),
            };
        };
        let mut rooms = self.rooms.borrow_mut();
        let log = rooms.entry(room).or_default();
        let path = request
            .url
            .split_once("://")
            .map_or(&*request.url, |(_, rest)| {
                rest.find('/').map_or("", |at| &rest[at..])
            });
        let (route, query) = path.split_once('?').unwrap_or((path, ""));
        let body = match (request.method, route) {
            (Method::Post, "/push") => {
                let Some(events) = request
                    .body
                    .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                    .and_then(|body| body.get("events").cloned())
                    .and_then(|events| events.as_array().cloned())
                else {
                    return Response {
                        status: 400,
                        body: "Bad request\n".to_owned(),
                    };
                };
                let mut seqs = Map::new();
                for event in events {
                    let id = event["id"].as_str().unwrap_or_default().to_owned();
                    let seq = match log.iter().find(|row| row["id"] == event["id"]) {
                        Some(row) => row["seq"].clone(),
                        None => {
                            let mut row = event;
                            row["seq"] = json!(log.len() + 1);
                            log.push(row);
                            json!(log.len())
                        }
                    };
                    seqs.insert(id, seq);
                }
                json!({ "seqs": seqs })
            }
            (Method::Get, "/pull") => {
                let param = |name: &str, fallback: usize| {
                    query
                        .split('&')
                        .filter_map(|pair| pair.split_once('='))
                        .find(|(key, _)| *key == name)
                        .and_then(|(_, value)| value.parse::<usize>().ok())
                        .unwrap_or(fallback)
                };
                let (after, limit) = (param("after", 0), param("limit", PULL_PAGE).min(PULL_PAGE));
                let events: Vec<Value> = log.iter().skip(after).take(limit).cloned().collect();
                json!({ "events": events, "latest": log.len() })
            }
            _ => {
                return Response {
                    status: 404,
                    body: "Not found\n".to_owned(),
                }
            }
        };
        Response {
            status: 200,
            body: body.to_string(),
        }
    }
}

impl Transport for MemoryRelay {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>> {
        ready(Ok(self.answer(request)))
    }
}
