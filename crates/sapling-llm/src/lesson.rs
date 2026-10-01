//! A top-up: the session's wants, cut into one request per wire type and run a
//! few at a time. Each request's prompt, schema and retry are about that one
//! type; its reply is checked against the words it was asked about, and a
//! request that still fails after one corrective retry is dropped, not fatal.
//! Only auth, rate-limit and network failures end the top-up. Challenges come
//! back in request order, and a lesson never introduces vocabulary.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use ts_rs::TS;

use sapling_challenges::Challenge;

use crate::client::{
    ChatRequest, ErrorKind, Llm, LlmError, Message, ProgressStepId, Result, TokenUsage, Transport,
};
use crate::json::{fenced, fill, strip_fences};
use crate::kinds::{kind_of, Lesson, WireType};
use crate::text::{term_key, Rng};
use crate::wire::{batch_schema, has_instruction, resolve, Generated, Resolver};
use crate::{is_mandarin, non_blank, truncated, LearnerProfile, MAX_ABOUT_CHARS};

/// Wants one request carries: six of one type keep the model on task.
pub const REQUEST_ITEMS: usize = 6;
pub const REQUEST_CONCURRENCY: usize = 3;

const PREAMBLE: &str = include_str!("../prompts/lesson.txt");
const INSTRUCTION_RULE: &str = include_str!("../prompts/lesson-instruction.txt");
const CORRECTIVE: &str = include_str!("../prompts/lesson-corrective.txt");

pub use sapling_challenges::kinds::{ChallengeKind, Want, WantItem};

/// A word the learner has: its id stays here, only the term reaches the prompt.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct KnownItem {
    pub id: String,
    pub term: String,
    /// Sent only when another known word is spelled the same way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub romanization: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchArgs {
    pub profile: LearnerProfile,
    /// The whole brief, planned by the session against its pool.
    pub wants: Vec<Want>,
    /// The learner's whole vocabulary: what sentences are built from, and cited by term.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub known_items: Option<Vec<KnownItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub topic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub items_per_request: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub challenges: Vec<Challenge>,
    /// Requests that contributed nothing even after their retry.
    pub failed_requests: u32,
    pub usage: TokenUsage,
}

/// One request: one wire type and at most a handful of distinct words.
#[derive(Debug)]
pub struct TypeRequest<'a> {
    pub kind: WireType,
    pub wants: Vec<&'a Want>,
}

fn bad(message: impl Into<String>) -> LlmError {
    LlmError::new(ErrorKind::BadResponse, message)
}

/// Cut by kind, in first-appearance order; a kind over `per_request` spills
/// into another request. A second want of one kind for one word is dropped: a
/// reply is matched back by the word it cites.
pub fn group_into_requests(wants: &[Want], per_request: usize) -> Vec<TypeRequest<'_>> {
    let per_request = per_request.max(1);
    let mut seen = HashSet::new();
    let mut requests: Vec<TypeRequest> = Vec::new();
    let mut open: HashMap<WireType, usize> = HashMap::new();
    for want in wants {
        if !seen.insert((want.item.id.as_str(), want.kind.kind)) {
            continue;
        }
        match open.get(&want.kind.kind) {
            Some(&at) if requests[at].wants.len() < per_request => requests[at].wants.push(want),
            _ => {
                open.insert(want.kind.kind, requests.len());
                requests.push(TypeRequest {
                    kind: want.kind.kind,
                    wants: vec![want],
                });
            }
        }
    }
    requests
}

fn compose(kind: WireType) -> String {
    let spec = kind.spec();
    let mut lines: Vec<String> = Vec::new();
    for line in PREAMBLE.lines() {
        match line {
            "{promptSpec}" => lines.push(spec.prompt_spec.clone()),
            "{paramsSpec}" => lines.push(spec.params_spec.clone()),
            "{rulesSpec}" => lines.extend(spec.rules_spec.clone()),
            "{instructionRule}" if has_instruction(kind) => {
                lines.push(INSTRUCTION_RULE.trim_end().to_owned())
            }
            "{instructionRule}" => {}
            _ => lines.push(line.replace("{type}", kind.as_str())),
        }
    }
    lines.join("\n")
}

/// This type's system prompt: static, so a prefix cache pays across requests.
pub fn system_prompt(kind: WireType) -> &'static str {
    static PROMPTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    let prompts = PROMPTS.get_or_init(|| WireType::ALL.into_iter().map(compose).collect());
    &prompts[WireType::ALL
        .iter()
        .position(|k| *k == kind)
        .expect("listed")]
}

