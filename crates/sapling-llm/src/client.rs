use std::cell::Cell;
use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const APP_REFERER: &str = "https://github.com/daanvo/language-learning";
const APP_TITLE: &str = "Language Learning";

/// Why a call failed, in terms the UI can act on. `message` is UI-ready.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct LlmError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    NoKey,
    Auth,
    RateLimit,
    Server,
    Network,
    BadResponse,
}

impl LlmError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        LlmError {
            kind,
            message: message.into(),
            status: None,
        }
    }

    /// The kind's stock sentence, with `detail` in parentheses when there is one.
    fn stock(kind: ErrorKind, detail: Option<&str>, status: Option<u16>) -> Self {
        let base = match kind {
            ErrorKind::NoKey => {
                "No OpenRouter API key yet. Add one in Settings to generate lessons."
            }
            ErrorKind::Auth => "OpenRouter rejected the API key. Check it in Settings.",
            ErrorKind::RateLimit => {
                "OpenRouter is rate-limiting this key. Wait a moment and try again."
            }
            ErrorKind::Server => "OpenRouter had a problem on its side. Try again in a minute.",
            ErrorKind::Network => {
                "Could not reach OpenRouter. Check your connection and try again."
            }
            ErrorKind::BadResponse => "The model returned something unusable. Try again.",
        };
        LlmError {
            kind,
            message: match detail {
                Some(detail) => format!("{base} ({detail})"),
                None => base.to_owned(),
            },
            status,
        }
    }
}

pub type Result<T> = std::result::Result<T, LlmError>;

/// Where live calls go. No endpoint at all is mock mode.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    #[ts(optional)]
    pub base_url: Option<String>,
}

pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// One POST. `Err` is a failure to get any response at all.
pub trait Transport {
    fn post(
        &self,
        request: HttpRequest,
    ) -> impl Future<Output = std::result::Result<HttpResponse, String>>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON as the model wrote it; the caller validates it.
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    System(String),
    User(String),
    Assistant {
        content: String,
        tool_calls: Vec<ToolCall>,
    },
    Tool {
        content: String,
        tool_call_id: String,
    },
}

