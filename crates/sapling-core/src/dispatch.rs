//! The `Backend` protocol, by name: one call in as `(method, args)`, one JSON
//! answer out.
//!
//! `src/lib/db/protocol.ts` fixes the method names and their argument lists;
//! this module is the other end of that wire. A host (the wasm build inside the
//! database Worker, a native shell, a server) parses nothing itself — it hands
//! the method name and the argument array here as JSON and gets JSON back, so
//! every transport shares one argument convention and one formatting of the
//! answer (`js::stringify`, so the text is what the TypeScript core printed).
//!
//! `None` is JavaScript's `undefined`: what a `void` method answers, and what a
//! read answers for a row that is not there. JSON has no `undefined`, so an
//! argument the caller left out arrives as `null` and is read as absent.
//!
//! [`METHODS`] must equal `BACKEND_METHODS` in `protocol.ts` — the test at the
//! bottom reads that file and checks — and every name in it must have an arm
//! in [`dispatch`], or a method added on one side silently fails on the other.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::core::Core;
use crate::events::{parse_payload, EventType, Payload};
use crate::js;
use crate::sql::{Error, Result};

/// Every `Backend` method, as `protocol.ts` names them.
pub const METHODS: [&str; 36] = [
    "getProfile",
    "saveProfile",
    "getAllItems",
    "getItem",
    "upsertItems",
    "deleteItem",
    "reviewItem",
    "addToPool",
    "getPool",
    "poolSize",
    "recordServe",
    "reportChallenge",
    "getChallengesByIds",
    "addResult",
    "recentResults",
    "getDailyActivity",
    "addText",
    "getTexts",
    "getText",
    "deleteText",
    "markWord",
    "getKnownTerms",
    "recordLookup",
    "addConversation",
    "addExchange",
    "getConversations",
    "getConversation",
    "deleteConversation",
    "resetData",
    "exportData",
    "importData",
    "pendingEvents",
    "markPushed",
    "applyRemote",
    "getPullCursor",
    "setPullCursor",
];

fn unknown_method(method: &str) -> Error {
    Error(format!("Unknown backend method {method}"))
}

/// The `i`th argument, `null` when the caller passed fewer.
fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn is_absent(value: &Value) -> bool {
    value.is_null()
}

/// A required argument, parsed as `T`.
fn required<T: DeserializeOwned>(method: &str, args: &[Value], i: usize) -> Result<T> {
    let value = arg(args, i);
    if is_absent(value) {
        return Err(Error(format!("{method}: argument {i} is missing")));
    }
    serde_json::from_value(value.clone()).map_err(|e| Error(format!("{method}: argument {i}: {e}")))
}

/// An optional argument: `None` when absent, otherwise parsed as `T`.
fn optional<T: DeserializeOwned>(method: &str, args: &[Value], i: usize) -> Result<Option<T>> {
    if is_absent(arg(args, i)) {
        Ok(None)
    } else {
        required(method, args, i).map(Some)
    }
}

/// A JavaScript `number` used where the TypeScript passes it straight to `LIMIT`.
fn as_limit(n: f64) -> i64 {
    n as i64
}

fn none() -> Result<Option<Value>> {
    Ok(None)
}

fn some<T: serde::Serialize>(value: T) -> Result<Option<Value>> {
    Ok(Some(serde_json::to_value(value)?))
}

/// `undefined` for `None`, the value otherwise — a read of a row that may not exist.
fn maybe<T: serde::Serialize>(value: Option<T>) -> Result<Option<Value>> {
    match value {
        Some(value) => some(value),
        None => none(),
    }
}

