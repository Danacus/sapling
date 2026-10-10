//! Conversation mode: the setup call that picks a scene, and the turn loop
//! where a teacher plays it with the learner. A turn's reply is an envelope —
//! the spoken line, its translation, what the teacher heard and what it
//! corrected — so a correction never enters the spoken line. The one tool is
//! `add_words`, the assistant's own.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use sapling_domain::types::{
    ConversationCorrection, ConversationLearnerTurn, ConversationLine, ConversationScenario,
    ConversationTeacherTurn, KnowledgeItem, Level, Speaker, TeacherRole,
};

use crate::client::{ChatRequest, Completion, ErrorKind, Llm, LlmError, Message, Transport};
use crate::json::{fenced, parse_reply, strict_schema};
use crate::reading::MAX_TOPIC_CHARS;
use crate::text::{same_romanization, template};
use crate::tools::{self, mock_call, word_lines, LoopError, ToolContext, ToolName};
use crate::{level_for, non_blank, truncated, LearnerProfile};

const SCENARIO_PROMPT: &str = include_str!("../prompts/scenario.txt");
const TEACHER_PROMPT: &str = include_str!("../prompts/teacher.txt");
const WORDS_LEAD: &str = include_str!("../prompts/teacher-words.txt");
const NO_WORDS: &str = include_str!("../prompts/teacher-no-words.txt");
const MOCK: &str = include_str!("../fixtures/conversation.json");

/// Re-sent every turn, so a running cost; the newest words are kept.
pub const MAX_CONTEXT_WORDS: usize = 200;
/// One tool, no read-then-write: the second round is for answering.
pub const MAX_TOOL_ROUNDS: usize = 2;
const MAX_REPLY_TOKENS: u32 = 2000;
const MAX_SCENARIO_TOKENS: u32 = 2000;
/// When the model said nothing usable: a pause, never words put in its mouth.
pub const ROUND_LIMIT_REPLY: &str = "…";

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioArgs {
    pub profile: LearnerProfile,
    /// How many words the learner's library holds: the level the scene is
    /// pitched at ([`level_for`]). The host counts, since this call lends no
    /// word list; a turn reads its own off the [`ToolContext`].
    pub word_count: usize,
    /// Blank means "you choose".
    #[serde(default)]
    #[ts(optional)]
    pub topic: Option<String>,
}

/// The transcript, as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
pub enum ConversationTurn {
    Learner(ConversationLearnerTurn),
    Teacher(ConversationTeacherTurn),
}

#[derive(Debug, Clone, Deserialize, TS)]
pub struct TurnArgs {
    pub profile: LearnerProfile,
    pub scenario: ConversationScenario,
    pub history: Vec<ConversationTurn>,
    /// Exactly what the learner typed.
    pub text: String,
}

/// One exchange. `heard` and `correction` belong to the learner's message,
/// not the teacher's line, and are never both set.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct TurnResult {
    pub teacher: ConversationTeacherTurn,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub heard: Option<ConversationLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub correction: Option<ConversationCorrection>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