impl Message {
    fn wire(&self) -> Value {
        match self {
            Message::System(content) => json!({ "role": "system", "content": content }),
            Message::User(content) => json!({ "role": "user", "content": content }),
            Message::Assistant {
                content,
                tool_calls,
            } if !tool_calls.is_empty() => json!({
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls.iter().map(|call| json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })).collect::<Vec<_>>(),
            }),
            Message::Assistant { content, .. } => {
                json!({ "role": "assistant", "content": content })
            }
            Message::Tool {
                content,
                tool_call_id,
            } => json!({ "role": "tool", "content": content, "tool_call_id": tool_call_id }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// A JSON Schema for the arguments, sent verbatim.
    pub parameters: Value,
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    /// A strict JSON schema the reply must match, and its name.
    pub schema: Option<(&'static str, Value)>,
    pub tools: Vec<Tool>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// Sent as both `reasoning_effort` and `reasoning.effort`: endpoints read one or the other.
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Live completions made.
    pub requests: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    /// `""` when the turn was only tool calls.
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// The chat client: an endpoint (or mock mode), a transport, and the usage it has spent.
pub struct Llm<T> {
    transport: T,
    endpoint: Option<Endpoint>,
    usage: Cell<TokenUsage>,
}

impl<T: Transport> Llm<T> {
    pub fn new(transport: T, endpoint: Option<Endpoint>) -> Self {
        Llm {
            transport,
            endpoint,
            usage: Cell::new(TokenUsage::default()),
        }
    }

    pub fn is_mock(&self) -> bool {
        self.endpoint.is_none()
    }

    /// Everything spent so far, across retries.
    pub fn usage(&self) -> TokenUsage {
        self.usage.get()
    }

    /// A live completion, or in mock mode `mock()`'s content, so both go
    /// through the caller's parser.
    pub async fn complete_or_mock(
        &self,
        request: &ChatRequest,
        mock: impl FnOnce() -> String,
    ) -> Result<Completion> {
        match &self.endpoint {
            None => Ok(Completion {
                content: mock(),
                tool_calls: Vec::new(),
            }),
            Some(endpoint) => self.complete(endpoint, request).await,
        }
    }

    async fn complete(&self, endpoint: &Endpoint, request: &ChatRequest) -> Result<Completion> {
        let api_key = endpoint.api_key.trim();
        if api_key.is_empty() {
            return Err(LlmError::stock(ErrorKind::NoKey, None, None));
        }
        let base_url = endpoint
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .unwrap_or(OPENROUTER_BASE_URL)
            .trim_end_matches('/');

        let mut headers = vec![
            ("Authorization".to_owned(), format!("Bearer {api_key}")),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ];
        // Other endpoints' CORS preflights reject OpenRouter's attribution headers.
        if base_url == OPENROUTER_BASE_URL {
            headers.push(("HTTP-Referer".to_owned(), APP_REFERER.to_owned()));
            headers.push(("X-Title".to_owned(), APP_TITLE.to_owned()));
        }
        // Anthropic only serves CORS headers to a browser that opts in.
        if is_anthropic(base_url) {
            headers.push((
                "anthropic-dangerous-direct-browser-access".to_owned(),
                "true".to_owned(),
            ));
        }

        let mut body = request_body(&endpoint.model, request);
        let url = format!("{base_url}/chat/completions");
        let mut with_schema = request.schema.is_some();
        let response = loop {
            if !with_schema {
                if let Some(body) = body.as_object_mut() {
                    body.remove("response_format");
                }
            }
            let response = self
                .transport
                .post(HttpRequest {
                    url: url.clone(),
                    headers: headers.clone(),
                    body: body.to_string(),
                })
                .await
                .map_err(|detail| LlmError::stock(ErrorKind::Network, Some(&detail), None))?;
            if (200..300).contains(&response.status) {
                break response;
            }
            // Some models reject structured outputs outright; ask once more without.
            if with_schema && rejects_schema(&response) {
                with_schema = false;
                continue;
            }
            let kind = match response.status {
                401 | 403 => ErrorKind::Auth,
                429 => ErrorKind::RateLimit,
                500.. => ErrorKind::Server,
                _ => ErrorKind::BadResponse,
            };
            return Err(LlmError::stock(
                kind,
                error_detail(&response.body).as_deref(),
                Some(response.status),
            ));
        };
        self.read(&response)
    }

    fn read(&self, response: &HttpResponse) -> Result<Completion> {
        let bad = |detail: &str| {
            LlmError::stock(ErrorKind::BadResponse, Some(detail), Some(response.status))
        };
        let payload: Value =
            serde_json::from_str(&response.body).map_err(|_| bad("response was not JSON"))?;
        if let Some(message) = payload["error"]["message"].as_str() {
            return Err(bad(&truncate(message)));
        }

        let choice = &payload["choices"][0];
        let message = &choice["message"];
        let tool_calls = tool_calls(&message["tool_calls"]);
        let content = message["content"].as_str().unwrap_or_default().to_owned();
        if content.trim().is_empty() && tool_calls.is_empty() {
            return Err(bad(if choice["finish_reason"] == "length" {
                "cut off at max_tokens before any content — a thinking model needs a higher cap"
            } else {
                "no message content"
            }));
        }

        let count = |value: &Value| value.as_f64().filter(|n| *n > 0.0).unwrap_or(0.0) as u64;
        let mut usage = self.usage.get();
        usage.prompt_tokens += count(&payload["usage"]["prompt_tokens"]);
        usage.completion_tokens += count(&payload["usage"]["completion_tokens"]);
        usage.requests += 1;
        self.usage.set(usage);

        Ok(Completion {
            content,
            tool_calls,
        })
    }
}

fn request_body(model: &str, request: &ChatRequest) -> Value {
    let mut body = json!({
        "model": model,
        "messages": request.messages.iter().map(Message::wire).collect::<Vec<_>>(),
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(effort) = &request.reasoning_effort {
        body["reasoning_effort"] = json!(effort);
        body["reasoning"] = json!({ "effort": effort });
    }
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            })
            .collect();
    }
    if let Some((name, schema)) = &request.schema {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": { "name": name, "strict": true, "schema": schema },
        });
    }
    body
}

fn is_anthropic(base_url: &str) -> bool {
    let host = base_url
        .split_once("://")
        .map_or(base_url, |(_, rest)| rest)
        .split(['/', ':'])
        .next()
        .unwrap_or_default();
    host == "anthropic.com" || host.ends_with(".anthropic.com")
}

fn rejects_schema(response: &HttpResponse) -> bool {
    let body = response.body.to_lowercase();
    (400..500).contains(&response.status)
        && !matches!(response.status, 401 | 403 | 429)
        && [
            "response_format",
            "response format",
            "json_schema",
            "structured output",
        ]
        .iter()
        .any(|needle| body.contains(needle))
}

fn truncate(text: &str) -> String {
    text.chars().take(200).collect()
}

fn error_detail(body: &str) -> Option<String> {
    if body.is_empty() {
        return None;
    }
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    match parsed.as_ref().and_then(|v| v["error"]["message"].as_str()) {
        Some(message) => Some(truncate(message)),
        None => Some(truncate(body)),
    }
}

