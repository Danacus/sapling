//! The stored challenge union: what a pool row holds once a challenge exists.
//!
//! Parsing is lenient on purpose — every row ever written has to keep reading,
//! so an optional field may be absent or `null` and unknown fields are ignored.
//! [`Challenge::check_shape`] is the strict half: what a freshly resolved or
//! locally built challenge must satisfy before it is stored.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// One discriminator literal, serialized as the `type` field of its struct.
macro_rules! tag {
    ($name:ident, $literal:literal) => {
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
        pub enum $name {
            #[default]
            #[serde(rename = $literal)]
            Tag,
        }
    };
}

tag!(MultipleChoiceTag, "multiple-choice");
tag!(ClozeTag, "cloze");
tag!(MultiClozeTag, "multi-cloze");
tag!(TypedTranslationTag, "typed-translation");
tag!(MatchPairsTag, "match-pairs");
tag!(WordOrderTag, "word-order");
tag!(SpotErrorTag, "spot-error");

/// Which way a challenge is exercised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    ToTarget,
    ToNative,
}

/// An index written by JavaScript: a whole number, however it was printed.
fn index<'de, D: Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if value >= 0.0 && value.fract() == 0.0 {
        Ok(value as usize)
    } else {
        Err(D::Error::custom(format!("{value} is not an index")))
    }
}

/// Pick one of four options.
///
/// Romanization note, which applies to every `*Romanization` field in the
/// union: these are display-only Latin-script readings, emitted **only** when
/// the target language is not written in the Latin script. Latin-script
/// languages omit them entirely, and the UI changes nothing when they are
/// absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultipleChoiceChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MultipleChoiceTag,
    pub id: String,
    pub direction: Direction,
    pub prompt: String,
    /// Romanization of `prompt`, when the prompt is in the target script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_romanization: Option<String>,
    /// `true` when the prompt is target-language text rather than native text —
    /// the `context-mc` wire type, whose challenge otherwise looks exactly like
    /// `produce-mc`'s: both resolve to `direction: 'toTarget'`. Absent (never
    /// `false`) for every other multiple-choice row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "true")]
    pub prompt_is_target: Option<bool>,
    /// Heading shown above the prompt; absent means the UI's own default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instruction: Option<String>,
    /// Exactly four options.
    pub options: [String; 4],
    /// Romanization of each option, index-aligned with `options`. Present only
    /// when the options are in the target script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options_romanization: Option<Vec<String>>,
    /// Index into `options`, 0-3.
    #[serde(deserialize_with = "index")]
    pub correct_index: usize,
    /// Shown after answering; why the answer is what it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    /// `KnowledgeItem` ids exercised by this challenge.
    pub item_ids: Vec<String>,
}

/// Fill the `___` blank in a sentence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClozeChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: ClozeTag,
    pub id: String,
    pub direction: Direction,
    /// Sentence containing a `___` placeholder for the blank.
    pub sentence: String,
    /// Romanization of the *whole* sentence, blank included. Present only when
    /// the sentence is in the target script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sentence_romanization: Option<String>,
    /// Any of these count as correct (before fuzzy matching).
    pub accepted_answers: Vec<String>,
    /// Latin reading of the canonical accepted answer (`acceptedAnswers[0]`),
    /// shown under "Answer: …" in the feedback. Absent for Latin-script targets
    /// and for rows written before the field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
    /// Optional set of tappable candidate words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank: Option<Vec<String>>,
    /// Latin-script reading of each word bank entry, index-aligned with
    /// `wordBank`, present only when *every* bank word has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank_romanization: Option<Vec<String>>,
    /// Native-language rendering of the full sentence. Generation always writes
    /// it; whether the learner *sees* it is decided when the challenge is
    /// served. Optional only because some rows were written without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub translation_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// One gap of a multi-cloze passage: its answer key and its SRS subject.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeGap {
    pub item_id: String,
    pub accepted_answers: Vec<String>,
    /// Reading of the canonical answer, available after feedback only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
}

