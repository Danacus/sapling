//! The chat assistant: one learner message in, one reply out, with the four
//! word-list tools in between. A turn is atomic — earlier turns travel as
//! prose, never as tool traffic — and every call it made is an action note.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use sapling_domain::types::ConversationAction;

use crate::client::{ChatRequest, Completion, Llm, Message, Transport};
use crate::text::template;
use crate::tools::{self, count_words, mock_call, word_lines, LoopError, ToolContext, ToolName};
use crate::{level_for, LearnerProfile};

const PROMPT: &str = include_str!("../prompts/chat.txt");
const MOCK: &str = include_str!("../fixtures/chat.json");

/// Room for read, write, confirm and one retry; every round is a paid request.
pub const MAX_TOOL_ROUNDS: usize = 5;
const MAX_REPLY_TOKENS: u32 = 1024;
pub const ROUND_LIMIT_REPLY: &str =
    "I made the changes I could; ask me again if something is missing.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    User,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum AssistantRole {
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct UserTurn {
    pub role: UserRole,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct AssistantTurn {
    pub role: AssistantRole,
    pub text: String,
    pub actions: Vec<ConversationAction>,
}

/// The conversation as the page holds it: prose only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ChatTurn {
    User(UserTurn),
    Assistant(AssistantTurn),
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct ChatArgs {
    pub profile: LearnerProfile,
    pub history: Vec<ChatTurn>,
    pub text: String,
}

pub fn system_prompt(profile: &LearnerProfile, word_count: usize) -> String {
    template(
        PROMPT,
        &[
            ("target", &profile.target_language),
            ("native", &profile.native_language),
            ("level", level_for(word_count).as_str()),
            ("words", &count_words(word_count)),
        ],
    )
}

pub async fn send<T: Transport, C: ToolContext>(
    llm: &Llm<T>,
    ctx: &C,
    args: &ChatArgs,
) -> Result<AssistantTurn, LoopError> {
    let items = ctx.all_items().await?;
    let mut messages = vec![Message::System(system_prompt(&args.profile, items.len()))];
    messages.extend(args.history.iter().map(|turn| match turn {
        ChatTurn::User(turn) => Message::User(turn.text.clone()),
        ChatTurn::Assistant(turn) => Message::Assistant {
            content: turn.text.clone(),
            tool_calls: Vec::new(),
        },
    }));
    messages.push(Message::User(args.text.clone()));

    let request = ChatRequest {
        messages,
        max_tokens: Some(MAX_REPLY_TOKENS),
        ..ChatRequest::default()
    };
    let ran = tools::run(
        llm,
        ctx,
        request,
        &ToolName::ALL,
        MAX_TOOL_ROUNDS,
        false,
        mock,
    )
    .await?;
    Ok(AssistantTurn {
        role: AssistantRole::Assistant,
        text: ran
            .said
            .map(|said| said.trim().to_owned())
            .unwrap_or_else(|| ROUND_LIMIT_REPLY.to_owned()),
        actions: ran.actions,
    })
}

/// Offline, the mock plays the model: `term = meaning` lines become an
/// `add_words` call, a question about the list a `list_words` call, and the
/// reply is written from what the real tool returned.
fn mock(messages: &[Message]) -> Completion {
    let text: Value = serde_json::from_str(MOCK).expect("a fixture is JSON");
    let line = |key: &str, vars: &[(&str, &str)]| Completion {
        content: template(text[key].as_str().expect("a fixture line"), vars),
        tool_calls: Vec::new(),
    };
    match messages {
        [.., Message::Assistant { tool_calls, .. }, Message::Tool { content, .. }] => {
            let result: Value = serde_json::from_str(content).unwrap_or_default();
            let strings = |key: &str| -> Vec<String> {
                result[key]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().or(v["term"].as_str()).map(str::to_owned))
                    .collect()
            };
            if tool_calls[0].name == ToolName::ListWords.as_str() {
                let terms = strings("entries");
                let total = result["total"].as_u64().unwrap_or(0);
                if terms.is_empty() {
                    return line("empty", &[]);
                }
                let tail = if total as usize > terms.len() {
                    ", ..."
                } else {
                    ""
                };
                return line(
                    "listed",
                    &[
                        ("total", &total.to_string()),
                        ("terms", &format!("{}{tail}", terms.join(", "))),
                    ],
                );
            }
            match strings("added") {
                added if added.is_empty() => line("unchanged", &[]),
                added => line("added", &[("terms", &added.join(", "))]),
            }
        }
        [.., Message::User(said)] => {
            let words = word_lines(said);
            if !words.is_empty() {
                return mock_call(ToolName::AddWords, serde_json::json!({ "words": words }));
            }
            if asks_for_list(said) {
                return mock_call(ToolName::ListWords, serde_json::json!({ "limit": 3 }));
            }
            line("offline", &[])
        }
        _ => line("offline", &[]),
    }
}

