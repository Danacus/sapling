//! The model calls by name, like the `Backend` table but async and without
//! `Core`: stateless, so the window runs them and never the database Worker.
//! Each method takes one argument object; the table also generates the
//! TypeScript `Llm` interface and `LLM_METHODS` (`llm.ts`). The tool-calling
//! ones also need the host's [`ToolContext`].

use serde_json::{json, Value};

use sapling_domain::types::ConversationScenario;
use sapling_llm::chat::{self, AssistantTurn, ChatArgs};
use sapling_llm::conversation::{self, ScenarioArgs, TurnArgs, TurnResult};
use sapling_llm::escalation::{self, EscalationArgs, EscalationReply};
use sapling_llm::lesson::{self, BatchArgs, BatchResult};
use sapling_llm::reading::TranslateLineArgs;
use sapling_llm::reading::{self, GenerateTextArgs, GlossEntry, LookupWordArgs, ReadingTextDraft};
use sapling_llm::tools::{self as word_tools, AddWordsParams, LoopError, ToolContext, ToolOutcome};
use sapling_llm::{Llm, LlmError, Transport};

use crate::required;

/// Why a call failed: the model's side, or a malformed call (or the host's
/// store failing under a tool).
#[derive(Debug)]
pub enum LlmFailure {
    Model(LlmError),
    Call(String),
}

impl From<LlmError> for LlmFailure {
    fn from(error: LlmError) -> Self {
        LlmFailure::Model(error)
    }
}

impl From<LoopError> for LlmFailure {
    fn from(error: LoopError) -> Self {
        match error {
            LoopError::Model(error) => LlmFailure::Model(error),
            LoopError::Store(error) => LlmFailure::Call(error.0),
        }
    }
}

impl From<word_tools::StoreError> for LlmFailure {
    fn from(error: word_tools::StoreError) -> Self {
        LlmFailure::Call(error.0)
    }
}

fn needs<C>(tools: Option<&C>) -> Result<&C, LlmFailure> {
    tools.ok_or_else(|| LlmFailure::Call("this call needs a tool context".to_owned()))
}

macro_rules! llm {
    (
        |$llm:ident, $tools:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one model call by name.
        #[allow(non_snake_case)]
        pub async fn dispatch_llm<T: Transport, C: ToolContext>(
            $llm: &Llm<T>,
            $tools: Option<&C>,
            method: &str,
            args: &[Value],
        ) -> Result<Value, LlmFailure> {
            match method {
                $(
                    stringify!($method) => {
                        let $arg: $ty =
                            required(method, args, 0).map_err(|e| LlmFailure::Call(e.0))?;
                        let value: $ret = $body.await.map_err(LlmFailure::from)?;
                        serde_json::to_value(value).map_err(|e| LlmFailure::Call(e.to_string()))
                    }
                )*
                _ => Err(LlmFailure::Call(format!("Unknown llm method {method}"))),
            }
        }

        #[cfg(test)]
        pub(crate) fn llm_methods(cfg: &ts_rs::Config) -> Vec<crate::typescript::Method> {
            vec![$(
                crate::typescript::Method {
                    name: stringify!($method),
                    docs: &[$($doc),*],
                    params: vec![(stringify!($arg), false, <$ty as ts_rs::TS>::name(cfg))],
                    returns: <$ret as ts_rs::TS>::name(cfg),
                },
            )*]
        }

        #[cfg(test)]
        pub(crate) fn visit_llm_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                visitor.visit::<$ty>();
                visitor.visit::<$ret>();
            )*
        }
    };
}

llm! {
    |llm, tools| {
        /// A text written out of the learner's vocabulary, paragraphs only.
        generateReadingText(args: GenerateTextArgs) -> ReadingTextDraft {
            reading::generate_text(llm, &args)
        }
        /// One word explained in the sentence it stands in.
        lookUpWord(args: LookupWordArgs) -> GlossEntry {
            reading::look_up_word(llm, &args)
        }
        /// One segment in the learner's native language.
        translateLine(args: TranslateLineArgs) -> String {
            reading::translate_line(llm, &args)
        }
        /// A top-up: one request per wire type, a few at a time. Reports progress.
        generateBatch(args: BatchArgs) -> BatchResult {
            lesson::generate_batch(llm, &args)
        }
        /// One follow-up about a graded answer, which may overturn it.
        escalate(args: EscalationArgs) -> EscalationReply {
            escalation::escalate(llm, &args)
        }
        /// One chat-assistant turn, with the word-list tools.
        sendChatMessage(args: ChatArgs) -> AssistantTurn {
            chat::send(llm, needs(tools)?, &args)
        }
        /// The scene a conversation plays.
        startConversation(args: ScenarioArgs) -> ConversationScenario {
            conversation::start(llm, &args)
        }
        /// One conversation exchange: the teacher's line, and what it heard or corrected.
        sendTurn(args: TurnArgs) -> TurnResult {
            conversation::send(llm, needs(tools)?, &args)
        }
        /// `add_words` without a model: the reader's "Add to my words".
        addWords(args: AddWordsParams) -> ToolOutcome {
            word_tools::add_words(&args, needs(tools)?)
        }
    }
}