/// Fill several target-language gaps from one shared word bank.
///
/// The passage uses numbered `___N___` markers so the stored answer key can
/// bind each gap to its own knowledge item. They are rendered as blank
/// controls by the exercise, never as learner-facing text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MultiClozeChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MultiClozeTag,
    pub id: String,
    pub direction: Direction,
    /// Target-language passage containing one numbered placeholder per gap.
    pub passage: String,
    /// A safe reading of the passage, with blanks rather than their answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub passage_romanization: Option<String>,
    /// One answer key and one SRS subject for each numbered gap.
    pub gaps: Vec<MultiClozeGap>,
    /// Shared target-language choices: every answer plus plausible distractors.
    pub word_bank: Vec<String>,
    /// Index-aligned with `wordBank`, present only when complete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub word_bank_romanization: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// Type the full translation of a prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TypedTranslationChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: TypedTranslationTag,
    pub id: String,
    pub direction: Direction,
    pub prompt: String,
    /// Romanization of `prompt`, when the prompt is in the target script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt_romanization: Option<String>,
    pub accepted_answers: Vec<String>,
    /// Latin reading of the canonical accepted answer; absent `toNative`, where
    /// the answer is already in the learner's own language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// One pair of a match round. `aRom`/`bRom` are copied from the source item's
/// `romanization` by the local builder — never model-produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchPair {
    pub a: String,
    pub b: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub a_rom: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub b_rom: Option<String>,
}

/// Match terms on the left with their counterparts on the right.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchPairsChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: MatchPairsTag,
    pub id: String,
    pub direction: Direction,
    pub pairs: Vec<MatchPair>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// Arrange shuffled target-language word tiles into the right sentence.
///
/// The model does the segmentation (one tile per *word*), which is what makes
/// the type work for Chinese and Japanese at all; the resolver shuffles.
/// Grading compares the assembled sentence, never tile indices, so a sentence
/// that uses a word twice cannot fail a correct arrangement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WordOrderChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: WordOrderTag,
    pub id: String,
    pub direction: Direction,
    /// The sentence to build, in the learner's native language. Always written
    /// by generation; whether it is shown is decided when the challenge is
    /// served. Optional only because some rows were written without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prompt: Option<String>,
    /// Heading shown above the prompt; absent means the UI's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub instruction: Option<String>,
    /// Every tile the learner may place, already shuffled: the sentence's own
    /// words plus any distractors. Duplicates are legal.
    pub tiles: Vec<String>,
    /// Latin reading of each tile, index-aligned with `tiles`; all-or-nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tiles_romanization: Option<Vec<String>>,
    /// The correct tile texts, in order. The answer key.
    pub answer_tokens: Vec<String>,
    /// `answerTokens` joined with the target script's own spacing rule — what
    /// the feedback banner prints, TTS speaks and grading compares against.
    pub answer: String,
    /// Latin reading of `answer`; absent for Latin-script targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub answer_romanization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// Tap the one word in a target-language sentence that does not belong.
///
/// `meaning` is load-bearing: without being told what the sentence is
/// *supposed* to say, a learner cannot tell a wrong word from one they simply
/// do not know yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SpotErrorChallenge {
    #[serde(rename = "type")]
    #[ts(inline)]
    pub kind: SpotErrorTag,
    pub id: String,
    pub direction: Direction,
    /// The sentence as shown, one entry per word, with the wrong word in place.
    pub tokens: Vec<String>,
    /// Latin reading of each token, index-aligned with `tokens`; all-or-nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens_romanization: Option<Vec<String>>,
    /// Index into `tokens` of the wrong word — tapping it is the correct answer.
    #[serde(deserialize_with = "index")]
    pub correct_index: usize,
    /// The word that belongs at `correctIndex`; the banner's "should have been".
    pub intended_word: String,
    /// Latin reading of `intendedWord`; absent for Latin-script targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub intended_word_romanization: Option<String>,
    /// The sentence with `intendedWord` restored — printed and spoken after answering.
    pub corrected_sentence: String,
    /// What the sentence is meant to say, in the learner's native language.
    /// Always written by generation; whether it is shown is decided when the
    /// challenge is served. Optional only because some rows were written
    /// without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub meaning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub explanation: Option<String>,
    pub item_ids: Vec<String>,
}

