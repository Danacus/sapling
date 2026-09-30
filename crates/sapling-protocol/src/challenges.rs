//! The challenge decisions by name, like the `llm!` table but synchronous and
//! needing nothing from the host: grading, what a served challenge shows, and
//! the two planners. (The host still lends a word counter; nothing reads it
//! now that difficulty is measured by the model's own `words_in`.) Each method takes one argument
//! object; the table also generates the TypeScript `Challenges` interface and
//! `CHALLENGE_METHODS` (`challenges.ts`). A seed, where a method takes one,
//! replays its draws; without one it draws from the OS.

use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use sapling_challenges::challenge::{MultiClozeChallenge, WordOrderChallenge};
use sapling_challenges::fits::Serving;
use sapling_challenges::grade::{self, MultiClozeGrade};
use sapling_challenges::help::HelpLevel;
use sapling_challenges::matcher::{self, AnswerMatch};
use sapling_challenges::pool::lenient_rows;
use sapling_challenges::serve::{self, Presentation};
use sapling_challenges::session::{self, Planned, Slot};
use sapling_challenges::text::WordCount;
use sapling_challenges::topup::{self, TopUpCoverage};
use sapling_challenges::word::{hide_reading_probability, maturity_for_strength, Maturity};
use sapling_challenges::{Challenge, PoolRow, Rng, Want, Word};
use sapling_domain::types::Verdict;

use crate::required;

