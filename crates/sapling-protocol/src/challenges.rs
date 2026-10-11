//! The challenge decisions by name, like the `llm!` table but synchronous and
//! needing nothing from the host: grading, what a served challenge shows, and
//! the two planners. The host lends nothing — not even a word counter: a
//! length the difficulty model learns from is the model's own `words_in`. Each
//! method takes one argument object; the table also generates the TypeScript `Challenges` interface and
//! `CHALLENGE_METHODS` (`challenges.ts`). A seed, where a method takes one,
//! replays its draws; without one it draws from the OS.

use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use sapling_challenges::fits::Serving;
use sapling_challenges::help::HelpLevel;
use sapling_challenges::pool::lenient_rows;
use sapling_challenges::stream::{self, Head};
use sapling_challenges::topup::{self, Scope, TopUpCoverage};
use sapling_challenges::types::MatchPairsChallenge;
use sapling_challenges::word::{hide_reading_probability, maturity_for_strength, Maturity};
use sapling_challenges::{
    Challenge, ChallengeAnswer, ChallengeType, ChallengeTypeInfo, Graded, PoolRow, Rng, Served,
    Want, Word,
};

use crate::required;

#[derive(Debug, Deserialize, TS)]
pub struct ServeArgs {
    pub challenge: Challenge,
    /// The help level serving picked (`Planned.shown`); a level this build
    /// does not know shows the row at its easiest step.
    pub shown: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct GradeArgs {
    pub challenge: Challenge,
    pub shown: String,
    pub answer: ChallengeAnswer,
}

#[derive(Debug, Deserialize, TS)]
pub struct StrengthArgs {
    pub strength: f64,
}

#[derive(Debug, Deserialize, TS)]
pub struct RegistryArgs {}

/// A pool as the host read it; a row this build cannot read keeps its place
/// and is never picked.
#[derive(Debug, Deserialize, TS)]
pub struct StreamArgs {
    #[serde(deserialize_with = "lenient_rows")]
    #[ts(as = "Vec<PoolRow>")]
    pub pool: Vec<Option<PoolRow>>,
    pub words: Vec<Word>,
    pub now: f64,
    /// The learned numbers, the aim and the help-level bounds a pick is made against.
    #[serde(default)]
    #[ts(optional)]
    pub serving: Option<Serving>,
    /// The challenge ids this stream has already shown: never picked again.
    #[serde(default)]
    #[ts(optional)]
    pub served: Option<Vec<String>>,
    /// No batch can help a head with nothing: pass it for the first word
    /// further down the list that has something. Absent, the head waits.
    #[serde(default)]
    #[ts(optional)]
    pub pass: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LowWaterArgs {
    /// The learner's recent time per answer, in milliseconds.
    #[serde(default)]
    #[ts(optional)]
    pub pace_ms: Option<f64>,
    /// How long the last batch took to come back, in milliseconds.
    #[serde(default)]
    #[ts(optional)]
    pub batch_ms: Option<f64>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EarlyArgs {
    pub item_ids: Vec<String>,
    pub words: Vec<Word>,
}

#[derive(Debug, Deserialize, TS)]
pub struct MatchRoundArgs {
    pub words: Vec<Word>,
    #[serde(default)]
    #[ts(optional)]
    pub seed: Option<u64>,
}

#[derive(Debug, Deserialize, TS)]
pub struct TopUpArgs {
    #[serde(deserialize_with = "lenient_rows")]
    #[ts(as = "Vec<PoolRow>")]
    pub pool: Vec<Option<PoolRow>>,
    pub words: Vec<Word>,
    pub now: f64,
    #[serde(default)]
    #[ts(optional)]
    pub serving: Option<Serving>,
    /// The challenge ids the stream has already shown: they cover nothing.
    #[serde(default)]
    #[ts(optional)]
    pub served: Option<Vec<String>>,
    /// Words the stream has already asked a refill for: they want nothing.
    #[serde(default)]
    #[ts(optional)]
    pub asked: Option<Vec<String>>,
    /// How many of the words ahead to write for; every word when absent.
    #[serde(default)]
    #[ts(optional)]
    pub limit: Option<usize>,
    #[serde(default)]
    #[ts(optional)]
    pub seed: Option<u64>,
}

macro_rules! challenges {
    (
        {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one challenge decision by name.
        #[allow(non_snake_case)]
        pub fn dispatch_challenges(method: &str, args: &[Value]) -> Result<Value, String> {
            match method {
                $(
                    stringify!($method) => {
                        let $arg: $ty = required(method, args, 0).map_err(|e| e.0)?;
                        let value: $ret = $body;
                        serde_json::to_value(value).map_err(|e| e.to_string())
                    }
                )*
                _ => Err(format!("Unknown challenges method {method}")),
            }
        }

        #[cfg(test)]
        pub(crate) fn challenge_methods(cfg: &ts_rs::Config) -> Vec<crate::typescript::Method> {
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
        pub(crate) fn visit_challenge_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                visitor.visit::<$ty>();
                visitor.visit::<$ret>();
            )*
        }
    };
}

challenges! {
    {
        /// Serves a row at one help level through its registered plugin.
        serveChallenge(args: ServeArgs) -> Served {
            let easiest = HelpLevel::step(args.challenge.steps()[0]);
            let level = HelpLevel::parse(&args.shown).unwrap_or(easiest);
            args.challenge.serve(level)
        }
        /// Grades a plugin-shaped answer and returns all feedback and logging facts.
        gradeChallenge(args: GradeArgs) -> Graded {
            let easiest = HelpLevel::step(args.challenge.steps()[0]);
            let level = HelpLevel::parse(&args.shown).unwrap_or(easiest);
            args.challenge.grade(level, &args.answer).expect("protocol answer tag matches challenge tag")
        }
        /// Returns canonical feedback for a skipped challenge through its plugin.
        correctFeedback(args: ServeArgs) -> sapling_challenges::Feedback {
            let easiest = HelpLevel::step(args.challenge.steps()[0]);
            let level = HelpLevel::parse(&args.shown).unwrap_or(easiest);
            let answer = args.challenge.correct_answer(level);
            args.challenge.grade(level, &answer).expect("a plugin's correct answer matches itself").feedback
        }
        /// Compile-time registry facts consumed by the frontend session.
        challengeTypes(_args: RegistryArgs) -> Vec<ChallengeTypeInfo> {
            ChallengeType::ALL.iter().map(|kind| kind.info()).collect()
        }
        /// A word's maturity bucket, from its strength.
        maturityOf(args: StrengthArgs) -> Maturity {
            maturity_for_strength(args.strength)
        }
        /// The chance the reader hides a word's reading at this strength.
        hideReadingProbability(args: StrengthArgs) -> f64 {
            hide_reading_probability(args.strength)
        }
        /// The most urgent word and its challenge — a position into `pool` at its help level — absent while it has nothing, unless `pass` lets it be the first word further down with something.
        streamHead(args: StreamArgs) -> Option<Head> {
            stream::head(&args.pool, &args.words, args.now, &args.serving.unwrap_or_default(), &args.served.unwrap_or_default(), args.pass.unwrap_or(false))
        }
        /// How many words ahead the stream keeps written for, at this pace.
        lowWaterMark(args: LowWaterArgs) -> usize {
            stream::low_water_mark(args.pace_ms, args.batch_ms)
        }
        /// Whether a challenge about these words counts towards the next match round.
        isEarly(args: EarlyArgs) -> bool {
            stream::is_early(&args.item_ids, &args.words)
        }
        /// A free match round from the early words, or none when there are too few.
        matchRound(args: MatchRoundArgs) -> Option<MatchPairsChallenge> {
            stream::match_round(&args.words, &mut Rng::from_seed(args.seed))
        }
        /// What the words ahead are missing, most urgent word first.
        planTopUp(args: TopUpArgs) -> Vec<Want> {
            let mut rng = Rng::from_seed(args.seed);
            let (served, asked) = (args.served.unwrap_or_default(), args.asked.unwrap_or_default());
            let scope = Scope { served: &served, asked: &asked, limit: args.limit };
            topup::plan_top_up(&args.pool, &args.words, args.now, &args.serving.unwrap_or_default(), scope, &mut || rng.next_f64())
        }
        /// The start screen's figure and what a press would write.
        topUpCoverage(args: TopUpArgs) -> TopUpCoverage {
            topup::coverage(&args.pool, &args.words, args.now, &args.serving.unwrap_or_default())
        }
    }
}

/// [`dispatch_challenges`] over the wire: the answer as JSON, a malformed call
/// as plain text.
pub fn dispatch_challenges_json(method: &str, args_json: &str) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    dispatch_challenges(method, &args).map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(method: &str, args: Value) -> Result<Value, String> {
        dispatch_challenges_json(method, &json!([args]).to_string())
            .map(|answer| serde_json::from_str(&answer).unwrap())
    }

    #[test]
    fn a_call_answers_its_json() {
        let answer = call("challengeTypes", json!({})).unwrap();
        assert_eq!(
            answer[0],
            json!({ "type": "multiple-choice", "reviews": true, "pooled": true })
        );
        assert_eq!(
            call("maturityOf", json!({ "strength": 0.9 })).unwrap(),
            json!("solid")
        );
    }

    #[test]
    fn a_pick_answers_a_position_and_skips_what_it_cannot_read() {
        let row = json!({ "id": "c", "type": "multiple-choice", "direction": "toNative", "prompt": "p",
            "options": ["a", "b", "c", "d"], "correctIndex": 0, "itemIds": ["w"],
            "generatedAt": 0, "timesServed": 0, "lastServedAt": null, "reported": false });
        let alien = json!({ "id": "x", "type": "dictation", "itemIds": ["w"] });
        let words =
            json!([{ "id": "w", "term": "t", "meaning": "m", "kind": "vocab", "fsrsCard": null }]);
        let head = call(
            "streamHead",
            json!({ "pool": [alien, row.clone()], "words": words, "now": 1 }),
        )
        .unwrap();
        assert_eq!(head["word"], json!("w"));
        assert_eq!(head["next"]["at"], json!(1));
        assert_eq!(head["next"]["shown"], json!("plain"));
        let blocked = call(
            "streamHead",
            json!({ "pool": [row.clone()], "words": words, "now": 1, "served": ["c"] }),
        )
        .unwrap();
        assert_eq!(blocked, json!({ "word": "w" }));
        // Passed, a head with nothing gives way to the next word with something.
        let mut other = row;
        other["id"] = json!("d");
        other["itemIds"] = json!(["x"]);
        let two = json!([words[0], { "id": "x", "term": "u", "meaning": "n" }]);
        let passed = call(
            "streamHead",
            json!({ "pool": [other], "words": two, "now": 1, "pass": true }),
        )
        .unwrap();
        assert_eq!(passed["word"], json!("w"));
        assert_eq!(passed["instead"], json!("x"));
        assert_eq!(passed["next"]["at"], json!(0));
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        assert_eq!(
            call("nope", json!({})).unwrap_err(),
            "Unknown challenges method nope"
        );
        assert!(call("gradeChallenge", json!({}))
            .unwrap_err()
            .starts_with("gradeChallenge: argument 0"));
    }
}