/// Any challenge; discriminate on `type`.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(untagged)]
pub enum Challenge {
    MultipleChoice(MultipleChoiceChallenge),
    Cloze(ClozeChallenge),
    MultiCloze(MultiClozeChallenge),
    TypedTranslation(TypedTranslationChallenge),
    MatchPairs(MatchPairsChallenge),
    WordOrder(WordOrderChallenge),
    SpotError(SpotErrorChallenge),
}

/// The union's members by name, for the places that dispatch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChallengeType {
    MultipleChoice,
    Cloze,
    MultiCloze,
    TypedTranslation,
    MatchPairs,
    WordOrder,
    SpotError,
}

impl ChallengeType {
    pub const ALL: [ChallengeType; 7] = [
        ChallengeType::MultipleChoice,
        ChallengeType::Cloze,
        ChallengeType::TypedTranslation,
        ChallengeType::MatchPairs,
        ChallengeType::MultiCloze,
        ChallengeType::WordOrder,
        ChallengeType::SpotError,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            ChallengeType::MultipleChoice => "multiple-choice",
            ChallengeType::Cloze => "cloze",
            ChallengeType::MultiCloze => "multi-cloze",
            ChallengeType::TypedTranslation => "typed-translation",
            ChallengeType::MatchPairs => "match-pairs",
            ChallengeType::WordOrder => "word-order",
            ChallengeType::SpotError => "spot-error",
        }
    }

    pub fn parse(name: &str) -> Option<ChallengeType> {
        ChallengeType::ALL.into_iter().find(|t| t.as_str() == name)
    }
}

// A variant left out of `ALL` fails here, as long as the last one stays last.
const _: () = assert!(ChallengeType::ALL.len() == ChallengeType::SpotError as usize + 1);

/// Every stored type by name: what the pool materializer admits.
pub const STORED_TYPES: [&str; 7] = {
    let mut names = [""; 7];
    let mut i = 0;
    while i < ChallengeType::ALL.len() {
        names[i] = ChallengeType::ALL[i].as_str();
        i += 1;
    }
    names
};

impl Challenge {
    /// A stored row read by its `type`; an unknown type is an error, never a guess.
    pub fn from_value(value: Value) -> Result<Challenge, String> {
        let name = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or("a challenge needs a string `type`")?
            .to_owned();
        let kind =
            ChallengeType::parse(&name).ok_or_else(|| format!("unknown challenge type {name}"))?;
        let parsed = match kind {
            ChallengeType::MultipleChoice => {
                serde_json::from_value(value).map(Challenge::MultipleChoice)
            }
            ChallengeType::Cloze => serde_json::from_value(value).map(Challenge::Cloze),
            ChallengeType::MultiCloze => serde_json::from_value(value).map(Challenge::MultiCloze),
            ChallengeType::TypedTranslation => {
                serde_json::from_value(value).map(Challenge::TypedTranslation)
            }
            ChallengeType::MatchPairs => serde_json::from_value(value).map(Challenge::MatchPairs),
            ChallengeType::WordOrder => serde_json::from_value(value).map(Challenge::WordOrder),
            ChallengeType::SpotError => serde_json::from_value(value).map(Challenge::SpotError),
        };
        parsed.map_err(|e| format!("{name}: {e}"))
    }

    pub fn kind(&self) -> ChallengeType {
        match self {
            Challenge::MultipleChoice(_) => ChallengeType::MultipleChoice,
            Challenge::Cloze(_) => ChallengeType::Cloze,
            Challenge::MultiCloze(_) => ChallengeType::MultiCloze,
            Challenge::TypedTranslation(_) => ChallengeType::TypedTranslation,
            Challenge::MatchPairs(_) => ChallengeType::MatchPairs,
            Challenge::WordOrder(_) => ChallengeType::WordOrder,
            Challenge::SpotError(_) => ChallengeType::SpotError,
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Challenge::MultipleChoice(c) => &c.id,
            Challenge::Cloze(c) => &c.id,
            Challenge::MultiCloze(c) => &c.id,
            Challenge::TypedTranslation(c) => &c.id,
            Challenge::MatchPairs(c) => &c.id,
            Challenge::WordOrder(c) => &c.id,
            Challenge::SpotError(c) => &c.id,
        }
    }

