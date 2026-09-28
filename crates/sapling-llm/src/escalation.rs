//! The learner disputes a grade or asks why. The one mid-session spend, and it
//! can win: `overturn` re-grades the answer as correct, so anything that is not
//! unambiguously `{answer, overturn}` degrades to prose and never overturns.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use crate::client::{ChatRequest, Llm, Message, Result, Transport};
use crate::json::parse_reply;
use crate::kinds::{Lesson, WireType};
use crate::non_blank;

const PROMPT: &str = include_str!("../prompts/escalation.txt");
const MOCK: &str = include_str!("../fixtures/escalation.txt");

pub const DEFAULT_QUESTION: &str = "Explain the correct answer and whether my answer should count.";

/// What the learner's screen showed, which can be less than the stored row.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub native_line: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tiles: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EscalationArgs {
    /// The stored challenge, as served.
    #[ts(type = "unknown")]
    pub challenge: Value,
    pub shown: Shown,
    pub answer_given: String,
    /// The local grader's verdict.
    pub verdict: String,
    #[serde(default)]
    #[ts(optional)]
    pub user_question: Option<String>,
    pub native_language: String,
    pub target_language: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct EscalationReply {
    /// Plain text, in the learner's native language.
    pub answer: String,
    /// The learner's answer should have counted.
    pub overturn: bool,
}

pub fn escalation_messages(args: &EscalationArgs) -> Vec<Message> {
    let glosses: Vec<&str> = WireType::ALL
        .into_iter()
        .filter_map(|kind| kind.spec().escalation_spec.as_deref())
        .collect();
    let system: Vec<String> = PROMPT
        .lines()
        .map(|line| match line {
            "{glosses}" => glosses.join(" "),
            _ => line
                .replace("{native}", &args.native_language)
                .replace("{target}", &args.target_language),
        })
        .collect();
    let context = json!({
        "challenge": args.challenge,
        "shown": args.shown,
        "answerGiven": args.answer_given,
        "verdict": args.verdict,
    });
    let question = non_blank(args.user_question.as_deref()).unwrap_or(DEFAULT_QUESTION);
    vec![
        Message::System(system.join(" ")),
        Message::User(format!("{context}\nQuestion: {question}")),
    ]
}

pub fn parse_escalation(raw: &str) -> EscalationReply {
    let text = raw.trim();
    match parse_reply::<EscalationReply>(text) {
        Some(reply) if !reply.answer.trim().is_empty() => EscalationReply {
            answer: reply.answer.trim().to_owned(),
            overturn: reply.overturn,
        },
        _ => EscalationReply {
            answer: text.to_owned(),
            overturn: false,
        },
    }
}

/// The mock never overturns: a flipped grade without a model would corrupt the schedule.
fn mock(args: &EscalationArgs) -> String {
    let answer = MOCK
        .trim_end()
        .replace(
            "{answer}",
            non_blank(Some(&args.answer_given)).unwrap_or("—"),
        )
        .replace("{verdict}", &args.verdict)
        .replace("{native}", &args.native_language);
    json!({ "answer": answer, "overturn": false }).to_string()
}

pub async fn escalate<T: Transport>(
    llm: &Llm<T>,
    args: &EscalationArgs,
) -> Result<EscalationReply> {
    let request = ChatRequest {
        messages: escalation_messages(args),
        // Generous: a thinking model spends against the cap before the JSON starts.
        max_tokens: Some(1500),
        temperature: Some(0.3),
        ..ChatRequest::default()
    };
    let completion = llm.complete_or_mock(&request, || mock(args)).await?;
    Ok(parse_escalation(&completion.content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, Fake};
    use pollster::block_on;

    fn args(question: Option<&str>) -> EscalationArgs {
        EscalationArgs {
            challenge: json!({ "id": "c", "type": "word-order", "tiles": ["a", "b"] }),
            shown: Shown {
                native_line: false,
                word_bank: None,
                tiles: Some(vec!["a".into()]),
            },
            answer_given: "b a".into(),
            verdict: "wrong".into(),
            user_question: question.map(str::to_owned),
            native_language: "English".into(),
            target_language: "Spanish".into(),
        }
    }

    fn contents(messages: &[Message]) -> (String, String) {
        match messages {
            [Message::System(system), Message::User(user)] => (system.clone(), user.clone()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_prompt_names_the_languages_glosses_the_tile_types_and_carries_the_view() {
        let (system, user) = contents(&escalation_messages(&args(None)));
        assert!(system.starts_with(
            "You are a precise language tutor. The learner speaks English and is learning Spanish."
        ));
        assert!(system.contains("at most 120 words"));
        for kind in [
            WireType::SpotError,
            WireType::WordOrder,
            WireType::MultiCloze,
        ] {
            assert!(system.contains(kind.spec().escalation_spec.as_deref().unwrap()));
        }
        assert!(!system.contains('\n') && !system.contains("{glosses}"));
        let (context, question) = user.split_once('\n').unwrap();
        let context: Value = serde_json::from_str(context).unwrap();
        assert_eq!(
            context["shown"],
            json!({ "nativeLine": false, "tiles": ["a"] })
        );
        assert_eq!(context["answerGiven"], "b a");
        assert_eq!(question, format!("Question: {DEFAULT_QUESTION}"));

        let (_, user) = contents(&escalation_messages(&args(Some(" Why? "))));
        assert!(user.ends_with("\nQuestion: Why?"));
    }

    #[test]
    fn a_reply_is_read_strictly_and_degrades_to_prose() {
        assert_eq!(
            parse_escalation("Sure: ```json\n{\"answer\":\" Yes. \",\"overturn\":true}\n```"),
            EscalationReply {
                answer: "Yes.".into(),
                overturn: true
            }
        );
        let prose = parse_escalation(" It should count. ");
        assert_eq!(
            (prose.answer.as_str(), prose.overturn),
            ("It should count.", false)
        );
        assert!(!parse_escalation(r#"{"answer":"x","overturn":"yes"}"#).overturn);
    }

    #[test]
    fn a_live_call_is_capped_and_the_mock_never_overturns() {
        let fake = Fake::replying(r#"{"answer":"Counts.","overturn":true}"#);
        let llm = live(&fake);
        assert!(block_on(escalate(&llm, &args(None))).unwrap().overturn);
        assert_eq!(fake.body(0)["max_tokens"], 1500);
        assert!(fake.body(0).get("response_format").is_none());

        let mock = Llm::new(&fake, None);
        let reply = block_on(escalate(&mock, &args(None))).unwrap();
        assert!(!reply.overturn);
        assert!(reply.answer.contains("\"b a\" was graded \"wrong\""));
    }
}
