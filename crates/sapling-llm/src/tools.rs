//! The assistant's tools: what a model may do to the learner's word list, and
//! the loop that lets it. Every read and write goes through a [`ToolContext`]
//! the host lends, so the store stays the host's and every write is its event.
//!
//! A domain failure (no such word, bad arguments) is a result the model reads,
//! never an error; only the store failing ends the call.

use std::cell::{Cell, RefCell};
use std::future::{ready, Future};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

use sapling_domain::types::{ConversationAction, ItemKind, KnowledgeItem};

use crate::client::{ChatRequest, Completion, Llm, LlmError, Message, Tool, ToolCall, Transport};
use crate::json::inline_schema;
use crate::text::{reading_key, same_card, term_key};

/// The store failing under a tool: the call ends, the model never sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreError(pub String);

pub type StoreResult<T> = std::result::Result<T, StoreError>;

/// Why a tool-calling turn failed.
#[derive(Debug)]
pub enum LoopError {
    Model(LlmError),
    Store(StoreError),
}

impl From<LlmError> for LoopError {
    fn from(error: LlmError) -> Self {
        LoopError::Model(error)
    }
}

impl From<StoreError> for LoopError {
    fn from(error: StoreError) -> Self {
        LoopError::Store(error)
    }
}

/// Everything a tool may touch beyond its arguments.
pub trait ToolContext {
    fn all_items(&self) -> impl Future<Output = StoreResult<Vec<KnowledgeItem>>>;
    fn upsert_items(&self, items: Vec<KnowledgeItem>) -> impl Future<Output = StoreResult<()>>;
    fn delete_item(&self, id: &str) -> impl Future<Output = StoreResult<()>>;
    fn new_id(&self) -> String;
    /// Epoch milliseconds.
    fn now(&self) -> f64;
}

/// A word list in memory, for tests and hosts without a store.
#[derive(Default)]
pub struct MemoryTools {
    pub items: RefCell<Vec<KnowledgeItem>>,
    minted: Cell<u32>,
}

impl MemoryTools {
    pub fn new(items: Vec<KnowledgeItem>) -> Self {
        MemoryTools {
            items: RefCell::new(items),
            minted: Cell::new(0),
        }
    }
}

impl ToolContext for MemoryTools {
    fn all_items(&self) -> impl Future<Output = StoreResult<Vec<KnowledgeItem>>> {
        ready(Ok(self.items.borrow().clone()))
    }

    fn upsert_items(&self, items: Vec<KnowledgeItem>) -> impl Future<Output = StoreResult<()>> {
        let mut held = self.items.borrow_mut();
        for item in items {
            match held.iter_mut().find(|other| other.id == item.id) {
                Some(other) => *other = item,
                None => held.push(item),
            }
        }
        ready(Ok(()))
    }

    fn delete_item(&self, id: &str) -> impl Future<Output = StoreResult<()>> {
        self.items.borrow_mut().retain(|item| item.id != id);
        ready(Ok(()))
    }

    fn new_id(&self) -> String {
        self.minted.set(self.minted.get() + 1);
        format!("id-{}", self.minted.get())
    }

    fn now(&self) -> f64 {
        1_700_000_000_000.0
    }
}

/// What one call did: `result` goes back to the model, `summary` to the learner.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
pub struct ToolOutcome {
    #[ts(type = "unknown")]
    pub result: Value,
    pub summary: String,
    pub ok: bool,
}

fn failure(message: impl Into<String>) -> ToolOutcome {
    let message = message.into();
    ToolOutcome {
        result: json!({ "error": message }),
        summary: message,
        ok: false,
    }
}

fn done(result: Value, summary: String) -> ToolOutcome {
    ToolOutcome {
        result,
        summary,
        ok: true,
    }
}