/// Runs one `Backend` method by name. `None` is `undefined`.
pub fn dispatch(core: &Core, method: &str, args: &[Value]) -> Result<Option<Value>> {
    match method {
        /* ---- Profile ------------------------------------------------- */
        "getProfile" => maybe(core.get_profile()?),
        "saveProfile" => {
            core.save_profile(&required(method, args, 0)?)?;
            none()
        }

        /* ---- Knowledge items ---------------------------------------- */
        "getAllItems" => {
            let with_recent_grades = arg(args, 0)
                .get("withRecentGrades")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            some(core.get_all_items(with_recent_grades)?)
        }
        "getItem" => maybe(core.get_item(&required::<String>(method, args, 0)?)?),
        "upsertItems" => {
            core.upsert_items(&required::<Vec<_>>(method, args, 0)?)?;
            none()
        }
        "deleteItem" => {
            core.delete_item(&required::<String>(method, args, 0)?)?;
            none()
        }
        "reviewItem" => {
            let id: String = required(method, args, 0)?;
            let entry = arg(args, 1);
            let (Some(at), Some(grade)) = (
                entry.get("at").and_then(Value::as_f64),
                entry.get("grade").and_then(Value::as_f64),
            ) else {
                return Err(Error(format!(
                    "{method}: argument 1 must be {{ at, grade }}"
                )));
            };
            let replace_last = arg(args, 2)
                .get("replaceLast")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            some(core.review_item(&id, at, grade, replace_last)?)
        }

        /* ---- Challenge pool ----------------------------------------- */
        "addToPool" => {
            let challenges: Vec<Value> = required(method, args, 0)?;
            let now: Option<f64> = optional(method, args, 1)?;
            let topic: Option<String> = optional(method, args, 2)?;
            core.add_to_pool(&challenges, now, topic.as_deref())?;
            none()
        }
        "getPool" => some(core.get_pool()?),
        "poolSize" => some(core.pool_size()?),
        "recordServe" => {
            let id: String = required(method, args, 0)?;
            core.record_serve(&id, optional(method, args, 1)?)?;
            none()
        }
        "reportChallenge" => {
            core.report_challenge(&required::<String>(method, args, 0)?)?;
            none()
        }
        "getChallengesByIds" => {
            some(core.get_challenges_by_ids(&required::<Vec<String>>(method, args, 0)?)?)
        }

        /* ---- Results ------------------------------------------------ */
        "addResult" => {
            core.add_result(&required(method, args, 0)?)?;
            none()
        }
        "recentResults" => some(core.recent_results(as_limit(required(method, args, 0)?))?),
        "getDailyActivity" => some(core.get_daily_activity()?),

        /* ---- Reading texts, word marks and lookups ------------------ */
        "addText" => {
            core.add_text(&required(method, args, 0)?)?;
            none()
        }
        "getTexts" => some(core.get_texts()?),
        "getText" => maybe(core.get_text(&required::<String>(method, args, 0)?)?),
        "deleteText" => {
            core.delete_text(&required::<String>(method, args, 0)?)?;
            none()
        }
        "markWord" => {
            let term: String = required(method, args, 0)?;
            core.mark_word(&term, required(method, args, 1)?)?;
            none()
        }
        "getKnownTerms" => some(core.get_known_terms()?),
        "recordLookup" => {
            let term: String = required(method, args, 0)?;
            let text_id: String = required(method, args, 1)?;
            let item_id: Option<String> = optional(method, args, 2)?;
            core.record_lookup(&term, &text_id, item_id.as_deref())?;
            none()
        }

        /* ---- Conversations ------------------------------------------ */
        "addConversation" => {
            core.add_conversation(&required(method, args, 0)?)?;
            none()
        }
        "addExchange" => {
            core.add_exchange(&required(method, args, 0)?)?;
            none()
        }
        "getConversations" => some(core.get_conversations()?),
        "getConversation" => maybe(core.get_conversation(&required::<String>(method, args, 0)?)?),
        "deleteConversation" => {
            core.delete_conversation(&required::<String>(method, args, 0)?)?;
            none()
        }

        /* ---- Export / import ---------------------------------------- */
        "resetData" => {
            core.reset_data()?;
            none()
        }
        "exportData" => some(core.export_data()?),
        "importData" => {
            core.import_data(&required::<String>(method, args, 0)?)?;
            none()
        }

        /* ---- Sync --------------------------------------------------- */
        "pendingEvents" => some(core.pending_events(as_limit(required(method, args, 0)?))?),
        "markPushed" => {
            let seqs: Map<String, Value> = required(method, args, 0)?;
            let mut pairs = Vec::with_capacity(seqs.len());
            for (id, seq) in seqs {
                let Some(seq) = seq.as_f64() else {
                    return Err(Error(format!("{method}: seq for {id} is not a number")));
                };
                pairs.push((id, seq));
            }
            some(core.mark_pushed(&pairs)?)
        }
        "applyRemote" => some(core.apply_remote(&required::<Vec<Value>>(method, args, 0)?)?),
        "getPullCursor" => some(core.get_pull_cursor()?),
        "setPullCursor" => {
            core.set_pull_cursor(required(method, args, 0)?)?;
            none()
        }

        _ => Err(unknown_method(method)),
    }
}

/// [`dispatch`] over the wire: `args_json` is the argument array, the answer
/// is `JSON.stringify` of the result, or `None` for `undefined`.
pub fn dispatch_json(core: &Core, method: &str, args_json: &str) -> Result<Option<String>> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| Error(format!("{method}: arguments are not a JSON array: {e}")))?;
    Ok(dispatch(core, method, &args)?.as_ref().map(js::stringify))
}

