//! An in-memory relay, speaking `worker/`'s wire protocol, for tests of the
//! cycle — here, and for any host that wants to prove its [`SyncStore`] end to
//! end without a network (`sapling-store`'s two-device test does).
//!
//! Faithful where the cycle could notice: a room per normalised phrase and 401
//! for anything else, `INSERT OR IGNORE` by id with the existing `seq` answered
//! for a re-push, and pulls clamped to [`PULL_PAGE`] and answering `latest`.
//! Content objects too (`docs/content-objects.md` §5): `POST /objects/missing`,
//! `PUT` verified against the name (400 on a mismatch, 413 over the cap) and
//! `GET` (404 when absent); a pushed row's `owner`/`objects`/`retire` are
//! recorded as sets beside the log and stripped from the row, so a pull never
//! returns them. [`MemoryRelay::without_objects`] is a relay from before all
//! that, answering 404 on every object route.
//!
//! [`SyncStore`]: crate::SyncStore

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::future::{ready, Future};

use serde_json::{json, Map, Value};

use sapling_domain::objects::{is_object_hash, object_hash, MAX_OBJECT_BYTES};

use crate::{phrase, Method, Request, Response, Transport, PULL_PAGE};

#[derive(Default)]
struct Room {
    log: Vec<Value>,
    objects: HashMap<String, String>,
    edges: BTreeSet<(String, String)>,
    retired: BTreeSet<String>,
}

#[derive(Default)]
pub struct MemoryRelay {
    rooms: RefCell<HashMap<String, Room>>,
    /// An older deployment: no object endpoints at all.
    legacy: bool,
}

fn status(status: u16, body: &str) -> Response {
    Response {
        status,
        body: body.to_owned(),
    }
}

impl MemoryRelay {
    /// A relay that predates content objects.
    pub fn without_objects() -> Self {
        MemoryRelay {
            legacy: true,
            ..MemoryRelay::default()
        }
    }

    fn room<T>(&self, phrase: &str, read: impl FnOnce(&Room) -> T) -> T {
        read(
            self.rooms
                .borrow()
                .get(&phrase::normalize(phrase))
                .unwrap_or(&Room::default()),
        )
    }

    /// The room `phrase` names, as the relay holds it: rows with their `seq`.
    pub fn log(&self, phrase: &str) -> Vec<Value> {
        self.room(phrase, |room| room.log.clone())
    }

    /// The objects the room holds, by hash.
    pub fn objects(&self, phrase: &str) -> HashMap<String, String> {
        self.room(phrase, |room| room.objects.clone())
    }

    /// The `(owner, hash)` edges pushes have declared.
    pub fn edges(&self, phrase: &str) -> Vec<(String, String)> {
        self.room(phrase, |room| room.edges.iter().cloned().collect())
    }

    /// The owners pushes have retired.
    pub fn retired(&self, phrase: &str) -> Vec<String> {
        self.room(phrase, |room| room.retired.iter().cloned().collect())
    }

    /// Puts an object in a room directly, the way another device's upload would.
    pub fn hold(&self, phrase: &str, bytes: &str) -> String {
        let hash = object_hash(bytes.as_bytes());
        self.rooms
            .borrow_mut()
            .entry(phrase::normalize(phrase))
            .or_default()
            .objects
            .insert(hash.clone(), bytes.to_owned());
        hash
    }

    fn answer(&self, request: Request) -> Response {
        let bearer = request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .and_then(|(_, value)| value.strip_prefix("Bearer "))
            .map(phrase::normalize)
            .filter(|phrase| phrase::is_valid(phrase));
        let Some(name) = bearer else {
            return status(401, "Unauthorized\n");
        };
        let mut rooms = self.rooms.borrow_mut();
        let room = rooms.entry(name).or_default();
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
                    return status(400, "Bad request\n");
                };
                let mut seqs = Map::new();
                for mut event in events {
                    let id = event["id"].as_str().unwrap_or_default().to_owned();
                    // Recorded beside the row, never on it.
                    if let Some(fields) = event.as_object_mut() {
                        let owner = fields.remove("owner");
                        let objects = fields.remove("objects");
                        let retire = fields.remove("retire");
                        if let Some(owner) = owner.as_ref().and_then(Value::as_str) {
                            for hash in objects.iter().flat_map(|o| o.as_array()).flatten() {
                                if let Some(hash) = hash.as_str() {
                                    room.edges.insert((owner.to_owned(), hash.to_owned()));
                                }
                            }
                        }
                        if let Some(retire) = retire.as_ref().and_then(Value::as_str) {
                            room.retired.insert(retire.to_owned());
                        }
                    }
                    let log = &mut room.log;
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
                let events: Vec<Value> = room.log.iter().skip(after).take(limit).cloned().collect();
                json!({ "events": events, "latest": room.log.len() })
            }
            _ if self.legacy => return status(404, "Not found\n"),
            (Method::Post, "/objects/missing") => {
                let Some(hashes) = request
                    .body
                    .and_then(|body| serde_json::from_str::<Value>(&body).ok())
                    .and_then(|body| body.get("hashes").cloned())
                    .and_then(|hashes| hashes.as_array().cloned())
                    .filter(|hashes| {
                        hashes.len() <= 500
                            && hashes
                                .iter()
                                .all(|h| h.as_str().is_some_and(is_object_hash))
                    })
                else {
                    return status(400, "Bad request\n");
                };
                let missing: Vec<&Value> = hashes
                    .iter()
                    .filter(|hash| !room.objects.contains_key(hash.as_str().unwrap_or("")))
                    .collect::<Vec<_>>();
                json!({ "missing": missing })
            }
            (method, route) if route.starts_with("/objects/") => {
                let hash = &route["/objects/".len()..];
                if !is_object_hash(hash) {
                    return status(400, "Bad request\n");
                }
                match method {
                    Method::Put => {
                        let bytes = request.body.unwrap_or_default();
                        if bytes.len() > MAX_OBJECT_BYTES {
                            return status(413, "Payload too large\n");
                        }
                        if object_hash(bytes.as_bytes()) != hash {
                            return status(400, "Bad request\n");
                        }
                        room.objects.entry(hash.to_owned()).or_insert(bytes);
                        return status(204, "");
                    }
                    Method::Get => match room.objects.get(hash) {
                        Some(bytes) => return status(200, bytes),
                        None => return status(404, "Not found\n"),
                    },
                    Method::Post => return status(404, "Not found\n"),
                }
            }
            _ => return status(404, "Not found\n"),
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