pub const MAX_WORDS_PER_CALL: usize = 50;
pub const ALREADY_PRESENT: &str = "already in the word list";
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum WordKind {
    Vocab,
    Grammar,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct NewWord {
    pub term: String,
    pub meaning: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notes: Option<String>,
    /// Vocabulary unless said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<WordKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct AddWordsParams {
    #[schemars(length(min = 1, max = 50))]
    pub words: Vec<NewWord>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListWordsParams {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    limit: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct WordFields {
    #[serde(default)]
    term: Option<String>,
    #[serde(default)]
    meaning: Option<String>,
    #[serde(default)]
    romanization: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct UpdateWordParams {
    term: String,
    /// Which homograph, not the new value.
    #[serde(default)]
    romanization: Option<String>,
    fields: WordFields,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RemoveWordParams {
    term: String,
    #[serde(default)]
    romanization: Option<String>,
}

/// Every tool, in the order the model is shown them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolName {
    AddWords,
    ListWords,
    UpdateWord,
    RemoveWord,
}

impl ToolName {
    pub const ALL: [ToolName; 4] = [
        ToolName::AddWords,
        ToolName::ListWords,
        ToolName::UpdateWord,
        ToolName::RemoveWord,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ToolName::AddWords => "add_words",
            ToolName::ListWords => "list_words",
            ToolName::UpdateWord => "update_word",
            ToolName::RemoveWord => "remove_word",
        }
    }

    /// Optional arguments stay optional: this is not a strict reply schema.
    pub fn tool(self) -> Tool {
        let (description, parameters) = match self {
            ToolName::AddWords => (
                include_str!("../prompts/tool-add-words.txt"),
                inline_schema::<AddWordsParams>(),
            ),
            ToolName::ListWords => (
                include_str!("../prompts/tool-list-words.txt"),
                inline_schema::<ListWordsParams>(),
            ),
            ToolName::UpdateWord => (
                include_str!("../prompts/tool-update-word.txt"),
                inline_schema::<UpdateWordParams>(),
            ),
            ToolName::RemoveWord => (
                include_str!("../prompts/tool-remove-word.txt"),
                inline_schema::<RemoveWordParams>(),
            ),
        };
        Tool {
            name: self.as_str().to_owned(),
            description: description.trim().to_owned(),
            parameters,
        }
    }
}

/// Runs one call the model asked for, if `offered` holds it.
pub async fn execute<C: ToolContext>(
    call: &ToolCall,
    ctx: &C,
    offered: &[ToolName],
) -> StoreResult<ToolOutcome> {
    let Some(name) = offered.iter().find(|tool| tool.as_str() == call.name) else {
        return Ok(failure(format!("no tool named {}", call.name)));
    };
    let raw = match call.arguments.trim() {
        "" => "{}",
        raw => raw,
    };
    macro_rules! parsed {
        () => {
            match serde_json::from_str(raw) {
                Ok(params) => params,
                Err(error) => return Ok(failure(format!("invalid arguments: {error}"))),
            }
        };
    }
    match name {
        ToolName::AddWords => add_words(&parsed!(), ctx).await,
        ToolName::ListWords => list_words(&parsed!(), ctx).await,
        ToolName::UpdateWord => update_word(&parsed!(), ctx).await,
        ToolName::RemoveWord => remove_word(&parsed!(), ctx).await,
    }
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn count_words(n: usize) -> String {
    format!("{n} word{}", if n == 1 { "" } else { "s" })
}

fn word_view(item: &KnowledgeItem) -> Value {
    let mut view = json!({ "term": item.term, "meaning": item.meaning });
    if let Some(romanization) = &item.romanization {
        view["romanization"] = json!(romanization);
    }
    if let Some(notes) = &item.notes {
        view["notes"] = json!(notes);
    }
    view
}

/// No card: the core folds one from `introducedAt`. Dedupes against the list
/// and within the batch, by card rather than by spelling.
pub async fn add_words<C: ToolContext>(
    params: &AddWordsParams,
    ctx: &C,
) -> StoreResult<ToolOutcome> {
    if params.words.is_empty() || params.words.len() > MAX_WORDS_PER_CALL {
        return Ok(failure(format!(
            "invalid arguments: words: send 1 to {MAX_WORDS_PER_CALL} words"
        )));
    }
    if params
        .words
        .iter()
        .any(|word| word.term.trim().is_empty() || word.meaning.trim().is_empty())
    {
        return Ok(failure(
            "invalid arguments: words: every word needs a term and a meaning",
        ));
    }

    let mut taken: Vec<(String, Option<String>)> = ctx
        .all_items()
        .await?
        .into_iter()
        .map(|item| (item.term, item.romanization))
        .collect();
    let mut added: Vec<KnowledgeItem> = Vec::new();
    let mut skipped = Vec::new();

    for word in &params.words {
        let term = word.term.trim().to_owned();
        let romanization = trimmed(word.romanization.as_deref());
        let card = (term.as_str(), romanization.as_deref());
        if taken
            .iter()
            .any(|(t, r)| same_card((t.as_str(), r.as_deref()), card))
        {
            skipped.push(json!({ "term": term, "reason": ALREADY_PRESENT }));
            continue;
        }
        taken.push((term.clone(), romanization.clone()));
        added.push(KnowledgeItem {
            id: ctx.new_id(),
            kind: match word.kind {
                Some(WordKind::Grammar) => ItemKind::Grammar,
                _ => ItemKind::Vocab,
            },
            term,
            meaning: word.meaning.trim().to_owned(),
            romanization,
            notes: trimmed(word.notes.as_deref()),
            introduced_at: ctx.now(),
            fsrs_card: Value::Null,
            srs: None,
            review_count: None,
            correct_count: None,
            recent_grades: None,
            history: Vec::new(),
        });
    }

    let terms: Vec<String> = added.iter().map(|item| item.term.clone()).collect();
    let summary = if terms.is_empty() {
        format!(
            "Nothing added: {} already in the list",
            count_words(skipped.len())
        )
    } else {
        let mut summary = format!("Added {}: {}", count_words(terms.len()), terms.join(", "));
        if !skipped.is_empty() {
            summary.push_str(&format!("; skipped {} already in the list", skipped.len()));
        }
        summary
    };
    if !added.is_empty() {
        ctx.upsert_items(added).await?;
    }
    Ok(done(json!({ "added": terms, "skipped": skipped }), summary))
}

async fn list_words<C: ToolContext>(params: &ListWordsParams, ctx: &C) -> StoreResult<ToolOutcome> {
    let items = ctx.all_items().await?;
    let query = trimmed(params.query.as_deref());
    let needle = query.as_deref().map(str::to_lowercase);
    let found: Vec<&KnowledgeItem> = items
        .iter()
        .filter(|item| match &needle {
            None => true,
            Some(needle) => [
                item.term.as_str(),
                item.meaning.as_str(),
                item.romanization.as_deref().unwrap_or_default(),
            ]
            .join("\n")
            .to_lowercase()
            .contains(needle.as_str()),
        })
        .collect();

    let limit = params.limit.map_or(DEFAULT_LIMIT, |limit| {
        limit.floor().clamp(1.0, MAX_LIMIT as f64) as usize
    });
    let entries: Vec<Value> = found
        .iter()
        .take(limit)
        .map(|item| {
            let mut view = word_view(item);
            view["reviews"] = json!(item.review_count.unwrap_or(item.history.len() as f64));
            view
        })
        .collect();

    let summary = match &query {
        Some(query) => format!("Found {} matching \"{query}\"", count_words(found.len())),
        None => format!("Read the list: {}", count_words(found.len())),
    };
    Ok(done(
        json!({ "total": found.len(), "showing": entries.len(), "entries": entries }),
        summary,
    ))
}

/// The one item `term` names — `romanization` picks between homographs — or
/// why there is none. Ambiguity is a miss, never a guess.
fn find_by_term<'a>(
    items: &'a [KnowledgeItem],
    term: &str,
    romanization: Option<&str>,
) -> Result<&'a KnowledgeItem, String> {
    let key = term_key(term);
    let candidates: Vec<&KnowledgeItem> = items
        .iter()
        .filter(|item| term_key(&item.term) == key)
        .collect();
    let term = term.trim();
    match candidates.as_slice() {
        [] => return Err(format!("no word \"{term}\" in the list")),
        [only] => return Ok(only),
        _ => {}
    }
    let readings = candidates
        .iter()
        .map(|item| item.romanization.as_deref().unwrap_or("(no romanization)"))
        .collect::<Vec<_>>()
        .join(", ");
    let Some(reading) = romanization else {
        return Err(format!(
            "\"{term}\" is in the list {} times ({readings}); pass \"romanization\" to say which one you mean",
            candidates.len()
        ));
    };
    let wanted = reading_key(reading);
    candidates
        .into_iter()
        .find(|item| item.romanization.as_deref().map(reading_key) == Some(wanted.clone()))
        .ok_or_else(|| {
            format!(
                "no word \"{term}\" with romanization \"{reading}\" in the list; it has {readings}"
            )
        })
}

/// A content edit: the card and its history are never touched. `null` leaves
/// a field alone; an empty string clears `romanization` or `notes`.
async fn update_word<C: ToolContext>(
    params: &UpdateWordParams,
    ctx: &C,
) -> StoreResult<ToolOutcome> {
    let items = ctx.all_items().await?;
    let selector = trimmed(params.romanization.as_deref());
    let item = match find_by_term(&items, &params.term, selector.as_deref()) {
        Ok(item) => item,
        Err(miss) => return Ok(failure(miss)),
    };

    let mut merged = item.clone();
    let mut changed: Vec<&str> = Vec::new();
    let fields = &params.fields;
    for (key, given, slot) in [
        ("term", &fields.term, &mut merged.term),
        ("meaning", &fields.meaning, &mut merged.meaning),
    ] {
        if let Some(next) = trimmed(given.as_deref()) {
            if next != *slot {
                *slot = next;
                changed.push(key);
            }
        }
    }
    for (key, given, slot) in [
        (
            "romanization",
            &fields.romanization,
            &mut merged.romanization,
        ),
        ("notes", &fields.notes, &mut merged.notes),
    ] {
        let Some(given) = given else { continue };
        let next = trimmed(Some(given.as_str()));
        if next != *slot {
            *slot = next;
            changed.push(key);
        }
    }
    if changed.is_empty() {
        return Ok(failure(format!(
            "nothing to change on \"{}\": no new values given",
            item.term
        )));
    }

    let card = (merged.term.as_str(), merged.romanization.as_deref());
    if items.iter().any(|other| {
        other.id != item.id && same_card((&other.term, other.romanization.as_deref()), card)
    }) {
        let reading = merged
            .romanization
            .as_ref()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default();
        return Ok(failure(format!(
            "\"{}\"{reading} would collide with a word already in the list; give it a romanization that tells them apart, or leave it as it is",
            merged.term
        )));
    }

    let summary = format!("Updated {} ({})", item.term, changed.join(", "));
    let result = json!({ "updated": word_view(&merged), "changed": changed });
    ctx.upsert_items(vec![merged]).await?;
    Ok(done(result, summary))
}

/// Single-word on purpose: a model has to name every deletion.
async fn remove_word<C: ToolContext>(
    params: &RemoveWordParams,
    ctx: &C,
) -> StoreResult<ToolOutcome> {
    let items = ctx.all_items().await?;
    let selector = trimmed(params.romanization.as_deref());
    let item = match find_by_term(&items, &params.term, selector.as_deref()) {
        Ok(item) => item,
        Err(miss) => return Ok(failure(miss)),
    };
    ctx.delete_item(&item.id).await?;
    Ok(done(
        json!({ "removed": item.term }),
        format!("Removed {}", item.term),
    ))
}

/// What a tool loop ends with: the last thing the model said, and every call it made.
pub(crate) struct Ran {
    pub said: Option<String>,
    pub actions: Vec<ConversationAction>,
}

/// Ask, run what the model called, ask again, for at most `rounds` rounds.
/// With `bare_last` the last round offers no tools, so it must answer. In mock
/// mode `mock` plays the model, from the messages so far.
pub(crate) async fn run<T: Transport, C: ToolContext>(
    llm: &Llm<T>,
    ctx: &C,
    mut request: ChatRequest,
    offered: &[ToolName],
    rounds: usize,
    bare_last: bool,
    mock: impl Fn(&[Message]) -> Completion,
) -> Result<Ran, LoopError> {
    let tools: Vec<Tool> = offered.iter().map(|name| name.tool()).collect();
    let mut ran = Ran {
        said: None,
        actions: Vec::new(),
    };
    for round in 0..rounds {
        request.tools = if bare_last && round + 1 == rounds {
            Vec::new()
        } else {
            tools.clone()
        };
        let completion = llm
            .complete_or(&request, || mock(&request.messages))
            .await?;
        if !completion.content.trim().is_empty() {
            ran.said = Some(completion.content.clone());
        }
        if completion.tool_calls.is_empty() {
            break;
        }
        request.messages.push(Message::Assistant {
            content: completion.content,
            tool_calls: completion.tool_calls.clone(),
        });
        for call in completion.tool_calls {
            let outcome = execute(&call, ctx, offered).await?;
            ran.actions.push(ConversationAction {
                tool: call.name,
                summary: outcome.summary,
                ok: outcome.ok,
            });
            request.messages.push(Message::Tool {
                content: outcome.result.to_string(),
                tool_call_id: call.id,
            });
        }
    }
    Ok(ran)
}

/// `term = meaning` lines (also `:` or ` - `, an optional leading `add`): what
/// the mocks turn into a real `add_words` call.
pub(crate) fn word_lines(text: &str) -> Vec<NewWord> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("add ").unwrap_or(line);
            let split = line.char_indices().skip(1).find_map(|(i, c)| match c {
                '=' | ':' => Some((i, i + 1)),
                ' ' if line[i..].starts_with(" - ") => Some((i, i + 3)),
                _ => None,
            })?;
            let term = line[..split.0].trim();
            let meaning = line[split.1..].trim();
            (!term.is_empty() && !meaning.is_empty() && term.split_whitespace().count() <= 4).then(
                || NewWord {
                    term: term.to_owned(),
                    meaning: meaning.to_owned(),
                    romanization: None,
                    notes: None,
                    kind: None,
                },
            )
        })
        .take(MAX_WORDS_PER_CALL)
        .collect()
}