struct Line {
    text: String,
    reading: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum FirstSpeaker {
    Teacher,
    Learner,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SceneReply {
    setting: String,
    teacher_role: String,
    learner_role: String,
    first_speaker: FirstSpeaker,
    opener: Option<Line>,
    opener_translation: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CorrectionReply {
    corrected: Line,
    note: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TurnReply {
    reply: Line,
    translation: Option<String>,
    heard: Option<Line>,
    correction: Option<CorrectionReply>,
}

/// A line with its text, or none; a blank reading is no reading.
fn line(raw: Line) -> Option<ConversationLine> {
    let text = raw.text.trim();
    (!text.is_empty()).then(|| ConversationLine {
        text: text.to_owned(),
        reading: non_blank(raw.reading.as_deref()).map(str::to_owned),
    })
}

fn owned(text: Option<&str>) -> Option<String> {
    non_blank(text).map(str::to_owned)
}

pub fn scenario_request(args: &ScenarioArgs) -> ChatRequest {
    let profile = &args.profile;
    let system = template(
        SCENARIO_PROMPT,
        &[
            ("level", level_for(args.word_count).as_str()),
            ("target", &profile.target_language),
            ("native", &profile.native_language),
        ],
    );
    let user = match non_blank(args.topic.as_deref()) {
        Some(topic) => format!(
            "Topic the learner asked for: {}",
            truncated(topic, MAX_TOPIC_CHARS)
        ),
        None => "The learner did not name a topic. Choose one.".to_owned(),
    };
    ChatRequest {
        messages: vec![Message::System(system), Message::User(user)],
        schema: Some((
            "conversation_scenario".to_owned(),
            strict_schema::<SceneReply>(),
        )),
        temperature: Some(0.9),
        max_tokens: Some(MAX_SCENARIO_TOKENS),
        ..ChatRequest::default()
    }
}

/// Strict: there is no playing a scene without its roles. The one thing
/// normalized is the opener: teacher-first needs one, learner-first drops it.
pub fn parse_scenario(raw: &str) -> Result<ConversationScenario, LlmError> {
    let unusable = || {
        LlmError::new(
            ErrorKind::BadResponse,
            "The model returned a scene in an unexpected shape. Try again.",
        )
    };
    let reply: SceneReply = parse_reply(raw).ok_or_else(unusable)?;
    let setting = owned(Some(&reply.setting)).ok_or_else(unusable)?;
    let teacher_role = owned(Some(&reply.teacher_role)).ok_or_else(unusable)?;
    let learner_role = owned(Some(&reply.learner_role)).ok_or_else(unusable)?;
    let opener = match reply.first_speaker {
        FirstSpeaker::Teacher => reply.opener.and_then(line),
        FirstSpeaker::Learner => None,
    };
    Ok(ConversationScenario {
        setting,
        teacher_role,
        learner_role,
        first_speaker: if opener.is_some() {
            Speaker::Teacher
        } else {
            Speaker::Learner
        },
        opener_translation: opener
            .as_ref()
            .and(owned(reply.opener_translation.as_deref())),
        opener,
    })
}

fn mock_fixture() -> Value {
    serde_json::from_str(MOCK).expect("a fixture is JSON")
}

fn mock_scenario(args: &ScenarioArgs) -> String {
    let mut scene = mock_fixture()["scenario"].take();
    if let Some(topic) = non_blank(args.topic.as_deref()) {
        let setting = format!(
            "{} You asked to talk about: {topic}.",
            scene["setting"].as_str().unwrap_or_default()
        );
        scene["setting"] = json!(setting);
    }
    fenced(&scene)
}

pub async fn start<T: Transport>(
    llm: &Llm<T>,
    args: &ScenarioArgs,
) -> Result<ConversationScenario, LlmError> {
    let completion = llm
        .complete_or_mock(&scenario_request(args), || mock_scenario(args))
        .await?;
    parse_scenario(&completion.content)
}

/// A hard shape rather than "at their level", and always a question at the
/// end: that is what hands the turn back.
fn reply_length(level: Level) -> &'static str {
    match level {
        Level::Beginner | Level::Elementary => {
            "one short sentence, then one short question. No more than that."
        }
        Level::Intermediate => "one or two short sentences, then one question.",
        Level::Advanced => "two or three sentences, then one question.",
    }
}

/// Newest first, `term (reading) = meaning`: paid for on every turn.
pub fn word_block(items: &[KnowledgeItem]) -> String {
    let mut recent: Vec<&KnowledgeItem> = items.iter().collect();
    recent.sort_by(|a, b| b.introduced_at.total_cmp(&a.introduced_at));
    recent
        .iter()
        .take(MAX_CONTEXT_WORDS)
        .map(|item| match &item.romanization {
            Some(reading) => format!("{} ({reading}) = {}", item.term, item.meaning),
            None => format!("{} = {}", item.term, item.meaning),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The scene is fixed for the session and the word list only grows, so the
/// list goes last and the prefix stays cacheable.
pub fn system_prompt(
    profile: &LearnerProfile,
    scenario: &ConversationScenario,
    items: &[KnowledgeItem],
) -> String {
    let target = profile.target_language.as_str();
    // `items` is the whole word list the host lent, so its size is the library's.
    let level = level_for(items.len());
    let rules = template(
        TEACHER_PROMPT,
        &[
            ("level", level.as_str()),
            ("target", target),
            ("native", &profile.native_language),
            ("setting", &scenario.setting),
            ("teacher_role", &scenario.teacher_role),
            ("learner_role", &scenario.learner_role),
            ("reply_length", reply_length(level)),
        ],
    );
    let block = word_block(items);
    let words = if block.is_empty() {
        template(NO_WORDS, &[("target", target)])
    } else {
        format!("{}\n{block}", template(WORDS_LEAD, &[("target", target)]))
    };
    format!("{rules}\n\n{words}")
}

fn replay(line: &ConversationLine) -> Value {
    json!({ "text": line.text, "reading": line.reading })
}

/// Learner turns as typed; teacher turns as the whole envelope they came from,
/// `heard` and `correction` paired back from the message they were about — a
/// bare line would teach the model the wrong contract, once per turn.
fn history_messages(history: &[ConversationTurn]) -> Vec<Message> {
    history
        .iter()
        .enumerate()
        .map(|(index, turn)| match turn {
            ConversationTurn::Learner(learner) => Message::User(learner.text.clone()),
            ConversationTurn::Teacher(teacher) => {
                let answered = match index.checked_sub(1).map(|i| &history[i]) {
                    Some(ConversationTurn::Learner(learner)) => Some(learner),
                    _ => None,
                };
                let envelope = json!({
                    "reply": replay(&teacher.reply),
                    "translation": teacher.translation,
                    "heard": answered.and_then(|l| l.heard.as_ref()).map(replay),
                    "correction": answered.and_then(|l| l.correction.as_ref()).map(|c| json!({
                        "corrected": replay(&c.corrected),
                        "note": c.note,
                    })),
                });
                Message::Assistant {
                    content: envelope.to_string(),
                    tool_calls: Vec::new(),
                }
            }
        })
        .collect()
}

struct Parsed {
    reply: ConversationLine,
    translation: Option<String>,
    heard: Option<ConversationLine>,
    correction: Option<ConversationCorrection>,
}

/// A reply that will not parse is prose, and prose is the line; a broken
/// envelope is never shown, so it becomes a pause.
fn parse_turn(raw: &str) -> Parsed {
    let envelope = parse_reply::<TurnReply>(raw).and_then(|reply| {
        Some(Parsed {
            reply: line(reply.reply)?,
            translation: owned(reply.translation.as_deref()),
            heard: reply.heard.and_then(line),
            correction: reply.correction.and_then(|c| {
                Some(ConversationCorrection {
                    corrected: line(c.corrected)?,
                    note: owned(c.note.as_deref()),
                })
            }),
        })
    });
    envelope.unwrap_or_else(|| {
        let text = raw.trim();
        let looks_like_json = text.starts_with('{') || text.starts_with("```");
        Parsed {
            reply: ConversationLine {
                text: if looks_like_json || text.is_empty() {
                    ROUND_LIMIT_REPLY.to_owned()
                } else {
                    text.to_owned()
                },
                reading: None,
            },
            translation: None,
            heard: None,
            correction: None,
        }
    })
}

/// A correction that matches what was typed corrected nothing: the script
/// exactly, the reading loosely (a learner cannot type tone marks).
fn is_no_op(typed: &str, corrected: &ConversationLine) -> bool {
    let typed = typed.trim();
    typed == corrected.text
        || corrected
            .reading
            .as_deref()
            .is_some_and(|reading| same_romanization(typed, reading))
}

pub async fn send<T: Transport, C: ToolContext>(
    llm: &Llm<T>,
    ctx: &C,
    args: &TurnArgs,
) -> Result<TurnResult, LoopError> {
    let items = ctx.all_items().await?;
    let mut messages = vec![Message::System(system_prompt(
        &args.profile,
        &args.scenario,
        &items,
    ))];
    messages.extend(history_messages(&args.history));
    messages.push(Message::User(args.text.clone()));

    let request = ChatRequest {
        messages,
        schema: Some(("teacher_turn".to_owned(), strict_schema::<TurnReply>())),
        temperature: Some(0.8),
        max_tokens: Some(MAX_REPLY_TOKENS),
        ..ChatRequest::default()
    };
    let ran = tools::run(
        llm,
        ctx,
        request,
        &[ToolName::AddWords],
        MAX_TOOL_ROUNDS,
        true,
        |messages| mock_turn(args, messages),
    )
    .await?;

    let parsed = parse_turn(ran.said.as_deref().unwrap_or(ROUND_LIMIT_REPLY));
    // A surviving correction already carries the sentence in the script; a
    // no-op one still does, as what was heard.
    let (correction, unneeded) = match parsed.correction {
        Some(c) if is_no_op(&args.text, &c.corrected) => (None, Some(c.corrected)),
        other => (other, None),
    };
    let heard = match correction {
        Some(_) => None,
        None => parsed
            .heard
            .or(unneeded)
            .filter(|line| line.text != args.text.trim()),
    };
    Ok(TurnResult {
        teacher: ConversationTeacherTurn {
            role: TeacherRole::Teacher,
            reply: parsed.reply,
            translation: parsed.translation,
            actions: ran.actions,
        },
        heard,
        correction,
    })
}

/// Capitalized and full-stopped: a rewrite that reliably differs from what
/// was typed, so the mock can exercise the correction and `heard` paths.
fn tidied(text: &str) -> Option<String> {
    let typed = text.trim();
    let mut chars = typed.chars();
    let first = chars.next()?;
    let mut out: String = first.to_uppercase().chain(chars).collect();
    if !out.ends_with(['.', '!', '?']) {
        out.push('.');
    }
    (out != typed).then_some(out)
}

/// Offline, the mock plays the teacher: `term = meaning` lines become an
/// `add_words` call, then a canned reply by turn number — the second message
/// gets a correction, the third a `heard` line.
fn mock_turn(args: &TurnArgs, messages: &[Message]) -> Completion {
    if let [.., Message::User(said)] = messages {
        let words = word_lines(said);
        if !words.is_empty() {
            return mock_call(ToolName::AddWords, json!({ "words": words }));
        }
    }
    let fixture = mock_fixture();
    let spoken = args
        .history
        .iter()
        .filter(|turn| matches!(turn, ConversationTurn::Learner(_)))
        .count();
    let replies = fixture["replies"].as_array().expect("mock replies");
    let reply = &replies[spoken % replies.len()];
    let rewrite = tidied(&args.text).map(|text| json!({ "text": text, "reading": null }));
    let envelope = json!({
        "reply": { "text": reply["text"], "reading": null },
        "translation": reply["translation"],
        "heard": if spoken == 2 { rewrite.clone() } else { None },
        "correction": match (spoken, rewrite) {
            (1, Some(corrected)) => Some(json!({ "corrected": corrected, "note": fixture["note"] })),
            _ => None,
        },
    });
    Completion {
        content: fenced(&envelope),
        tool_calls: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{live, ok, Fake};
    use crate::client::HttpResponse;
    use crate::tools::tests::item;
    use crate::tools::MemoryTools;
    use pollster::block_on;
    use sapling_domain::types::{ConversationAction, LearnerRole};

    fn profile() -> LearnerProfile {
        LearnerProfile {
            native_language: "English".into(),
            target_language: "Mandarin".into(),
            about: None,
        }
    }

    /// A word list of `n` distinct words.
    fn library(n: usize) -> Vec<KnowledgeItem> {
        (0..n)
            .map(|i| item(&format!("w{i}"), &format!("词{i}"), None))
            .collect()
    }

    fn scene() -> ConversationScenario {
        ConversationScenario {
            setting: "A tea house.".into(),
            teacher_role: "the waiter".into(),
            learner_role: "a guest".into(),
            first_speaker: Speaker::Teacher,
            opener: None,
            opener_translation: None,
        }
    }

    fn learner(text: &str) -> ConversationTurn {
        ConversationTurn::Learner(ConversationLearnerTurn {
            role: LearnerRole::Learner,
            text: text.into(),
            heard: None,
            correction: None,
        })
    }

    fn teacher(text: &str) -> ConversationTurn {
        ConversationTurn::Teacher(ConversationTeacherTurn {
            role: TeacherRole::Teacher,
            reply: ConversationLine {
                text: text.into(),
                reading: None,
            },
            translation: Some("t".into()),
            actions: vec![],
        })
    }

    fn turn_args(text: &str, history: Vec<ConversationTurn>) -> TurnArgs {
        TurnArgs {
            profile: profile(),
            scenario: scene(),
            history,
            text: text.into(),
        }
    }

    fn reply(content: Value) -> Result<HttpResponse, String> {
        Ok(ok(
            json!({ "choices": [{ "message": { "content": content.to_string() } }] }),
        ))
    }

    fn envelope(heard: Value, correction: Value) -> Value {
        json!({
            "reply": { "text": "你要什么?", "reading": "nǐ yào shénme?" },
            "translation": "What do you want?",
            "heard": heard,
            "correction": correction,
        })
    }

    fn run(fake: &Fake, args: &TurnArgs) -> TurnResult {
        block_on(send(&live(fake), &MemoryTools::default(), args)).unwrap()
    }

    #[test]
    fn a_scene_is_parsed_strictly_and_its_opener_agrees_with_who_starts() {
        let scene = parse_scenario(
            &json!({
                "setting": " A market. ", "teacherRole": "a seller", "learnerRole": "a buyer",
                "firstSpeaker": "teacher", "opener": { "text": "你好!", "reading": " nǐ hǎo! " },
                "openerTranslation": "Hello!",
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(scene.setting, "A market.");
        assert_eq!(scene.first_speaker, Speaker::Teacher);
        assert_eq!(scene.opener.unwrap().reading.as_deref(), Some("nǐ hǎo!"));

        let no_opener = parse_scenario(
            &json!({
                "setting": "s", "teacherRole": "a", "learnerRole": "b",
                "firstSpeaker": "teacher", "opener": null, "openerTranslation": "Hello!",
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(no_opener.first_speaker, Speaker::Learner);
        assert_eq!(no_opener.opener_translation, None);

        for broken in [
            "not json",
            r#"{"setting":"s"}"#,
            r#"{"setting":" ","teacherRole":"a","learnerRole":"b","firstSpeaker":"learner"}"#,
        ] {
            assert_eq!(
                parse_scenario(broken).unwrap_err().kind,
                ErrorKind::BadResponse
            );
        }
    }

    #[test]
    fn the_scenario_request_is_strict_and_carries_the_topic() {
        let request = scenario_request(&ScenarioArgs {
            profile: profile(),
            word_count: crate::ELEMENTARY_WORDS,
            topic: Some(format!(" {} ", "x".repeat(200))),
        });
        let (name, schema) = request.schema.unwrap();
        assert_eq!(name, "conversation_scenario");
        assert_eq!(schema["required"].as_array().unwrap().len(), 6);
        match &request.messages[..] {
            [Message::System(system), Message::User(user)] => {
                assert!(system.starts_with(
                    "You set up role-play scenes for a elementary learner of Mandarin"
                ));
                assert_eq!(
                    user.chars().count(),
                    "Topic the learner asked for: ".len() + MAX_TOPIC_CHARS
                );
            }
            other => panic!("{other:?}"),
        }
        let fresh = scenario_request(&ScenarioArgs {
            profile: profile(),
            word_count: 0,
            topic: None,
        });
        assert!(matches!(&fresh.messages[0], Message::System(system)
            if system.starts_with("You set up role-play scenes for a beginner learner")));
    }

    #[test]
    fn the_mock_scene_names_the_topic() {
        let scene = block_on(start(
            &Llm::new(&Fake::default(), None),
            &ScenarioArgs {
                profile: profile(),
                word_count: 0,
                topic: Some("football".into()),
            },
        ))
        .unwrap();
        assert!(scene
            .setting
            .ends_with("You asked to talk about: football."));
        assert_eq!(scene.opener.unwrap().text, "¡Hola! ¿Qué te pongo?");
        assert_eq!(
            scene.opener_translation.as_deref(),
            Some("Hello! What can I get you?")
        );
    }

    #[test]
    fn the_prompt_puts_the_scene_first_and_the_newest_words_last() {
        let mut old = item("a", "茶", Some("chá"));
        old.introduced_at = 1.0;
        let mut new = item("b", "水", None);
        new.introduced_at = 2.0;
        let prompt = system_prompt(&profile(), &scene(), &[old, new]);
        assert!(
            prompt.contains("The scene: A tea house. You are the waiter. The learner is a guest.")
        );
        assert!(prompt.contains("one short sentence, then one short question."));
        assert!(prompt.ends_with("\n水 = meaning of 水\n茶 (chá) = meaning of 茶"));
        assert!(!prompt.contains("{target}") && !prompt.contains("{reply_length}"));
        let empty = system_prompt(&profile(), &scene(), &[]);
        assert!(empty.ends_with("use only the most common words of Mandarin."));
    }

    #[test]
    fn the_teacher_is_pitched_at_the_level_the_word_list_reads_as() {
        let at = |n: usize| system_prompt(&profile(), &scene(), &library(n));
        let beginner = at(crate::ELEMENTARY_WORDS - 1);
        assert!(beginner.starts_with("You are role-playing a conversation with a beginner learner"));
        let intermediate = at(crate::INTERMEDIATE_WORDS);
        assert!(intermediate.contains("with a intermediate learner"));
        assert!(intermediate.contains("one or two short sentences, then one question."));
        let advanced = at(crate::ADVANCED_WORDS);
        assert!(advanced.contains("with a advanced learner"));
        assert!(advanced.contains("two or three sentences, then one question."));
    }

    #[test]
    fn history_replays_as_dialogue_with_each_envelope_paired_to_its_message() {
        let corrected = ConversationLearnerTurn {
            role: LearnerRole::Learner,
            text: "wo yao cha".into(),
            heard: None,
            correction: Some(ConversationCorrection {
                corrected: ConversationLine {
                    text: "我要茶。".into(),
                    reading: Some("wǒ yào chá.".into()),
                },
                note: None,
            }),
        };
        let history = vec![
            teacher("你好"),
            ConversationTurn::Learner(corrected),
            teacher("好的"),
        ];
        let fake = Fake::new(vec![reply(envelope(Value::Null, Value::Null))]);
        run(&fake, &turn_args("xie xie", history));
        let messages = fake.body(0)["messages"].clone();
        let first: Value = serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            first,
            json!({ "reply": { "text": "你好", "reading": null }, "translation": "t", "heard": null, "correction": null })
        );
        assert_eq!(
            messages[2],
            json!({ "role": "user", "content": "wo yao cha" })
        );
        let second: Value = serde_json::from_str(messages[3]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            second["correction"],
            json!({ "corrected": { "text": "我要茶。", "reading": "wǒ yào chá." }, "note": null })
        );
        assert_eq!(messages[4], json!({ "role": "user", "content": "xie xie" }));
    }

    #[test]
    fn a_correction_that_corrected_nothing_becomes_what_was_heard() {
        let line = json!({ "text": "你好吗?", "reading": "Nǐ hǎo ma?" });
        let fake = Fake::new(vec![reply(envelope(
            Value::Null,
            json!({ "corrected": line, "note": "tones" }),
        ))]);
        let result = run(&fake, &turn_args("ni hao ma?", vec![]));
        assert_eq!(result.correction, None);
        assert_eq!(result.heard.unwrap().text, "你好吗?");
        assert_eq!(
            result.teacher.translation.as_deref(),
            Some("What do you want?")
        );
        assert_eq!(
            result.teacher.reply.reading.as_deref(),
            Some("nǐ yào shénme?")
        );
    }

    #[test]
    fn a_real_correction_leaves_no_heard_line() {
        let fake = Fake::new(vec![reply(envelope(
            json!({ "text": "我要茶。", "reading": "wǒ yào chá." }),
            json!({ "corrected": { "text": "我要茶。", "reading": "wǒ yào chá." }, "note": " " }),
        ))]);
        let result = run(&fake, &turn_args("wo yao cai", vec![]));
        assert_eq!(result.heard, None);
        let correction = result.correction.unwrap();
        assert_eq!(correction.corrected.text, "我要茶。");
        assert_eq!(correction.note, None);
    }

    #[test]
    fn heard_is_dropped_when_it_is_what_they_typed() {
        let fake = Fake::new(vec![reply(envelope(
            json!({ "text": "你好", "reading": null }),
            Value::Null,
        ))]);
        assert_eq!(run(&fake, &turn_args("你好", vec![])).heard, None);
    }

    #[test]
    fn an_unparseable_reply_is_prose_or_a_pause() {
        let fake = Fake::new(vec![Ok(ok(
            json!({ "choices": [{ "message": { "content": "你好!" } }] }),
        ))]);
        assert_eq!(
            run(&fake, &turn_args("hi", vec![])).teacher.reply.text,
            "你好!"
        );
        let fake = Fake::new(vec![reply(json!({ "reply": "a bare string" }))]);
        let result = run(&fake, &turn_args("hi", vec![]));
        assert_eq!(result.teacher.reply.text, ROUND_LIMIT_REPLY);
        assert_eq!(result.teacher.translation, None);
    }

    #[test]
    fn the_last_round_offers_no_tools() {
        let fake = Fake::new(vec![
            Ok(ok(
                json!({ "choices": [{ "message": { "content": "", "tool_calls": [
                { "id": "c", "function": { "name": "add_words", "arguments": "{\"words\":[{\"term\":\"茶\",\"meaning\":\"tea\",\"romanization\":\"chá\"}]}" } },
            ] } }] }),
            )),
            reply(envelope(Value::Null, Value::Null)),
        ]);
        let ctx = MemoryTools::default();
        let result = block_on(send(&live(&fake), &ctx, &turn_args("cha", vec![]))).unwrap();
        assert_eq!(fake.body(0)["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            fake.body(0)["response_format"]["json_schema"]["name"],
            "teacher_turn"
        );
        assert!(fake.body(1).get("tools").is_none());
        assert_eq!(
            result.teacher.actions,
            [ConversationAction {
                tool: "add_words".into(),
                summary: "Added 1 word: 茶".into(),
                ok: true
            }]
        );
        assert_eq!(ctx.items.borrow()[0].romanization.as_deref(), Some("chá"));
    }

    #[test]
    fn the_mock_files_words_and_walks_the_correction_and_heard_paths() {
        let fake = Fake::default();
        let llm = Llm::new(&fake, None);
        let ctx = MemoryTools::default();
        let first = block_on(send(&llm, &ctx, &turn_args("helado = ice cream", vec![]))).unwrap();
        assert_eq!(first.teacher.reply.text, "Muy bien. ¿Algo más?");
        assert_eq!(first.teacher.actions[0].tool, "add_words");
        assert_eq!(ctx.items.borrow().len(), 1);
        assert_eq!(
            (first.heard.as_ref(), first.correction.as_ref()),
            (None, None)
        );

        let second = block_on(send(
            &llm,
            &ctx,
            &turn_args("un helado", vec![learner("x"), teacher("y")]),
        ))
        .unwrap();
        assert_eq!(second.correction.unwrap().corrected.text, "Un helado.");
        assert_eq!(second.heard, None);

        let history = vec![learner("x"), teacher("y"), learner("x"), teacher("y")];
        let third = block_on(send(&llm, &ctx, &turn_args("agua", history))).unwrap();
        assert_eq!(third.heard.unwrap().text, "Agua.");
        assert_eq!(third.correction, None);
        assert!(fake.requests.borrow().is_empty());
    }
}
