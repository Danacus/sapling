//! What the model writes (content only) and how it becomes a stored challenge.
//! The resolver decides everything positional — option order, the blank, the
//! tile tray, which readings are safe to show — so the model cannot get it wrong.
//! A defect that leaves nothing to play drops the challenge; a cosmetic one
//! (a partial reading, a bank that dedupes away) only drops that part.

use std::collections::HashSet;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::json::{inline_schema, seal};
use crate::kinds::WireType;
use crate::text::{
    fold_diacritics, is_punctuation_only, join_tokens, label_key, merge_punctuation,
    uses_inter_word_spaces, Rng, Token,
};

/// The most wrong tiles a word-order tray carries, and the most tiles in all.
pub const MAX_WORD_ORDER_DISTRACTORS: usize = 3;
pub const MAX_WORD_ORDER_TILES: usize = 10;

const CLOZE_GAP: &str = "___";

/// One string of the target language with its Latin reading; null for Latin scripts.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TargetText {
    pub text: String,
    #[serde(default)]
    pub reading: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeMc {
    pub shown: TargetText,
    pub correct_meaning: String,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProduceMc {
    pub prompt_native: String,
    pub correct: TargetText,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<TargetText>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextMc {
    pub prompt: TargetText,
    pub correct: TargetText,
    #[schemars(length(equal = 3))]
    pub distractors: Vec<TargetText>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateToNative {
    pub prompt: TargetText,
    #[schemars(length(min = 1))]
    pub answers_native: Vec<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslateToTarget {
    pub prompt_native: String,
    #[schemars(length(min = 1))]
    pub answers: Vec<TargetText>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpotError {
    /// The correct sentence, segmented; the swap happens here.
    #[schemars(length(min = 3))]
    pub words: Vec<TargetText>,
    pub wrong_word: TargetText,
    pub wrong_position: u32,
    pub meaning_native: String,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WordOrder {
    pub prompt_native: String,
    /// The sentence in the correct order; the app shuffles.
    #[schemars(length(min = 2))]
    pub words: Vec<TargetText>,
    #[serde(default)]
    pub distractor_words: Option<Vec<TargetText>>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Cloze {
    pub before: TargetText,
    pub answer: TargetText,
    pub after: TargetText,
    pub hint_native: String,
    #[serde(default)]
    pub distractor_words: Option<Vec<TargetText>>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub item_id: String,
    pub answer: TargetText,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MultiCloze {
    /// Spans around the gaps: one more than there are gaps.
    #[schemars(length(min = 3, max = 5))]
    pub parts: Vec<TargetText>,
    #[schemars(length(min = 2, max = 4))]
    pub gaps: Vec<Gap>,
    #[schemars(length(min = 2))]
    pub distractor_words: Vec<TargetText>,
    #[serde(default)]
    pub explanation: Option<String>,
    #[schemars(length(min = 1))]
    pub item_ids: Vec<String>,
}

/// One entry of a reply, tagged with its wire type.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Generated {
    RecognizeMc(RecognizeMc),
    ProduceMc(ProduceMc),
    ContextMc(ContextMc),
    TranslateToNative(TranslateToNative),
    SpotError(SpotError),
    WordOrder(WordOrder),
    Cloze(Cloze),
    MultiCloze(MultiCloze),
    TranslateToTarget(TranslateToTarget),
}

impl Generated {
    pub fn kind(&self) -> WireType {
        match self {
            Generated::RecognizeMc(_) => WireType::RecognizeMc,
            Generated::ProduceMc(_) => WireType::ProduceMc,
            Generated::ContextMc(_) => WireType::ContextMc,
            Generated::TranslateToNative(_) => WireType::TranslateToNative,
            Generated::SpotError(_) => WireType::SpotError,
            Generated::WordOrder(_) => WireType::WordOrder,
            Generated::Cloze(_) => WireType::Cloze,
            Generated::MultiCloze(_) => WireType::MultiCloze,
            Generated::TranslateToTarget(_) => WireType::TranslateToTarget,
        }
    }

    fn base(&self) -> (&[String], Option<&str>) {
        match self {
            Generated::RecognizeMc(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::ProduceMc(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::ContextMc(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::TranslateToNative(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::SpotError(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::WordOrder(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::Cloze(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::MultiCloze(g) => (&g.item_ids, g.explanation.as_deref()),
            Generated::TranslateToTarget(g) => (&g.item_ids, g.explanation.as_deref()),
        }
    }
}

/// The member schema for one wire type, `type` pinned, before sealing.
fn member_schema(kind: WireType) -> Value {
    let mut schema = match kind {
        WireType::RecognizeMc => inline_schema::<RecognizeMc>(),
        WireType::ProduceMc => inline_schema::<ProduceMc>(),
        WireType::ContextMc => inline_schema::<ContextMc>(),
        WireType::TranslateToNative => inline_schema::<TranslateToNative>(),
        WireType::SpotError => inline_schema::<SpotError>(),
        WireType::WordOrder => inline_schema::<WordOrder>(),
        WireType::Cloze => inline_schema::<Cloze>(),
        WireType::MultiCloze => inline_schema::<MultiCloze>(),
        WireType::TranslateToTarget => inline_schema::<TranslateToTarget>(),
    };
    let mut properties = Map::new();
    properties.insert(
        "type".into(),
        json!({ "type": "string", "const": kind.as_str() }),
    );
    if let Some(Value::Object(fields)) = schema.get("properties") {
        properties.extend(fields.clone());
    }
    schema["properties"] = Value::Object(properties);
    schema
}

/// The strict structured-output schema for one request: that type and no other.
pub fn batch_schema(kind: WireType) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": {
            "challenges": { "type": "array", "items": member_schema(kind) }
        }
    });
    seal(&mut schema);
    schema
}

/// Whether this wire type has an `instruction` field for the heading rule.
pub fn has_instruction(kind: WireType) -> bool {
    member_schema(kind)["properties"]
        .get("instruction")
        .is_some()
}

/// Everything a resolver depends on beyond the payload.
pub struct Resolver<'a> {
    /// An id or a known term to the item id it names; `None` is not carried.
    pub item_ref: &'a dyn Fn(&str) -> Option<String>,
    pub rng: &'a mut Rng,
}

fn non_blank(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn reading(value: &TargetText) -> Option<String> {
    non_blank(value.reading.as_deref())
}

fn put(map: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    map.insert(key.into(), value.into());
}

fn put_opt(map: &mut Map<String, Value>, key: &str, value: Option<impl Into<Value>>) {
    if let Some(value) = value {
        map.insert(key.into(), value.into());
    }
}

/// Every reading, or none: a half-annotated row reads worse than a bare one.
fn all_readings<'a>(readings: impl IntoIterator<Item = &'a Option<String>>) -> Option<Vec<String>> {
    readings.into_iter().cloned().collect()
}

/// Trimmed, blanks and exact repeats dropped, order kept.
fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty() && seen.insert(v.clone()))
        .collect()
}

/// The text, its reading, and both with diacritics folded: what the local grader accepts.
fn answer_variants(target: &TargetText) -> Vec<String> {
    let text = target.text.trim().to_owned();
    let reading = reading(target);
    let mut values = vec![text.clone()];
    if let Some(reading) = &reading {
        values.push(reading.clone());
        values.push(fold_diacritics(reading));
    }
    values.push(fold_diacritics(&text));
    dedupe(values)
}

/// The native slot is in the same no-space script as the target side: both
/// sides of the card are the target language.
fn native_in_target_script(native: &str, target: &str) -> bool {
    !uses_inter_word_spaces(native) && !uses_inter_word_spaces(target)
}

struct Choice {
    text: String,
    reading: Option<String>,
    correct: bool,
}

/// Four options shuffled, `correctIndex` wherever the right one landed.
fn choices(mut choices: Vec<Choice>, rng: &mut Rng, out: &mut Map<String, Value>) {
    rng.shuffle(&mut choices);
    let index = choices.iter().position(|c| c.correct).unwrap_or(0);
    put(
        out,
        "options",
        choices.iter().map(|c| c.text.clone()).collect::<Vec<_>>(),
    );
    put(out, "correctIndex", index);
    put_opt(
        out,
        "optionsRomanization",
        all_readings(choices.iter().map(|c| &c.reading)),
    );
}

fn target_choice(value: &TargetText, correct: bool) -> Choice {
    Choice {
        text: value.text.trim().to_owned(),
        reading: reading(value),
        correct,
    }
}

fn tokens(words: &[TargetText]) -> Option<Vec<Token>> {
    let tokens: Vec<Token> = words
        .iter()
        .map(|word| Token {
            text: word.text.trim().to_owned(),
            reading: reading(word),
        })
        .collect();
    tokens.iter().all(|t| !t.text.is_empty()).then_some(tokens)
}

/// The stored challenge, or `None` to drop it.
pub fn resolve(generated: Generated, ctx: &mut Resolver) -> Option<Value> {
    let (refs, explanation) = generated.base();
    let mut item_ids: Vec<String> = Vec::new();
    for id in refs.iter().filter_map(|r| (ctx.item_ref)(r)) {
        if !item_ids.contains(&id) {
            item_ids.push(id);
        }
    }
    if item_ids.is_empty() {
        return None;
    }
    let mut out = Map::new();
    put(&mut out, "id", ctx.rng.uuid());
    put(&mut out, "itemIds", item_ids);
    put_opt(&mut out, "explanation", non_blank(explanation));

    let rng = &mut *ctx.rng;
    match generated {
        Generated::RecognizeMc(g) => {
            let options: Vec<&str> = std::iter::once(g.correct_meaning.as_str())
                .chain(g.distractors.iter().map(String::as_str))
                .collect();
            let shown = g.shown.text.trim();
            if g.distractors.len() != 3
                || shown.is_empty()
                || options
                    .iter()
                    .any(|o| o.trim().is_empty() || native_in_target_script(o, shown))
            {
                return None;
            }
            put(&mut out, "type", "multiple-choice");
            put(&mut out, "direction", "toNative");
            put(&mut out, "prompt", shown);
            put_opt(&mut out, "promptRomanization", reading(&g.shown));
            let list = options
                .iter()
                .enumerate()
                .map(|(i, text)| Choice {
                    text: text.trim().to_owned(),
                    reading: None,
                    correct: i == 0,
                })
                .collect();
            choices(list, rng, &mut out);
            put_opt(&mut out, "instruction", non_blank(g.instruction.as_deref()));
        }
        Generated::ProduceMc(g) => {
            let prompt = g.prompt_native.trim();
            if g.distractors.len() != 3
                || prompt.is_empty()
                || native_in_target_script(prompt, &g.correct.text)
            {
                return None;
            }
            put(&mut out, "type", "multiple-choice");
            put(&mut out, "direction", "toTarget");
            put(&mut out, "prompt", prompt);
            mc_options(&g.correct, &g.distractors, rng, &mut out)?;
            put_opt(&mut out, "instruction", non_blank(g.instruction.as_deref()));
        }
        Generated::ContextMc(g) => {
            let prompt = g.prompt.text.trim();
            if g.distractors.len() != 3 || prompt.is_empty() {
                return None;
            }
            put(&mut out, "type", "multiple-choice");
            put(&mut out, "direction", "toTarget");
            put(&mut out, "promptIsTarget", true);
            put(&mut out, "prompt", prompt);
            put_opt(&mut out, "promptRomanization", reading(&g.prompt));
            mc_options(&g.correct, &g.distractors, rng, &mut out)?;
            put_opt(&mut out, "instruction", non_blank(g.instruction.as_deref()));
        }
        Generated::TranslateToNative(g) => {
            let prompt = g.prompt.text.trim();
            let answers = dedupe(g.answers_native.iter().cloned());
            if prompt.is_empty()
                || answers.is_empty()
                || answers.iter().any(|a| native_in_target_script(a, prompt))
            {
                return None;
            }
            put(&mut out, "type", "typed-translation");
            put(&mut out, "direction", "toNative");
            put(&mut out, "prompt", prompt);
            put_opt(&mut out, "promptRomanization", reading(&g.prompt));
            put(&mut out, "acceptedAnswers", answers);
        }
        Generated::TranslateToTarget(g) => {
            let prompt = g.prompt_native.trim();
            let answers: Vec<&TargetText> = g
                .answers
                .iter()
                .filter(|a| !a.text.trim().is_empty())
                .collect();
            if prompt.is_empty() || answers.is_empty() {
                return None;
            }
            put(&mut out, "type", "typed-translation");
            put(&mut out, "direction", "toTarget");
            put(&mut out, "prompt", prompt);
            put(
                &mut out,
                "acceptedAnswers",
                dedupe(answers.iter().flat_map(|a| answer_variants(a))),
            );
            put_opt(&mut out, "answerRomanization", reading(answers[0]));
        }
        Generated::Cloze(g) => {
            let hint = g.hint_native.trim();
            if g.answer.text.trim().is_empty() || hint.is_empty() {
                return None;
            }
            put(&mut out, "type", "cloze");
            put(&mut out, "direction", "toTarget");
            put(
                &mut out,
                "sentence",
                format!("{}{CLOZE_GAP}{}", g.before.text, g.after.text),
            );
            put_opt(&mut out, "sentenceRomanization", cloze_reading(&g));
            put(&mut out, "acceptedAnswers", answer_variants(&g.answer));
            put_opt(&mut out, "answerRomanization", reading(&g.answer));
            cloze_bank(&g.answer, g.distractor_words.as_deref(), rng, &mut out);
            put(&mut out, "translationHint", hint);
        }
        Generated::MultiCloze(g) => multi_cloze(g, ctx.item_ref, rng, &mut out)?,
        Generated::WordOrder(g) => word_order(g, rng, &mut out)?,
        Generated::SpotError(g) => spot_error(g, &mut out)?,
    }
    Some(Value::Object(out))
}

fn mc_options(
    correct: &TargetText,
    distractors: &[TargetText],
    rng: &mut Rng,
    out: &mut Map<String, Value>,
) -> Option<()> {
    let list: Vec<Choice> = std::iter::once(target_choice(correct, true))
        .chain(distractors.iter().map(|d| target_choice(d, false)))
        .collect();
    if list.iter().any(|c| c.text.is_empty()) {
        return None;
    }
    choices(list, rng, out);
    Some(())
}

/// The sentence's reading around the blank, never through it: the answer's
/// reading is not in it, so it cannot spell the answer out.
fn cloze_reading(g: &Cloze) -> Option<String> {
    reading(&g.answer)?;
    for part in [&g.before, &g.after] {
        if !part.text.trim().is_empty() && reading(part).is_none() {
            return None;
        }
    }
    let head = reading(&g.before).unwrap_or_default();
    let tail = reading(&g.after).unwrap_or_default();
    if head.is_empty() && tail.is_empty() {
        return None;
    }
    let gap_tail = if tail.chars().next().is_some_and(char::is_alphanumeric) {
        " "
    } else {
        ""
    };
    let head_space = if head.is_empty() { "" } else { " " };
    let line = format!("{head}{head_space}{CLOZE_GAP}{gap_tail}{tail}");
    Some(line.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The answer shuffled in among the distractors that do not collide with it;
/// fewer than two chips is no choice, and the learner types instead.
fn cloze_bank(
    answer: &TargetText,
    distractors: Option<&[TargetText]>,
    rng: &mut Rng,
    out: &mut Map<String, Value>,
) {
    let Some(distractors) = distractors.filter(|d| !d.is_empty()) else {
        return;
    };
    let mut entries = vec![(answer.text.trim().to_owned(), reading(answer))];
    let mut seen = HashSet::from([label_key(&entries[0].0)]);
    for distractor in distractors {
        let text = distractor.text.trim();
        let key = label_key(text);
        if !key.is_empty() && seen.insert(key) {
            entries.push((text.to_owned(), reading(distractor)));
        }
    }
    if entries.len() < 2 {
        return;
    }
    rng.shuffle(&mut entries);
    put_opt(
        out,
        "wordBankRomanization",
        all_readings(entries.iter().map(|(_, r)| r)),
    );
    out.insert(
        "wordBank".into(),
        entries
            .into_iter()
            .map(|(t, _)| t)
            .collect::<Vec<_>>()
            .into(),
    );
}

fn multi_cloze(
    g: MultiCloze,
    item_ref: &dyn Fn(&str) -> Option<String>,
    rng: &mut Rng,
    out: &mut Map<String, Value>,
) -> Option<()> {
    if g.parts.len() != g.gaps.len() + 1 || !(2..=4).contains(&g.gaps.len()) {
        return None;
    }
    let item_ids: Vec<String> = g
        .gaps
        .iter()
        .map(|gap| item_ref(&gap.item_id))
        .collect::<Option<_>>()?;
    if item_ids.iter().collect::<HashSet<_>>().len() != item_ids.len() {
        return None;
    }

    // Every answer is a chip of its own, and at least two plausible extras.
    let mut entries: Vec<(String, Option<String>)> = g
        .gaps
        .iter()
        .map(|gap| (gap.answer.text.trim().to_owned(), reading(&gap.answer)))
        .collect();
    let mut seen = HashSet::new();
    if entries
        .iter()
        .any(|(text, _)| text.is_empty() || !seen.insert(label_key(text)))
    {
        return None;
    }
    for distractor in &g.distractor_words {
        let text = distractor.text.trim();
        let key = label_key(text);
        if !key.is_empty() && seen.insert(key) {
            entries.push((text.to_owned(), reading(distractor)));
        }
    }
    if entries.len() < g.gaps.len() + 2 {
        return None;
    }
    rng.shuffle(&mut entries);

    let mut passage = String::new();
    for (index, part) in g.parts.iter().enumerate() {
        passage.push_str(&part.text);
        if index < g.gaps.len() {
            passage.push_str(&format!("___{}___", index + 1));
        }
    }
    let romanized = g.gaps.iter().all(|gap| reading(&gap.answer).is_some())
        && g.parts
            .iter()
            .all(|part| part.text.trim().is_empty() || reading(part).is_some());
    let passage_reading = romanized
        .then(|| {
            let mut pieces = Vec::new();
            for (index, part) in g.parts.iter().enumerate() {
                pieces.push(reading(part).unwrap_or_default());
                if index < g.gaps.len() {
                    pieces.push(CLOZE_GAP.to_owned());
                }
            }
            pieces
                .join(" ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty());

    put(out, "type", "multi-cloze");
    put(out, "direction", "toTarget");
    put(out, "passage", passage);
    put_opt(out, "passageRomanization", passage_reading);
    let gaps: Vec<Value> = g
        .gaps
        .iter()
        .zip(&item_ids)
        .map(|(gap, id)| {
            let mut entry = Map::new();
            put(&mut entry, "itemId", id.as_str());
            put(&mut entry, "acceptedAnswers", answer_variants(&gap.answer));
            put_opt(&mut entry, "answerRomanization", reading(&gap.answer));
            Value::Object(entry)
        })
        .collect();
    put(out, "gaps", gaps);
    put_opt(
        out,
        "wordBankRomanization",
        all_readings(entries.iter().map(|(_, r)| r)),
    );
    put(
        out,
        "wordBank",
        entries.into_iter().map(|(t, _)| t).collect::<Vec<_>>(),
    );
    put(out, "itemIds", item_ids);
    Some(())
}

fn word_order(g: WordOrder, rng: &mut Rng, out: &mut Map<String, Value>) -> Option<()> {
    let prompt = g.prompt_native.trim();
    let words = merge_punctuation(tokens(&g.words)?);
    if words.len() < 2 || prompt.is_empty() {
        return None;
    }
    // A distractor that duplicates a real tile could never be wrong; and an
    // overshot sentence is not padded past the tray's ceiling.
    let allowance =
        MAX_WORD_ORDER_DISTRACTORS.min(MAX_WORD_ORDER_TILES.saturating_sub(words.len()));
    let mut seen: HashSet<String> = words.iter().map(|w| label_key(&w.text)).collect();
    let mut tiles = words.clone();
    for candidate in g.distractor_words.iter().flatten() {
        if tiles.len() - words.len() >= allowance {
            break;
        }
        let text = candidate.text.trim();
        let key = label_key(text);
        if key.is_empty() || is_punctuation_only(text) || !seen.insert(key) {
            continue;
        }
        tiles.push(Token {
            text: text.to_owned(),
            reading: reading(candidate),
        });
    }
    rng.shuffle(&mut tiles);
    let answer: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();

    put(out, "type", "word-order");
    put(out, "direction", "toTarget");
    put(out, "prompt", prompt);
    put(
        out,
        "tiles",
        tiles.iter().map(|t| t.text.clone()).collect::<Vec<_>>(),
    );
    put_opt(
        out,
        "tilesRomanization",
        all_readings(tiles.iter().map(|t| &t.reading)),
    );
    put(out, "answerTokens", answer.clone());
    put(out, "answer", join_tokens(&answer));
    put_opt(
        out,
        "answerRomanization",
        all_readings(words.iter().map(|w| &w.reading)).map(|r| r.join(" ")),
    );
    put_opt(out, "instruction", non_blank(g.instruction.as_deref()));
    Some(())
}

fn spot_error(g: SpotError, out: &mut Map<String, Value>) -> Option<()> {
    let words = tokens(&g.words)?;
    let at = g.wrong_position as usize;
    let wrong = Token {
        text: g.wrong_word.text.trim().to_owned(),
        reading: reading(&g.wrong_word),
    };
    let meaning = g.meaning_native.trim();
    if words.len() < 3
        || at >= words.len()
        || wrong.text.is_empty()
        || meaning.is_empty()
        || label_key(&wrong.text) == label_key(&words[at].text)
    {
        return None;
    }
    let mut shown = words.clone();
    shown[at] = wrong;

    put(out, "type", "spot-error");
    put(out, "direction", "toNative");
    put(
        out,
        "tokens",
        shown.iter().map(|t| t.text.clone()).collect::<Vec<_>>(),
    );
    put_opt(
        out,
        "tokensRomanization",
        all_readings(shown.iter().map(|t| &t.reading)),
    );
    put(out, "correctIndex", at);
    put(out, "intendedWord", words[at].text.as_str());
    put_opt(out, "intendedWordRomanization", words[at].reading.clone());
    put(
        out,
        "correctedSentence",
        join_tokens(&words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>()),
    );
    put(out, "meaning", meaning);
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve_json(entry: Value) -> Option<Value> {
        let generated: Generated = serde_json::from_value(entry).expect("a wire entry");
        let mut rng = Rng::seeded(1);
        let item_ref = |r: &str| (r.starts_with('i')).then(|| r.to_owned());
        resolve(
            generated,
            &mut Resolver {
                item_ref: &item_ref,
                rng: &mut rng,
            },
        )
    }

    fn t(text: &str, reading: Option<&str>) -> Value {
        json!({ "text": text, "reading": reading })
    }

    fn latin(words: &[&str]) -> Vec<Value> {
        words.iter().map(|w| t(w, None)).collect()
    }

    #[test]
    fn every_schema_is_strict_and_admits_one_type() {
        for kind in WireType::ALL {
            let schema = batch_schema(kind);
            let text = schema.to_string();
            assert!(!text.contains("$ref") && !text.contains("$defs") && !text.contains("oneOf"));
            assert!(!text.contains("\"format\""), "{kind:?}");
            let item = &schema["properties"]["challenges"]["items"];
            assert_eq!(item["properties"]["type"]["const"], kind.as_str());
            assert_eq!(item["additionalProperties"], false);
            let keys: Vec<&String> = item["properties"].as_object().unwrap().keys().collect();
            assert_eq!(
                item["required"].as_array().unwrap().len(),
                keys.len(),
                "{kind:?}"
            );
        }
        assert!(has_instruction(WireType::RecognizeMc));
        assert!(!has_instruction(WireType::Cloze));
    }

    #[test]
    fn a_recognize_mc_shuffles_the_right_meaning_and_guards_the_sides() {
        let entry = |meaning: &str| {
            json!({ "type": "recognize-mc", "shown": t("菜单", Some("càidān")), "correctMeaning": meaning,
                "distractors": ["the bill", "the tea", "the water"], "instruction": " ", "itemIds": ["i1"], "explanation": null })
        };
        let c = resolve_json(entry("the menu")).unwrap();
        let options = c["options"].as_array().unwrap();
        assert_eq!(
            options[c["correctIndex"].as_u64().unwrap() as usize],
            "the menu"
        );
        assert_eq!(c["promptRomanization"], "càidān");
        assert!(c.get("optionsRomanization").is_none() && c.get("instruction").is_none());
        assert!(c.get("explanation").is_none());
        assert!(resolve_json(entry("菜单")).is_none());
    }

    #[test]
    fn target_options_carry_their_readings_through_the_shuffle() {
        let c = resolve_json(json!({ "type": "produce-mc", "promptNative": "the menu",
            "correct": t("菜单", Some("càidān")),
            "distractors": [t("茶", Some("chá")), t("水", Some("shuǐ")), t("汤", Some("tāng"))],
            "instruction": null, "itemIds": ["i1"], "explanation": null }))
        .unwrap();
        let at = c["correctIndex"].as_u64().unwrap() as usize;
        assert_eq!(c["options"][at], "菜单");
        assert_eq!(c["optionsRomanization"][at], "càidān");

        let context = resolve_json(
            json!({ "type": "context-mc", "prompt": t("Quiero pagar la...", None),
            "correct": t("cuenta", None), "distractors": latin(&["carta", "mesa", "sopa"]),
            "instruction": null, "itemIds": ["i1"], "explanation": null }),
        )
        .unwrap();
        assert_eq!(context["promptIsTarget"], true);
        assert!(context.get("optionsRomanization").is_none());
    }

    #[test]
    fn a_cloze_places_one_blank_and_never_reads_through_it() {
        let c = resolve_json(json!({ "type": "cloze", "before": t("我们想", Some("Wǒmen xiǎng")),
            "answer": t("买单", Some("mǎidān")), "after": t("。", Some(".")), "hintNative": "We want to pay.",
            "distractorWords": [t("菜单", Some("càidān")), t("买单", Some("mǎidān"))], "itemIds": ["i1"], "explanation": null }))
        .unwrap();
        assert_eq!(c["sentence"], "我们想___。");
        assert_eq!(c["sentenceRomanization"], "Wǒmen xiǎng ___.");
        assert_eq!(c["acceptedAnswers"], json!(["买单", "mǎidān", "maidan"]));
        assert_eq!(c["answerRomanization"], "mǎidān");
        let bank = c["wordBank"].as_array().unwrap();
        assert_eq!(bank.len(), 2);
        assert_eq!(c["wordBankRomanization"].as_array().unwrap().len(), 2);
        assert_eq!(c["translationHint"], "We want to pay.");

        let typed = resolve_json(json!({ "type": "cloze", "before": t("", None), "answer": t("pedir", None),
            "after": t(" ahora?", None), "hintNative": "Order now?", "distractorWords": null, "itemIds": ["i1"] }))
        .unwrap();
        assert_eq!(typed["sentence"], "___ ahora?");
        assert!(typed.get("wordBank").is_none() && typed.get("sentenceRomanization").is_none());
        assert_eq!(typed["acceptedAnswers"], json!(["pedir"]));
    }

    #[test]
    fn translations_derive_variants_and_refuse_same_script_sides() {
        let c = resolve_json(json!({ "type": "translate-to-target", "promptNative": "The water is cold.",
            "answers": [t("el agua está fría", None), t("el agua está fría", None)], "itemIds": ["i1"] }))
        .unwrap();
        assert_eq!(
            c["acceptedAnswers"],
            json!(["el agua está fría", "el agua esta fria"])
        );
        assert!(c.get("promptRomanization").is_none());

        let native = json!({ "type": "translate-to-native", "prompt": t("买单", Some("mǎidān")),
            "answersNative": ["pay the bill", " pay the bill "], "itemIds": ["i1"] });
        let c = resolve_json(native).unwrap();
        assert_eq!(c["acceptedAnswers"], json!(["pay the bill"]));
        assert!(resolve_json(
            json!({ "type": "translate-to-native", "prompt": t("买单", None),
            "answersNative": ["买单"], "itemIds": ["i1"] })
        )
        .is_none());
    }

    #[test]
    fn a_word_order_keeps_the_answer_and_bounds_the_tray() {
        let c = resolve_json(
            json!({ "type": "word-order", "promptNative": "Can you bring the bill?",
            "words": latin(&["¿", "Nos", "trae", "la", "cuenta", "?"]),
            "distractorWords": latin(&["carta", "trae", "?", "mesa", "sopa", "vino"]),
            "instruction": null, "itemIds": ["i1"] }),
        )
        .unwrap();
        assert_eq!(c["answerTokens"], json!(["¿Nos", "trae", "la", "cuenta?"]));
        assert_eq!(c["answer"], "¿Nos trae la cuenta?");
        let tiles: Vec<&str> = c["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        assert_eq!(tiles.len(), 4 + MAX_WORD_ORDER_DISTRACTORS);
        for word in ["carta", "mesa", "sopa"] {
            assert!(tiles.contains(&word));
        }

        let long: Vec<String> = (0..9).map(|i| format!("w{i}")).collect();
        let long: Vec<&str> = long.iter().map(String::as_str).collect();
        let c = resolve_json(
            json!({ "type": "word-order", "promptNative": "p", "words": latin(&long),
            "distractorWords": latin(&["x", "y", "z"]), "itemIds": ["i1"] }),
        )
        .unwrap();
        assert_eq!(c["tiles"].as_array().unwrap().len(), MAX_WORD_ORDER_TILES);

        let zh = resolve_json(json!({ "type": "word-order", "promptNative": "We want to pay",
            "words": [t("我们", Some("wǒmen")), t("想", Some("xiǎng")), t("买单。", Some("mǎidān"))],
            "itemIds": ["i1"] }))
        .unwrap();
        assert_eq!(zh["answer"], "我们想买单。");
        assert_eq!(zh["answerRomanization"], "wǒmen xiǎng mǎidān");
        assert!(
            resolve_json(json!({ "type": "word-order", "promptNative": "p",
            "words": latin(&["hola", "?"]), "itemIds": ["i1"] }))
            .is_none()
        );
    }

    #[test]
    fn a_spot_error_swaps_at_the_stated_position_only() {
        let entry = |position: u32, wrong: &str| {
            json!({ "type": "spot-error", "words": latin(&["Quisiera", "pedir", "el", "pescado."]),
                "wrongWord": t(wrong, None), "wrongPosition": position, "meaningNative": "I'd like to order the fish.",
                "itemIds": ["i1"] })
        };
        let c = resolve_json(entry(1, "pagar")).unwrap();
        assert_eq!(c["tokens"], json!(["Quisiera", "pagar", "el", "pescado."]));
        assert_eq!(c["correctIndex"], 1);
        assert_eq!(c["intendedWord"], "pedir");
        assert_eq!(c["correctedSentence"], "Quisiera pedir el pescado.");
        assert!(c.get("tokensRomanization").is_none());
        assert!(resolve_json(entry(4, "pagar")).is_none());
        assert!(resolve_json(entry(1, "Pedir")).is_none());
    }

    #[test]
    fn a_multi_cloze_binds_each_gap_and_banks_every_answer() {
        let entry = |second: &str, answer: &str| {
            json!({ "type": "multi-cloze", "parts": latin(&["Primero quiero ", ". Después pido la ", "."]),
                "gaps": [{ "itemId": "i1", "answer": t("comer", None) }, { "itemId": second, "answer": t(answer, None) }],
                "distractorWords": latin(&["mesa", "carta", "comer"]), "itemIds": ["i1", second] })
        };
        let c = resolve_json(entry("i2", "cuenta")).unwrap();
        assert_eq!(
            c["passage"],
            "Primero quiero ___1___. Después pido la ___2___."
        );
        assert_eq!(c["itemIds"], json!(["i1", "i2"]));
        assert_eq!(c["gaps"][1]["itemId"], "i2");
        let bank = c["wordBank"].as_array().unwrap();
        assert_eq!(bank.len(), 4);
        assert!(bank.contains(&json!("cuenta")) && bank.contains(&json!("comer")));
        assert!(resolve_json(entry("i1", "cuenta")).is_none());
        assert!(resolve_json(entry("i2", "Comer")).is_none());
        assert!(resolve_json(entry("nobody", "cuenta")).is_none());
    }

    #[test]
    fn a_challenge_citing_nothing_resolvable_is_dropped() {
        assert!(resolve_json(
            json!({ "type": "translate-to-native", "prompt": t("hola", None),
            "answersNative": ["hi"], "itemIds": ["made-up"] })
        )
        .is_none());
    }
}