/// A tool call the mock makes.
pub(crate) fn mock_call(name: ToolName, arguments: Value) -> Completion {
    Completion {
        content: String::new(),
        tool_calls: vec![ToolCall {
            id: "mock-call".to_owned(),
            name: name.as_str().to_owned(),
            arguments: arguments.to_string(),
        }],
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use pollster::block_on;

    pub fn item(id: &str, term: &str, romanization: Option<&str>) -> KnowledgeItem {
        KnowledgeItem {
            id: id.into(),
            kind: ItemKind::Vocab,
            term: term.into(),
            meaning: format!("meaning of {term}"),
            romanization: romanization.map(str::to_owned),
            notes: None,
            introduced_at: 1.0,
            fsrs_card: Value::Null,
            srs: None,
            review_count: Some(3.0),
            correct_count: None,
            recent_grades: None,
            history: Vec::new(),
        }
    }

    fn call(ctx: &MemoryTools, name: &str, arguments: Value) -> ToolOutcome {
        let call = ToolCall {
            id: "c".into(),
            name: name.into(),
            arguments: arguments.to_string(),
        };
        block_on(execute(&call, ctx, &ToolName::ALL)).unwrap()
    }

    fn terms(ctx: &MemoryTools) -> Vec<String> {
        ctx.items.borrow().iter().map(|i| i.term.clone()).collect()
    }

    #[test]
    fn add_words_mints_items_without_a_card_and_skips_what_is_there() {
        let ctx = MemoryTools::new(vec![item("a", "hola", None)]);
        let outcome = call(
            &ctx,
            "add_words",
            json!({ "words": [
                { "term": " Hola ", "meaning": "hi" },
                { "term": "gato", "meaning": " cat ", "notes": null, "kind": "vocab" },
                { "term": "GATO", "meaning": "cat again" },
            ] }),
        );
        assert!(outcome.ok);
        assert_eq!(
            outcome.result,
            json!({ "added": ["gato"], "skipped": [
                { "term": "Hola", "reason": ALREADY_PRESENT },
                { "term": "GATO", "reason": ALREADY_PRESENT },
            ] })
        );
        assert_eq!(
            outcome.summary,
            "Added 1 word: gato; skipped 2 already in the list"
        );
        let items = ctx.items.borrow();
        let gato = &items[1];
        assert_eq!((gato.id.as_str(), gato.meaning.as_str()), ("id-1", "cat"));
        assert_eq!(gato.fsrs_card, Value::Null);
        assert_eq!(gato.introduced_at, 1_700_000_000_000.0);
    }

    #[test]
    fn homographs_are_two_cards_only_when_both_carry_a_reading() {
        let ctx = MemoryTools::new(vec![item("a", "长", Some("cháng"))]);
        call(
            &ctx,
            "add_words",
            json!({ "words": [
                { "term": "长", "meaning": "to grow", "romanization": "zhǎng" },
                { "term": "长", "meaning": "long", "romanization": "cha\u{0301}ng" },
                { "term": "长", "meaning": "bare" },
            ] }),
        );
        assert_eq!(terms(&ctx), ["长", "长"]);

        let ctx = MemoryTools::new(vec![item("a", "长", None)]);
        let outcome = call(
            &ctx,
            "add_words",
            json!({ "words": [{ "term": "长", "meaning": "to grow", "romanization": "zhǎng" }] }),
        );
        assert_eq!(outcome.summary, "Nothing added: 1 word already in the list");
    }

    #[test]
    fn bad_calls_are_results_the_model_reads() {
        let ctx = MemoryTools::default();
        for (name, arguments) in [
            ("nope", json!({})),
            ("add_words", json!({ "words": [] })),
            (
                "add_words",
                json!({ "words": [{ "term": " ", "meaning": "m" }] }),
            ),
            ("add_words", json!({ "words": "hola" })),
            ("remove_word", json!({})),
        ] {
            let outcome = call(&ctx, name, arguments);
            assert!(!outcome.ok, "{name}");
            assert_eq!(outcome.result["error"], json!(outcome.summary));
        }
        let broken = ToolCall {
            id: "c".into(),
            name: "list_words".into(),
            arguments: "{nope".into(),
        };
        let outcome = block_on(execute(&broken, &ctx, &ToolName::ALL)).unwrap();
        assert!(outcome.summary.starts_with("invalid arguments"));
    }

    #[test]
    fn only_the_offered_tools_run() {
        let ctx = MemoryTools::new(vec![item("a", "hola", None)]);
        let call = ToolCall {
            id: "c".into(),
            name: "remove_word".into(),
            arguments: json!({ "term": "hola" }).to_string(),
        };
        let outcome = block_on(execute(&call, &ctx, &[ToolName::AddWords])).unwrap();
        assert!(!outcome.ok);
        assert_eq!(terms(&ctx), ["hola"]);
    }

    #[test]
    fn list_words_filters_clamps_and_counts_reviews() {
        let ctx = MemoryTools::new(vec![
            item("a", "gato", None),
            item("b", "perro", None),
            item("c", "gatito", None),
        ]);
        let outcome = call(
            &ctx,
            "list_words",
            json!({ "query": " GAT ", "limit": 0.5 }),
        );
        assert_eq!(outcome.result["total"], 2);
        assert_eq!(outcome.result["showing"], 1);
        assert_eq!(
            outcome.result["entries"][0],
            json!({ "term": "gato", "meaning": "meaning of gato", "reviews": 3.0 })
        );
        assert_eq!(outcome.summary, "Found 2 words matching \"GAT\"");
        let all = call(&ctx, "list_words", json!({ "query": null }));
        assert_eq!(all.summary, "Read the list: 3 words");
    }

    #[test]
    fn update_word_edits_content_and_refuses_a_collision() {
        let ctx = MemoryTools::new(vec![
            item("a", "长", Some("cháng")),
            item("b", "长", Some("zhǎng")),
        ]);
        let ambiguous = call(
            &ctx,
            "update_word",
            json!({ "term": "长", "fields": { "notes": "x" } }),
        );
        assert!(ambiguous.summary.contains("2 times (cháng, zhǎng)"));

        let collision = call(
            &ctx,
            "update_word",
            json!({ "term": "长", "romanization": "zha\u{030C}ng", "fields": { "romanization": "cháng" } }),
        );
        assert!(
            collision.summary.contains("would collide"),
            "{}",
            collision.summary
        );

        let edited = call(
            &ctx,
            "update_word",
            json!({ "term": "长", "romanization": "zhǎng", "fields": { "meaning": "to grow", "notes": "verb", "term": null } }),
        );
        assert_eq!(edited.summary, "Updated 长 (meaning, notes)");
        let items = ctx.items.borrow();
        assert_eq!(items[1].meaning, "to grow");
        assert_eq!(items[1].review_count, Some(3.0));
        drop(items);

        let cleared = call(
            &ctx,
            "update_word",
            json!({ "term": "长", "romanization": "zhǎng", "fields": { "notes": "" } }),
        );
        assert!(cleared.ok);
        assert_eq!(ctx.items.borrow()[1].notes, None);
        let nothing = call(
            &ctx,
            "update_word",
            json!({ "term": "长", "romanization": "zhǎng", "fields": {} }),
        );
        assert!(!nothing.ok);
    }

    #[test]
    fn remove_word_deletes_exactly_the_named_card() {
        let ctx = MemoryTools::new(vec![
            item("a", "长", Some("cháng")),
            item("b", "长", Some("zhǎng")),
        ]);
        assert!(!call(&ctx, "remove_word", json!({ "term": "长" })).ok);
        assert!(
            !call(
                &ctx,
                "remove_word",
                json!({ "term": "长", "romanization": "chang" })
            )
            .ok
        );
        let removed = call(
            &ctx,
            "remove_word",
            json!({ "term": "长", "romanization": "zhǎng" }),
        );
        assert_eq!(removed.summary, "Removed 长");
        assert_eq!(ctx.items.borrow().len(), 1);
        assert_eq!(ctx.items.borrow()[0].id, "a");
    }

    #[test]
    fn tool_schemas_keep_optionals_optional() {
        let list = ToolName::ListWords.tool();
        assert_eq!(list.name, "list_words");
        assert!(list
            .parameters
            .get("required")
            .is_none_or(|r| r == &json!([])));
        let add = ToolName::AddWords.tool().parameters;
        assert_eq!(add["required"], json!(["words"]));
        assert_eq!(add["properties"]["words"]["maxItems"], 50);
        assert_eq!(
            add["properties"]["words"]["items"]["required"],
            json!(["term", "meaning"])
        );
        assert!(!add.to_string().contains("$ref"));
    }

    #[test]
    fn word_lines_read_term_meaning_pairs() {
        let words = word_lines("add hola = hello\nadiós: bye\nel gato - the cat\njust chatting\n= x\na b c d e = too long");
        let pairs: Vec<(&str, &str)> = words
            .iter()
            .map(|w| (w.term.as_str(), w.meaning.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [("hola", "hello"), ("adiós", "bye"), ("el gato", "the cat")]
        );
    }
}