fn asks_for_list(text: &str) -> bool {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| {
            matches!(
                word,
                "list" | "show" | "words" | "vocab" | "vocabulary" | "know" | "learned"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, ok, Fake};
    use crate::tools::tests::item;
    use crate::tools::MemoryTools;
    use pollster::block_on;
    use serde_json::json;

    fn args(text: &str, history: Vec<ChatTurn>) -> ChatArgs {
        ChatArgs {
            profile: LearnerProfile {
                native_language: "English".into(),
                target_language: "Spanish".into(),
                about: None,
            },
            history,
            text: text.into(),
        }
    }

    fn mock_llm(fake: &Fake) -> Llm<&Fake> {
        Llm::new(fake, None)
    }

    #[test]
    fn the_prompt_states_the_learner_and_the_word_count() {
        let prompt = system_prompt(&args("", vec![]).profile, 1);
        assert!(prompt.starts_with("You manage the vocabulary list of a learner of Spanish whose native language is English, at beginner level. Their list currently holds 1 word."));
        assert!(!prompt.contains('{'));
        let grown = system_prompt(&args("", vec![]).profile, crate::INTERMEDIATE_WORDS);
        assert!(grown.contains("at intermediate level. Their list currently holds 600 words."));
    }

    #[test]
    fn the_loop_runs_tools_and_answers_with_what_they_did() {
        let fake = Fake::new(vec![
            Ok(ok(
                json!({ "choices": [{ "message": { "content": "", "tool_calls": [
                { "id": "c1", "function": { "name": "add_words", "arguments": "{\"words\":[{\"term\":\"gato\",\"meaning\":\"cat\"}]}" } },
                { "id": "c2", "function": { "name": "remove_word", "arguments": "{\"term\":\"perro\"}" } },
            ] } }] }),
            )),
            Ok(ok(
                json!({ "choices": [{ "message": { "content": " Added gato. " } }] }),
            )),
        ]);
        let ctx = MemoryTools::new(vec![item("a", "hola", None)]);
        let history = vec![
            ChatTurn::User(UserTurn {
                role: UserRole::User,
                text: "hi".into(),
            }),
            ChatTurn::Assistant(AssistantTurn {
                role: AssistantRole::Assistant,
                text: "hello".into(),
                actions: vec![],
            }),
        ];
        let turn = block_on(send(&live(&fake), &ctx, &args("add gato", history))).unwrap();
        assert_eq!(turn.text, "Added gato.");
        let notes: Vec<(&str, bool)> = turn
            .actions
            .iter()
            .map(|a| (a.tool.as_str(), a.ok))
            .collect();
        assert_eq!(notes, [("add_words", true), ("remove_word", false)]);

        let first = fake.body(0);
        assert!(first["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("holds 1 word."));
        assert_eq!(
            first["messages"][2],
            json!({ "role": "assistant", "content": "hello" })
        );
        assert_eq!(first["tools"].as_array().unwrap().len(), 4);
        let second = fake.body(1);
        assert_eq!(second["messages"][5]["role"], "tool");
        assert_eq!(
            second["messages"][6]["content"],
            "{\"error\":\"no word \\\"perro\\\" in the list\"}"
        );
        assert_eq!(ctx.items.borrow().len(), 2);
    }

    #[test]
    fn a_model_that_never_stops_calling_tools_gets_the_round_limit_reply() {
        let calling = || {
            Ok(ok(
                json!({ "choices": [{ "message": { "content": null, "tool_calls": [
                { "id": "c", "function": { "name": "list_words", "arguments": "{}" } },
            ] } }] }),
            ))
        };
        let fake = Fake::new((0..MAX_TOOL_ROUNDS).map(|_| calling()).collect());
        let turn = block_on(send(
            &live(&fake),
            &MemoryTools::default(),
            &args("?", vec![]),
        ))
        .unwrap();
        assert_eq!(turn.text, ROUND_LIMIT_REPLY);
        assert_eq!(turn.actions.len(), MAX_TOOL_ROUNDS);
    }

    #[test]
    fn the_mock_adds_words_through_the_real_tool() {
        let fake = Fake::default();
        let ctx = MemoryTools::new(vec![item("a", "hola", None)]);
        let turn = block_on(send(
            &mock_llm(&fake),
            &ctx,
            &args("hola = hi\ngato = cat", vec![]),
        ))
        .unwrap();
        assert!(turn.text.starts_with("Added gato."), "{}", turn.text);
        assert_eq!(
            turn.actions[0].summary,
            "Added 1 word: gato; skipped 1 already in the list"
        );
        assert_eq!(ctx.items.borrow().len(), 2);

        let again = block_on(send(&mock_llm(&fake), &ctx, &args("gato = cat", vec![]))).unwrap();
        assert!(again.text.starts_with("Nothing added"));
    }

    #[test]
    fn the_mock_lists_or_explains_itself() {
        let fake = Fake::default();
        let ctx = MemoryTools::new(
            ["uno", "dos", "tres", "cuatro"]
                .iter()
                .enumerate()
                .map(|(i, t)| item(&i.to_string(), t, None))
                .collect(),
        );
        let listed = block_on(send(
            &mock_llm(&fake),
            &ctx,
            &args("What words do I know?", vec![]),
        ))
        .unwrap();
        assert!(
            listed
                .text
                .starts_with("Your list holds 4: uno, dos, tres, ..."),
            "{}",
            listed.text
        );
        assert_eq!(listed.actions[0].tool, "list_words");

        let empty = block_on(send(
            &mock_llm(&fake),
            &MemoryTools::default(),
            &args("show me", vec![]),
        ))
        .unwrap();
        assert!(empty.text.starts_with("Your list is empty"));

        let other = block_on(send(&mock_llm(&fake), &ctx, &args("hello there", vec![]))).unwrap();
        assert!(other.text.starts_with("Offline demo mode"));
        assert!(other.actions.is_empty());
        assert!(fake.requests.borrow().is_empty());
    }
}
