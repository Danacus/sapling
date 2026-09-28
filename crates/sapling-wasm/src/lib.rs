//! `sapling-db` for a JavaScript host.
//!
//! The database stays on the JavaScript side — sqlite-wasm's synchronous `oo1`
//! API, inside the Worker — and comes across as two callbacks, `exec` and
//! `query`, that speak JSON strings. The core's three other runtime facts
//! arrive the same way: `localDay` (the host's calendar, which is the only
//! place a time zone exists), `now` and `newId`. Nothing here parses an
//! argument or formats an answer; `sapling-protocol` does both, so the
//! Worker forwards `(method, argsJson)` verbatim and posts the string back.
//!
//! Errors cross as strings: a `Result::Err` from the core becomes a thrown
//! JavaScript string, and a JavaScript exception from a callback becomes a
//! core `Error` carrying its message.
//!
//! [`llm`] is separate and needs no database: the window thread calls it with
//! its own `fetch` as the transport.

use std::future::Future;

use js_sys::Function;
use sapling_db::{Core, Error, Param, Result, Row, Sql, SqlValue};
use sapling_domain::types::KnowledgeItem;
use sapling_domain::LocalDay;
use sapling_llm::tools::{StoreError, StoreResult, ToolContext};
use sapling_llm::{Endpoint, HttpRequest, HttpResponse, Llm, Transport};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

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
    Value::Array(values).to_string()
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
        sapling_protocol::dispatch_json(&self.core, method, args_json).map_err(to_js)
    }

    /// Appends local facts, `[{ type, payload }, ...]`, in one transaction.
    /// What the node test rig seeds a store with; the app has no use for it.
    #[wasm_bindgen(js_name = commitAll)]
    pub fn commit_all(&self, facts_json: &str) -> std::result::Result<(), JsValue> {
        sapling_protocol::commit_facts_json(&self.core, facts_json).map_err(to_js)
    }

    /// The read-table shape this build expects — the version `meta` records.
    #[wasm_bindgen(js_name = derivedSchemaVersion)]
    pub fn derived_schema_version() -> u32 {
        sapling_db::schema::DERIVED_SCHEMA_VERSION
    }
}

/// `post(url, headersJson, body) -> Promise<string>`, resolving to `{status, body}` as JSON.
struct JsTransport(Function);

impl Transport for JsTransport {
    fn post(
        &self,
        request: HttpRequest,
    ) -> impl Future<Output = std::result::Result<HttpResponse, String>> {
        let headers: Map<String, Value> = request
            .headers
            .into_iter()
            .map(|(name, value)| (name, Value::String(value)))
            .collect();
        let promise = self.0.call3(
            &JsValue::NULL,
            &JsValue::from_str(&request.url),
            &JsValue::from_str(&Value::Object(headers).to_string()),
            &JsValue::from_str(&request.body),
        );
        async move {
            let promise: js_sys::Promise = promise.map_err(|e| from_js(e).0)?.into();
            let answer = JsFuture::from(promise).await.map_err(|e| from_js(e).0)?;
            let answer: Value = answer
                .as_string()
                .and_then(|text| serde_json::from_str(&text).ok())
                .ok_or("post() did not resolve to {status, body}")?;
            Ok(HttpResponse {
                status: answer["status"].as_u64().unwrap_or(0) as u16,
                body: answer["body"].as_str().unwrap_or_default().to_owned(),
            })
        }
    }
}

#[wasm_bindgen(typescript_custom_section)]
const TOOL_HOST: &str = r#"
/** The word list a tool-calling `llm` call reads and writes, items as JSON. */
export interface ToolHost {
  getAllItems(): Promise<string>;
  upsertItems(itemsJson: string): Promise<void>;
  deleteItem(id: string): Promise<void>;
  newId(): string;
  now(): number;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "ToolHost")]
    pub type ToolHost;

    #[wasm_bindgen(method, catch, js_name = getAllItems)]
    fn js_get_all_items(this: &ToolHost) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, catch, js_name = upsertItems)]
    fn js_upsert_items(
        this: &ToolHost,
        items_json: &str,
    ) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, catch, js_name = deleteItem)]
    fn js_delete_item(this: &ToolHost, id: &str) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, js_name = newId)]
    fn js_new_id(this: &ToolHost) -> String;

    #[wasm_bindgen(method, js_name = now)]
    fn js_now(this: &ToolHost) -> f64;
}

async fn settled(promise: std::result::Result<js_sys::Promise, JsValue>) -> StoreResult<JsValue> {
    let promise = promise.map_err(|e| StoreError(from_js(e).0))?;
    JsFuture::from(promise)
        .await
        .map_err(|e| StoreError(from_js(e).0))
}

impl ToolContext for ToolHost {
    fn all_items(&self) -> impl Future<Output = StoreResult<Vec<KnowledgeItem>>> {
        let promise = self.js_get_all_items();
        async move {
            let json = settled(promise)
                .await?
                .as_string()
                .ok_or_else(|| StoreError("getAllItems() did not resolve to a string".into()))?;
            serde_json::from_str(&json).map_err(|e| StoreError(format!("getAllItems(): {e}")))
        }
    }

    fn upsert_items(&self, items: Vec<KnowledgeItem>) -> impl Future<Output = StoreResult<()>> {
        let json = serde_json::to_string(&items).expect("items serialize");
        let promise = self.js_upsert_items(&json);
        async move { settled(promise).await.map(|_| ()) }
    }

    fn delete_item(&self, id: &str) -> impl Future<Output = StoreResult<()>> {
        let promise = self.js_delete_item(id);
        async move { settled(promise).await.map(|_| ()) }
    }

    fn new_id(&self) -> String {
        self.js_new_id()
    }

    fn now(&self) -> f64 {
        self.js_now()
    }
}

/// One model call: the method, its argument array and the endpoint as JSON
/// (no endpoint is mock mode), the host's `post`, optionally
/// `progress(stepJson)`, and for the tool-calling methods the word list.
/// Resolves to `{result, usage?}` as JSON; rejects with the `LlmError` as
/// JSON, or plain text for a malformed call or a failing store.
#[wasm_bindgen]
pub async fn llm(
    method: String,
    args_json: String,
    endpoint_json: Option<String>,
    post: Function,
    progress: Option<Function>,
    tools: Option<ToolHost>,
) -> std::result::Result<String, JsValue> {
    let endpoint: Option<Endpoint> = endpoint_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|e| JsValue::from_str(&format!("endpoint: {e}")))?;
    let mut llm = Llm::new(JsTransport(post), endpoint);
    if let Some(progress) = progress {
        // A throwing callback costs its step, never the call.
        llm = llm.with_progress(move |step| {
            let step = serde_json::to_string(step).unwrap_or_default();
            let _ = progress.call1(&JsValue::NULL, &JsValue::from_str(&step));
        });
    }
    sapling_protocol::dispatch_llm_json(&llm, tools.as_ref(), &method, &args_json)
        .await
        .map_err(|e| JsValue::from_str(&e))
}