/// An entry with no id or name is unanswerable and dropped; missing arguments are `{}`.
fn tool_calls(raw: &Value) -> Vec<ToolCall> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let id = entry["id"].as_str().filter(|s| !s.is_empty())?;
            let name = entry["function"]["name"]
                .as_str()
                .filter(|s| !s.is_empty())?;
            Some(ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments: entry["function"]["arguments"]
                    .as_str()
                    .unwrap_or("{}")
                    .to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod fake {
    use super::*;
    use std::cell::RefCell;
    use std::future::ready;

    /// A request as the fake saw it: url, headers, parsed body.
    pub type Seen = (String, Vec<(String, String)>, Value);

    /// Answers each POST with the next canned response and remembers the request.
    #[derive(Default)]
    pub struct Fake {
        pub responses: RefCell<Vec<std::result::Result<HttpResponse, String>>>,
        pub requests: RefCell<Vec<Seen>>,
    }

    impl Fake {
        pub fn new(responses: Vec<std::result::Result<HttpResponse, String>>) -> Self {
            Fake {
                responses: RefCell::new(responses.into_iter().rev().collect()),
                requests: RefCell::default(),
            }
        }

        /// One successful completion whose message content is `content`.
        pub fn replying(content: &str) -> Self {
            Self::new(vec![Ok(ok(json!({
                "model": "m",
                "choices": [{ "message": { "content": content } }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 5 },
            })))])
        }

        pub fn body(&self, i: usize) -> Value {
            self.requests.borrow()[i].2.clone()
        }
    }

    pub fn ok(body: Value) -> HttpResponse {
        HttpResponse {
            status: 200,
            body: body.to_string(),
        }
    }

    pub fn status(status: u16, body: &str) -> HttpResponse {
        HttpResponse {
            status,
            body: body.to_owned(),
        }
    }

    impl Transport for &Fake {
        fn post(
            &self,
            request: HttpRequest,
        ) -> impl Future<Output = std::result::Result<HttpResponse, String>> {
            let body = serde_json::from_str(&request.body).unwrap();
            self.requests
                .borrow_mut()
                .push((request.url, request.headers, body));
            ready(
                self.responses
                    .borrow_mut()
                    .pop()
                    .expect("an unexpected request"),
            )
        }
    }

    pub fn live(fake: &Fake) -> Llm<&Fake> {
        with_base(fake, None)
    }

    pub fn with_base<'a>(fake: &'a Fake, base_url: Option<&str>) -> Llm<&'a Fake> {
        Llm::new(
            fake,
            Some(Endpoint {
                api_key: "sk-test".into(),
                model: "test/model".into(),
                base_url: base_url.map(str::to_owned),
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::fake::*;
    use super::*;
    use pollster::block_on;

    fn ask(llm: &Llm<&Fake>, request: &ChatRequest) -> Result<Completion> {
        block_on(llm.complete_or_mock(request, || unreachable!()))
    }

    fn hello() -> ChatRequest {
        ChatRequest {
            messages: vec![Message::System("s".into()), Message::User("u".into())],
            ..ChatRequest::default()
        }
    }

    #[test]
    fn posts_the_request_and_counts_usage() {
        let fake = Fake::replying("hi");
        let llm = live(&fake);
        let request = ChatRequest {
            temperature: Some(0.3),
            reasoning_effort: Some("low".into()),
            schema: Some(("s", json!({ "type": "object" }))),
            ..hello()
        };
        assert_eq!(ask(&llm, &request).unwrap().content, "hi");

        let (url, headers, body) = fake.requests.borrow()[0].clone();
        assert_eq!(url, "https://openrouter.ai/api/v1/chat/completions");
        assert!(headers.contains(&("Authorization".into(), "Bearer sk-test".into())));
        assert!(headers.iter().any(|(name, _)| name == "X-Title"));
        assert_eq!(body["model"], "test/model");
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "u" })
        );
        assert_eq!(
            llm.usage(),
            TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 5,
                requests: 1
            }
        );
    }

    #[test]
    fn attribution_headers_go_only_to_openrouter() {
        let fake = Fake::replying("hi");
        ask(
            &with_base(&fake, Some("https://api.anthropic.com/v1/")),
            &hello(),
        )
        .unwrap();
        let (url, headers, _) = fake.requests.borrow()[0].clone();
        assert_eq!(url, "https://api.anthropic.com/v1/chat/completions");
        assert!(!headers.iter().any(|(name, _)| name == "X-Title"));
        assert!(headers
            .iter()
            .any(|(name, _)| name == "anthropic-dangerous-direct-browser-access"));
    }

    #[test]
    fn statuses_map_to_kinds() {
        for (status, kind) in [
            (401, ErrorKind::Auth),
            (403, ErrorKind::Auth),
            (429, ErrorKind::RateLimit),
            (502, ErrorKind::Server),
            (400, ErrorKind::BadResponse),
        ] {
            let fake = Fake::new(vec![Ok(status_response(status))]);
            let error = ask(&live(&fake), &hello()).unwrap_err();
            assert_eq!((error.kind, error.status), (kind, Some(status)));
            assert!(error.message.contains("(nope)"), "{}", error.message);
        }
    }

    fn status_response(code: u16) -> HttpResponse {
        status(code, r#"{"error":{"message":"nope"}}"#)
    }

    #[test]
    fn a_transport_failure_is_a_network_error() {
        let fake = Fake::new(vec![Err("offline".into())]);
        assert_eq!(
            ask(&live(&fake), &hello()).unwrap_err().kind,
            ErrorKind::Network
        );
    }

    #[test]
    fn a_blank_key_is_no_key() {
        let fake = Fake::default();
        let llm = Llm::new(
            &fake,
            Some(Endpoint {
                api_key: " ".into(),
                model: "m".into(),
                base_url: None,
            }),
        );
        assert_eq!(ask(&llm, &hello()).unwrap_err().kind, ErrorKind::NoKey);
    }

    #[test]
    fn a_rejected_schema_is_retried_once_without_it() {
        let fake = Fake::new(vec![
            Ok(status(400, "response_format json_schema is not supported")),
            Ok(ok(
                json!({ "choices": [{ "message": { "content": "{}" } }] }),
            )),
        ]);
        let request = ChatRequest {
            schema: Some(("s", json!({}))),
            ..hello()
        };
        assert_eq!(ask(&live(&fake), &request).unwrap().content, "{}");
        assert!(fake.body(0).get("response_format").is_some());
        assert!(fake.body(1).get("response_format").is_none());
    }

    #[test]
    fn without_a_schema_a_400_is_not_retried() {
        let fake = Fake::new(vec![Ok(status(400, "response_format"))]);
        assert_eq!(
            ask(&live(&fake), &hello()).unwrap_err().kind,
            ErrorKind::BadResponse
        );
    }

    #[test]
    fn empty_content_is_a_bad_response_and_says_why() {
        let fake = Fake::new(vec![Ok(ok(json!({
            "choices": [{ "message": { "content": "" }, "finish_reason": "length" }],
        })))]);
        let error = ask(&live(&fake), &hello()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::BadResponse);
        assert!(error.message.contains("max_tokens"));

        let fake = Fake::new(vec![Ok(status(200, "not json"))]);
        assert_eq!(
            ask(&live(&fake), &hello()).unwrap_err().kind,
            ErrorKind::BadResponse
        );
    }

    #[test]
    fn tool_calls_go_out_and_come_back() {
        let fake = Fake::new(vec![Ok(ok(json!({
            "choices": [{ "message": { "content": null, "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "add_words", "arguments": "{\"a\":1}" } },
                { "id": "c2", "function": { "name": "list" } },
                { "function": { "name": "no_id" } },
            ] } }],
        })))]);
        let request = ChatRequest {
            messages: vec![
                Message::User("u".into()),
                Message::Assistant {
                    content: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "c0".into(),
                        name: "list".into(),
                        arguments: "{}".into(),
                    }],
                },
                Message::Tool {
                    content: "[]".into(),
                    tool_call_id: "c0".into(),
                },
            ],
            tools: vec![Tool {
                name: "add_words".into(),
                description: "d".into(),
                parameters: json!({ "type": "object" }),
            }],
            ..ChatRequest::default()
        };
        let completion = ask(&live(&fake), &request).unwrap();
        assert_eq!(completion.content, "");
        assert_eq!(
            completion.tool_calls,
            vec![
                ToolCall {
                    id: "c1".into(),
                    name: "add_words".into(),
                    arguments: "{\"a\":1}".into()
                },
                ToolCall {
                    id: "c2".into(),
                    name: "list".into(),
                    arguments: "{}".into()
                },
            ]
        );

        let body = fake.body(0);
        assert_eq!(body["tools"][0]["function"]["name"], "add_words");
        assert_eq!(
            body["messages"][1]["tool_calls"][0]["function"]["name"],
            "list"
        );
        assert_eq!(
            body["messages"][2],
            json!({ "role": "tool", "content": "[]", "tool_call_id": "c0" })
        );
    }

    #[test]
    fn mock_mode_makes_no_request_and_spends_nothing() {
        let fake = Fake::default();
        let llm = Llm::new(&fake, None);
        let completion = block_on(llm.complete_or_mock(&hello(), || "canned".into())).unwrap();
        assert_eq!(completion.content, "canned");
        assert!(fake.requests.borrow().is_empty());
        assert_eq!(llm.usage(), TokenUsage::default());
    }
}