    pub fn direction(&self) -> Direction {
        match self {
            Challenge::MultipleChoice(c) => c.direction,
            Challenge::Cloze(c) => c.direction,
            Challenge::MultiCloze(c) => c.direction,
            Challenge::TypedTranslation(c) => c.direction,
            Challenge::MatchPairs(c) => c.direction,
            Challenge::WordOrder(c) => c.direction,
            Challenge::SpotError(c) => c.direction,
        }
    }

    pub fn item_ids(&self) -> &[String] {
        match self {
            Challenge::MultipleChoice(c) => &c.item_ids,
            Challenge::Cloze(c) => &c.item_ids,
            Challenge::MultiCloze(c) => &c.item_ids,
            Challenge::TypedTranslation(c) => &c.item_ids,
            Challenge::MatchPairs(c) => &c.item_ids,
            Challenge::WordOrder(c) => &c.item_ids,
            Challenge::SpotError(c) => &c.item_ids,
        }
    }

    /// Whether this is `context-mc`'s target-language prompt.
    pub fn prompt_is_target(&self) -> bool {
        matches!(self, Challenge::MultipleChoice(c) if c.prompt_is_target == Some(true))
    }

    /// What a fresh challenge must satisfy before it is stored. A stored row is
    /// never re-checked: rows written by an older build read as they are.
    pub fn check_shape(&self) -> Result<(), String> {
        let fail = |what: &str| Err(format!("{}: {what}", self.kind().as_str()));
        if self.id().is_empty() || self.item_ids().iter().any(String::is_empty) {
            return fail("an id and every item id must be filled in");
        }
        let blank = |values: &[String]| values.iter().any(|v| v.is_empty());
        match self {
            Challenge::MultipleChoice(c) => {
                if c.prompt.is_empty() || c.correct_index > 3 {
                    return fail("needs a prompt and a correct index in 0..=3");
                }
                if c.options_romanization
                    .as_ref()
                    .is_some_and(|r| r.len() != 4)
                {
                    return fail("optionsRomanization must align with the four options");
                }
            }
            Challenge::Cloze(c) => {
                if c.sentence.is_empty() || c.accepted_answers.is_empty() {
                    return fail("needs a sentence and an accepted answer");
                }
            }
            Challenge::TypedTranslation(c) => {
                if c.prompt.is_empty() || c.accepted_answers.is_empty() {
                    return fail("needs a prompt and an accepted answer");
                }
            }
            Challenge::MatchPairs(c) => {
                if c.pairs.len() < 2 || c.pairs.iter().any(|p| p.a.is_empty() || p.b.is_empty()) {
                    return fail("needs two pairs, both sides filled in");
                }
            }
            Challenge::WordOrder(c) => {
                if c.prompt.as_ref().is_some_and(String::is_empty)
                    || c.tiles.len() < 2
                    || c.answer_tokens.len() < 2
                    || blank(&c.tiles)
                    || blank(&c.answer_tokens)
                    || c.answer.is_empty()
                {
                    return fail("needs two tiles, two answer tokens and an answer");
                }
            }
            Challenge::SpotError(c) => {
                if c.tokens.len() < 3
                    || blank(&c.tokens)
                    || c.intended_word.is_empty()
                    || c.corrected_sentence.is_empty()
                    || c.meaning.as_ref().is_some_and(String::is_empty)
                {
                    return fail(
                        "needs three tokens, the intended word and the corrected sentence",
                    );
                }
            }
            Challenge::MultiCloze(c) => {
                if c.direction != Direction::ToTarget
                    || c.passage.is_empty()
                    || !(2..=4).contains(&c.gaps.len())
                    || c.word_bank.len() < c.gaps.len() + 2
                    || blank(&c.word_bank)
                    || c.gaps.iter().any(|g| {
                        g.item_id.is_empty()
                            || g.accepted_answers.is_empty()
                            || blank(&g.accepted_answers)
                    })
                {
                    return fail("needs 2-4 filled gaps and a bank of two more");
                }
                let mut ids: Vec<&str> = c.gaps.iter().map(|g| g.item_id.as_str()).collect();
                ids.sort_unstable();
                ids.dedup();
                if ids.len() != c.gaps.len() {
                    return fail("every gap needs its own item");
                }
                if c.item_ids.len() != c.gaps.len()
                    || c.gaps.iter().any(|g| !c.item_ids.contains(&g.item_id))
                {
                    return fail("itemIds must contain exactly the gap items");
                }
                for index in 0..c.gaps.len() {
                    let marker = crate::grade::multi_cloze_marker(index);
                    if c.passage.matches(&marker).count() != 1 {
                        return fail(&format!("the passage must contain {marker} exactly once"));
                    }
                }
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for Challenge {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Challenge::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_row_reads_by_its_type_and_writes_back_the_same_json() {
        let row = json!({
            "type": "multiple-choice", "id": "m", "direction": "toTarget", "prompt": "el perro",
            "promptIsTarget": true, "options": ["a", "b", "c", "d"], "correctIndex": 2, "itemIds": ["i"]
        });
        let challenge: Challenge = serde_json::from_value(row.clone()).unwrap();
        assert_eq!(challenge.kind(), ChallengeType::MultipleChoice);
        assert!(challenge.prompt_is_target());
        assert_eq!(serde_json::to_value(&challenge).unwrap(), row);
    }

    #[test]
    fn old_rows_keep_reading() {
        // A cloze from before the hint and the readings, a word-order and a
        // spot-error from before their native lines, an index JavaScript
        // printed as a float, `null` where a field was never set, and a field
        // from some newer build.
        let rows = [
            json!({ "type": "cloze", "id": "c", "direction": "toTarget", "sentence": "Yo ___.",
                "acceptedAnswers": ["leo"], "itemIds": ["i"] }),
            json!({ "type": "word-order", "id": "w", "direction": "toTarget", "tiles": ["a", "b"],
                "answerTokens": ["a", "b"], "answer": "a b", "itemIds": ["i"], "prompt": null }),
            json!({ "type": "spot-error", "id": "s", "direction": "toNative", "tokens": ["a", "b", "c"],
                "correctIndex": 1.0, "intendedWord": "x", "correctedSentence": "a x c", "itemIds": ["i"] }),
            json!({ "type": "typed-translation", "id": "t", "direction": "toNative", "prompt": "hola",
                "acceptedAnswers": ["hi"], "itemIds": ["i"], "someLaterField": 3 }),
            json!({ "type": "match-pairs", "id": "p", "direction": "toNative",
                "pairs": [{ "a": "a", "b": "b" }], "itemIds": [] }),
        ];
        for row in rows {
            Challenge::from_value(row.clone()).unwrap_or_else(|e| panic!("{row}: {e}"));
        }
    }

    #[test]
    fn an_unknown_type_is_an_error_by_name() {
        let error = Challenge::from_value(json!({ "type": "dictation", "id": "x" })).unwrap_err();
        assert!(error.contains("dictation"));
        assert!(Challenge::from_value(json!({ "id": "x" })).is_err());
    }

    #[test]
    fn stored_types_are_every_member_once() {
        let mut names = STORED_TYPES.to_vec();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), ChallengeType::ALL.len());
    }

    #[test]
    fn a_multi_cloze_needs_every_marker_and_its_own_item_per_gap() {
        let passage = json!({ "type": "multi-cloze", "id": "mc", "direction": "toTarget",
            "passage": "___1___ leo un libro. Luego ___2___ café.",
            "gaps": [{ "itemId": "i1", "acceptedAnswers": ["Yo"] }, { "itemId": "i2", "acceptedAnswers": ["bebo"] }],
            "wordBank": ["Yo", "bebo", "como", "libro", "café"], "itemIds": ["i1", "i2"] });
        let ok = Challenge::from_value(passage.clone()).unwrap();
        assert_eq!(ok.check_shape(), Ok(()));

        let mut missing = passage.clone();
        missing["passage"] = json!("___1___ leo un libro.");
        assert!(Challenge::from_value(missing)
            .unwrap()
            .check_shape()
            .is_err());

        let mut shared = passage;
        shared["gaps"][1]["itemId"] = json!("i1");
        assert!(Challenge::from_value(shared)
            .unwrap()
            .check_shape()
            .is_err());
    }
}