#[derive(Debug, Deserialize, TS)]
pub struct CheckChallengeArgs {
    pub challenge: Challenge,
    pub answer: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct GradeMultiClozeArgs {
    pub challenge: MultiClozeChallenge,
    pub answers: Vec<String>,
}

#[derive(Debug, Deserialize, TS)]
pub struct ValidateAnswerArgs {
    pub given: String,
    pub accepted: Vec<String>,
    /// Whether a near miss can earn `almost`; on unless `false`.
    #[serde(default)]
    #[ts(optional)]
    pub fuzzy: Option<bool>,
}

#[derive(Debug, Deserialize, TS)]
pub struct PresentationArgs {
    pub challenge: Challenge,
    /// The help level serving picked (`Planned.shown`); a level this build
    /// does not know shows the row at its easiest step.
    pub shown: String,
}

#[derive(Debug, Deserialize, TS)]
pub struct VisibleBankArgs {
    pub challenge: Challenge,
    pub size: usize,
}

#[derive(Debug, Deserialize, TS)]
pub struct VisibleTilesArgs {
    pub challenge: WordOrderChallenge,
    pub count: usize,
}

#[derive(Debug, Deserialize, TS)]
pub struct StrengthArgs {
    pub strength: f64,
}

/// A pool as the host read it; a row this build cannot read keeps its place
/// and is never planned.
#[derive(Debug, Deserialize, TS)]
pub struct PlanSessionArgs {
    #[serde(deserialize_with = "lenient_rows")]
    #[ts(as = "Vec<PoolRow>")]
    pub pool: Vec<Option<PoolRow>>,
    pub words: Vec<Word>,
    pub now: f64,
    /// The learned numbers, the aim and the help-level bounds a pick is made against.
    #[serde(default)]
    #[ts(optional)]
    pub serving: Option<Serving>,
    /// Slots to aim for.
    #[serde(default)]
    #[ts(optional)]
    pub target: Option<i64>,
    /// The ceiling, whatever `target` says.
    #[serde(default)]
    #[ts(optional)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize, TS)]
pub struct InterleaveArgs {
    /// Each planned challenge's `itemIds`, in play order.
    pub plan: Vec<Vec<String>>,
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
    #[serde(default)]
    #[ts(optional)]
    pub seed: Option<u64>,
}

fn readable(pool: &[Option<PoolRow>]) -> Vec<&PoolRow> {
    pool.iter().flatten().collect()
}

macro_rules! challenges {
    (
        |$count:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one challenge decision by name.
        #[allow(non_snake_case)]
        pub fn dispatch_challenges(
            method: &str,
            args: &[Value],
            $count: WordCount,
        ) -> Result<Value, String> {
            let _ = $count;
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
    |count| {
        /// Grades any challenge from the one string its component reports.
        checkChallenge(args: CheckChallengeArgs) -> Verdict {
            grade::check(&args.challenge, &args.answer)
        }
        /// A passage, gap by gap: the overall verdict and each gap's own.
        gradeMultiCloze(args: GradeMultiClozeArgs) -> MultiClozeGrade {
            grade::grade_multi_cloze(&args.challenge, &args.answers)
        }
        /// A free-text answer against accepted ones: verdict and nearest answer.
        validateAnswer(args: ValidateAnswerArgs) -> AnswerMatch {
            matcher::validate_answer(&args.given, &args.accepted, args.fuzzy.unwrap_or(true))
        }
        /// Everything a served challenge shows at the help level it was picked at.
        presentationFor(args: PresentationArgs) -> Presentation {
            let easiest = HelpLevel::step(sapling_challenges::help::steps_of(&args.challenge)[0]);
            serve::presentation_for(&args.challenge, HelpLevel::parse(&args.shown).unwrap_or(easiest))
        }
        /// The bank positions a cloze or multi-cloze shows at `size`.
        visibleBank(args: VisibleBankArgs) -> Vec<usize> {
            serve::visible_bank(&args.challenge, args.size)
        }
        /// The tray positions a word-order shows with `count` distractors.
        visibleTiles(args: VisibleTilesArgs) -> Vec<usize> {
            serve::visible_tiles(&args.challenge, args.count)
        }
        /// A word's maturity bucket, from its strength.
        maturityOf(args: StrengthArgs) -> Maturity {
            maturity_for_strength(args.strength)
        }
        /// The chance the reader hides a word's reading at this strength.
        hideReadingProbability(args: StrengthArgs) -> f64 {
            hide_reading_probability(args.strength)
        }
        /// The session: positions into `pool`, in play order, each at its help level.
        planSession(args: PlanSessionArgs) -> Vec<Planned> {
            session::plan_session(&args.pool, &args.words, args.now, &args.serving.unwrap_or_default(), args.target, args.limit)
        }
        /// The queue: each planned challenge by its position, with the match rounds between.
        interleaveMatchRounds(args: InterleaveArgs) -> Vec<Slot> {
            session::interleave_match_rounds(&args.plan, &args.words, &mut Rng::from_seed(args.seed))
        }
        /// What the pool is missing, most urgent word first.
        planTopUp(args: TopUpArgs) -> Vec<Want> {
            let mut rng = Rng::from_seed(args.seed);
            topup::plan_top_up(&readable(&args.pool), &args.words, args.now, &args.serving.unwrap_or_default(), &mut || rng.next_f64())
        }
        /// How well the pool covers the words a session is about to serve.
        topUpCoverage(args: TopUpArgs) -> TopUpCoverage {
            topup::top_up_coverage(&readable(&args.pool), &args.words, args.now, &args.serving.unwrap_or_default())
        }
    }
}

/// [`dispatch_challenges`] over the wire: the answer as JSON, a malformed call
/// as plain text.
pub fn dispatch_challenges_json(
    method: &str,
    args_json: &str,
    count: WordCount,
) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    dispatch_challenges(method, &args, count).map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_challenges::text::fallback_word_count;
    use serde_json::json;

    fn call(method: &str, args: Value) -> Result<Value, String> {
        dispatch_challenges_json(method, &json!([args]).to_string(), &fallback_word_count)
            .map(|answer| serde_json::from_str(&answer).unwrap())
    }

    #[test]
    fn a_call_answers_its_json() {
        let answer = call(
            "validateAnswer",
            json!({ "given": "cafe", "accepted": ["café"] }),
        )
        .unwrap();
        assert_eq!(
            answer,
            json!({ "verdict": "almost", "closestAccepted": "café", "distance": 0 })
        );
        assert_eq!(
            call("maturityOf", json!({ "strength": 0.9 })).unwrap(),
            json!("solid")
        );
    }

    #[test]
    fn a_plan_answers_positions_and_skips_what_it_cannot_read() {
        let row = json!({ "id": "c", "type": "multiple-choice", "direction": "toNative", "prompt": "p",
            "options": ["a", "b", "c", "d"], "correctIndex": 0, "itemIds": ["w"],
            "generatedAt": 0, "timesServed": 0, "lastServedAt": null, "reported": false });
        let alien = json!({ "id": "x", "type": "dictation", "itemIds": ["w"] });
        let words =
            json!([{ "id": "w", "term": "t", "meaning": "m", "kind": "vocab", "fsrsCard": null }]);
        let plan = call(
            "planSession",
            json!({ "pool": [alien, row], "words": words, "now": 1 }),
        )
        .unwrap();
        assert_eq!(plan[0]["at"], json!(1));
        assert_eq!(plan[0]["shown"], json!("plain"));
        assert_eq!(plan.as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        assert_eq!(
            call("nope", json!({})).unwrap_err(),
            "Unknown challenges method nope"
        );
        assert!(call("checkChallenge", json!({}))
            .unwrap_err()
            .starts_with("checkChallenge: argument 0"));
    }
}