pub fn corrective(kind: WireType) -> String {
    CORRECTIVE
        .trim_end()
        .replace("{correctiveSpec}", &kind.spec().corrective_spec)
}

/// Each known word as the prompt writes it: `term (reading)` where two cards
/// share a spelling, else bare.
pub fn known_labels(known: &[KnownItem]) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for item in known {
        *counts.entry(term_key(&item.term)).or_default() += 1;
    }
    known
        .iter()
        .map(|item| match non_blank(item.romanization.as_deref()) {
            Some(reading) if counts[&term_key(&item.term)] > 1 => {
                format!("{} ({reading})", item.term)
            }
            _ => item.term.clone(),
        })
        .collect()
}

/// Term → item id for citations by term. The wanted words claim a bare
/// spelling first; a qualified label names exactly its card.
pub fn term_index(args: &BatchArgs) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for want in &args.wants {
        index
            .entry(term_key(&want.item.term))
            .or_insert_with(|| want.item.id.clone());
    }
    let known = args.known_items.as_deref().unwrap_or_default();
    for (item, label) in known.iter().zip(known_labels(known)) {
        let bare = term_key(&item.term);
        index.entry(bare.clone()).or_insert_with(|| item.id.clone());
        let label = term_key(&label);
        if label != bare {
            index.insert(label, item.id.clone());
        }
    }
    index
}

/// The user payload. Key order matters: everything shared across a top-up's
/// requests comes first, `items` last, so a prefix cache pays for `known`.
fn payload(args: &BatchArgs, request: &TypeRequest) -> String {
    let profile = &args.profile;
    let mut out = Map::new();
    out.insert("native".into(), json!(profile.native_language));
    out.insert("target".into(), json!(profile.target_language));
    out.insert("level".into(), json!(profile.level));
    if let Some(topic) = non_blank(args.topic.as_deref()) {
        out.insert("topic".into(), json!(topic));
    }
    out.insert("interests".into(), json!(profile.interests));
    if let Some(about) = non_blank(profile.about.as_deref()) {
        out.insert("about".into(), json!(truncated(about, MAX_ABOUT_CHARS)));
    }
    if let Some(known) = args.known_items.as_deref().filter(|k| !k.is_empty()) {
        out.insert("known".into(), json!(known_labels(known)));
    }
    let items: Vec<Value> = request
        .wants
        .iter()
        .map(|want| {
            let mut entry = Map::new();
            entry.insert("id".into(), json!(want.item.id));
            entry.insert("t".into(), json!(want.item.term));
            if !want.item.meaning.is_empty() {
                entry.insert("m".into(), json!(want.item.meaning));
            }
            entry.extend(request.kind.params(want.length));
            Value::Object(entry)
        })
        .collect();
    out.insert("items".into(), Value::Array(items));
    Value::Object(out).to_string()
}

pub fn request_messages(args: &BatchArgs, request: &TypeRequest) -> Vec<Message> {
    vec![
        Message::System(system_prompt(request.kind).to_owned()),
        Message::User(payload(args, request)),
    ]
}

/// A reply's entries of this request's type. Anything else in it is not an entry.
fn parse_entries(raw: &str, kind: WireType) -> Result<Vec<Generated>> {
    let json: Value = serde_json::from_str(strip_fences(raw))
        .map_err(|_| bad("The model did not return JSON. Try again."))?;
    let entries = match json.get("challenges") {
        _ if !json.is_object() => None,
        None => Some(&[][..]),
        Some(Value::Array(entries)) => Some(entries.as_slice()),
        Some(_) => None,
    }
    .ok_or_else(|| bad("The model returned JSON in an unexpected shape. Try again."))?;
    Ok(entries
        .iter()
        .filter_map(|entry| serde_json::from_value::<Generated>(entry.clone()).ok())
        .filter(|generated| generated.kind() == kind)
        .collect())
}

