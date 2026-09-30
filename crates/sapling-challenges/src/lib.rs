//! The challenge union and everything decided about a challenge once it
//! exists: its stored shape (`challenge.rs`), grading (`grade.rs` over the
//! string matchers in `matcher.rs`), the help levels a stored row can be shown
//! at (`help.rs`), how hard it is for which word — one learned scale, the
//! difficulty model (`model.rs`, replayed from the log by `replay.rs`,
//! measured by `calibrate.rs`) — and the one check both planners ask
//! (`fits.rs`), what a served one shows (`serve.rs`), the free match round
//! (`match_pairs.rs`), and the two planners over the pool: which challenge
//! the practice stream serves next (`stream.rs`) and what a top-up writes
//! (`topup.rs`). The
//! kinds a challenge is written as are `kinds.rs`; the numbers are data
//! (`data/*.json`).
//!
//! No database and no model call: a host hands in the pool and the words and
//! gets decisions back. Presentation — what to print, speak or render — stays
//! with the host.

#![forbid(unsafe_code)]

pub mod calibrate;
pub mod challenge;
pub mod fits;
pub mod grade;
pub mod help;
pub mod kinds;
pub mod legacy;
pub mod match_pairs;
pub mod matcher;
pub mod model;
pub mod pool;
pub mod replay;
pub mod rng;
pub mod serve;
pub mod sim;
pub mod stream;
pub mod text;
pub mod topup;
pub mod word;

pub use challenge::{Challenge, ChallengeType, Direction, STORED_TYPES};
pub use kinds::{kind_of, ChallengeKind, Want, WantItem, WireType};
pub use pool::PoolRow;
pub use rng::Rng;
pub use word::Word;
