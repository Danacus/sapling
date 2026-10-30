//! The challenge union and everything decided about a challenge once it
//! exists: its stored shape (`challenge.rs`), grading (`grade.rs` over the
//! string matchers in `matcher.rs`), the help levels a stored row can be shown
//! at (`help.rs`), how hard it is for which word — one learned scale, the
//! difficulty model (`model.rs`, replayed from the log by `replay.rs`,
//! measured by `calibrate.rs`) — and the one check both planners ask
//! (`fits.rs`), what a served one shows (`serve.rs`), the free match round
//! (`match_pairs.rs`), the rows built from the learner's own material
//! (`local.rs`), and the two planners over the pool: which challenge
//! the practice stream serves next (`stream.rs`) and what a top-up writes
//! (`topup.rs`). The
//! kinds a challenge is written as are `kinds.rs`; the numbers are data
//! (`data/*.json`).
//!
//! Beside them, a research prototype that nothing in the app calls: a
//! Bayesian difficulty model (`model_v2.rs`), a Thompson-sampling policy over
//! it (`policy_v2.rs`), its calibration report (`calibrate_v2.rs`) and a
//! closed-loop simulation to compare policies in (`sim/closed_loop.rs`), all
//! run from the `calibrate` binary; and a barer one to compare it with,
//! ratings with margins (`ratings.rs`, `ratings_policy.rs`, `ratings_extras.rs`).
//!
//! No database and no model call: a host hands in the pool and the words and
//! gets decisions back. Presentation — what to print, speak or render — stays
//! with the host.

#![forbid(unsafe_code)]

pub mod calibrate;
pub mod calibrate_ratings;
pub mod calibrate_v2;
pub mod fits;
pub mod generation;
pub mod grade;
pub mod help;
#[cfg(test)]
mod invariants;
pub mod kinds;
pub mod legacy;
pub mod local;
pub mod match_pairs;
pub mod matcher;
pub mod model;
pub mod model_v2;
pub mod policy_v2;
pub mod pool;
pub mod ratings;
pub mod ratings_extras;
pub mod ratings_policy;
pub mod replay;
pub mod rng;
pub mod schema;
pub mod serve;
pub mod sim;
pub mod stream;
pub mod text;
pub mod topup;
pub mod types;
pub mod word;

pub use kinds::{kind_of, ChallengeKind, Want, WantItem, WireType};
pub use pool::PoolRow;
pub use rng::Rng;
pub use types::{
    Challenge, ChallengeAnswer, ChallengeScreen, ChallengeType, ChallengeTypeInfo, Direction,
    Feedback, Graded, Served, STORED_TYPES,
};
pub use word::Word;