/// The challenges that fill this request's brief, in brief order: the right
/// kind, about an entry's own word, each entry at most once.
fn fill_request(challenges: Vec<Challenge>, request: &TypeRequest) -> Vec<Challenge> {
    let mut filled: Vec<Option<Challenge>> = vec![None; request.wants.len()];
    for mut challenge in challenges {
        if kind_of(&challenge) != Some(request.kind) {
            continue;
        }
        let cites = |id: &str| challenge.item_ids().iter().any(|i| i == id);
        if let Some(at) =
            (0..filled.len()).find(|&i| filled[i].is_none() && cites(&request.wants[i].item.id))
        {
            // Judged at the length asked for; the row's correction learns the drift.
            challenge.set_asked_length(f64::from(request.wants[at].length));
            filled[at] = Some(challenge);
        }
    }
    filled.into_iter().flatten().collect()
}

/// The mock's reply to one request: that type's fixtures, one per want, bound
/// to the want's own word (and, where a type needs two, another the learner has).
fn mock_reply(args: &BatchArgs, request: &TypeRequest) -> String {
    let fixtures = &request.kind.spec().fixtures;
    let fixtures = if is_mandarin(&args.profile.target_language) {
        &fixtures.mandarin
    } else {
        &fixtures.spanish
    };
    let index = term_index(args);
    let known = args.known_items.as_deref().unwrap_or_default();
    let labels = known_labels(known);
    let candidates: Vec<&str> = args
        .wants
        .iter()
        .map(|want| want.item.term.as_str())
        .chain(labels.iter().map(String::as_str))
        .collect();
    let challenges: Vec<Value> = request
        .wants
        .iter()
        .enumerate()
        .map(|(i, want)| {
            let other = candidates
                .iter()
                .find(|term| {
                    index
                        .get(&term_key(term))
                        .is_some_and(|id| *id != want.item.id)
                })
                .copied()
                .unwrap_or("{other}");
            let mut challenge = fixtures[i % fixtures.len()].clone();
            fill(&mut challenge, &[("item", &want.item.id), ("other", other)]);
            challenge
        })
        .collect();
    fenced(&json!({ "challenges": challenges }))
}

#[derive(Default)]
struct Outcome {
    filled: Vec<Challenge>,
    error: Option<LlmError>,
}

struct Run<'a, T> {
    llm: &'a Llm<T>,
    args: &'a BatchArgs,
    item_ref: &'a dyn Fn(&str) -> Option<String>,
    fatal: RefCell<Option<LlmError>>,
    retry_announced: Cell<bool>,
}

impl<T: Transport> Run<'_, T> {
    async fn request(&self, request: &TypeRequest<'_>, mut rng: Rng) -> Outcome {
        let mut outcome = Outcome::default();
        let messages = request_messages(self.args, request);
        let schema = batch_schema(request.kind);
        let name = format!("lesson_{}", request.kind.as_str());
        let minimum = request.wants.len().div_ceil(2).max(1);

        for attempt in 0..2 {
            if self.fatal.borrow().is_some() {
                return outcome;
            }
            let mut messages = messages.clone();
            if attempt > 0 {
                messages.push(Message::User(corrective(request.kind)));
                if !self.retry_announced.replace(true) {
                    self.llm.report(ProgressStepId::Retry, "Retrying a request");
                }
            }
            let chat = ChatRequest {
                messages,
                schema: Some((name.clone(), schema.clone())),
                temperature: Some(0.7),
                reasoning_effort: self.args.reasoning_effort.clone(),
                ..ChatRequest::default()
            };
            let reply = self
                .llm
                .complete_or_mock(&chat, || mock_reply(self.args, request))
                .await
                .and_then(|completion| parse_entries(&completion.content, request.kind));
            let entries = match reply {
                Ok(entries) => entries,
                Err(error) if error.kind == ErrorKind::BadResponse => {
                    outcome.error = Some(error);
                    continue;
                }
                Err(error) => {
                    self.fatal.borrow_mut().get_or_insert(error);
                    return outcome;
                }
            };
            let mut resolver = Resolver {
                item_ref: self.item_ref,
                rng: &mut rng,
            };
            let resolved = entries
                .into_iter()
                .filter_map(|generated| resolve(generated, &mut resolver))
                .collect();
            let filled = fill_request(resolved, request);
            if filled.len() >= minimum {
                return Outcome {
                    filled,
                    error: None,
                };
            }
            outcome.error = Some(bad(format!(
                "One request filled {} of its {} {} challenges.",
                filled.len(),
                request.wants.len(),
                request.kind.as_str()
            )));
            // The best partial reply is kept: it is still paid-for content.
            if filled.len() > outcome.filled.len() {
                outcome.filled = filled;
            }
        }
        outcome
    }
}

