//! `sapling-core` for a JavaScript host.
//!
//! The database stays on the JavaScript side — sqlite-wasm's synchronous `oo1`
//! API, inside the Worker — and comes across as two callbacks, `exec` and
//! `query`, that speak JSON strings. The core's three other runtime facts
//! arrive the same way: `localDay` (the host's calendar, which is the only
//! place a time zone exists), `now` and `newId`. Nothing here parses an
//! argument or formats an answer; `sapling_core::dispatch` does both, so the
//! Worker forwards `(method, argsJson)` verbatim and posts the string back.
//!
//! Errors cross as strings: a `Result::Err` from the core becomes a thrown
//! JavaScript string, and a JavaScript exception from a callback becomes a
//! core `Error` carrying its message.

use js_sys::Function;
use sapling_core::{dispatch, js, Core, Error, LocalDay, Param, Result, Row, Sql, SqlValue};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

/// A JavaScript exception, as the message it carried.
fn from_js(error: JsValue) -> Error {
    if let Some(error) = error.dyn_ref::<js_sys::Error>() {
        return Error(String::from(error.message()));
    }
    Error(error.as_string().unwrap_or_else(|| format!("{error:?}")))
}

fn to_js(error: Error) -> JsValue {
    JsValue::from_str(&error.0)
}

fn params_json(params: &[Param]) -> String {
    let values = params
        .iter()
        .map(|param| match param {
            Param::Null => Value::Null,
            Param::Integer(i) => Value::from(*i),
            Param::Real(f) => serde_json::Number::from_f64(*f)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            Param::Text(s) => Value::String(s.clone()),
        })
        .collect();
    js::stringify(&Value::Array(values))
}

/// A cell as sqlite-wasm's `rowMode: 'object'` handed it to `JSON.stringify`.
///
/// SQLite has no booleans and the host never sends one; an integral number is
/// an `INTEGER` because that is what sqlite-wasm reads an integer column as.
fn cell(value: Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => SqlValue::Text(s),
        other => SqlValue::Text(other.to_string()),
    }
}

/// The `Sql` seam over two host callbacks: `exec(sql, paramsJson)` and
/// `query(sql, paramsJson) -> rowsJson`.
struct JsSql {
    exec: Function,
    query: Function,
}

impl Sql for JsSql {
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()> {
        self.exec
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(sql),
                &JsValue::from_str(&params_json(params)),
            )
            .map(|_| ())
            .map_err(from_js)
    }

    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        let answer = self
            .query
            .call2(
                &JsValue::NULL,
                &JsValue::from_str(sql),
                &JsValue::from_str(&params_json(params)),
            )
            .map_err(from_js)?;
        let text = answer
            .as_string()
            .ok_or_else(|| Error("query callback did not return a string".into()))?;
        let rows: Vec<Map<String, Value>> = serde_json::from_str(&text)?;
        Ok(rows
            .into_iter()
            .map(|row| {
                Row::new(
                    row.into_iter()
                        .map(|(name, value)| (name, cell(value)))
                        .collect(),
                )
            })
            .collect())
    }
}

/// The host's calendar: `localDay(at) -> 'YYYY-MM-DD'`.
struct JsDay(Function);

impl LocalDay for JsDay {
    fn local_day(&self, at: f64) -> String {
        self.0
            .call1(&JsValue::NULL, &JsValue::from_f64(at))
            .ok()
            .and_then(|day| day.as_string())
            .expect("localDay(at) returns a string")
    }
}

/// The core, as the Worker holds it.
#[wasm_bindgen]
pub struct WasmCore {
    core: Core,
}

#[wasm_bindgen]
impl WasmCore {
    /// Opens the core over the host's database: applies the schema, replaying
    /// the log if the read tables are stale, and is then ready to `dispatch`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        device_id: String,
        exec: Function,
        query: Function,
        local_day: Function,
        now: Function,
        new_id: Function,
    ) -> std::result::Result<WasmCore, JsValue> {
        let clock = move || {
            now.call0(&JsValue::NULL)
                .ok()
                .and_then(|value| value.as_f64())
                .expect("now() returns a number")
        };
        let ids = move || {
            new_id
                .call0(&JsValue::NULL)
                .ok()
                .and_then(|value| value.as_string())
                .expect("newId() returns a string")
        };
        let core = Core::open(
            Box::new(JsSql { exec, query }),
            device_id,
            clock,
            ids,
            JsDay(local_day),
        )
        .map_err(to_js)?;
        Ok(WasmCore { core })
    }

    /// One `Backend` call: the method name and its argument array as JSON;
    /// the answer as JSON, or `undefined` where the method answers nothing.
    pub fn dispatch(
        &self,
        method: &str,
        args_json: &str,
    ) -> std::result::Result<Option<String>, JsValue> {
        dispatch::dispatch_json(&self.core, method, args_json).map_err(to_js)
    }

    /// Appends local facts, `[{ type, payload }, ...]`, in one transaction.
    /// What the node test rig seeds a store with; the app has no use for it.
    #[wasm_bindgen(js_name = commitAll)]
    pub fn commit_all(&self, facts_json: &str) -> std::result::Result<(), JsValue> {
        dispatch::commit_facts_json(&self.core, facts_json).map_err(to_js)
    }

    /// The read-table shape this build expects — the version `meta` records.
    #[wasm_bindgen(js_name = derivedSchemaVersion)]
    pub fn derived_schema_version() -> u32 {
        sapling_core::schema::DERIVED_SCHEMA_VERSION
    }
}