/// Appends local facts from their wire shape — `[{ type, payload }, ...]`, the
/// TypeScript `Fact[]` — in one transaction. What a test rig seeds a store with.
pub fn commit_facts_json(core: &Core, facts_json: &str) -> Result<()> {
    let raw: Vec<Value> = serde_json::from_str(facts_json)
        .map_err(|e| Error(format!("facts are not a JSON array: {e}")))?;
    let mut facts = Vec::with_capacity(raw.len());
    for fact in &raw {
        let type_name = fact
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("fact has no `type`".into()))?;
        let kind = EventType::from_name(type_name)
            .ok_or_else(|| Error(format!("unknown event type {type_name}")))?;
        let payload = fact.get("payload").unwrap_or(&Value::Null);
        let parsed: Payload = parse_payload(kind, payload)
            .ok_or_else(|| Error(format!("payload for {type_name} will not parse")))?;
        facts.push(parsed);
    }
    core.commit_all(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::day::Utc;
    use crate::sql::{Param, Row, Sql};
    use std::collections::BTreeSet;

    /// A database that answers nothing: enough to tell "unknown method" from
    /// "known method, wrong arguments".
    struct Silent;

    impl Sql for Silent {
        fn exec(&self, _sql: &str, _params: &[Param]) -> Result<()> {
            Ok(())
        }

        fn query(&self, _sql: &str, _params: &[Param]) -> Result<Vec<Row>> {
            Ok(Vec::new())
        }
    }

    fn silent_core() -> Core {
        Core::new(Box::new(Silent), "dev", || 0.0, || "id".to_owned(), Utc)
    }

    /// `BACKEND_METHODS` as `protocol.ts` writes it: the quoted names between
    /// the array's brackets.
    fn protocol_methods() -> BTreeSet<String> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/lib/db/protocol.ts");
        let source = std::fs::read_to_string(path).expect("protocol.ts is readable");
        let start = source
            .find("export const BACKEND_METHODS = [")
            .expect("protocol.ts declares BACKEND_METHODS");
        let body = &source[start..];
        let end = body.find(']').expect("the array closes");
        body[..end]
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn methods_match_protocol_ts() {
        let ours: BTreeSet<String> = METHODS.iter().map(|m| (*m).to_owned()).collect();
        assert_eq!(ours, protocol_methods());
        assert_eq!(ours.len(), METHODS.len(), "METHODS lists a name twice");
    }

    #[test]
    fn every_method_has_an_arm() {
        let core = silent_core();
        for method in METHODS {
            match dispatch(&core, method, &[]) {
                Err(Error(message)) if message.starts_with("Unknown backend method") => {
                    panic!("{method} is listed but not dispatched")
                }
                _ => {}
            }
        }
        assert!(matches!(
            dispatch(&core, "notAMethod", &[]),
            Err(Error(message)) if message == "Unknown backend method notAMethod"
        ));
    }

    #[test]
    fn a_void_method_answers_undefined_and_a_read_answers_json() {
        let core = silent_core();
        assert_eq!(dispatch_json(&core, "resetData", "[]").unwrap(), None);
        assert_eq!(
            dispatch_json(&core, "getKnownTerms", "[]").unwrap(),
            Some("[]".to_owned())
        );
        assert_eq!(dispatch_json(&core, "getProfile", "[]").unwrap(), None);
        assert_eq!(
            dispatch_json(&core, "poolSize", "[]").unwrap(),
            Some("0".to_owned())
        );
    }

    #[test]
    fn a_missing_required_argument_is_an_error_not_a_panic() {
        let core = silent_core();
        assert!(dispatch_json(&core, "getItem", "[]").is_err());
        assert!(dispatch_json(&core, "getItem", "[null]").is_err());
        assert!(dispatch_json(&core, "markWord", "[\"木\"]").is_err());
    }

    #[test]
    fn facts_parse_by_type() {
        let core = silent_core();
        assert!(commit_facts_json(
            &core,
            r#"[{"type":"itemDeleted","payload":{"itemId":"i1"}}]"#
        )
        .is_ok());
        assert!(commit_facts_json(&core, r#"[{"type":"xpBanked","payload":{}}]"#).is_err());
        assert!(
            commit_facts_json(&core, r#"[{"type":"itemAdded","payload":{"id":"i1"}}]"#).is_err()
        );
    }
}