pub async fn generate_batch<T: Transport>(llm: &Llm<T>, args: &BatchArgs) -> Result<BatchResult> {
    generate_batch_with(llm, args, Rng::from_entropy()).await
}

pub async fn generate_batch_with<T: Transport>(
    llm: &Llm<T>,
    args: &BatchArgs,
    mut rng: Rng,
) -> Result<BatchResult> {
    let per_request = args.items_per_request.map_or(REQUEST_ITEMS, |n| n as usize);
    let requests = group_into_requests(&args.wants, per_request);
    if requests.is_empty() {
        return Err(bad(
            "There is nothing to write: no challenges were asked for.",
        ));
    }
    let total: usize = requests.iter().map(|r| r.wants.len()).sum();
    llm.report(
        ProgressStepId::BuildPrompt,
        if requests.len() > 1 {
            format!("Preparing {total} challenges")
        } else {
            "Building the prompt".to_owned()
        },
    );

    let wanted: HashSet<&str> = args.wants.iter().map(|w| w.item.id.as_str()).collect();
    let index = term_index(args);
    let item_ref = |reference: &str| {
        index
            .get(&term_key(reference))
            .cloned()
            .or_else(|| wanted.contains(reference).then(|| reference.to_owned()))
    };
    let run = Run {
        llm,
        args,
        item_ref: &item_ref,
        fatal: RefCell::new(None),
        retry_announced: Cell::new(false),
    };

    let model = llm.model().unwrap_or("practice-mode content");
    llm.report(
        ProgressStepId::Request,
        if requests.len() > 1 {
            format!("Waiting for {model} ({} requests)", requests.len())
        } else {
            format!("Waiting for {model}")
        },
    );
    let seeds: Vec<u64> = requests.iter().map(|_| rng.next_u64()).collect();
    let outcomes: Vec<Outcome> = stream::iter(requests.iter().zip(seeds))
        .map(|(request, seed)| run.request(request, Rng::seeded(seed)))
        .buffered(REQUEST_CONCURRENCY)
        .collect()
        .await;
    if let Some(error) = run.fatal.into_inner() {
        return Err(error);
    }

    llm.report(ProgressStepId::Validate, "Validating challenges");
    let mut challenges = Vec::new();
    let mut failed_requests = 0;
    let mut last_error = None;
    for outcome in outcomes {
        if let Some(error) = outcome.error {
            if outcome.filled.is_empty() {
                failed_requests += 1;
            }
            last_error = Some(error);
        }
        challenges.extend(outcome.filled);
    }
    if challenges.is_empty() {
        let all = if requests.len() > 1 {
            format!(" — all {} requests failed", requests.len())
        } else {
            String::new()
        };
        let detail = last_error.map_or(String::new(), |e| format!(" ({})", e.message));
        return Err(bad(format!(
            "Nothing usable came back{all}. Try again.{detail}"
        )));
    }
    Ok(BatchResult {
        challenges,
        failed_requests,
        usage: llm.usage(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::fake::{ok, status};
    use crate::client::{Endpoint, HttpRequest, HttpResponse, ProgressStep};
    use pollster::block_on;
    use sapling_domain::types::Level;
    use std::future::{ready, Future};
    use std::rc::Rc;

    /// Answers each POST by the request's schema name, and logs every body.
    struct Scripted<F> {
        answer: F,
        bodies: RefCell<Vec<Value>>,
    }

    impl<F: Fn(&str, usize) -> std::result::Result<HttpResponse, String>> Transport for &Scripted<F> {
        fn post(
            &self,
            request: HttpRequest,
        ) -> impl Future<Output = std::result::Result<HttpResponse, String>> {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let name = body["response_format"]["json_schema"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let attempt = body["messages"].as_array().unwrap().len() - 2;
            self.bodies.borrow_mut().push(body);
            ready((self.answer)(&name, attempt))
        }
    }

    fn scripted<F>(answer: F) -> Scripted<F> {
        Scripted {
            answer,
            bodies: RefCell::default(),
        }
    }

    fn live<F>(transport: &Scripted<F>) -> Llm<&Scripted<F>>
    where
        for<'a> &'a Scripted<F>: Transport,
    {
        Llm::new(
            transport,
            Some(Endpoint {
                api_key: "k".into(),
                model: "test/model".into(),
                base_url: None,
            }),
        )
    }

    fn reply(challenges: Value) -> std::result::Result<HttpResponse, String> {
        Ok(ok(json!({
            "choices": [{ "message": { "content": json!({ "challenges": challenges }).to_string() } }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 },
        })))
    }

    fn profile(target: &str) -> LearnerProfile {
        LearnerProfile {
            native_language: "English".into(),
            target_language: target.into(),
            level: Level::Beginner,
            interests: vec!["food".into()],
            about: None,
        }
    }

    fn want(id: &str, term: &str, kind: WireType, length: u8) -> Want {
        Want {
            item: WantItem {
                id: id.into(),
                term: term.into(),
                meaning: format!("meaning of {term}"),
            },
            kind: ChallengeKind { kind },
            length,
        }
    }

    fn args(wants: Vec<Want>) -> BatchArgs {
        BatchArgs {
            profile: profile("Spanish"),
            wants,
            known_items: None,
            topic: None,
            items_per_request: None,
            reasoning_effort: None,
        }
    }

    fn native(id: &str, text: &str) -> Value {
        json!({ "type": "translate-to-native", "prompt": { "text": text, "reading": null },
            "answersNative": ["an answer"], "itemIds": [id], "explanation": null })
    }

    fn run<T: Transport>(llm: &Llm<T>, args: &BatchArgs) -> Result<BatchResult> {
        block_on(generate_batch_with(llm, args, Rng::seeded(3)))
    }

    #[test]
    fn requests_are_cut_by_kind_and_never_ask_twice_about_a_word() {
        let wants = vec![
            want("a", "x", WireType::Cloze, 2),
            want("b", "y", WireType::RecognizeMc, 1),
            want("a", "x", WireType::Cloze, 3),
            want("c", "z", WireType::Cloze, 2),
            want("d", "w", WireType::Cloze, 2),
        ];
        let requests = group_into_requests(&wants, 2);
        let shape: Vec<(WireType, Vec<&str>)> = requests
            .iter()
            .map(|r| (r.kind, r.wants.iter().map(|w| w.item.id.as_str()).collect()))
            .collect();
        assert_eq!(
            shape,
            [
                (WireType::Cloze, vec!["a", "c"]),
                (WireType::RecognizeMc, vec!["b"]),
                (WireType::Cloze, vec!["d"]),
            ]
        );
        assert!(group_into_requests(&[], 6).is_empty());
    }

    #[test]
    fn a_system_prompt_is_about_its_own_type_only() {
        for kind in WireType::ALL {
            let prompt = system_prompt(kind);
            let spec = kind.spec();
            assert!(prompt.contains(&spec.prompt_spec) && prompt.contains(&spec.params_spec));
            if let Some(rules) = &spec.rules_spec {
                assert_eq!(prompt.matches(rules.as_str()).count(), 1);
            }
            assert!(!prompt.contains('{') || !prompt.contains("{type}"));
            assert_eq!(
                prompt.contains("- instruction: a short heading"),
                has_instruction(kind)
            );
            for other in WireType::ALL.into_iter().filter(|o| *o != kind) {
                let quoted = format!("\"{}\"", other.as_str());
                assert!(!prompt.contains(&quoted), "{kind:?} names {other:?}");
            }
            assert!(corrective(kind).contains(&spec.corrective_spec));
        }
    }

    #[test]
    fn the_payload_sends_sizes_shared_blocks_first_and_ids_never_for_known() {
        let mut batch = args(vec![
            want("a", "la cuenta", WireType::MultiCloze, 14),
            want("b", "pedir", WireType::MultiCloze, 1),
        ]);
        batch.topic = Some(" restaurant ".into());
        batch.profile.about = Some("x".repeat(600));
        batch.known_items = Some(vec![
            KnownItem {
                id: "k1".into(),
                term: "长".into(),
                romanization: Some("cháng".into()),
            },
            KnownItem {
                id: "k2".into(),
                term: "长".into(),
                romanization: Some("zhǎng".into()),
            },
            KnownItem {
                id: "k3".into(),
                term: "agua".into(),
                romanization: Some("agua".into()),
            },
        ]);
        let requests = group_into_requests(&batch.wants, 6);
        let payload: Value = serde_json::from_str(&payload(&batch, &requests[0])).unwrap();
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "native",
                "target",
                "level",
                "topic",
                "interests",
                "about",
                "known",
                "items"
            ]
        );
        assert_eq!(payload["topic"], "restaurant");
        assert_eq!(payload["about"].as_str().unwrap().len(), MAX_ABOUT_CHARS);
        assert_eq!(
            payload["known"],
            json!(["长 (cháng)", "长 (zhǎng)", "agua"])
        );
        assert_eq!(
            payload["items"][0],
            json!({ "id": "a", "t": "la cuenta", "m": "meaning of la cuenta", "words": 14, "gaps": 3 })
        );
        assert!(!payload.to_string().contains("k1"));
        assert!(!payload.to_string().contains("difficulty"));

        let index = term_index(&batch);
        assert_eq!(index["长 (zhǎng)"], "k2");
        assert_eq!(index["长"], "k1");
        assert_eq!(index["pedir"], "b");
    }

    #[test]
    fn a_top_up_fans_out_and_comes_back_in_request_order() {
        let transport = scripted(|name: &str, _| match name {
            "lesson_translate-to-native" => reply(json!([
                native("b", "dos"),
                native("a", "uno"),
                native("zzz", "x")
            ])),
            "lesson_spot-error" => reply(json!([{
                "type": "spot-error", "words": [{"text":"Quiero","reading":null},{"text":"pedir","reading":null},{"text":"sopa.","reading":null}],
                "wrongWord": {"text":"pagar","reading":null}, "wrongPosition": 1, "meaningNative": "I want to order soup.",
                "itemIds": ["pedir"], "explanation": null
            }])),
            other => panic!("unexpected {other}"),
        });
        let llm = live(&transport);
        let steps = Rc::new(RefCell::new(Vec::new()));
        let seen = steps.clone();
        let llm =
            llm.with_progress(move |step: &ProgressStep| seen.borrow_mut().push(step.clone()));
        let mut batch = args(vec![
            want("a", "uno", WireType::TranslateToNative, 1),
            want("b", "dos", WireType::TranslateToNative, 1),
            want("c", "pedir", WireType::SpotError, 2),
        ]);
        batch.reasoning_effort = Some("low".into());
        let result = run(&llm, &batch).unwrap();

        let stored: Vec<Value> = result
            .challenges
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect();
        let prompts: Vec<&str> = stored
            .iter()
            .map(|c| c["prompt"].as_str().or(c["tokens"][0].as_str()).unwrap())
            .collect();
        assert_eq!(prompts, ["uno", "dos", "Quiero"]);
        assert_eq!(result.challenges[2].item_ids(), ["c"]);
        assert_eq!(result.failed_requests, 0);
        assert_eq!(
            result.usage,
            TokenUsage {
                prompt_tokens: 20,
                completion_tokens: 10,
                requests: 2
            }
        );
        let ids: Vec<ProgressStepId> = steps.borrow().iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            [
                ProgressStepId::BuildPrompt,
                ProgressStepId::Request,
                ProgressStepId::Validate
            ]
        );
        assert_eq!(
            steps.borrow()[1].label,
            "Waiting for test/model (2 requests)"
        );

        let body = &transport.bodies.borrow()[0];
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(
            body["messages"][0]["content"],
            system_prompt(WireType::TranslateToNative)
        );
    }

    #[test]
    fn a_thin_reply_is_retried_once_with_the_corrective_line() {
        let transport = scripted(|_: &str, attempt| match attempt {
            0 => Ok(ok(
                json!({ "choices": [{ "message": { "content": "not json" } }] }),
            )),
            _ => reply(json!([native("a", "uno")])),
        });
        let llm = live(&transport);
        let result = run(
            &llm,
            &args(vec![want("a", "uno", WireType::TranslateToNative, 1)]),
        )
        .unwrap();
        assert_eq!(result.challenges.len(), 1);
        let bodies = transport.bodies.borrow();
        assert_eq!(bodies.len(), 2);
        assert_eq!(
            bodies[1]["messages"][2]["content"],
            corrective(WireType::TranslateToNative)
        );
    }

    #[test]
    fn a_failed_request_is_dropped_and_counted_and_only_all_failing_is_an_error() {
        let transport = scripted(|name: &str, _| match name {
            "lesson_cloze" => reply(json!([native("a", "wrong type")])),
            _ => reply(json!([native("b", "dos")])),
        });
        let llm = live(&transport);
        let result = run(
            &llm,
            &args(vec![
                want("a", "uno", WireType::Cloze, 2),
                want("b", "dos", WireType::TranslateToNative, 1),
            ]),
        )
        .unwrap();
        assert_eq!(result.challenges.len(), 1);
        assert_eq!(result.failed_requests, 1);
        assert_eq!(transport.bodies.borrow().len(), 3);

        let transport = scripted(|_: &str, _| reply(json!([])));
        let error = run(
            &live(&transport),
            &args(vec![
                want("a", "uno", WireType::Cloze, 2),
                want("b", "dos", WireType::TranslateToNative, 1),
            ]),
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::BadResponse);
        assert!(
            error.message.contains("all 2 requests failed"),
            "{}",
            error.message
        );
    }

    #[test]
    fn a_rate_limit_ends_the_top_up_and_nothing_queued_is_sent() {
        let transport = scripted(|_: &str, _| Ok(status(429, "slow down")));
        let wants: Vec<Want> = [
            WireType::Cloze,
            WireType::RecognizeMc,
            WireType::SpotError,
            WireType::WordOrder,
            WireType::ProduceMc,
        ]
        .into_iter()
        .map(|kind| want("a", "uno", kind, 2))
        .collect();
        let error = run(&live(&transport), &args(wants)).unwrap_err();
        assert_eq!(error.kind, ErrorKind::RateLimit);
        assert_eq!(transport.bodies.borrow().len(), 1);
    }

    #[test]
    fn nothing_wanted_is_said_before_any_step() {
        let steps = Rc::new(Cell::new(0));
        let count = steps.clone();
        let transport = scripted(|_: &str, _| unreachable!());
        let llm = Llm::new(&transport, None).with_progress(move |_| count.set(count.get() + 1));
        let error = run(&llm, &args(vec![])).unwrap_err();
        assert!(error.message.contains("nothing to write"));
        assert_eq!(steps.get(), 0);
    }

    #[test]
    fn the_mock_writes_every_kind_through_the_real_path() {
        let transport = scripted(|_: &str, _| unreachable!());
        let mock = Llm::new(&transport, None);
        for target in ["Spanish", "Chinese"] {
            let mut batch = args(
                WireType::ALL
                    .into_iter()
                    .map(|kind| want("a", "uno", kind, 3))
                    .collect(),
            );
            batch.profile = profile(target);
            batch.known_items = Some(vec![KnownItem {
                id: "k".into(),
                term: "dos".into(),
                romanization: None,
            }]);
            let result = run(&mock, &batch).unwrap();
            let kinds: Vec<WireType> = result
                .challenges
                .iter()
                .map(|c| kind_of(c).unwrap())
                .collect();
            assert_eq!(kinds, WireType::ALL, "{target}");
            for (challenge, kind) in result.challenges.iter().zip(kinds) {
                assert!(challenge.item_ids().contains(&"a".to_owned()));
                assert_eq!(challenge.check_shape(), Ok(()), "{kind:?}");
                // Stamped with the length asked for, whatever the fixture's own.
                assert_eq!(challenge.asked_length(), Some(3.0), "{kind:?}");
            }
            assert_eq!(result.challenges[7].item_ids(), ["a", "k"]);
            assert_eq!(result.usage, TokenUsage::default());
        }
        assert!(transport.bodies.borrow().is_empty());
    }

    #[test]
    fn the_mock_has_no_second_word_for_a_multi_cloze_of_one() {
        let transport = scripted(|_: &str, _| unreachable!());
        let mock = Llm::new(&transport, None);
        let error = run(
            &mock,
            &args(vec![want("a", "uno", WireType::MultiCloze, 3)]),
        )
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::BadResponse);
    }

    #[test]
    fn a_citation_by_label_lands_on_that_card() {
        let transport = scripted(|_: &str, _| reply(json!([native("长 (zhǎng)", "长")])));
        let mut batch = args(vec![want("a", "高", WireType::TranslateToNative, 1)]);
        batch.known_items = Some(vec![
            KnownItem {
                id: "k1".into(),
                term: "长".into(),
                romanization: Some("cháng".into()),
            },
            KnownItem {
                id: "k2".into(),
                term: "长".into(),
                romanization: Some("zhǎng".into()),
            },
        ]);
        // Cites only a known word, not the wanted one: it fills nothing.
        let error = run(&live(&transport), &batch).unwrap_err();
        assert!(
            error.message.contains("filled 0 of its 1"),
            "{}",
            error.message
        );

        let index = term_index(&batch);
        let resolve_ref = |r: &str| index.get(&term_key(r)).cloned();
        assert_eq!(resolve_ref("长 (zhǎng)").as_deref(), Some("k2"));
        assert_eq!(resolve_ref("长").as_deref(), Some("k1"));
    }
}