/// [`dispatch_llm`] over the wire: `{result, usage?}` as JSON, `usage` only
/// when a live call spent something. An `Err` is the [`LlmError`] as JSON, or
/// plain text for a malformed call.
pub async fn dispatch_llm_json<T: Transport, C: ToolContext>(
    llm: &Llm<T>,
    tools: Option<&C>,
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    match dispatch_llm(llm, tools, method, &args).await {
        Ok(result) => {
            let mut answer = json!({ "result": result });
            if llm.usage().requests > 0 {
                answer["usage"] = json!(llm.usage());
            }
            Ok(answer.to_string())
        }
        Err(LlmFailure::Model(error)) => Err(json!(error).to_string()),
        Err(LlmFailure::Call(message)) => Err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_llm::tools::MemoryTools;
    use sapling_llm::{HttpRequest, HttpResponse};
    use std::future::{ready, Future};

    struct Offline;

    impl Transport for Offline {
        fn post(&self, _: HttpRequest) -> impl Future<Output = Result<HttpResponse, String>> {
            ready(Err("offline".to_owned()))
        }
    }

    const PROFILE: &str = r#"{"nativeLanguage":"English","targetLanguage":"Spanish","level":"beginner","interests":[],"model":"m","createdAt":1}"#;

    fn call(llm: &Llm<Offline>, method: &str, args: &str) -> Result<Value, String> {
        call_with(llm, None, method, args)
    }

    fn call_with(
        llm: &Llm<Offline>,
        tools: Option<&MemoryTools>,
        method: &str,
        args: &str,
    ) -> Result<Value, String> {
        pollster::block_on(dispatch_llm_json(llm, tools, method, args))
            .map(|answer| serde_json::from_str(&answer).unwrap())
    }

    #[test]
    fn a_tool_call_runs_against_the_host_context_and_needs_one() {
        let mock = Llm::new(Offline, None);
        let tools = MemoryTools::default();
        let chat = format!(r#"[{{"profile":{PROFILE},"history":[],"text":"hola = hi"}}]"#);
        let answer = call_with(&mock, Some(&tools), "sendChatMessage", &chat).unwrap();
        assert_eq!(answer["result"]["role"], "assistant");
        assert_eq!(answer["result"]["actions"][0]["tool"], "add_words");
        assert_eq!(tools.items.borrow()[0].term, "hola");

        let added = call_with(
            &mock,
            Some(&tools),
            "addWords",
            r#"[{"words":[{"term":"gato","meaning":"cat"}]}]"#,
        )
        .unwrap();
        assert_eq!(added["result"]["summary"], "Added 1 word: gato");

        assert_eq!(
            call(&mock, "sendChatMessage", &chat).unwrap_err(),
            "this call needs a tool context"
        );
    }

    #[test]
    fn a_mock_call_answers_its_result_and_no_usage() {
        let mock = Llm::new(Offline, None);
        let answer = call(
            &mock,
            "translateLine",
            &format!(r#"[{{"profile":{PROFILE},"text":"Hola."}}]"#),
        )
        .unwrap();
        assert_eq!(answer, json!({ "result": "(translation of \"Hola.\")" }));
    }

    #[test]
    fn a_mock_top_up_answers_its_challenges() {
        let mock = Llm::new(Offline, None);
        let want = r#"{"item":{"id":"w","term":"hola","meaning":"hi"},"kind":{"type":"recognize-mc"},"length":1}"#;
        let answer = call(
            &mock,
            "generateBatch",
            &format!(r#"[{{"profile":{PROFILE},"wants":[{want}]}}]"#),
        )
        .unwrap();
        let result = &answer["result"];
        assert_eq!(result["challenges"][0]["type"], "multiple-choice");
        assert_eq!(result["challenges"][0]["itemIds"], json!(["w"]));
        assert_eq!(result["failedRequests"], 0);
        assert!(answer.get("usage").is_none());
    }

    #[test]
    fn a_model_failure_is_its_error_as_json() {
        let live = Llm::new(
            Offline,
            Some(serde_json::from_str(r#"{"apiKey":"k","model":"m"}"#).unwrap()),
        );
        let error = call(
            &live,
            "lookUpWord",
            &format!(r#"[{{"profile":{PROFILE},"term":"a","sentence":"a"}}]"#),
        )
        .unwrap_err();
        let error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(error["kind"], "network");
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        let mock = Llm::new(Offline, None);
        assert_eq!(
            call(&mock, "nope", "[]").unwrap_err(),
            "Unknown llm method nope"
        );
        assert!(call(&mock, "lookUpWord", "[]")
            .unwrap_err()
            .starts_with("lookUpWord: argument 0"));
    }
}
